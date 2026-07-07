import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GraphcodeConfig } from '../../src/core/config.js'
import { GraphStore } from '../../src/graph/store.js'
import { ingestDocs } from '../../src/knowledge/specs.js'

function configFor(root: string): GraphcodeConfig {
  return {
    root,
    graphDir: join(root, '.graphcode'),
    dbPath: join(root, '.graphcode', 'graph.db'),
    model: 'test-model',
    contextPackTokens: 6000,
    maxCommits: 2000,
    ignore: [],
    workspaceRepos: [],
  }
}

describe('ingestDocs', () => {
  let root: string
  let dbDir: string
  let store: GraphStore

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'graphcode-docs-root-'))
    dbDir = mkdtempSync(join(tmpdir(), 'graphcode-docs-db-'))
    store = GraphStore.open(join(dbDir, 'graph.db'))
  })

  afterEach(() => {
    store.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(dbDir, { recursive: true, force: true })
  })

  it('ingests a doc, classifying by name and extracting a title', () => {
    const repo = store.upsertRepo('demo', root)
    writeFileSync(join(root, 'README.md'), '# My Project\n\nThis project does things. See `src/core/config.ts`.\n')

    const result = ingestDocs(store, repo, configFor(root), [{ path: 'README.md' }])
    expect(result.docs).toBe(1)

    const docs = store.raw("SELECT * FROM nodes WHERE kind = 'doc'") as Array<{
      name: string
      subkind: string
      file_path: string
    }>
    expect(docs).toHaveLength(1)
    expect(docs[0]?.name).toBe('My Project')
    expect(docs[0]?.subkind).toBe('readme')
    expect(docs[0]?.file_path).toBe('README.md')
  })

  it('links mentions edges to files and backtick-quoted symbols', () => {
    const repo = store.upsertRepo('demo', root)
    store.insertNode(repo.id, { kind: 'file', name: 'config.ts', filePath: 'src/core/config.ts' })
    store.insertNode(repo.id, { kind: 'symbol', name: 'GraphStore', filePath: 'src/graph/store.ts' })

    mkdirSync(join(root, 'docs'), { recursive: true })
    writeFileSync(
      join(root, 'docs/architecture.md'),
      '# Architecture\n\nSee `src/core/config.ts` for config loading. The `GraphStore` class owns writes.\n',
    )

    const result = ingestDocs(store, repo, configFor(root), [{ path: 'docs/architecture.md' }])
    expect(result.docs).toBe(1)
    expect(result.mentionEdges).toBe(2)

    const docNode = store.raw("SELECT id FROM nodes WHERE kind = 'doc'") as Array<{ id: number }>
    const docId = docNode[0]?.id
    expect(docId).toBeDefined()
    const neighbors = store.neighbors(docId ?? -1, { direction: 'out', kinds: ['mentions'] })
    expect(neighbors).toHaveLength(2)
    const names = neighbors.map((n) => n.node.name).sort()
    expect(names).toEqual(['GraphStore', 'config.ts'])
  })

  it('skips ambiguous backtick symbol matches (more than 3)', () => {
    const repo = store.upsertRepo('demo', root)
    for (let i = 0; i < 4; i++) {
      store.insertNode(repo.id, { kind: 'symbol', name: 'Ambiguous', filePath: `f${i}.ts` })
    }
    writeFileSync(join(root, 'doc.md'), '# Doc\n\nRefers to `Ambiguous` which exists in many files.\n')
    const result = ingestDocs(store, repo, configFor(root), [{ path: 'doc.md' }])
    expect(result.mentionEdges).toBe(0)
  })

  it('classifies changelog and spec docs correctly', () => {
    const repo = store.upsertRepo('demo', root)
    writeFileSync(join(root, 'CHANGELOG.md'), '# Changelog\n\nv1.0.0 initial release\n')
    mkdirSync(join(root, 'specs'), { recursive: true })
    writeFileSync(join(root, 'specs/api-spec.md'), '# API Spec\n\nDetails.\n')

    ingestDocs(store, repo, configFor(root), [{ path: 'CHANGELOG.md' }, { path: 'specs/api-spec.md' }])
    const docs = store.raw("SELECT name, subkind FROM nodes WHERE kind = 'doc' ORDER BY name") as Array<{
      name: string
      subkind: string
    }>
    expect(docs.find((d) => d.name === 'Changelog')?.subkind).toBe('changelog')
    expect(docs.find((d) => d.name === 'API Spec')?.subkind).toBe('spec')
  })

  it('rebuilds by deleting existing doc nodes first', () => {
    const repo = store.upsertRepo('demo', root)
    writeFileSync(join(root, 'a.md'), '# A\n\nContent A\n')
    ingestDocs(store, repo, configFor(root), [{ path: 'a.md' }])
    expect(store.stats().docs).toBe(1)

    writeFileSync(join(root, 'b.md'), '# B\n\nContent B\n')
    const result = ingestDocs(store, repo, configFor(root), [{ path: 'b.md' }])
    expect(result.docs).toBe(1)
    expect(store.stats().docs).toBe(1)
  })

  it('falls back to the basename when there is no heading', () => {
    const repo = store.upsertRepo('demo', root)
    writeFileSync(join(root, 'notes.md'), 'Just some notes without a heading.\n')
    ingestDocs(store, repo, configFor(root), [{ path: 'notes.md' }])
    const docs = store.raw("SELECT name FROM nodes WHERE kind = 'doc'") as Array<{ name: string }>
    expect(docs[0]?.name).toBe('notes')
  })

  it('skips files that fail to read', () => {
    const repo = store.upsertRepo('demo', root)
    const result = ingestDocs(store, repo, configFor(root), [{ path: 'does-not-exist.md' }])
    expect(result.docs).toBe(0)
  })
})
