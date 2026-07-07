import { describe, expect, it } from 'vitest'
import type { Tree } from 'web-tree-sitter'
import { extractRust } from '../../src/index/extractors/rust.js'
import { fakeNode, fakeTree, type FakeNodeSpec } from './helpers/fake-node.js'

// Fake CST approximating:
//
// use std::fmt;
//
// pub struct Widget { pub label: String }
// pub enum Shape { Circle, Square }
// pub trait Renderer { fn render(&self); }
//
// impl Renderer for Widget {
//     fn render(&self) { helper(&self.label); }
// }
//
// impl Widget {
//     pub fn new(label: String) -> Self { Widget { label } }
// }
//
// mod util {
//     pub fn helper() {}
// }

const sourceFileSpec: FakeNodeSpec = {
  type: 'source_file',
  startLine: 1,
  endLine: 20,
  children: [
    { type: 'use_declaration', startLine: 1, endLine: 1, children: [{ type: 'scoped_identifier', text: 'std::fmt' }] },
    {
      type: 'struct_item',
      startLine: 3,
      endLine: 3,
      text: 'pub struct Widget { pub label: String }',
      children: [{ type: 'visibility_modifier', text: 'pub' }],
      fields: { name: { type: 'type_identifier', text: 'Widget' } },
    },
    {
      type: 'enum_item',
      startLine: 4,
      endLine: 4,
      text: 'pub enum Shape { Circle, Square }',
      children: [{ type: 'visibility_modifier', text: 'pub' }],
      fields: { name: { type: 'type_identifier', text: 'Shape' } },
    },
    {
      type: 'trait_item',
      startLine: 5,
      endLine: 5,
      text: 'pub trait Renderer { fn render(&self); }',
      children: [{ type: 'visibility_modifier', text: 'pub' }],
      fields: {
        name: { type: 'type_identifier', text: 'Renderer' },
        body: {
          type: 'declaration_list',
          children: [
            {
              type: 'function_signature_item',
              text: 'fn render(&self);',
              fields: { name: { type: 'identifier', text: 'render' } },
            },
          ],
        },
      },
    },
    {
      type: 'impl_item',
      startLine: 7,
      endLine: 9,
      text: 'impl Renderer for Widget {\n    fn render(&self) { helper(&self.label); }\n}',
      fields: {
        trait: { type: 'type_identifier', text: 'Renderer' },
        type: { type: 'type_identifier', text: 'Widget' },
        body: {
          type: 'declaration_list',
          children: [
            {
              type: 'function_item',
              startLine: 8,
              endLine: 8,
              text: 'fn render(&self) { helper(&self.label); }',
              fields: {
                name: { type: 'identifier', text: 'render' },
                body: {
                  type: 'block',
                  children: [{ type: 'call_expression', fields: { function: { type: 'identifier', text: 'helper' } } }],
                },
              },
            },
          ],
        },
      },
    },
    {
      type: 'impl_item',
      startLine: 11,
      endLine: 13,
      text: 'impl Widget {\n    pub fn new(label: String) -> Self { Widget { label } }\n}',
      fields: {
        type: { type: 'type_identifier', text: 'Widget' },
        body: {
          type: 'declaration_list',
          children: [
            {
              type: 'function_item',
              startLine: 12,
              endLine: 12,
              text: 'pub fn new(label: String) -> Self { Widget { label } }',
              children: [{ type: 'visibility_modifier', text: 'pub' }],
              fields: {
                name: { type: 'identifier', text: 'new' },
                body: { type: 'block', children: [] },
              },
            },
          ],
        },
      },
    },
    {
      type: 'mod_item',
      startLine: 15,
      endLine: 17,
      text: 'mod util {\n    pub fn helper() {}\n}',
      fields: {
        name: { type: 'identifier', text: 'util' },
        body: {
          type: 'declaration_list',
          children: [
            {
              type: 'function_item',
              startLine: 16,
              endLine: 16,
              text: 'pub fn helper() {}',
              children: [{ type: 'visibility_modifier', text: 'pub' }],
              fields: { name: { type: 'identifier', text: 'helper' }, body: { type: 'block', children: [] } },
            },
          ],
        },
      },
    },
  ],
}

describe('extractRust (fake CST)', () => {
  const tree = fakeTree(fakeNode(sourceFileSpec)) as unknown as Tree
  const extraction = extractRust(tree)

  it('extracts struct, enum, and trait decls', () => {
    // Widget legitimately produces both a `struct` symbol and `impl` symbols
    // (same name, different kind) -- find by kind rather than a name-keyed map.
    expect(extraction.symbols.find((s) => s.name === 'Widget' && s.kind === 'struct')).toBeDefined()
    expect(extraction.symbols.find((s) => s.name === 'Shape' && s.kind === 'enum')).toBeDefined()
    expect(extraction.symbols.find((s) => s.name === 'Renderer' && s.kind === 'trait')).toBeDefined()
  })

  it('extracts impl blocks with methods, qualified by the implementing type', () => {
    const methods = extraction.symbols.filter((s) => s.kind === 'method' && s.parentName === 'Widget')
    expect(methods.map((m) => m.name).sort()).toEqual(['new', 'render'])
  })

  it('extracts mod declarations and nested fns within them', () => {
    const mod = extraction.symbols.find((s) => s.name === 'util' && s.kind === 'module')
    expect(mod).toBeDefined()
    const nestedHelper = extraction.symbols.find((s) => s.name === 'helper' && s.kind === 'function')
    expect(nestedHelper).toBeDefined()
  })

  it('extracts use decls', () => {
    expect(extraction.imports.map((i) => i.raw)).toContain('std::fmt')
  })

  it('extracts trait impl refs as implements', () => {
    const impl = extraction.refs.find((r) => r.kind === 'implements' && r.fromSymbol === 'Widget')
    expect(impl?.name).toBe('Renderer')
  })

  it('extracts call refs within method bodies', () => {
    expect(extraction.refs.find((r) => r.kind === 'calls' && r.fromSymbol === 'render' && r.name === 'helper')).toBeDefined()
  })
})
