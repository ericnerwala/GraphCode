import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { rmSync } from 'node:fs'
import type { GraphStore } from '../../src/graph/store.js'
import { resolveSymbol } from '../../src/query/locate.js'
import { insertSymbol, makeTempStore } from './fixtures.js'

describe('resolveSymbol', () => {
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

  it('resolves an exact name match', () => {
    const repo = store.upsertRepo('demo', '/tmp/demo')
    insertSymbol(store, repo.id, { name: 'Foo', filePath: 'src/foo.ts' })
    const result = resolveSymbol(store, 'Foo')
    expect(result.node?.name).toBe('Foo')
  })

  it('resolves a qualified name match', () => {
    const repo = store.upsertRepo('demo', '/tmp/demo')
    store.insertNode(repo.id, { kind: 'symbol', name: 'bar', qualifiedName: 'pkg/Foo.bar', filePath: 'src/foo.ts' })
    const result = resolveSymbol(store, 'pkg/Foo.bar')
    expect(result.node?.qualifiedName).toBe('pkg/Foo.bar')
  })

  it('falls back to FTS search when no exact match exists', () => {
    const repo = store.upsertRepo('demo', '/tmp/demo')
    insertSymbol(store, repo.id, { name: 'MonotonicClock', filePath: 'src/clock.ts' })
    const result = resolveSymbol(store, 'monotonic clock')
    expect(result.node?.name).toBe('MonotonicClock')
  })

  it('falls back to file path match', () => {
    const repo = store.upsertRepo('demo', '/tmp/demo')
    store.insertNode(repo.id, { kind: 'file', name: 'clock.ts', filePath: 'src/core/clock.ts' })
    const result = resolveSymbol(store, 'src/core/clock.ts')
    expect(result.node?.filePath).toBe('src/core/clock.ts')
  })

  it('matches a file path by suffix', () => {
    const repo = store.upsertRepo('demo', '/tmp/demo')
    store.insertNode(repo.id, { kind: 'file', name: 'clock.ts', filePath: 'src/core/clock.ts' })
    const result = resolveSymbol(store, 'clock.ts')
    expect(result.node?.filePath).toBe('src/core/clock.ts')
  })

  it('returns null with no alternatives when nothing matches', () => {
    store.upsertRepo('demo', '/tmp/demo')
    const result = resolveSymbol(store, 'DoesNotExist')
    expect(result.node).toBeNull()
    expect(result.alternatives).toHaveLength(0)
  })

  it('returns empty result for blank input', () => {
    const result = resolveSymbol(store, '   ')
    expect(result.node).toBeNull()
  })

  it('prefers exported symbols over non-exported when multiple exact matches exist', () => {
    const repo = store.upsertRepo('demo', '/tmp/demo')
    store.insertNode(repo.id, { kind: 'symbol', name: 'Dup', filePath: 'a.ts', exported: false })
    store.insertNode(repo.id, { kind: 'symbol', name: 'Dup', filePath: 'b.ts', exported: true })
    const result = resolveSymbol(store, 'Dup')
    expect(result.node?.filePath).toBe('b.ts')
    expect(result.alternatives).toHaveLength(1)
  })

  it('resolves gracefully to not-found for a very long query instead of throwing', () => {
    store.upsertRepo('demo', '/tmp/demo')
    const longQuery = 'x'.repeat(5000)
    expect(() => resolveSymbol(store, longQuery)).not.toThrow()
    const result = resolveSymbol(store, longQuery)
    expect(result.node).toBeNull()
  })

  it('treats a store.raw() error on the file-path LIKE tier as no-match rather than throwing', () => {
    store.upsertRepo('demo', '/tmp/demo')
    // Simulates a SQLite build that throws on an oversized LIKE pattern —
    // reproduces the crash deterministically regardless of the local
    // SQLite build's own length limits.
    const original = store.raw.bind(store)
    store.raw = ((sql: string, params?: readonly unknown[]) => {
      if (sql.includes('LIKE')) throw new Error('simulated SQLite LIKE pattern too long')
      return original(sql, params as never)
    }) as typeof store.raw

    const longQuery = 'x'.repeat(5000)
    expect(() => resolveSymbol(store, longQuery)).not.toThrow()
    expect(resolveSymbol(store, longQuery).node).toBeNull()
  })
})
