import { describe, expect, it } from 'vitest'
import type { Tree } from 'web-tree-sitter'
import { extractPython } from '../../src/index/extractors/python.js'
import { fakeNode, fakeTree, type FakeNodeSpec } from './helpers/fake-node.js'

// Fake CST for:
//
// import os
// from .base import Base
//
// def greet(name):
//     """Greets someone by name."""
//     return format_name(name)
//
// class Widget(Base):
//     def render(self):
//         helper(self.label)
//
// def _private_helper():
//     pass

const moduleSpec: FakeNodeSpec = {
  type: 'module',
  startLine: 1,
  endLine: 15,
  children: [
    { type: 'import_statement', startLine: 1, endLine: 1, children: [{ type: 'dotted_name', text: 'os' }] },
    {
      type: 'import_from_statement',
      startLine: 2,
      endLine: 2,
      fields: { module_name: { type: 'dotted_name', text: '.base' } },
    },
    {
      type: 'function_definition',
      startLine: 4,
      endLine: 6,
      text: 'def greet(name):\n    """Greets someone by name."""\n    return format_name(name)',
      fields: {
        name: { type: 'identifier', text: 'greet' },
        parameters: { type: 'parameters', text: '(name)' },
        body: {
          type: 'block',
          children: [
            {
              type: 'expression_statement',
              children: [{ type: 'string', text: '"""Greets someone by name."""' }],
            },
            {
              type: 'return_statement',
              children: [
                {
                  type: 'call',
                  fields: {
                    function: { type: 'identifier', text: 'format_name' },
                  },
                },
              ],
            },
          ],
        },
      },
    },
    {
      type: 'class_definition',
      startLine: 8,
      endLine: 10,
      fields: {
        name: { type: 'identifier', text: 'Widget' },
        superclasses: { type: 'argument_list', children: [{ type: 'identifier', text: 'Base' }] },
        body: {
          type: 'block',
          children: [
            {
              type: 'function_definition',
              startLine: 9,
              endLine: 10,
              fields: {
                name: { type: 'identifier', text: 'render' },
                parameters: { type: 'parameters', text: '(self)' },
                body: {
                  type: 'block',
                  children: [
                    {
                      type: 'expression_statement',
                      children: [
                        {
                          type: 'call',
                          fields: { function: { type: 'identifier', text: 'helper' } },
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
    },
    {
      type: 'function_definition',
      startLine: 12,
      endLine: 13,
      fields: {
        name: { type: 'identifier', text: '_private_helper' },
        parameters: { type: 'parameters', text: '()' },
        body: { type: 'block', children: [{ type: 'pass_statement' }] },
      },
    },
  ],
}

describe('extractPython (fake CST)', () => {
  const tree = fakeTree(fakeNode(moduleSpec)) as unknown as Tree
  const extraction = extractPython(tree)

  it('extracts functions, classes, and methods with correct kinds', () => {
    const byName = new Map(extraction.symbols.map((s) => [s.name, s]))
    expect(byName.get('greet')?.kind).toBe('function')
    expect(byName.get('Widget')?.kind).toBe('class')
    expect(byName.get('render')?.kind).toBe('method')
    expect(byName.get('render')?.parentName).toBe('Widget')
  })

  it('records correct start/end lines', () => {
    const greet = extraction.symbols.find((s) => s.name === 'greet')
    expect(greet?.startLine).toBe(4)
    expect(greet?.endLine).toBe(6)
  })

  it('marks underscore-prefixed functions as not exported', () => {
    expect(extraction.symbols.find((s) => s.name === '_private_helper')?.exported).toBe(false)
    expect(extraction.symbols.find((s) => s.name === 'greet')?.exported).toBe(true)
  })

  it('extracts docstrings from the first statement in the body', () => {
    const greet = extraction.symbols.find((s) => s.name === 'greet')
    expect(greet?.doc).toContain('Greets someone by name')
  })

  it('extracts import and from-import statements', () => {
    const raws = extraction.imports.map((i) => i.raw)
    expect(raws).toContain('os')
    expect(raws).toContain('.base')
  })

  it('extracts class base refs as extends', () => {
    const base = extraction.refs.find((r) => r.kind === 'extends' && r.fromSymbol === 'Widget')
    expect(base?.name).toBe('Base')
  })

  it('extracts call refs within function/method bodies', () => {
    expect(extraction.refs.find((r) => r.kind === 'calls' && r.fromSymbol === 'greet' && r.name === 'format_name')).toBeDefined()
    expect(extraction.refs.find((r) => r.kind === 'calls' && r.fromSymbol === 'render' && r.name === 'helper')).toBeDefined()
  })
})
