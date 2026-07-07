import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GraphStore } from '../../src/graph/store.js'
import {
  collectIndexedSymbols,
  insertFileGraph,
  parseFiles,
  reresolvePendingRefs,
  reresolvePendingRefsForNames,
  resolveFileEdges,
} from '../../src/index/indexer.js'
import type { IndexedSymbolRef } from '../../src/index/resolve.js'

describe('reresolvePendingRefsForNames', () => {
  let dbDir: string
  let store: GraphStore
  let repoId: number
  let fooId: number
  let barId: number
  let src1: number
  let src2: number
  let indexedSymbols: IndexedSymbolRef[]

  beforeEach(() => {
    dbDir = mkdtempSync(join(tmpdir(), 'graphcode-reresolve-scoped-'))
    store = GraphStore.open(join(dbDir, 'graph.db'))
    const repo = store.upsertRepo('r', '/tmp/fake-root')
    repoId = repo.id

    // Resolution targets.
    fooId = store.insertNode(repoId, {
      kind: 'symbol',
      subkind: 'class',
      name: 'Foo',
      qualifiedName: 'Foo',
      filePath: 'src/foo.ts',
    })
    barId = store.insertNode(repoId, {
      kind: 'symbol',
      subkind: 'class',
      name: 'Bar',
      qualifiedName: 'Bar',
      filePath: 'src/bar.ts',
    })

    // Pending-ref sources, in a different file from the targets.
    src1 = store.insertNode(repoId, {
      kind: 'symbol',
      subkind: 'function',
      name: 'useFoo',
      qualifiedName: 'useFoo',
      filePath: 'src/consumer.ts',
    })
    src2 = store.insertNode(repoId, {
      kind: 'symbol',
      subkind: 'function',
      name: 'useBar',
      qualifiedName: 'useBar',
      filePath: 'src/consumer.ts',
    })

    store.addPendingRef(repoId, { srcNode: src1, name: 'Foo', kind: 'references' })
    store.addPendingRef(repoId, { srcNode: src2, name: 'Bar', kind: 'references' })

    indexedSymbols = [
      { nodeId: fooId, name: 'Foo', filePath: 'src/foo.ts', kind: 'class', qualifiedName: 'Foo' },
      { nodeId: barId, name: 'Bar', filePath: 'src/bar.ts', kind: 'class', qualifiedName: 'Bar' },
    ]
  })

  afterEach(() => {
    store.close()
    rmSync(dbDir, { recursive: true, force: true })
  })

  it('resolves only the pending refs matching the given names, leaving others untouched', () => {
    const resolved = reresolvePendingRefsForNames(store, repoId, ['Foo'], indexedSymbols)
    expect(resolved).toBe(1)

    // The Foo pending ref should now be a real edge.
    const neighbors = store.neighbors(src1, { direction: 'out', kinds: ['references'] })
    expect(neighbors.some((n) => n.node.id === fooId)).toBe(true)

    // The Bar pending ref must still exist untouched — proving name-scoping.
    const barPending = store.raw('SELECT * FROM pending_refs WHERE repo_id = ? AND name = ?', [repoId, 'Bar'])
    expect(barPending.length).toBe(1)

    // And Foo's pending row should be gone (cleared after resolution).
    const fooPending = store.raw('SELECT * FROM pending_refs WHERE repo_id = ? AND name = ?', [repoId, 'Foo'])
    expect(fooPending.length).toBe(0)
  })

  it('returns 0 and is a no-op when given an empty names array', () => {
    const resolved = reresolvePendingRefsForNames(store, repoId, [], indexedSymbols)
    expect(resolved).toBe(0)

    // Neither pending ref should have been touched.
    const fooPending = store.raw('SELECT * FROM pending_refs WHERE repo_id = ? AND name = ?', [repoId, 'Foo'])
    const barPending = store.raw('SELECT * FROM pending_refs WHERE repo_id = ? AND name = ?', [repoId, 'Bar'])
    expect(fooPending.length).toBe(1)
    expect(barPending.length).toBe(1)
  })

  it('returns 0 for a name with no pending row', () => {
    const resolved = reresolvePendingRefsForNames(store, repoId, ['NoSuchName'], indexedSymbols)
    expect(resolved).toBe(0)

    // Existing pending refs remain untouched.
    const fooPending = store.raw('SELECT * FROM pending_refs WHERE repo_id = ? AND name = ?', [repoId, 'Foo'])
    const barPending = store.raw('SELECT * FROM pending_refs WHERE repo_id = ? AND name = ?', [repoId, 'Bar'])
    expect(fooPending.length).toBe(1)
    expect(barPending.length).toBe(1)
  })

  it('exposes the widened indexer exports as functions (guards against re-privatization)', () => {
    expect(typeof parseFiles).toBe('function')
    expect(typeof insertFileGraph).toBe('function')
    expect(typeof collectIndexedSymbols).toBe('function')
    expect(typeof resolveFileEdges).toBe('function')
    expect(typeof reresolvePendingRefs).toBe('function')
    expect(typeof reresolvePendingRefsForNames).toBe('function')
  })
})
