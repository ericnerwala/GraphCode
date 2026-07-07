import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GraphcodeConfig } from '../../src/core/config.js'
import { GraphStore } from '../../src/graph/store.js'
import { ingestGitHistory } from '../../src/git/history.js'
import { initRepo, writeAndCommit, renameFile, resetCommitCounter } from './git-test-helpers.js'

function configFor(root: string, overrides: Partial<GraphcodeConfig> = {}): GraphcodeConfig {
  return {
    root,
    graphDir: join(root, '.graphcode'),
    dbPath: join(root, '.graphcode', 'graph.db'),
    model: 'test-model',
    contextPackTokens: 6000,
    maxCommits: 2000,
    ignore: [],
    workspaceRepos: [],
    ...overrides,
  }
}

describe('ingestGitHistory', () => {
  let dbDir: string
  let store: GraphStore

  beforeEach(() => {
    resetCommitCounter()
    dbDir = mkdtempSync(join(tmpdir(), 'graphcode-history-db-'))
    store = GraphStore.open(join(dbDir, 'graph.db'))
  })

  afterEach(() => {
    store.close()
    rmSync(dbDir, { recursive: true, force: true })
  })

  it('no-ops gracefully in a non-git directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'graphcode-nogit-'))
    try {
      const repo = store.upsertRepo('demo', dir)
      const result = ingestGitHistory(store, repo, configFor(dir))
      expect(result).toEqual({ commits: 0, touchEdges: 0, cochangeEdges: 0 })
      expect(store.stats().commits).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('ingests commit nodes and touched_by edges for files that exist in the graph', () => {
    const dir = initRepo()
    try {
      writeAndCommit(dir, { 'a.ts': 'one\n' }, 'feat(core): add a')
      writeAndCommit(dir, { 'b.ts': 'two\n' }, 'feat(core): add b')

      const repo = store.upsertRepo('demo', dir)
      store.insertNode(repo.id, { kind: 'file', name: 'a.ts', filePath: 'a.ts' })
      store.insertNode(repo.id, { kind: 'file', name: 'b.ts', filePath: 'b.ts' })

      const result = ingestGitHistory(store, repo, configFor(dir))
      expect(result.commits).toBe(2)
      expect(result.touchEdges).toBe(2)
      expect(store.stats().commits).toBe(2)

      const aFileNode = store.fileNode(repo.id, 'a.ts')
      expect(aFileNode).not.toBeNull()
      const commitNeighbors = store.neighbors(aFileNode?.id ?? -1, { direction: 'out', kinds: ['touched_by'] })
      expect(commitNeighbors).toHaveLength(1)
      expect(commitNeighbors[0]?.node.doc).toBe('feat(core): add a')

      expect(store.getMeta('git_last_sha')).not.toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('skips touched_by edges for files not present in the graph', () => {
    const dir = initRepo()
    try {
      writeAndCommit(dir, { 'untracked.ts': 'content\n' }, 'feat: add untracked file')
      const repo = store.upsertRepo('demo', dir)
      const result = ingestGitHistory(store, repo, configFor(dir))
      expect(result.commits).toBe(1)
      expect(result.touchEdges).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('ingests incrementally after a new commit, only adding the new commit', () => {
    const dir = initRepo()
    try {
      writeAndCommit(dir, { 'a.ts': 'one\n' }, 'feat(core): add a')
      const repo = store.upsertRepo('demo', dir)
      store.insertNode(repo.id, { kind: 'file', name: 'a.ts', filePath: 'a.ts' })
      store.insertNode(repo.id, { kind: 'file', name: 'b.ts', filePath: 'b.ts' })

      const first = ingestGitHistory(store, repo, configFor(dir))
      expect(first.commits).toBe(1)

      writeAndCommit(dir, { 'b.ts': 'two\n' }, 'feat(core): add b')
      const second = ingestGitHistory(store, repo, configFor(dir))
      expect(second.commits).toBe(1)
      expect(store.stats().commits).toBe(2)

      const bFileNode = store.fileNode(repo.id, 'b.ts')
      const commitNeighbors = store.neighbors(bFileNode?.id ?? -1, { direction: 'out', kinds: ['touched_by'] })
      expect(commitNeighbors).toHaveLength(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rebuilds fully when the incremental range fails (e.g. history rewritten)', () => {
    const dir = initRepo()
    try {
      writeAndCommit(dir, { 'a.ts': 'one\n' }, 'feat(core): add a')
      const repo = store.upsertRepo('demo', dir)
      store.insertNode(repo.id, { kind: 'file', name: 'a.ts', filePath: 'a.ts' })
      ingestGitHistory(store, repo, configFor(dir))

      // Simulate a rebase: pretend git_last_sha refers to a commit that no
      // longer exists in this repo's object database.
      store.setMeta('git_last_sha', '0'.repeat(40))

      writeAndCommit(dir, { 'a.ts': 'one\ntwo\n' }, 'feat(core): update a')
      const result = ingestGitHistory(store, repo, configFor(dir))
      expect(result.commits).toBe(2)
      expect(store.stats().commits).toBe(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('follows renamed files to the new path for touched_by edges', () => {
    const dir = initRepo()
    try {
      writeAndCommit(dir, { 'old.ts': 'content that is long enough to be detected as a rename by git heuristics\n'.repeat(3) }, 'feat: add old')
      renameFile(dir, 'old.ts', 'new.ts', 'refactor: rename old to new')

      const repo = store.upsertRepo('demo', dir)
      store.insertNode(repo.id, { kind: 'file', name: 'new.ts', filePath: 'new.ts' })

      const result = ingestGitHistory(store, repo, configFor(dir))
      expect(result.commits).toBe(2)
      expect(result.touchEdges).toBe(1)

      const newFileNode = store.fileNode(repo.id, 'new.ts')
      const commitNeighbors = store.neighbors(newFileNode?.id ?? -1, { direction: 'out', kinds: ['touched_by'] })
      expect(commitNeighbors).toHaveLength(1)
      expect(commitNeighbors[0]?.node.doc).toBe('refactor: rename old to new')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('respects maxCommits cap', () => {
    const dir = initRepo()
    try {
      for (let i = 0; i < 5; i++) {
        writeAndCommit(dir, { [`f${i}.ts`]: `content ${i}\n` }, `feat: add f${i}`)
      }
      const repo = store.upsertRepo('demo', dir)
      const result = ingestGitHistory(store, repo, configFor(dir, { maxCommits: 3 }))
      expect(result.commits).toBe(3)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
