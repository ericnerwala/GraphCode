import { beforeAll, describe, expect, it } from 'vitest'
import { getParserFor, initParsers } from '../../src/index/parser.js'
import { languageForPath } from '../../src/index/languages.js'
import { extractPython } from '../../src/index/extractors/python.js'
import { wasmGrammarsLoad } from './helpers/wasm-support.js'

const SOURCE = `
import os
from .base import Base

def greet(name):
    """Greets someone by name."""
    return format_name(name)


class Widget(Base):
    def __init__(self, label):
        self.label = label

    def render(self):
        helper(self.label)
        dn = DataNode()
        dn.serve()
        items = len(self.label)
        print(items)


def _private_helper():
    pass
`

const canLoadWasm = await wasmGrammarsLoad()

describe.skipIf(!canLoadWasm)('extractPython', () => {
  let extraction: ReturnType<typeof extractPython>

  beforeAll(async () => {
    await initParsers()
    const def = languageForPath('widget.py')
    if (!def) throw new Error('no language def for .py')
    const parser = await getParserFor(def)
    const tree = parser.parse(SOURCE)
    if (!tree) throw new Error('parse failed')
    extraction = extractPython(tree)
  })

  it('extracts functions, classes, and methods with correct kinds', () => {
    const byName = new Map(extraction.symbols.map((s) => [s.name, s]))
    expect(byName.get('greet')?.kind).toBe('function')
    expect(byName.get('Widget')?.kind).toBe('class')
    expect(byName.get('render')?.kind).toBe('method')
    expect(byName.get('render')?.parentName).toBe('Widget')
  })

  it('marks underscore-prefixed functions as not exported', () => {
    const priv = extraction.symbols.find((s) => s.name === '_private_helper')
    expect(priv?.exported).toBe(false)
    const pub = extraction.symbols.find((s) => s.name === 'greet')
    expect(pub?.exported).toBe(true)
  })

  it('extracts docstrings', () => {
    const greet = extraction.symbols.find((s) => s.name === 'greet')
    expect(greet?.doc).toContain('Greets someone by name')
  })

  it('extracts import and from-import statements', () => {
    const raws = extraction.imports.map((i) => i.raw)
    expect(raws).toContain('os')
    expect(raws).toContain('.base')
  })

  it('extracts class base refs', () => {
    const base = extraction.refs.find((r) => r.kind === 'extends' && r.fromSymbol === 'Widget')
    expect(base?.name).toBe('Base')
  })

  it('extracts call refs within method bodies', () => {
    const call = extraction.refs.find((r) => r.kind === 'calls' && r.fromSymbol === 'render' && r.name === 'helper')
    expect(call).toBeDefined()
  })

  it('refs an attribute call by its attribute name, never the local variable receiver', () => {
    const calls = extraction.refs.filter((r) => r.kind === 'calls' && r.fromSymbol === 'render')
    expect(calls.some((r) => r.name === 'serve')).toBe(true)
    expect(calls.some((r) => r.name === 'dn')).toBe(false)
  })

  it('filters common Python builtins out of call refs', () => {
    const calls = extraction.refs.filter((r) => r.kind === 'calls' && r.fromSymbol === 'render')
    expect(calls.some((r) => r.name === 'len')).toBe(false)
    expect(calls.some((r) => r.name === 'print')).toBe(false)
  })
})

describe.skipIf(canLoadWasm)('extractPython (wasm unavailable)', () => {
  it('documents that grammar loading is blocked in this environment', () => {
    expect(canLoadWasm).toBe(false)
  })
})
