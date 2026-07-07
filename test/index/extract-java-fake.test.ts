import { describe, expect, it } from 'vitest'
import type { Tree } from 'web-tree-sitter'
import { extractJava } from '../../src/index/extractors/java.js'
import { fakeNode, fakeTree, type FakeNodeSpec } from './helpers/fake-node.js'

// Fake CST approximating:
//
// package com.example;
//
// import com.example.base.Base;
// import com.example.wild.*;
//
// public class Widget extends Base implements Shape {
//     private int count;
//
//     public void render() {
//         Helper.assist(count);
//         new Helper();
//     }
// }
//
// interface Shape {}

const programSpec: FakeNodeSpec = {
  type: 'program',
  startLine: 1,
  endLine: 15,
  children: [
    {
      type: 'package_declaration',
      startLine: 1,
      endLine: 1,
      children: [{ type: 'scoped_identifier', text: 'com.example' }],
    },
    {
      type: 'import_declaration',
      startLine: 2,
      endLine: 2,
      children: [{ type: 'scoped_identifier', text: 'com.example.base.Base' }],
    },
    {
      type: 'import_declaration',
      startLine: 3,
      endLine: 3,
      text: 'import com.example.wild.*;',
      children: [{ type: 'scoped_identifier', text: 'com.example.wild' }, { type: 'asterisk', text: '*' }],
    },
    {
      type: 'class_declaration',
      startLine: 3,
      endLine: 10,
      text: 'public class Widget extends Base implements Shape {\n...\n}',
      fields: {
        name: { type: 'identifier', text: 'Widget' },
        superclass: { type: 'superclass', children: [{ type: 'type_identifier', text: 'Base' }] },
        interfaces: {
          type: 'super_interfaces',
          children: [{ type: 'type_identifier', text: 'Shape' }],
        },
        body: {
          type: 'class_body',
          children: [
            {
              type: 'field_declaration',
              startLine: 4,
              endLine: 4,
              text: 'private int count;',
              children: [
                { type: 'modifiers', children: [] },
                { type: 'variable_declarator', fields: { name: { type: 'identifier', text: 'count' } } },
              ],
            },
            {
              type: 'method_declaration',
              startLine: 6,
              endLine: 9,
              text: 'public void render() {\n    Helper.assist(count);\n    new Helper();\n}',
              children: [{ type: 'modifiers', children: [{ type: 'modifier', text: 'public' }] }],
              fields: {
                name: { type: 'identifier', text: 'render' },
                parameters: { type: 'formal_parameters', text: '()' },
                body: {
                  type: 'block',
                  children: [
                    {
                      type: 'expression_statement',
                      children: [
                        {
                          type: 'method_invocation',
                          fields: {
                            name: { type: 'identifier', text: 'assist' },
                            object: { type: 'identifier', text: 'Helper' },
                          },
                        },
                      ],
                    },
                    {
                      type: 'expression_statement',
                      children: [
                        {
                          type: 'object_creation_expression',
                          fields: { type: { type: 'type_identifier', text: 'Helper' } },
                        },
                      ],
                    },
                  ],
                },
              },
            },
          ],
        },
      },
      children: [{ type: 'modifiers', children: [{ type: 'modifier', text: 'public' }] }],
    },
    {
      type: 'interface_declaration',
      startLine: 12,
      endLine: 12,
      text: 'interface Shape {}',
      fields: { name: { type: 'identifier', text: 'Shape' }, body: { type: 'interface_body', children: [] } },
    },
  ],
}

describe('extractJava (fake CST)', () => {
  const tree = fakeTree(fakeNode(programSpec)) as unknown as Tree
  const extraction = extractJava(tree)

  it('extracts class, interface, and method decls', () => {
    const byName = new Map(extraction.symbols.map((s) => [s.name, s]))
    expect(byName.get('Widget')?.kind).toBe('class')
    expect(byName.get('Shape')?.kind).toBe('interface')
    expect(byName.get('render')?.kind).toBe('method')
    expect(byName.get('render')?.parentName).toBe('Widget')
  })

  it('extracts field decls', () => {
    const count = extraction.symbols.find((s) => s.name === 'count')
    expect(count?.kind).toBe('variable')
    expect(count?.parentName).toBe('Widget')
  })

  it('marks public members as exported, package-private as not', () => {
    expect(extraction.symbols.find((s) => s.name === 'Widget')?.exported).toBe(true)
    expect(extraction.symbols.find((s) => s.name === 'render')?.exported).toBe(true)
    expect(extraction.symbols.find((s) => s.name === 'Shape')?.exported).toBe(false)
  })

  it('extracts imports', () => {
    expect(extraction.imports.map((i) => i.raw)).toContain('com.example.base.Base')
  })

  it('extracts the package declaration', () => {
    expect(extraction.packageName).toBe('com.example')
  })

  it('marks wildcard imports with a trailing .*', () => {
    expect(extraction.imports.map((i) => i.raw)).toContain('com.example.wild.*')
  })

  it('extracts extends and implements refs', () => {
    expect(extraction.refs.find((r) => r.kind === 'extends' && r.fromSymbol === 'Widget')?.name).toBe('Base')
    expect(extraction.refs.find((r) => r.kind === 'implements' && r.fromSymbol === 'Widget')?.name).toBe('Shape')
  })

  it('extracts method_invocation and object_creation refs as calls', () => {
    expect(extraction.refs.find((r) => r.kind === 'calls' && r.fromSymbol === 'render' && r.name === 'assist')).toBeDefined()
    expect(extraction.refs.find((r) => r.kind === 'calls' && r.fromSymbol === 'render' && r.name === 'Helper')).toBeDefined()
  })
})
