import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GraphStore, toFtsQuery } from '../src/graph/store.js'

describe('GraphStore', () => {
  let dir: string
  let store: GraphStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'graphcode-store-'))
    store = GraphStore.open(join(dir, 'graph.db'))
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('creates and retrieves repos idempotently', () => {
    const repo = store.upsertRepo('demo', '/tmp/demo')
    const again = store.upsertRepo('demo-renamed', '/tmp/demo')
    expect(again.id).toBe(repo.id)
    expect(again.name).toBe('demo-renamed')
    expect(store.listRepos()).toHaveLength(1)
  })

  it('inserts nodes and finds them by exact name', () => {
    const repo = store.upsertRepo('demo', '/tmp/demo')
    const id = store.insertNode(repo.id, {
      kind: 'symbol',
      subkind: 'class',
      name: 'MonotonicClock',
      qualifiedName: 'core/MonotonicClock',
      filePath: 'src/core/clock.ts',
      startLine: 10,
      endLine: 42,
      language: 'typescript',
      exported: true,
    })
    const node = store.getNode(id)
    expect(node?.name).toBe('MonotonicClock')
    expect(node?.exported).toBe(true)
    expect(store.findNodesByName('MonotonicClock')).toHaveLength(1)
    expect(store.findNodesByName('core/MonotonicClock')).toHaveLength(1)
  })

  it('finds camelCase symbols via multi-word FTS search', () => {
    const repo = store.upsertRepo('demo', '/tmp/demo')
    store.insertNode(repo.id, { kind: 'symbol', subkind: 'class', name: 'MonotonicClock' })
    store.insertNode(repo.id, { kind: 'symbol', subkind: 'function', name: 'unrelatedThing' })
    const hits = store.search('monotonic clock')
    expect(hits.length).toBeGreaterThanOrEqual(1)
    expect(hits[0]?.node.name).toBe('MonotonicClock')
  })

  it('stores edges with upsert semantics and walks neighbors', () => {
    const repo = store.upsertRepo('demo', '/tmp/demo')
    const caller = store.insertNode(repo.id, { kind: 'symbol', name: 'main' })
    const callee = store.insertNode(repo.id, { kind: 'symbol', name: 'helper' })
    store.insertEdge(repo.id, { src: caller, dst: callee, kind: 'calls' })
    store.insertEdge(repo.id, { src: caller, dst: callee, kind: 'calls', weight: 3 })
    const out = store.neighbors(caller, { direction: 'out' })
    expect(out).toHaveLength(1)
    expect(out[0]?.node.name).toBe('helper')
    expect(out[0]?.edge.weight).toBe(3)
    const incoming = store.neighbors(callee, { direction: 'in', kinds: ['calls'] })
    expect(incoming).toHaveLength(1)
    expect(incoming[0]?.node.name).toBe('main')
  })

  it('deletes a file subgraph including edges, FTS rows, and pending refs', () => {
    const repo = store.upsertRepo('demo', '/tmp/demo')
    const fileNode = store.insertNode(repo.id, { kind: 'file', name: 'a.ts', filePath: 'a.ts' })
    const symbol = store.insertNode(repo.id, {
      kind: 'symbol',
      name: 'doWork',
      filePath: 'a.ts',
    })
    const other = store.insertNode(repo.id, { kind: 'file', name: 'b.ts', filePath: 'b.ts' })
    store.insertEdge(repo.id, { src: fileNode, dst: symbol, kind: 'contains' })
    store.insertEdge(repo.id, { src: other, dst: fileNode, kind: 'imports' })
    store.addPendingRef(repo.id, { srcNode: symbol, name: 'External', kind: 'calls' })

    store.deleteFileGraph(repo.id, 'a.ts')

    expect(store.getNode(fileNode)).toBeNull()
    expect(store.getNode(symbol)).toBeNull()
    expect(store.getNode(other)).not.toBeNull()
    expect(store.neighbors(other, { direction: 'out' })).toHaveLength(0)
    expect(store.search('doWork')).toHaveLength(0)
    expect(store.pendingRefsByName(repo.id, 'External')).toHaveLength(0)
  })

  it('tracks file states for incremental sync', () => {
    const repo = store.upsertRepo('demo', '/tmp/demo')
    store.upsertFileState(repo.id, { path: 'a.ts', hash: 'h1', size: 10, mtime: 1 })
    store.upsertFileState(repo.id, { path: 'a.ts', hash: 'h2', size: 12, mtime: 2 })
    const states = store.getFileStates(repo.id)
    expect(states.size).toBe(1)
    expect(states.get('a.ts')?.hash).toBe('h2')
    store.deleteFileState(repo.id, 'a.ts')
    expect(store.getFileStates(repo.id).size).toBe(0)
  })

  it('rolls back a failed transaction atomically', () => {
    const repo = store.upsertRepo('demo', '/tmp/demo')
    expect(() =>
      store.transaction(() => {
        store.insertNode(repo.id, { kind: 'symbol', name: 'ghost' })
        throw new Error('boom')
      }),
    ).toThrow('boom')
    expect(store.findNodesByName('ghost')).toHaveLength(0)
  })

  it('computes stats across node kinds', () => {
    const repo = store.upsertRepo('demo', '/tmp/demo')
    const file = store.insertNode(repo.id, { kind: 'file', name: 'a.ts', filePath: 'a.ts', language: 'typescript' })
    const symbol = store.insertNode(repo.id, { kind: 'symbol', name: 'fn', filePath: 'a.ts' })
    store.insertNode(repo.id, { kind: 'commit', name: 'abc1234' })
    store.insertEdge(repo.id, { src: file, dst: symbol, kind: 'contains' })
    const stats = store.stats()
    expect(stats.files).toBe(1)
    expect(stats.symbols).toBe(1)
    expect(stats.commits).toBe(1)
    expect(stats.edges).toBe(1)
    expect(stats.edgesByKind.contains).toBe(1)
    expect(stats.languages.typescript).toBe(1)
  })
})

describe('toFtsQuery', () => {
  it('splits identifiers and quotes terms', () => {
    const query = toFtsQuery('MonotonicClock.now()')
    expect(query).toContain('"monotonicclock"*')
    expect(query).toContain('"monotonic"*')
    expect(query).toContain('"clock"*')
    expect(query).toContain('"now"*')
  })

  it('handles empty input safely', () => {
    expect(toFtsQuery('...')).toBe('""')
  })
})
