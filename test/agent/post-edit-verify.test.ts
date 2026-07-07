import { rmSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../../src/core/config.js'
import type { GraphcodeConfig } from '../../src/core/config.js'
import { verifyEditedFile, renderFindings } from '../../src/agent/post-edit-verify.js'
import type { Finding } from '../../src/agent/post-edit-verify.js'
import type { ReindexResult } from '../../src/agent/reindex-types.js'
import { makeAgentFixture } from './fixtures.js'
import type { AgentFixture } from './fixtures.js'

let fixture: AgentFixture | undefined

afterEach(() => {
  if (fixture) {
    fixture.store.close()
    rmSync(fixture.root, { recursive: true, force: true })
    rmSync(fixture.dbDir, { recursive: true, force: true })
    fixture = undefined
  }
})

function baseSync(fixture: AgentFixture, overrides: Partial<ReindexResult> = {}): ReindexResult {
  return {
    synced: true,
    repoId: fixture.repoId,
    path: 'src/helper.ts',
    addedSymbols: [],
    removedSymbols: [],
    edgesAdded: 0,
    newlyDanglingRefCount: 0,
    priorInboundCallerFiles: [],
    durationMs: 1,
    ...overrides,
  }
}

function verifyConfig(fixture: AgentFixture): GraphcodeConfig {
  return { ...loadConfig(fixture.root), postEditVerify: true }
}

describe('verifyEditedFile', () => {
  it('returns [] when postEditVerify is false, regardless of sync', () => {
    fixture = makeAgentFixture()
    const cfg = { ...loadConfig(fixture.root), postEditVerify: false }
    const sync = baseSync(fixture, {
      removedSymbols: ['helper'],
      priorInboundCallerFiles: ['src/main.ts'],
      newlyDanglingRefCount: 5,
    })
    expect(verifyEditedFile(fixture.store, cfg, 'src/helper.ts', sync)).toEqual([])
  })

  it('returns [] when sync.synced is false', () => {
    fixture = makeAgentFixture()
    const cfg = verifyConfig(fixture)
    const sync = baseSync(fixture, {
      synced: false,
      removedSymbols: ['helper'],
      priorInboundCallerFiles: ['src/main.ts'],
      newlyDanglingRefCount: 5,
    })
    expect(verifyEditedFile(fixture.store, cfg, 'src/helper.ts', sync)).toEqual([])
  })

  it('reports a stale_caller finding mentioning the prior caller file', () => {
    fixture = makeAgentFixture()
    const cfg = verifyConfig(fixture)
    const sync = baseSync(fixture, {
      removedSymbols: ['helper'],
      priorInboundCallerFiles: ['src/main.ts'],
    })
    const findings = verifyEditedFile(fixture.store, cfg, 'src/helper.ts', sync)
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ kind: 'stale_caller', severity: 'high' })
    expect(findings[0]!.message).toContain('src/main.ts')
  })

  it('reports a dangling_reference medium finding with the exact count', () => {
    fixture = makeAgentFixture()
    const cfg = verifyConfig(fixture)
    const sync = baseSync(fixture, { newlyDanglingRefCount: 3 })
    const findings = verifyEditedFile(fixture.store, cfg, 'src/helper.ts', sync)
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ kind: 'dangling_reference', severity: 'medium' })
    expect(findings[0]!.message).toContain('3')
  })

  it('reports an unresolved_import finding for pending imports sourced from the edited file', () => {
    fixture = makeAgentFixture()
    const cfg = verifyConfig(fixture)
    const symbolInFile = fixture.store.insertNode(fixture.repoId, {
      kind: 'symbol',
      subkind: 'function',
      name: 'helper',
      qualifiedName: 'helper',
      filePath: 'src/helper.ts',
      startLine: 1,
      endLine: 3,
      language: 'typescript',
      signature: 'function helper(): number',
      exported: true,
    })
    fixture.store.addPendingRef(fixture.repoId, {
      srcNode: symbolInFile,
      name: './missing.js',
      kind: 'imports',
    })
    const sync = baseSync(fixture, { removedSymbols: [] })
    const findings = verifyEditedFile(fixture.store, cfg, 'src/helper.ts', sync)
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ kind: 'unresolved_import', severity: 'medium' })
    expect(findings[0]!.message).toContain('1')
    expect(findings[0]!.message).toContain('./missing.js')
  })

  it('truncates to MAX_FINDINGS + a suppressed tail, keeping high severity first', () => {
    fixture = makeAgentFixture()
    const cfg = verifyConfig(fixture)
    const callerFiles = Array.from({ length: 10 }, (_, i) => `src/caller${i}.ts`)
    const sync = baseSync(fixture, {
      removedSymbols: ['helper'],
      priorInboundCallerFiles: callerFiles,
    })
    const findings = verifyEditedFile(fixture.store, cfg, 'src/helper.ts', sync)
    expect(findings).toHaveLength(9)
    const tail = findings[findings.length - 1] as Finding
    expect(tail.message).toContain('suppressed')
    // Regression (review finding F4): when the suppressed findings are
    // high-severity, the tail must ALSO carry high severity — otherwise the
    // completion gate's severity floor can't tell that unresolved high-severity
    // issues remain beyond the cap.
    expect(tail.severity).toBe('high')
    // The 8 shown before the tail must all be the high-severity stale_caller findings.
    const shown = findings.slice(0, 8)
    for (const f of shown) {
      expect(f.kind).toBe('stale_caller')
      expect(f.severity).toBe('high')
    }
  })

  it('renderFindings renders [] as empty string, and a finding with the [verify] prefix', () => {
    expect(renderFindings([])).toBe('')
    const finding: Finding = {
      kind: 'dangling_reference',
      severity: 'medium',
      message: 'something went stale',
    }
    const rendered = renderFindings([finding])
    expect(rendered).toContain('[verify]')
    expect(rendered).toContain('something went stale')
  })
})
