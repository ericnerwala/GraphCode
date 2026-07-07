import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { rmSync } from 'node:fs'
import type { GraphStore } from '../../src/graph/store.js'
import { impactAnalysis } from '../../src/query/impact.js'
import { buildDiamondGraph, insertSymbol, makeTempStore } from './fixtures.js'

describe('impactAnalysis on a diamond call graph', () => {
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

  it('finds direct callers of bottom as depth-1 direct hits', () => {
    const { bottom } = buildDiamondGraph(store)
    const target = store.getNode(bottom)
    if (!target) throw new Error('missing node')
    const result = impactAnalysis(store, dir, target, { depth: 3 })
    const files = result.files.map((f) => f.filePath).sort()
    expect(files).toEqual(['a.ts', 'b.ts', 'c.ts'])
    const b = result.files.find((f) => f.filePath === 'b.ts')
    const c = result.files.find((f) => f.filePath === 'c.ts')
    expect(b?.direct).toBe(true)
    expect(b?.minDepth).toBe(1)
    expect(c?.direct).toBe(true)
  })

  it('finds top (a.ts) at depth 2 with hop-decay score lower than direct callers', () => {
    const { bottom } = buildDiamondGraph(store)
    const target = store.getNode(bottom)
    if (!target) throw new Error('missing node')
    const result = impactAnalysis(store, dir, target, { depth: 3 })
    const a = result.files.find((f) => f.filePath === 'a.ts')
    const b = result.files.find((f) => f.filePath === 'b.ts')
    expect(a?.minDepth).toBe(2)
    expect(a?.direct).toBe(false)
    expect(a && b && a.maxScore < b.maxScore).toBe(true)
  })

  it('excludes the target file itself from results', () => {
    const { bottom } = buildDiamondGraph(store)
    const target = store.getNode(bottom)
    if (!target) throw new Error('missing node')
    const result = impactAnalysis(store, dir, target, { depth: 3 })
    expect(result.files.some((f) => f.filePath === 'd.ts')).toBe(false)
  })

  it('respects the depth option (stops expansion early)', () => {
    const { bottom } = buildDiamondGraph(store)
    const target = store.getNode(bottom)
    if (!target) throw new Error('missing node')
    const result = impactAnalysis(store, dir, target, { depth: 1 })
    const files = result.files.map((f) => f.filePath).sort()
    expect(files).toEqual(['b.ts', 'c.ts'])
  })

  it('respects the limit option', () => {
    const { bottom } = buildDiamondGraph(store)
    const target = store.getNode(bottom)
    if (!target) throw new Error('missing node')
    const result = impactAnalysis(store, dir, target, { depth: 3, limit: 1 })
    expect(result.files.length).toBeLessThanOrEqual(1)
  })

  it('ranks a dense direct test-file caller below a thinner production caller', () => {
    const repo = store.upsertRepo('demo', '/tmp/demo')
    const target = insertSymbol(store, repo.id, { name: 'Clock', filePath: 'src/core/Clock.ts' }).symbolId
    const targetNode = store.getNode(target)
    if (!targetNode) throw new Error('missing node')

    // A test file with many calling symbols (high density, direct).
    for (let i = 0; i < 10; i++) {
      const { symbolId } = insertSymbol(store, repo.id, { name: `testCaller${i}`, filePath: 'src/core/clock.test.ts' })
      store.insertEdge(repo.id, { src: symbolId, dst: target, kind: 'calls' })
    }
    // A production caller (low density, direct).
    const prod = insertSymbol(store, repo.id, { name: 'useClock', filePath: 'src/core/scheduler.ts' }).symbolId
    store.insertEdge(repo.id, { src: prod, dst: target, kind: 'calls' })

    const result = impactAnalysis(store, dir, targetNode, { depth: 1 })
    expect(result.files[0]?.filePath).toBe('src/core/scheduler.ts')
    expect(result.files.at(-1)?.filePath).toBe('src/core/clock.test.ts')
    expect(result.files.at(-1)?.tier).toBe('test')
  })

  it('includes a co_change section for top files, kept separate from ranked files', () => {
    const repo = store.upsertRepo('demo', '/tmp/demo')
    const target = insertSymbol(store, repo.id, { name: 'Clock', filePath: 'src/core/Clock.ts' }).symbolId
    const targetNode = store.getNode(target)
    if (!targetNode) throw new Error('missing node')

    const callerSymbol = insertSymbol(store, repo.id, { name: 'useClock', filePath: 'src/core/scheduler.ts' }).symbolId
    store.insertEdge(repo.id, { src: callerSymbol, dst: target, kind: 'calls' })

    const otherFile = store.insertNode(repo.id, { kind: 'file', name: 'related.ts', filePath: 'src/core/related.ts' })
    const schedulerFile = store.fileNode(repo.id, 'src/core/scheduler.ts')
    if (!schedulerFile) throw new Error('missing file node')
    store.insertEdge(repo.id, { src: schedulerFile.id, dst: otherFile, kind: 'co_change', weight: 0.8 })

    const result = impactAnalysis(store, dir, targetNode, { depth: 1 })
    expect(result.coChanges).toHaveLength(1)
    expect(result.coChanges[0]?.filePath).toBe('src/core/related.ts')
    expect(result.coChanges[0]?.withFile).toBe('src/core/scheduler.ts')
    expect(result.coChanges[0]?.weight).toBe(0.8)
    // co-changes must not leak into the ranked files list
    expect(result.files.some((f) => f.filePath === 'src/core/related.ts')).toBe(false)
  })

  it('includes a caller that lives in the same file as the target', () => {
    const repo = store.upsertRepo('demo', '/tmp/demo')
    const target = insertSymbol(store, repo.id, { name: 'Clock', filePath: 'src/core/clock.ts' }).symbolId
    const targetNode = store.getNode(target)
    if (!targetNode) throw new Error('missing node')

    // A caller defined in the SAME file as the target — must still be
    // aggregated and returned, not dropped just because it shares a file.
    const sameFileCaller = store.insertNode(repo.id, {
      kind: 'symbol',
      name: 'useClockLocally',
      qualifiedName: 'useClockLocally',
      filePath: 'src/core/clock.ts',
    })
    store.insertEdge(repo.id, { src: sameFileCaller, dst: target, kind: 'calls' })

    const result = impactAnalysis(store, dir, targetNode, { depth: 1 })
    const sameFile = result.files.find((f) => f.filePath === 'src/core/clock.ts')
    expect(sameFile).toBeDefined()
    expect(sameFile?.symbols).toContain('useClockLocally')
    expect(sameFile?.direct).toBe(true)
  })

  it('returns an empty result set for a target with no incoming edges', () => {
    const repo = store.upsertRepo('demo', '/tmp/demo')
    const target = insertSymbol(store, repo.id, { name: 'Lonely', filePath: 'src/lonely.ts' }).symbolId
    const targetNode = store.getNode(target)
    if (!targetNode) throw new Error('missing node')
    const result = impactAnalysis(store, dir, targetNode, { depth: 3 })
    expect(result.files).toHaveLength(0)
    expect(result.coChanges).toHaveLength(0)
  })
})

describe('impactAnalysis seeds from a container symbol\'s members', () => {
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

  it('surfaces callers of a struct\'s methods when impacting the struct itself (no direct callers of the struct)', () => {
    const repo = store.upsertRepo('demo', '/tmp/demo')
    const structId = store.insertNode(repo.id, {
      kind: 'symbol',
      subkind: 'struct',
      name: 'NameNode',
      qualifiedName: 'NameNode',
      filePath: 'internal/namenode/namenode.go',
    })
    const serveId = store.insertNode(repo.id, {
      kind: 'symbol',
      subkind: 'method',
      name: 'Serve',
      qualifiedName: 'NameNode.Serve',
      filePath: 'internal/namenode/namenode.go',
      parentName: 'NameNode',
    })
    store.insertEdge(repo.id, { src: structId, dst: serveId, kind: 'contains' })

    const callerId = insertSymbol(store, repo.id, { name: 'main', filePath: 'cmd/namenode/main.go' }).symbolId
    store.insertEdge(repo.id, { src: callerId, dst: serveId, kind: 'calls' })

    const target = store.getNode(structId)
    if (!target) throw new Error('missing node')
    const result = impactAnalysis(store, dir, target, { depth: 3 })

    expect(result.files.some((f) => f.filePath === 'cmd/namenode/main.go')).toBe(true)
  })

  it('does not expand seeding for non-container subkinds (functions behave as before)', () => {
    const repo = store.upsertRepo('demo', '/tmp/demo')
    const { symbolId: fnId } = insertSymbol(store, repo.id, { name: 'standalone', filePath: 'a.ts' })
    const unrelatedChild = insertSymbol(store, repo.id, { name: 'unrelated', filePath: 'b.ts' }).symbolId
    // Even if a (bogus) contains edge existed, function targets shouldn't seed from it.
    store.insertEdge(repo.id, { src: fnId, dst: unrelatedChild, kind: 'contains' })
    const callerOfChild = insertSymbol(store, repo.id, { name: 'callerOfChild', filePath: 'c.ts' }).symbolId
    store.insertEdge(repo.id, { src: callerOfChild, dst: unrelatedChild, kind: 'calls' })

    const target = store.getNode(fnId)
    if (!target) throw new Error('missing node')
    const result = impactAnalysis(store, dir, target, { depth: 3 })
    expect(result.files.some((f) => f.filePath === 'c.ts')).toBe(false)
  })
})
