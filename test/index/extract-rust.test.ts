import { beforeAll, describe, expect, it } from 'vitest'
import { getParserFor, initParsers } from '../../src/index/parser.js'
import { languageForPath } from '../../src/index/languages.js'
import { extractRust } from '../../src/index/extractors/rust.js'
import { wasmGrammarsLoad } from './helpers/wasm-support.js'

const SOURCE = `
use std::fmt;
use crate::base::Base;

pub struct Widget {
    pub label: String,
}

pub enum Shape {
    Circle,
    Square,
}

pub trait Renderer {
    fn render(&self);
}

impl Renderer for Widget {
    fn render(&self) {
        helper(&self.label);
    }
}

impl Widget {
    pub fn new(label: String) -> Self {
        Widget { label }
    }
}

mod util {
    pub fn helper() {}
}
`

const canLoadWasm = await wasmGrammarsLoad()

describe.skipIf(!canLoadWasm)('extractRust', () => {
  let extraction: ReturnType<typeof extractRust>

  beforeAll(async () => {
    await initParsers()
    const def = languageForPath('widget.rs')
    if (!def) throw new Error('no language def for .rs')
    const parser = await getParserFor(def)
    const tree = parser.parse(SOURCE)
    if (!tree) throw new Error('parse failed')
    extraction = extractRust(tree)
  })

  it('extracts struct, enum, and trait decls', () => {
    // Widget also has 'impl' symbols (same name, different kind) from the impl
    // blocks below, so disambiguate by kind rather than by name alone — same
    // convention used in extract-rust-fake.test.ts.
    expect(extraction.symbols.find((s) => s.name === 'Widget' && s.kind === 'struct')).toBeDefined()
    const byName = new Map(extraction.symbols.map((s) => [s.name, s]))
    expect(byName.get('Shape')?.kind).toBe('enum')
    expect(byName.get('Renderer')?.kind).toBe('trait')
  })

  it('extracts impl blocks with methods', () => {
    const methods = extraction.symbols.filter((s) => s.kind === 'method' && s.parentName === 'Widget')
    expect(methods.map((m) => m.name).sort()).toEqual(['new', 'render'])
  })

  it('extracts mod declarations', () => {
    const mod = extraction.symbols.find((s) => s.name === 'util')
    expect(mod?.kind).toBe('module')
  })

  it('extracts use decls', () => {
    const raws = extraction.imports.map((i) => i.raw)
    expect(raws.some((r) => r.includes('fmt'))).toBe(true)
    expect(raws.some((r) => r.includes('Base'))).toBe(true)
  })

  it('extracts trait impl refs as implements', () => {
    const impl = extraction.refs.find((r) => r.kind === 'implements' && r.fromSymbol === 'Widget')
    expect(impl?.name).toBe('Renderer')
  })

  it('extracts call refs within method bodies', () => {
    const call = extraction.refs.find((r) => r.kind === 'calls' && r.fromSymbol === 'render' && r.name === 'helper')
    expect(call).toBeDefined()
  })
})

describe.skipIf(canLoadWasm)('extractRust (wasm unavailable)', () => {
  it('documents that grammar loading is blocked in this environment', () => {
    expect(canLoadWasm).toBe(false)
  })
})
