import { describe, expect, it } from 'vitest'
import type { Tree } from 'web-tree-sitter'
import { extractGo } from '../../src/index/extractors/go.js'
import { fakeNode, fakeTree, type FakeNodeSpec } from './helpers/fake-node.js'

// Fake CST approximating:
//
// package widget
//
// import (
//   "fmt"
// )
//
// type Widget struct {
//   Embedded
//   Label string
// }
//
// type Shape interface {
//   Area() float64
// }
//
// const MaxSize = 100
//
// func NewWidget(label string) *Widget { return &Widget{Label: label} }
//
// func (w *Widget) Render() {
//   fmt.Println(w.Label)
//   helper(w.Label)
// }

const sourceFileSpec: FakeNodeSpec = {
  type: 'source_file',
  startLine: 1,
  endLine: 32,
  children: [
    {
      type: 'import_declaration',
      startLine: 3,
      endLine: 5,
      children: [{ type: 'import_spec', fields: { path: { type: 'interpreted_string_literal', text: '"fmt"' } } }],
    },
    {
      type: 'type_declaration',
      startLine: 7,
      endLine: 10,
      children: [
        {
          type: 'type_spec',
          startLine: 7,
          endLine: 10,
          text: 'Widget struct {\n  Embedded\n  Label string\n}',
          fields: {
            name: { type: 'type_identifier', text: 'Widget' },
            type: {
              type: 'struct_type',
              fields: {
                body: {
                  type: 'field_declaration_list',
                  children: [
                    { type: 'field_declaration', fields: { type: { type: 'type_identifier', text: 'Embedded' } } },
                    {
                      type: 'field_declaration',
                      fields: {
                        name: { type: 'field_identifier', text: 'Label' },
                        type: { type: 'type_identifier', text: 'string' },
                      },
                    },
                  ],
                },
              },
            },
          },
        },
      ],
    },
    {
      type: 'type_declaration',
      startLine: 12,
      endLine: 14,
      children: [
        {
          type: 'type_spec',
          startLine: 12,
          endLine: 14,
          text: 'Shape interface {\n  Area() float64\n}',
          fields: {
            name: { type: 'type_identifier', text: 'Shape' },
            type: { type: 'interface_type', children: [] },
          },
        },
      ],
    },
    {
      type: 'const_declaration',
      startLine: 16,
      endLine: 16,
      children: [
        {
          type: 'const_spec',
          startLine: 16,
          endLine: 16,
          text: 'MaxSize = 100',
          fields: { name: [{ type: 'identifier', text: 'MaxSize' }] },
        },
      ],
    },
    {
      type: 'function_declaration',
      startLine: 18,
      endLine: 18,
      text: 'func NewWidget(label string) *Widget { return &Widget{Label: label} }',
      fields: {
        name: { type: 'identifier', text: 'NewWidget' },
        parameters: { type: 'parameter_list', text: '(label string)' },
        result: { type: 'pointer_type', text: '*Widget' },
        body: { type: 'block', children: [] },
      },
    },
    {
      type: 'method_declaration',
      startLine: 20,
      endLine: 23,
      text: 'func (w *Widget) Render() {\n  fmt.Println(w.Label)\n  helper(w.Label)\n}',
      fields: {
        receiver: {
          type: 'parameter_list',
          text: '(w *Widget)',
          children: [
            {
              type: 'parameter_declaration',
              fields: { type: { type: 'pointer_type', children: [{ type: 'type_identifier', text: 'Widget' }] } },
            },
          ],
        },
        name: { type: 'field_identifier', text: 'Render' },
        parameters: { type: 'parameter_list', text: '()' },
        body: {
          type: 'block',
          children: [
            {
              type: 'call_expression',
              fields: {
                function: {
                  type: 'selector_expression',
                  text: 'fmt.Println',
                  fields: { operand: { type: 'identifier', text: 'fmt' }, field: { type: 'field_identifier', text: 'Println' } },
                },
              },
            },
            {
              type: 'call_expression',
              fields: { function: { type: 'identifier', text: 'helper' } },
            },
          ],
        },
      },
    },
    // func (nn *NameNode) main-style usage:
    //   nn := namenode.New(namenode.Config{})
    //   nn.Serve()
    //   append(x, y)
    {
      type: 'function_declaration',
      startLine: 26,
      endLine: 30,
      text: 'func run() {\n  nn := namenode.New(namenode.Config{})\n  nn.Serve()\n  append(nil, nil)\n}',
      fields: {
        name: { type: 'identifier', text: 'run' },
        parameters: { type: 'parameter_list', text: '()' },
        body: {
          type: 'block',
          children: [
            {
              // nn := namenode.New(...) — selector call on a package identifier.
              type: 'call_expression',
              fields: {
                function: {
                  type: 'selector_expression',
                  text: 'namenode.New',
                  fields: { operand: { type: 'identifier', text: 'namenode' }, field: { type: 'field_identifier', text: 'New' } },
                },
              },
            },
            {
              // nn.Serve() — selector call whose operand is a *local variable*.
              // Must ref "Serve", never "nn".
              type: 'call_expression',
              fields: {
                function: {
                  type: 'selector_expression',
                  text: 'nn.Serve',
                  fields: { operand: { type: 'identifier', text: 'nn' }, field: { type: 'field_identifier', text: 'Serve' } },
                },
              },
            },
            {
              // append(...) — Go builtin; must be filtered, never emitted as a ref.
              type: 'call_expression',
              fields: { function: { type: 'identifier', text: 'append' } },
            },
          ],
        },
      },
    },
    // func makeNode() *NameNode { return &NameNode{Label: "x"} }
    {
      type: 'function_declaration',
      startLine: 32,
      endLine: 32,
      text: 'func makeNode() *NameNode { return &NameNode{Label: "x"} }',
      fields: {
        name: { type: 'identifier', text: 'makeNode' },
        parameters: { type: 'parameter_list', text: '()' },
        result: { type: 'pointer_type', text: '*NameNode', children: [{ type: 'type_identifier', text: 'NameNode' }] },
        body: {
          type: 'block',
          children: [
            {
              type: 'composite_literal',
              fields: { type: { type: 'type_identifier', text: 'NameNode' } },
            },
          ],
        },
      },
    },
  ],
}

describe('extractGo (fake CST)', () => {
  const tree = fakeTree(fakeNode(sourceFileSpec)) as unknown as Tree
  const extraction = extractGo(tree)

  it('extracts func and method decls with receiver', () => {
    const byName = new Map(extraction.symbols.map((s) => [s.name, s]))
    expect(byName.get('NewWidget')?.kind).toBe('function')
    expect(byName.get('Render')?.kind).toBe('method')
    expect(byName.get('Render')?.parentName).toBe('Widget')
  })

  it('extracts struct and interface type decls', () => {
    const byName = new Map(extraction.symbols.map((s) => [s.name, s]))
    expect(byName.get('Widget')?.kind).toBe('struct')
    expect(byName.get('Shape')?.kind).toBe('interface')
  })

  it('extracts top-level const decls', () => {
    expect(extraction.symbols.find((s) => s.name === 'MaxSize')?.kind).toBe('constant')
  })

  it('extracts imports', () => {
    expect(extraction.imports.map((i) => i.raw)).toContain('fmt')
  })

  it('extracts embedded struct fields as extends refs', () => {
    const embedded = extraction.refs.find((r) => r.kind === 'extends' && r.fromSymbol === 'Widget')
    expect(embedded?.name).toBe('Embedded')
  })

  it('extracts call refs within method bodies', () => {
    expect(extraction.refs.find((r) => r.kind === 'calls' && r.fromSymbol === 'Render' && r.name === 'helper')).toBeDefined()
  })

  it('refs a selector call by its field name, not the package operand', () => {
    const call = extraction.refs.find((r) => r.kind === 'calls' && r.fromSymbol === 'Render' && r.name === 'Println')
    expect(call).toBeDefined()
    expect(extraction.refs.some((r) => r.fromSymbol === 'Render' && r.name === 'fmt')).toBe(false)
  })

  it('refs a selector call on a local variable receiver by its method name, never the variable', () => {
    const calls = extraction.refs.filter((r) => r.kind === 'calls' && r.fromSymbol === 'run')
    expect(calls.some((r) => r.name === 'Serve')).toBe(true)
    expect(calls.some((r) => r.name === 'New')).toBe(true)
    expect(calls.some((r) => r.name === 'nn')).toBe(false)
    expect(calls.some((r) => r.name === 'namenode')).toBe(false)
  })

  it('filters Go builtins out of call refs', () => {
    expect(extraction.refs.some((r) => r.fromSymbol === 'run' && r.name === 'append')).toBe(false)
  })

  it('emits a references ref for a composite literal type', () => {
    const ref = extraction.refs.find((r) => r.kind === 'references' && r.fromSymbol === 'makeNode' && r.name === 'NameNode')
    expect(ref).toBeDefined()
  })

  it('emits a references ref for the function result type', () => {
    const ref = extraction.refs.find((r) => r.kind === 'references' && r.fromSymbol === 'makeNode' && r.name === 'NameNode')
    expect(ref).toBeDefined()
  })
})
