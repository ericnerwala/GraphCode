import { rmSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildEditGuardAdvisory } from '../../src/agent/edit-guard.js'
import type { EditGuardConfig } from '../../src/core/config.js'
import type { GraphNode } from '../../src/graph/types.js'
import type { ImpactResult, RankedImpactFile } from '../../src/query/query-types.js'
import type { QueryApi } from '../../src/agent/query-api.js'
import { makeAgentFixture, type AgentFixture } from './fixtures.js'

/** Full EditGuardConfig object literal, overridable per test. */
function makeOptions(overrides: Partial<EditGuardConfig> = {}): EditGuardConfig {
  return {
    enabled: true,
    minImpactedFiles: 2,
    topFiles: 5,
    topCoChanges: 3,
    maxSymbolsPerFile: 40,
    depth: undefined,
    ...overrides,
  }
}

const RANK_SIGNALS = { refs: 1, direct: true, samePkg: true, nameMatch: false, isTest: false }

function makeRankedFile(overrides: Partial<RankedImpactFile> = {}): RankedImpactFile {
  return {
    filePath: 'src/other.ts',
    maxScore: 1,
    hitCount: 1,
    minDepth: 1,
    direct: true,
    symbols: [],
    rank: 1,
    tier: 'direct',
    signals: RANK_SIGNALS,
    ...overrides,
  }
}

function makeImpactResult(target: GraphNode, overrides: Partial<ImpactResult> = {}): ImpactResult {
  return {
    target,
    files: [],
    coChanges: [],
    ...overrides,
  }
}

function makeApiStub(impl?: (...args: Parameters<QueryApi['impactAnalysis']>) => ImpactResult): QueryApi {
  return {
    resolveSymbol: vi.fn(),
    findCallers: vi.fn(),
    findCallees: vi.fn(),
    explore: vi.fn(),
    impactAnalysis: impl ? vi.fn(impl) : vi.fn(),
    buildContextPack: vi.fn(),
  }
}

describe('buildEditGuardAdvisory', () => {
  let fixture: AgentFixture

  afterEach(() => {
    fixture.store.close()
    rmSync(fixture.root, { recursive: true, force: true })
    rmSync(fixture.dbDir, { recursive: true, force: true })
  })

  it('returns "" when disabled', () => {
    fixture = makeAgentFixture()
    const api = makeApiStub(() => makeImpactResult(fixture.store.nodesForFile(fixture.repoId, 'src/main.ts')[0]))
    const options = makeOptions({ enabled: false })

    const result = buildEditGuardAdvisory(api, fixture.store, fixture.root, fixture.repoId, 'src/main.ts', options)

    expect(result).toBe('')
    expect(api.impactAnalysis).not.toHaveBeenCalled()
  })

  it('returns "" when the file has 0 symbol nodes', () => {
    fixture = makeAgentFixture()
    const api = makeApiStub()
    const options = makeOptions()

    // README.md has no nodes at all in the fixture graph.
    const result = buildEditGuardAdvisory(api, fixture.store, fixture.root, fixture.repoId, 'README.md', options)

    expect(result).toBe('')
    expect(api.impactAnalysis).not.toHaveBeenCalled()
  })

  it('returns "" when impacted files are below minImpactedFiles threshold', () => {
    fixture = makeAgentFixture()
    const api = makeApiStub((_store, _root, target) =>
      makeImpactResult(target, { files: [makeRankedFile({ filePath: 'src/only-one.ts' })] }),
    )
    const options = makeOptions({ minImpactedFiles: 2 })

    const result = buildEditGuardAdvisory(api, fixture.store, fixture.root, fixture.repoId, 'src/helper.ts', options)

    expect(result).toBe('')
  })

  it('returns a non-empty advisory at/above the threshold, containing impacted file paths and tiers', () => {
    fixture = makeAgentFixture()
    const api = makeApiStub((_store, _root, target) =>
      makeImpactResult(target, {
        files: [
          makeRankedFile({ filePath: 'src/a.ts', rank: 2, tier: 'direct' }),
          makeRankedFile({ filePath: 'src/b.ts', rank: 1, tier: 'weak' }),
        ],
      }),
    )
    const options = makeOptions({ minImpactedFiles: 2 })

    const result = buildEditGuardAdvisory(api, fixture.store, fixture.root, fixture.repoId, 'src/helper.ts', options)

    expect(result).not.toBe('')
    expect(result).toContain('[impact guard]')
    expect(result).toContain('src/a.ts')
    expect(result).toContain('src/b.ts')
    expect(result).toContain('[direct]')
    expect(result).toContain('[weak]')
  })

  it('caps cost on files with too many symbols: never calls impactAnalysis, returns ""', () => {
    fixture = makeAgentFixture()
    // Seed a file with 2 symbols but cap maxSymbolsPerFile at 1.
    fixture.store.insertNode(fixture.repoId, {
      kind: 'symbol',
      subkind: 'function',
      name: 'firstFn',
      qualifiedName: 'firstFn',
      filePath: 'src/busy.ts',
      startLine: 1,
      endLine: 2,
      language: 'typescript',
    })
    fixture.store.insertNode(fixture.repoId, {
      kind: 'symbol',
      subkind: 'function',
      name: 'secondFn',
      qualifiedName: 'secondFn',
      filePath: 'src/busy.ts',
      startLine: 3,
      endLine: 4,
      language: 'typescript',
    })
    const api = makeApiStub()
    const options = makeOptions({ maxSymbolsPerFile: 1 })

    const result = buildEditGuardAdvisory(api, fixture.store, fixture.root, fixture.repoId, 'src/busy.ts', options)

    expect(result).toBe('')
    expect(api.impactAnalysis).not.toHaveBeenCalled()
  })

  it('returns "" and never throws when impactAnalysis throws', () => {
    fixture = makeAgentFixture()
    const api = makeApiStub(() => {
      throw new Error('boom')
    })
    const options = makeOptions()

    let result = ''
    expect(() => {
      result = buildEditGuardAdvisory(api, fixture.store, fixture.root, fixture.repoId, 'src/main.ts', options)
    }).not.toThrow()
    expect(result).toBe('')
  })

  it('merges tier from the higher-rank call, never mixing tier and rank across calls', () => {
    fixture = makeAgentFixture()
    // Give main.ts a second symbol so we have two symbols to iterate over,
    // each impacting the SAME target file with different (tier, rank).
    const secondSymbol = fixture.store.insertNode(fixture.repoId, {
      kind: 'symbol',
      subkind: 'function',
      name: 'secondMain',
      qualifiedName: 'secondMain',
      filePath: 'src/main.ts',
      startLine: 6,
      endLine: 8,
      language: 'typescript',
    })
    fixture.store.insertEdge(fixture.repoId, { src: secondSymbol, dst: fixture.nodeIds.helper, kind: 'calls' })

    const api = makeApiStub((_store, _root, target) => {
      if (target.name === 'main') {
        // Lower rank, but tier 'direct' — must NOT win.
        return makeImpactResult(target, {
          files: [makeRankedFile({ filePath: 'src/shared.ts', rank: 1, tier: 'direct' })],
        })
      }
      if (target.name === 'secondMain') {
        // Higher rank with tier 'weak' — this tier must be the one rendered.
        return makeImpactResult(target, {
          files: [makeRankedFile({ filePath: 'src/shared.ts', rank: 5, tier: 'weak' })],
        })
      }
      return makeImpactResult(target)
    })
    // Second target file to satisfy minImpactedFiles:2 so the advisory renders.
    const options = makeOptions({ minImpactedFiles: 1 })

    const result = buildEditGuardAdvisory(api, fixture.store, fixture.root, fixture.repoId, 'src/main.ts', options)

    expect(result).not.toBe('')
    expect(result).toContain('[weak] src/shared.ts')
    expect(result).not.toContain('[direct] src/shared.ts')
  })
})
