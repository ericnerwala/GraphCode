import { beforeAll, describe, expect, it } from 'vitest'
import { getParserFor, initParsers } from '../../src/index/parser.js'
import { languageForPath } from '../../src/index/languages.js'
import { extractJava } from '../../src/index/extractors/java.js'
import { wasmGrammarsLoad } from './helpers/wasm-support.js'

const SOURCE = `
package com.example;

import com.example.base.Base;
import com.example.util.Helper;
import com.example.wild.*;
import static com.example.util.StaticHelper.assistStatically;

public class Widget extends Base implements Shape {
    private int count;

    public void render() {
        count++;
        Helper.assist(count);
        new Helper();
    }
}

interface Shape {
    double area();
}
`

const canLoadWasm = await wasmGrammarsLoad()

describe.skipIf(!canLoadWasm)('extractJava', () => {
  let extraction: ReturnType<typeof extractJava>

  beforeAll(async () => {
    await initParsers()
    const def = languageForPath('Widget.java')
    if (!def) throw new Error('no language def for .java')
    const parser = await getParserFor(def)
    const tree = parser.parse(SOURCE)
    if (!tree) throw new Error('parse failed')
    extraction = extractJava(tree)
  })

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

  it('marks public members as exported', () => {
    const widget = extraction.symbols.find((s) => s.name === 'Widget')
    const render = extraction.symbols.find((s) => s.name === 'render')
    expect(widget?.exported).toBe(true)
    expect(render?.exported).toBe(true)
  })

  it('extracts imports', () => {
    const raws = extraction.imports.map((i) => i.raw)
    expect(raws).toContain('com.example.base.Base')
    expect(raws).toContain('com.example.util.Helper')
  })

  it('extracts the package declaration', () => {
    expect(extraction.packageName).toBe('com.example')
  })

  it('marks wildcard imports with a trailing .*', () => {
    expect(extraction.imports.map((i) => i.raw)).toContain('com.example.wild.*')
  })

  it('skips static imports rather than mis-resolving them', () => {
    const raws = extraction.imports.map((i) => i.raw)
    expect(raws.some((r) => r.includes('StaticHelper'))).toBe(false)
  })

  it('extracts extends and implements refs', () => {
    const extendsRef = extraction.refs.find((r) => r.kind === 'extends' && r.fromSymbol === 'Widget')
    const implementsRef = extraction.refs.find((r) => r.kind === 'implements' && r.fromSymbol === 'Widget')
    expect(extendsRef?.name).toBe('Base')
    expect(implementsRef?.name).toBe('Shape')
  })

  it('extracts method_invocation and object_creation refs', () => {
    const call = extraction.refs.find((r) => r.kind === 'calls' && r.fromSymbol === 'render' && r.name === 'assist')
    const creation = extraction.refs.find((r) => r.kind === 'calls' && r.fromSymbol === 'render' && r.name === 'Helper')
    expect(call).toBeDefined()
    expect(creation).toBeDefined()
  })
})

describe.skipIf(canLoadWasm)('extractJava (wasm unavailable)', () => {
  it('documents that grammar loading is blocked in this environment', () => {
    expect(canLoadWasm).toBe(false)
  })
})
