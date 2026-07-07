import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GraphStore } from '../../src/graph/store.js'
import { ingestFeatures } from '../../src/knowledge/features.js'

describe('ingestFeatures', () => {
  let dir: string
  let store: GraphStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'graphcode-features-'))
    store = GraphStore.open(join(dir, 'graph.db'))
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  function makeCommitWithFiles(repoId: number, subject: string, files: string[]): number {
    const commitId = store.insertNode(repoId, { kind: 'commit', name: subject.slice(0, 7), doc: subject })
    for (const path of files) {
      const fileNode = store.fileNode(repoId, path) ?? store.getNode(store.insertNode(repoId, { kind: 'file', name: path, filePath: path }))
      if (fileNode) {
        store.insertEdge(repoId, { src: fileNode.id, dst: commitId, kind: 'touched_by' })
      }
    }
    return commitId
  }

  it('clusters three feat(auth) commits and one fix(auth) into one auth feature', () => {
    const repo = store.upsertRepo('demo', '/tmp/demo')
    makeCommitWithFiles(repo.id, 'feat(auth): add login', ['auth.ts', 'session.ts'])
    makeCommitWithFiles(repo.id, 'feat(auth): add logout', ['auth.ts', 'session.ts'])
    makeCommitWithFiles(repo.id, 'feat(auth): add refresh token', ['auth.ts'])
    makeCommitWithFiles(repo.id, 'fix(auth): fix session bug', ['session.ts'])

    const result = ingestFeatures(store, repo)
    expect(result.features).toBe(1)

    const features = store.raw("SELECT * FROM nodes WHERE kind = 'feature'") as Array<{
      id: number
      name: string
      meta: string
    }>
    expect(features).toHaveLength(1)
    expect(features[0]?.name).toBe('auth')
    const meta = JSON.parse(features[0]?.meta ?? '{}') as { commitCount: number; types: string[] }
    expect(meta.commitCount).toBe(4)
    expect(meta.types.sort()).toEqual(['feat', 'fix'])

    const featureId = features[0]?.id ?? -1
    const commitNeighbors = store.neighbors(featureId, { direction: 'in', kinds: ['in_feature'] })
    const commitLinks = commitNeighbors.filter((n) => n.node.kind === 'commit')
    expect(commitLinks).toHaveLength(4)

    // auth.ts touched by 3 feature commits, session.ts by 3 (2 feat + 1 fix) -> both linked.
    const fileLinks = commitNeighbors.filter((n) => n.node.kind === 'file')
    const fileNames = fileLinks.map((n) => n.node.name).sort()
    expect(fileNames).toEqual(['auth.ts', 'session.ts'])
  })

  it('drops scopes with fewer than 2 commits', () => {
    const repo = store.upsertRepo('demo', '/tmp/demo')
    makeCommitWithFiles(repo.id, 'feat(rare): one-off change', ['rare.ts'])

    const result = ingestFeatures(store, repo)
    expect(result.features).toBe(0)
  })

  it('ignores commits whose subjects are not conventional-commit formatted', () => {
    const repo = store.upsertRepo('demo', '/tmp/demo')
    store.insertNode(repo.id, { kind: 'commit', name: 'abc1234', doc: 'quick fix for thing' })
    store.insertNode(repo.id, { kind: 'commit', name: 'def5678', doc: 'another random commit message' })

    const result = ingestFeatures(store, repo)
    expect(result.features).toBe(0)
  })

  it('does not link a file touched by only one of the feature commits', () => {
    const repo = store.upsertRepo('demo', '/tmp/demo')
    makeCommitWithFiles(repo.id, 'feat(billing): add invoice', ['invoice.ts'])
    makeCommitWithFiles(repo.id, 'feat(billing): add receipt', ['receipt.ts'])

    ingestFeatures(store, repo)
    const features = store.raw("SELECT id FROM nodes WHERE kind = 'feature'") as Array<{ id: number }>
    const featureId = features[0]?.id ?? -1
    const neighbors = store.neighbors(featureId, { direction: 'in', kinds: ['in_feature'] })
    const fileLinks = neighbors.filter((n) => n.node.kind === 'file')
    expect(fileLinks).toHaveLength(0)
  })

  it('rebuilds by removing previously ingested feature nodes', () => {
    const repo = store.upsertRepo('demo', '/tmp/demo')
    makeCommitWithFiles(repo.id, 'feat(auth): add login', ['auth.ts'])
    makeCommitWithFiles(repo.id, 'feat(auth): add logout', ['auth.ts'])
    ingestFeatures(store, repo)
    expect(store.stats().features).toBe(1)

    ingestFeatures(store, repo)
    expect(store.stats().features).toBe(1)
  })

  it('handles scope with special characters and breaking-change marker', () => {
    const repo = store.upsertRepo('demo', '/tmp/demo')
    makeCommitWithFiles(repo.id, 'feat(api-v2)!: breaking change to endpoint', ['api.ts'])
    makeCommitWithFiles(repo.id, 'feat(api-v2): add endpoint', ['api.ts'])

    const result = ingestFeatures(store, repo)
    expect(result.features).toBe(1)
    const features = store.raw("SELECT name FROM nodes WHERE kind = 'feature'") as Array<{ name: string }>
    expect(features[0]?.name).toBe('api-v2')
  })
})
