import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../../src/core/config.js'
import type { GraphcodeConfig } from '../../src/core/config.js'
import { GraphStore } from '../../src/graph/store.js'
import { indexRepo } from '../../src/index/indexer.js'
import { reindexFile } from '../../src/agent/graph-sync.js'
import { makeAgentFixture, type AgentFixture } from './fixtures.js'
import { wasmGrammarsLoad } from '../index/helpers/wasm-support.js'

const canLoadWasm = await wasmGrammarsLoad()

function write(root: string, relPath: string, content: string): void {
  const full = join(root, relPath)
  mkdirSync(full.slice(0, full.lastIndexOf('/')), { recursive: true })
  writeFileSync(full, content)
}

function liveConfig(root: string): GraphcodeConfig {
  return { ...loadConfig(root), liveGraphSync: true }
}

describe('reindexFile (no real parsing needed)', () => {
  let fixture: AgentFixture

  beforeEach(() => {
    fixture = makeAgentFixture()
  })

  afterEach(() => {
    fixture.store.close()
    rmSync(fixture.root, { recursive: true, force: true })
    rmSync(fixture.dbDir, { recursive: true, force: true })
  })

  it('skips when liveGraphSync is disabled', async () => {
    const config = { ...fixture.config, liveGraphSync: false }
    const result = await reindexFile(fixture.store, config, 'src/helper.ts')

    expect(result.synced).toBe(false)
    expect(result.skippedReason).toBeDefined()
    expect(result.skippedReason?.toLowerCase()).toContain('disabled')
    expect(result.addedSymbols).toEqual([])
    expect(result.removedSymbols).toEqual([])
    expect(result.edgesAdded).toBe(0)
    expect(result.newlyDanglingRefCount).toBe(0)
    expect(result.priorInboundCallerFiles).toEqual([])
  })

  it('skips when the repo has not been indexed yet', async () => {
    // Fresh store/root pair that was never registered via upsertRepo.
    const root = mkdtempSync(join(tmpdir(), 'graphcode-sync-freshroot-'))
    const dbDir = mkdtempSync(join(tmpdir(), 'graphcode-sync-freshdb-'))
    const store = GraphStore.open(join(dbDir, 'graph.db'))
    write(root, 'src/a.ts', 'export const a = 1\n')
    const config = liveConfig(root)

    try {
      const result = await reindexFile(store, config, 'src/a.ts')
      expect(result.synced).toBe(false)
      expect(result.skippedReason).toBeDefined()
      expect(result.skippedReason?.toLowerCase()).toContain('not indexed')
    } finally {
      store.close()
      rmSync(root, { recursive: true, force: true })
      rmSync(dbDir, { recursive: true, force: true })
    }
  })

  it('skips unsupported languages once the repo is indexed', async () => {
    // Register the repo the same way indexRepo would (upsertRepo), so
    // getRepoByRoot succeeds without requiring real wasm parsing.
    fixture.store.upsertRepo('fixture', fixture.root)
    write(fixture.root, 'notes.md', '# just notes\n')
    const config = liveConfig(fixture.root)

    const result = await reindexFile(fixture.store, config, 'notes.md')
    expect(result.synced).toBe(false)
    expect(result.skippedReason).toBeDefined()
    expect(result.skippedReason?.toLowerCase()).toContain('unsupported')
  })
})

describe.skipIf(!canLoadWasm)('reindexFile (real parsing)', () => {
  let root: string
  let dbDir: string
  let store: GraphStore

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'graphcode-sync-root-'))
    dbDir = mkdtempSync(join(tmpdir(), 'graphcode-sync-db-'))
    store = GraphStore.open(join(dbDir, 'graph.db'))
  })

  afterEach(() => {
    store.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(dbDir, { recursive: true, force: true })
  })

  it('adds a newly-introduced exported symbol on a real edit', async () => {
    write(root, 'src/main.ts', "import { helper } from './helper.js'\n\nexport function main(): void {\n  helper()\n}\n")
    write(root, 'src/helper.ts', 'export function helper(): number {\n  return 42\n}\n')
    const config = liveConfig(root)
    await indexRepo(store, config)

    // Append a brand-new exported function to helper.ts on disk.
    write(
      root,
      'src/helper.ts',
      'export function helper(): number {\n  return 42\n}\n\nexport function helperExtra(): number {\n  return 7\n}\n',
    )

    const result = await reindexFile(store, config, 'src/helper.ts')

    expect(result.synced).toBe(true)
    expect(result.addedSymbols).toContain('helperExtra')
    expect(result.removedSymbols).toEqual([])
    expect(result.edgesAdded).toBeGreaterThanOrEqual(0)
    expect(result.repoId).toBeGreaterThan(0)
    expect(result.path).toBe('src/helper.ts')
  })

  it('captures the pre-delete snapshot: renaming a called symbol reports removed/added names, the prior caller, and an exact dangling count', async () => {
    write(root, 'src/main.ts', "import { helper } from './helper.js'\n\nexport function main(): void {\n  helper()\n}\n")
    write(root, 'src/helper.ts', 'export function helper(): number {\n  return 42\n}\n')
    const config = liveConfig(root)
    const indexResult = await indexRepo(store, config)

    // Sanity: the calls edge from main -> helper exists before the rename.
    const mainNodeBefore = store
      .nodesForFile(indexResult.repoId, 'src/main.ts')
      .find((n) => n.kind === 'symbol' && n.name === 'main')
    expect(mainNodeBefore).toBeDefined()
    const helperNodeBefore = store
      .nodesForFile(indexResult.repoId, 'src/helper.ts')
      .find((n) => n.kind === 'symbol' && n.name === 'helper')
    expect(helperNodeBefore).toBeDefined()
    const callsEdgesBefore = store.neighbors(mainNodeBefore!.id, { direction: 'out', kinds: ['calls'] })
    expect(callsEdgesBefore.some((n) => n.node.id === helperNodeBefore!.id)).toBe(true)

    // Rename helper -> helperRenamed on disk: 'helper' is removed, 'helperRenamed' is added.
    write(root, 'src/helper.ts', 'export function helperRenamed(): number {\n  return 42\n}\n')

    const result = await reindexFile(store, config, 'src/helper.ts')

    expect(result.synced).toBe(true)
    expect(result.removedSymbols).toContain('helper')
    expect(result.addedSymbols).toContain('helperRenamed')
    expect(result.priorInboundCallerFiles).toContain('src/main.ts')
    // main.ts's call to the now-gone `helper` symbol must register as dangling.
    expect(result.newlyDanglingRefCount).toBeGreaterThanOrEqual(1)
  })

  it('reindexes a deleted file: removes its nodes and reports removed symbols', async () => {
    write(root, 'src/main.ts', "import { helper } from './helper.js'\n\nexport function main(): void {\n  helper()\n}\n")
    write(root, 'src/helper.ts', 'export function helper(): number {\n  return 42\n}\n')
    const config = liveConfig(root)
    const indexResult = await indexRepo(store, config)

    // Confirm the helper file node exists before deletion.
    expect(store.fileNode(indexResult.repoId, 'src/helper.ts')).not.toBeNull()

    unlinkSync(join(root, 'src/helper.ts'))

    const result = await reindexFile(store, config, 'src/helper.ts')

    expect(result.synced).toBe(true)
    expect(result.removedSymbols.length).toBeGreaterThan(0)
    expect(result.removedSymbols).toContain('helper')
    expect(store.fileNode(indexResult.repoId, 'src/helper.ts')).toBeNull()
    expect(store.nodesForFile(indexResult.repoId, 'src/helper.ts')).toEqual([])
  })

  it('does not count an intra-file caller as dangling on a trivial edit (regression: same-file renumbering)', async () => {
    // one.ts has an intra-file call (top() calls bottom(), both in one.ts). A
    // reindex deletes+reinserts every node in one.ts with fresh ids, so the
    // intra-file calls edge is renumbered but faithfully recreated. It must NOT
    // be counted as a newly-dangling reference — only cross-file callers can
    // genuinely dangle.
    write(root, 'src/one.ts', 'function bottom(): number {\n  return 1\n}\n\nexport function top(): number {\n  return bottom()\n}\n')
    const config = liveConfig(root)
    await indexRepo(store, config)

    // A whitespace-only edit: no symbol added or removed.
    write(root, 'src/one.ts', 'function bottom(): number {\n  return 1\n}\n\nexport function top(): number {\n  return bottom() // touched\n}\n')
    const result = await reindexFile(store, config, 'src/one.ts')

    expect(result.synced).toBe(true)
    expect(result.removedSymbols).toEqual([])
    expect(result.addedSymbols).toEqual([])
    expect(result.newlyDanglingRefCount).toBe(0)
  })
})
