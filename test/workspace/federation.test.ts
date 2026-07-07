import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../../src/core/config.js'
import { GraphStore } from '../../src/graph/store.js'
import { closeWorkspace, openWorkspace, workspaceImpact, workspaceSearch } from '../../src/workspace/federation.js'

describe('workspace federation', () => {
  let rootDir: string
  let memberDir: string

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'graphcode-ws-root-'))
    memberDir = mkdtempSync(join(tmpdir(), 'graphcode-ws-member-'))

    mkdirSync(join(rootDir, '.graphcode'), { recursive: true })
    mkdirSync(join(memberDir, '.graphcode'), { recursive: true })

    const rootStore = GraphStore.open(join(rootDir, '.graphcode', 'graph.db'))
    const rootRepo = rootStore.upsertRepo('root-repo', rootDir)
    const rootFn = rootStore.insertNode(rootRepo.id, { kind: 'symbol', name: 'RootWidget', filePath: 'src/widget.ts' })
    const rootFile = rootStore.insertNode(rootRepo.id, { kind: 'file', name: 'widget.ts', filePath: 'src/widget.ts' })
    const rootCaller = rootStore.insertNode(rootRepo.id, { kind: 'symbol', name: 'useRootWidget', filePath: 'src/app.ts' })
    rootStore.insertEdge(rootRepo.id, { src: rootFile, dst: rootFn, kind: 'contains' })
    rootStore.insertEdge(rootRepo.id, { src: rootCaller, dst: rootFn, kind: 'calls' })
    rootStore.close()

    const memberStore = GraphStore.open(join(memberDir, '.graphcode', 'graph.db'))
    const memberRepo = memberStore.upsertRepo('member-repo', memberDir)
    memberStore.insertNode(memberRepo.id, { kind: 'symbol', name: 'SnorkelGadget', filePath: 'src/snorkel-gadget.ts' })
    const sharedFn = memberStore.insertNode(memberRepo.id, { kind: 'symbol', name: 'RootWidget', filePath: 'lib/vendored-widget.ts' })
    const sharedCaller = memberStore.insertNode(memberRepo.id, { kind: 'symbol', name: 'consumesRootWidget', filePath: 'src/consumer.ts' })
    memberStore.insertEdge(memberRepo.id, { src: sharedCaller, dst: sharedFn, kind: 'calls' })
    memberStore.close()
  })

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true })
    rmSync(memberDir, { recursive: true, force: true })
  })

  it('opens the root store and configured workspace members', () => {
    const config = loadConfig(rootDir)
    const withMembers = { ...config, workspaceRepos: [memberDir] }
    const ws = openWorkspace(withMembers)
    expect(ws.repos).toHaveLength(2)
    expect(ws.repos.map((r) => r.root).sort()).toEqual([memberDir, rootDir].sort())
    closeWorkspace(ws)
  })

  it('skips a workspace member with no index and notes it', () => {
    const config = loadConfig(rootDir)
    const missingDir = join(tmpdir(), 'graphcode-ws-missing-does-not-exist')
    const withMembers = { ...config, workspaceRepos: [missingDir] }
    const notes: string[] = []
    const ws = openWorkspace(withMembers, { onProgress: (msg) => notes.push(msg) })
    expect(ws.repos).toHaveLength(1)
    expect(notes.some((n) => n.includes(missingDir))).toBe(true)
    closeWorkspace(ws)
  })

  it('merges search results across repos, sorted by score, labeled by repo', () => {
    const config = loadConfig(rootDir)
    const withMembers = { ...config, workspaceRepos: [memberDir] }
    const ws = openWorkspace(withMembers)
    const hits = workspaceSearch(ws, 'widget', 20)
    expect(hits.length).toBeGreaterThanOrEqual(2)
    const repos = new Set(hits.map((h) => h.repo))
    expect(repos.has('root-repo')).toBe(true)
    expect(repos.has('member-repo')).toBe(true)
    for (let i = 1; i < hits.length; i++) {
      const prev = hits[i - 1]
      const curr = hits[i]
      if (prev && curr) expect(prev.score).toBeGreaterThanOrEqual(curr.score)
    }
    closeWorkspace(ws)
  })

  it('computes per-repo impact merged with repo labels for a name present in both repos', () => {
    const config = loadConfig(rootDir)
    const withMembers = { ...config, workspaceRepos: [memberDir] }
    const ws = openWorkspace(withMembers)
    const results = workspaceImpact(ws, 'RootWidget', { depth: 2 })
    expect(results).toHaveLength(2)
    const byRepo = Object.fromEntries(results.map((r) => [r.repo, r.result]))
    expect(byRepo['root-repo']?.files.some((f) => f.filePath === 'src/app.ts')).toBe(true)
    expect(byRepo['member-repo']?.files.some((f) => f.filePath === 'src/consumer.ts')).toBe(true)
    closeWorkspace(ws)
  })

  it('omits repos where the target does not resolve', () => {
    const config = loadConfig(rootDir)
    const withMembers = { ...config, workspaceRepos: [memberDir] }
    const ws = openWorkspace(withMembers)
    const results = workspaceImpact(ws, 'SnorkelGadget', { depth: 2 })
    expect(results).toHaveLength(1)
    expect(results[0]?.repo).toBe('member-repo')
    closeWorkspace(ws)
  })

  it('closeWorkspace closes every underlying store without throwing', () => {
    const config = loadConfig(rootDir)
    const withMembers = { ...config, workspaceRepos: [memberDir] }
    const ws = openWorkspace(withMembers)
    expect(() => closeWorkspace(ws)).not.toThrow()
  })

  it('skips a member whose index fails to open, without throwing or leaking the good store', () => {
    const brokenDir = mkdtempSync(join(tmpdir(), 'graphcode-ws-broken-'))
    // graph.db exists at the expected path but is a directory, not a valid
    // SQLite file — GraphStore.open() throws when it tries to open it.
    mkdirSync(join(brokenDir, '.graphcode', 'graph.db'), { recursive: true })

    const config = loadConfig(rootDir)
    const withMembers = { ...config, workspaceRepos: [memberDir, brokenDir] }
    const notes: string[] = []

    let ws: ReturnType<typeof openWorkspace> | undefined
    expect(() => {
      ws = openWorkspace(withMembers, { onProgress: (msg) => notes.push(msg) })
    }).not.toThrow()
    if (!ws) throw new Error('openWorkspace did not return')

    try {
      // Root + the good member only; the broken member is skipped.
      expect(ws.repos).toHaveLength(2)
      expect(ws.repos.some((r) => r.root === memberDir)).toBe(true)
      expect(ws.repos.some((r) => r.root === brokenDir)).toBe(false)
      expect(notes.some((n) => n.includes(brokenDir))).toBe(true)

      // The good store must still be fully usable (not left in some
      // half-opened state by the sibling failure).
      const hits = workspaceSearch(ws, 'widget', 20)
      expect(hits.some((h) => h.repo === 'member-repo')).toBe(true)
    } finally {
      closeWorkspace(ws)
      rmSync(brokenDir, { recursive: true, force: true })
    }
  })
})
