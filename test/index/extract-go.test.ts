import { beforeAll, describe, expect, it } from 'vitest'
import { getParserFor, initParsers } from '../../src/index/parser.js'
import { languageForPath } from '../../src/index/languages.js'
import { extractGo } from '../../src/index/extractors/go.js'
import { wasmGrammarsLoad } from './helpers/wasm-support.js'

const SOURCE = `
package widget

import (
	"fmt"
	"example.com/base"
	"example.com/namenode"
)

type Widget struct {
	base.Embedded
	Label string
}

type Shape interface {
	Area() float64
}

const MaxSize = 100

func NewWidget(label string) *Widget {
	return &Widget{Label: label}
}

func (w *Widget) Render() {
	fmt.Println(w.Label)
	helper(w.Label)
}

func run() {
	nn := namenode.New(namenode.Config{})
	nn.Serve()
	items := append([]string{}, "a")
	_ = items
}

func makeWidget() *Widget {
	return &Widget{Label: "x"}
}
`

const canLoadWasm = await wasmGrammarsLoad()

describe.skipIf(!canLoadWasm)('extractGo', () => {
  let extraction: ReturnType<typeof extractGo>

  beforeAll(async () => {
    await initParsers()
    const def = languageForPath('widget.go')
    if (!def) throw new Error('no language def for .go')
    const parser = await getParserFor(def)
    const tree = parser.parse(SOURCE)
    if (!tree) throw new Error('parse failed')
    extraction = extractGo(tree)
  })

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
    const byName = new Map(extraction.symbols.map((s) => [s.name, s]))
    expect(byName.get('MaxSize')?.kind).toBe('constant')
  })

  it('extracts imports', () => {
    const raws = extraction.imports.map((i) => i.raw)
    expect(raws).toContain('fmt')
    expect(raws).toContain('example.com/base')
  })

  it('extracts embedded type refs on struct as extends', () => {
    const embedded = extraction.refs.find((r) => r.kind === 'extends' && r.fromSymbol === 'Widget')
    expect(embedded?.name).toBe('Embedded')
  })

  it('extracts call refs within method bodies', () => {
    const call = extraction.refs.find((r) => r.kind === 'calls' && r.fromSymbol === 'Render' && r.name === 'helper')
    expect(call).toBeDefined()
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
    const ref = extraction.refs.find((r) => r.kind === 'references' && r.fromSymbol === 'makeWidget' && r.name === 'Widget')
    expect(ref).toBeDefined()
  })
})

describe.skipIf(canLoadWasm)('extractGo (wasm unavailable)', () => {
  it('documents that grammar loading is blocked in this environment', () => {
    expect(canLoadWasm).toBe(false)
  })
})
