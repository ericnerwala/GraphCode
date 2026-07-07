import { describe, expect, it } from 'vitest'
import type { Tree } from 'web-tree-sitter'
import { extractTsJs } from '../../src/index/extractors/ts-js.js'
import { fakeNode, fakeTree, type FakeNodeSpec } from './helpers/fake-node.js'

// Fake CST approximating:
//
// import { Base } from './base.js'
//
// /** Greets someone by name. */
// export function greet(name) {
//   return format(name)
// }
//
// export const helper = (x) => { return x + 1 }
//
// export class Widget extends Base implements Shape {
//   render() {
//     helper(this.count)
//   }
// }
//
// export interface Shape {}
// export type Size = {}
// export enum Color { Red }

const programSpec: FakeNodeSpec = {
  type: 'program',
  startLine: 1,
  endLine: 20,
  children: [
    {
      type: 'import_statement',
      startLine: 1,
      endLine: 1,
      fields: { source: { type: 'string', text: "'./base.js'" } },
    },
    { type: 'comment', startLine: 3, text: '/** Greets someone by name. */' },
    {
      type: 'export_statement',
      startLine: 4,
      endLine: 6,
      fields: {
        declaration: {
          type: 'function_declaration',
          startLine: 4,
          endLine: 6,
          text: 'function greet(name) {\n  return format(name)\n}',
          fields: {
            name: { type: 'identifier', text: 'greet' },
            body: {
              type: 'statement_block',
              children: [
                {
                  type: 'return_statement',
                  children: [{ type: 'call_expression', fields: { function: { type: 'identifier', text: 'format' } } }],
                },
              ],
            },
          },
        },
      },
    },
    {
      type: 'export_statement',
      startLine: 8,
      endLine: 8,
      fields: {
        declaration: {
          type: 'lexical_declaration',
          startLine: 8,
          endLine: 8,
          children: [
            {
              type: 'variable_declarator',
              text: 'helper = (x) => { return x + 1 }',
              fields: {
                name: { type: 'identifier', text: 'helper' },
                value: {
                  type: 'arrow_function',
                  fields: {
                    body: { type: 'statement_block', children: [] },
                  },
                },
              },
            },
          ],
        },
      },
    },
    {
      type: 'export_statement',
      startLine: 10,
      endLine: 14,
      fields: {
        declaration: {
          type: 'class_declaration',
          startLine: 10,
          endLine: 14,
          text: 'class Widget extends Base implements Shape {\n  render() {\n    helper(this.count)\n  }\n}',
          fields: {
            name: { type: 'identifier', text: 'Widget' },
            body: {
              type: 'class_body',
              children: [
                {
                  type: 'method_definition',
                  startLine: 11,
                  endLine: 13,
                  text: 'render() {\n    helper(this.count)\n  }',
                  fields: {
                    name: { type: 'identifier', text: 'render' },
                    body: {
                      type: 'statement_block',
                      children: [
                        {
                          type: 'expression_statement',
                          children: [{ type: 'call_expression', fields: { function: { type: 'identifier', text: 'helper' } } }],
                        },
                      ],
                    },
                  },
                },
              ],
            },
          },
          children: [
            {
              type: 'class_heritage',
              children: [
                { type: 'extends_clause', children: [{ type: 'identifier', text: 'Base' }] },
                { type: 'implements_clause', children: [{ type: 'type_identifier', text: 'Shape' }] },
              ],
            },
          ],
        },
      },
    },
    {
      type: 'export_statement',
      startLine: 16,
      endLine: 16,
      fields: {
        declaration: {
          type: 'interface_declaration',
          startLine: 16,
          endLine: 16,
          text: 'interface Shape {}',
          fields: { name: { type: 'type_identifier', text: 'Shape' } },
        },
      },
    },
    {
      type: 'export_statement',
      startLine: 17,
      endLine: 17,
      fields: {
        declaration: {
          type: 'type_alias_declaration',
          startLine: 17,
          endLine: 17,
          text: 'type Size = {}',
          fields: { name: { type: 'type_identifier', text: 'Size' } },
        },
      },
    },
    {
      type: 'export_statement',
      startLine: 18,
      endLine: 18,
      fields: {
        declaration: {
          type: 'enum_declaration',
          startLine: 18,
          endLine: 18,
          text: 'enum Color { Red }',
          fields: { name: { type: 'identifier', text: 'Color' } },
        },
      },
    },
  ],
}

describe('extractTsJs (fake CST)', () => {
  const tree = fakeTree(fakeNode(programSpec)) as unknown as Tree
  const extraction = extractTsJs(tree)

  it('extracts function, class, interface, type, and enum symbols with correct kinds', () => {
    const byName = new Map(extraction.symbols.map((s) => [s.name, s]))
    expect(byName.get('greet')?.kind).toBe('function')
    expect(byName.get('helper')?.kind).toBe('function')
    expect(byName.get('Widget')?.kind).toBe('class')
    expect(byName.get('Shape')?.kind).toBe('interface')
    expect(byName.get('Size')?.kind).toBe('type')
    expect(byName.get('Color')?.kind).toBe('enum')
    expect(byName.get('render')?.kind).toBe('method')
    expect(byName.get('render')?.parentName).toBe('Widget')
  })

  it('marks all top-level exported declarations as exported', () => {
    const byName = new Map(extraction.symbols.map((s) => [s.name, s]))
    for (const name of ['greet', 'helper', 'Widget', 'Shape', 'Size', 'Color']) {
      expect(byName.get(name)?.exported).toBe(true)
    }
  })

  it('extracts the leading doc comment for an exported function', () => {
    const greet = extraction.symbols.find((s) => s.name === 'greet')
    expect(greet?.doc).toContain('Greets someone by name')
  })

  it('extracts import statements', () => {
    expect(extraction.imports.map((i) => i.raw)).toContain('./base.js')
  })

  it('extracts extends/implements refs for classes', () => {
    expect(extraction.refs.find((r) => r.kind === 'extends' && r.fromSymbol === 'Widget')?.name).toBe('Base')
    expect(extraction.refs.find((r) => r.kind === 'implements' && r.fromSymbol === 'Widget')?.name).toBe('Shape')
  })

  it('extracts call refs within function and method bodies', () => {
    expect(extraction.refs.find((r) => r.kind === 'calls' && r.fromSymbol === 'greet' && r.name === 'format')).toBeDefined()
    expect(extraction.refs.find((r) => r.kind === 'calls' && r.fromSymbol === 'render' && r.name === 'helper')).toBeDefined()
  })
})
