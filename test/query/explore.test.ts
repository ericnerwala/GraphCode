import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { rmSync } from 'node:fs'
import type { GraphStore } from '../../src/graph/store.js'
import { explore } from '../../src/query/explore.js'
import { insertSymbol, makeTempStore, writeFixtureFile } from './fixtures.js'

describe('explore', () => {
  let dir: string
  let store: GraphStore

  beforeEach(() => {
    const t = makeTempStore()
    dir = t.dir
    store = t.store
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('finds a path across 3 symbols and inlines their source', () => {
    const repo = store.upsertRepo('demo', '/tmp/demo')

    writeFixtureFile(
      dir,
      'src/handler.ts',
      ['export function handleRequest() {', '  return parseInput()', '}', ''].join('\n'),
    )
    writeFixtureFile(
      dir,
      'src/parser.ts',
      ['export function parseInput() {', '  return validate()', '}', ''].join('\n'),
    )
    writeFixtureFile(dir, 'src/validator.ts', ['export function validate() {', '  return true', '}', ''].join('\n'))

    const handleRequest = insertSymbol(store, repo.id, {
      name: 'handleRequest',
      filePath: 'src/handler.ts',
      startLine: 1,
      endLine: 3,
    }).symbolId
    const parseInput = insertSymbol(store, repo.id, {
      name: 'parseInput',
      filePath: 'src/parser.ts',
      startLine: 1,
      endLine: 3,
    }).symbolId
    const validate = insertSymbol(store, repo.id, {
      name: 'validate',
      filePath: 'src/validator.ts',
      startLine: 1,
      endLine: 3,
    }).symbolId

    store.insertEdge(repo.id, { src: handleRequest, dst: parseInput, kind: 'calls' })
    store.insertEdge(repo.id, { src: parseInput, dst: validate, kind: 'calls' })

    const result = explore(store, dir, ['handleRequest', 'parseInput', 'validate'])

    expect(result.resolved.handleRequest?.node?.name).toBe('handleRequest')
    expect(result.resolved.parseInput?.node?.name).toBe('parseInput')
    expect(result.resolved.validate?.node?.name).toBe('validate')

    expect(result.paths).toHaveLength(2)
    expect(result.paths[0]?.found).toBe(true)
    expect(result.paths[0]?.edges).toHaveLength(1)
    expect(result.paths[0]?.edges[0]?.kind).toBe('calls')
    expect(result.paths[1]?.found).toBe(true)

    const bySymbol = Object.fromEntries(result.symbols.map((s) => [s.node.name, s]))
    expect(bySymbol.handleRequest?.source).toContain('handleRequest')
    expect(bySymbol.parseInput?.source).toContain('parseInput')
    expect(bySymbol.validate?.source).toContain('validate')
    expect(bySymbol.handleRequest?.truncated).toBe(false)
  })

  it('marks a path as not found when nodes are disconnected within maxHops', () => {
    const repo = store.upsertRepo('demo', '/tmp/demo')
    writeFixtureFile(dir, 'src/a.ts', 'export function a() {}\n')
    writeFixtureFile(dir, 'src/z.ts', 'export function z() {}\n')
    insertSymbol(store, repo.id, { name: 'a', filePath: 'src/a.ts' })
    insertSymbol(store, repo.id, { name: 'z', filePath: 'src/z.ts' })

    const result = explore(store, dir, ['a', 'z'], { maxHops: 4 })
    expect(result.paths[0]?.found).toBe(false)
    expect(result.paths[0]?.edges).toHaveLength(0)
  })

  it('marks a path as not found when a name does not resolve at all', () => {
    const repo = store.upsertRepo('demo', '/tmp/demo')
    insertSymbol(store, repo.id, { name: 'a', filePath: 'src/a.ts' })
    const result = explore(store, dir, ['a', 'NoSuchSymbol'])
    expect(result.resolved.NoSuchSymbol?.node).toBeNull()
    expect(result.paths[0]?.found).toBe(false)
  })

  it('clamps inlined snippets to the configured max lines', () => {
    const repo = store.upsertRepo('demo', '/tmp/demo')
    const longBody = Array.from({ length: 200 }, (_, i) => `  line${i}()`).join('\n')
    writeFixtureFile(dir, 'src/long.ts', `export function longFn() {\n${longBody}\n}\n`)
    insertSymbol(store, repo.id, { name: 'longFn', filePath: 'src/long.ts', startLine: 1, endLine: 202 })

    const result = explore(store, dir, ['longFn'], { maxSnippetLines: 120 })
    const symbol = result.symbols.find((s) => s.node.name === 'longFn')
    expect(symbol?.truncated).toBe(true)
    expect(symbol?.source?.split('\n')).toHaveLength(120)
  })

  it('handles a missing source file gracefully (no throw, source undefined)', () => {
    const repo = store.upsertRepo('demo', '/tmp/demo')
    insertSymbol(store, repo.id, { name: 'ghost', filePath: 'src/does-not-exist.ts' })
    const result = explore(store, dir, ['ghost'])
    const symbol = result.symbols.find((s) => s.node.name === 'ghost')
    expect(symbol?.source).toBeUndefined()
  })

  it('omits the source for a symbol whose filePath escapes root, without throwing', () => {
    const repo = store.upsertRepo('demo', '/tmp/demo')
    // A real file just outside root (its parent dir) — a "../secret.txt"
    // filePath (e.g. from a corrupted index entry) resolves there and must
    // be blocked, not silently read and inlined, and must not crash explore().
    const secretPath = join(dir, '..', `explore-secret-${basename(dir)}.txt`)
    writeFileSync(secretPath, 'super-secret-contents', 'utf8')
    try {
      insertSymbol(store, repo.id, { name: 'escapee', filePath: `../explore-secret-${basename(dir)}.txt` })
      expect(() => explore(store, dir, ['escapee'])).not.toThrow()
      const result = explore(store, dir, ['escapee'])
      const symbol = result.symbols.find((s) => s.node.name === 'escapee')
      expect(symbol?.source).toBeUndefined()
    } finally {
      rmSync(secretPath, { force: true })
    }
  })

  it('finds an undirected path across imports/contains/references edge kinds too', () => {
    const repo = store.upsertRepo('demo', '/tmp/demo')
    writeFixtureFile(dir, 'src/one.ts', 'export const one = 1\n')
    writeFixtureFile(dir, 'src/two.ts', 'export const two = 2\n')
    const oneFile = store.insertNode(repo.id, { kind: 'file', name: 'one.ts', filePath: 'src/one.ts' })
    const twoFile = store.insertNode(repo.id, { kind: 'file', name: 'two.ts', filePath: 'src/two.ts' })
    const oneSym = insertSymbol(store, repo.id, { name: 'one', filePath: 'src/one.ts' }).symbolId
    const twoSym = insertSymbol(store, repo.id, { name: 'two', filePath: 'src/two.ts' }).symbolId
    store.insertEdge(repo.id, { src: twoFile, dst: oneFile, kind: 'imports' })

    const result = explore(store, dir, ['one', 'two'])
    // one -> file(one) -> file(two) -> two, all within 4 hops via contains+imports
    expect(result.paths[0]?.found).toBe(true)
    const kinds = result.paths[0]?.edges.map((e) => e.kind)
    expect(kinds).toContain('imports')
    void oneSym
    void twoSym
  })
})
