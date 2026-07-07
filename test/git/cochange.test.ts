import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GraphStore } from '../../src/graph/store.js'
import { applyCochangePairs, mineCochangePairs, type CochangePair } from '../../src/git/cochange.js'
import type { ParsedCommit } from '../../src/git/log-parser.js'

function commit(files: string[], overrides: Partial<ParsedCommit> = {}): ParsedCommit {
  return {
    sha: overrides.sha ?? Math.random().toString(36).slice(2),
    author: 'Test User',
    email: 'test@example.com',
    ts: 1,
    subject: 'test commit',
    files: files.map((path) => ({ path, insertions: 1, deletions: 0 })),
    ...overrides,
  }
}

describe('mineCochangePairs', () => {
  it('finds a pair that meets support and confidence thresholds', () => {
    const commits: ParsedCommit[] = [
      commit(['a.ts', 'b.ts']),
      commit(['a.ts', 'b.ts']),
      commit(['a.ts', 'b.ts']),
    ]
    const pairs = mineCochangePairs(commits)
    expect(pairs).toHaveLength(1)
    expect(pairs[0]).toMatchObject({ fileA: 'a.ts', fileB: 'b.ts', support: 3, confidence: 1 })
  })

  it('drops pairs below the support threshold', () => {
    const commits: ParsedCommit[] = [commit(['a.ts', 'b.ts']), commit(['a.ts', 'b.ts'])]
    expect(mineCochangePairs(commits)).toHaveLength(0)
  })

  it('drops pairs below the confidence threshold even with enough support', () => {
    const commits: ParsedCommit[] = [
      commit(['a.ts', 'b.ts']),
      commit(['a.ts', 'b.ts']),
      commit(['a.ts', 'b.ts']),
      // Both files also change alone many more times, so support (3) stays
      // fixed while min(count(a), count(b)) grows well past 3 / 0.4 = 7.5,
      // tanking confidence below the 0.4 threshold.
      commit(['a.ts']),
      commit(['a.ts']),
      commit(['a.ts']),
      commit(['a.ts']),
      commit(['a.ts']),
      commit(['b.ts']),
      commit(['b.ts']),
      commit(['b.ts']),
      commit(['b.ts']),
      commit(['b.ts']),
    ]
    const pairs = mineCochangePairs(commits)
    expect(pairs).toHaveLength(0)
  })

  it('skips commits touching more than 30 files (bulk rename poison)', () => {
    const bulkFiles = Array.from({ length: 35 }, (_, i) => `f${i}.ts`)
    const commits: ParsedCommit[] = [
      commit(bulkFiles),
      commit(['a.ts', 'b.ts']),
      commit(['a.ts', 'b.ts']),
      commit(['a.ts', 'b.ts']),
    ]
    const pairs = mineCochangePairs(commits)
    expect(pairs).toHaveLength(1)
    expect(pairs[0]?.fileA).toBe('a.ts')
  })

  it('caps results at 5000 pairs by support', () => {
    const commits: ParsedCommit[] = []
    for (let i = 0; i < 5100; i++) {
      commits.push(commit([`file${i}_a.ts`, `file${i}_b.ts`]))
      commits.push(commit([`file${i}_a.ts`, `file${i}_b.ts`]))
      commits.push(commit([`file${i}_a.ts`, `file${i}_b.ts`]))
    }
    const pairs = mineCochangePairs(commits)
    expect(pairs.length).toBeLessThanOrEqual(5000)
  })
})

describe('applyCochangePairs', () => {
  let dir: string
  let store: GraphStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'graphcode-cochange-'))
    store = GraphStore.open(join(dir, 'graph.db'))
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('inserts one co_change edge per pair with src as the lower node id', () => {
    const repo = store.upsertRepo('demo', '/tmp/demo')
    const nodeB = store.insertNode(repo.id, { kind: 'file', name: 'b.ts', filePath: 'b.ts' })
    const nodeA = store.insertNode(repo.id, { kind: 'file', name: 'a.ts', filePath: 'a.ts' })
    // nodeB has the lower id since it was inserted first.
    const pairs: CochangePair[] = [{ fileA: 'a.ts', fileB: 'b.ts', support: 3, confidence: 0.75 }]

    const result = applyCochangePairs(store, repo, pairs)
    expect(result.cochangeEdges).toBe(1)

    const outgoing = store.neighbors(nodeB, { direction: 'out', kinds: ['co_change'] })
    expect(outgoing).toHaveLength(1)
    expect(outgoing[0]?.node.id).toBe(nodeA)
    expect(outgoing[0]?.edge.weight).toBe(0.75)
    expect(outgoing[0]?.edge.meta?.support).toBe(3)

    // neighbors() must find the edge from either side.
    const incoming = store.neighbors(nodeA, { direction: 'in', kinds: ['co_change'] })
    expect(incoming).toHaveLength(1)
  })

  it('skips pairs where a file node does not exist in the graph', () => {
    const repo = store.upsertRepo('demo', '/tmp/demo')
    store.insertNode(repo.id, { kind: 'file', name: 'a.ts', filePath: 'a.ts' })
    const pairs: CochangePair[] = [{ fileA: 'a.ts', fileB: 'missing.ts', support: 3, confidence: 0.5 }]
    const result = applyCochangePairs(store, repo, pairs)
    expect(result.cochangeEdges).toBe(0)
  })
})
