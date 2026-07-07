import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { rmSync } from 'node:fs'
import { runCompletionGate } from '../../src/agent/completion-gate.js'
import { emptySessionState, recordWrite, incrementGateIterations } from '../../src/agent/session-state.js'
import type { SessionState } from '../../src/agent/session-state.js'
import type { ReindexResult } from '../../src/agent/reindex-types.js'
import type { Finding } from '../../src/agent/post-edit-verify.js'
import { loadConfig } from '../../src/core/config.js'
import type { GraphcodeConfig } from '../../src/core/config.js'
import { makeAgentFixture, type AgentFixture } from './fixtures.js'

/** Build a minimal ReindexResult for a given path; defaults represent a clean, synced write. */
function makeSync(repoId: number, path: string, overrides: Partial<ReindexResult> = {}): ReindexResult {
  return {
    synced: true,
    repoId,
    path,
    addedSymbols: [],
    removedSymbols: [],
    edgesAdded: 0,
    newlyDanglingRefCount: 0,
    priorInboundCallerFiles: [],
    durationMs: 1,
    ...overrides,
  }
}

function staleCallerFinding(filePath: string, severity: Finding['severity'] = 'high'): Finding {
  return {
    kind: 'stale_caller',
    severity,
    filePath,
    message: `${filePath} previously referenced symbol(s) removed or renamed — verify it still compiles`,
  }
}

describe('runCompletionGate', () => {
  let fixture: AgentFixture
  let gateConfig: GraphcodeConfig

  beforeEach(() => {
    fixture = makeAgentFixture()
    gateConfig = { ...loadConfig(fixture.root), completionGateEnabled: true, completionGateMinSeverity: 'high' }
  })

  afterEach(() => {
    fixture.store.close()
    rmSync(fixture.root, { recursive: true, force: true })
    rmSync(fixture.dbDir, { recursive: true, force: true })
  })

  it('does not gate when completionGateEnabled is false', () => {
    const config = { ...gateConfig, completionGateEnabled: false }
    let state = emptySessionState()
    state = recordWrite(state, 'src/helper.ts', makeSync(fixture.repoId, 'src/helper.ts'), [
      staleCallerFinding('src/other.ts'),
    ])

    const result = runCompletionGate(fixture.store, config, state)

    expect(result.shouldGate).toBe(false)
    expect(result.message).toBeUndefined()
  })

  it('does not gate when gateIterations has reached the configured max', () => {
    const config = { ...gateConfig, completionGateMaxIterations: 2 }
    let state = emptySessionState()
    state = recordWrite(state, 'src/helper.ts', makeSync(fixture.repoId, 'src/helper.ts'), [
      staleCallerFinding('src/other.ts'),
    ])
    state = incrementGateIterations(state)
    state = incrementGateIterations(state)

    expect(state.gateIterations).toBe(2)

    const result = runCompletionGate(fixture.store, config, state)

    expect(result.shouldGate).toBe(false)
  })

  it('does not gate when no files were written this session', () => {
    const state = emptySessionState()

    const result = runCompletionGate(fixture.store, gateConfig, state)

    expect(result.shouldGate).toBe(false)
  })

  it('gates on a stale_caller finding whose file was not written this turn', () => {
    let state: SessionState = emptySessionState()
    state = recordWrite(state, 'src/helper.ts', makeSync(fixture.repoId, 'src/helper.ts'), [
      staleCallerFinding('src/other.ts', 'high'),
    ])

    const result = runCompletionGate(fixture.store, gateConfig, state)

    expect(result.shouldGate).toBe(true)
    expect(result.message).toBeDefined()
    expect(result.message).toContain('src/other.ts')
    expect(result.message).toContain('possible loose ends')
  })

  it('suppresses a stale_caller finding when its filePath was also written this turn', () => {
    let state: SessionState = emptySessionState()
    // helper.ts was edited such that main.ts (the caller) is now stale...
    state = recordWrite(state, 'src/helper.ts', makeSync(fixture.repoId, 'src/helper.ts'), [
      staleCallerFinding('src/main.ts', 'high'),
    ])
    // ...but main.ts was ALSO written this turn, so the caller is presumed addressed.
    state = recordWrite(state, 'src/main.ts', makeSync(fixture.repoId, 'src/main.ts'), [])

    const result = runCompletionGate(fixture.store, gateConfig, state)

    expect(result.shouldGate).toBe(false)
  })

  it('gates on an unopened co-change neighbor discovered via store.neighbors', () => {
    const otherFile = fixture.store.insertNode(fixture.repoId, {
      kind: 'file',
      name: 'other.ts',
      filePath: 'src/other.ts',
      language: 'typescript',
    })
    const helperFileNode = fixture.store.fileNode(fixture.repoId, 'src/helper.ts')
    expect(helperFileNode).not.toBeNull()
    fixture.store.insertEdge(fixture.repoId, { src: helperFileNode!.id, dst: otherFile, kind: 'co_change' })

    let state: SessionState = emptySessionState()
    state = recordWrite(state, 'src/helper.ts', makeSync(fixture.repoId, 'src/helper.ts'), [])

    // Co-change findings are 'medium' severity; use a 'medium' floor so this case fires on its own.
    const config = { ...gateConfig, completionGateMinSeverity: 'medium' as const }
    const result = runCompletionGate(fixture.store, config, state)

    expect(result.shouldGate).toBe(true)
    expect(result.message).toBeDefined()
    expect(result.message).toContain('src/other.ts')
  })

  it('does not gate when only findings below the severity floor exist (co-change is medium, floor is high)', () => {
    const otherFile = fixture.store.insertNode(fixture.repoId, {
      kind: 'file',
      name: 'other.ts',
      filePath: 'src/other.ts',
      language: 'typescript',
    })
    const helperFileNode = fixture.store.fileNode(fixture.repoId, 'src/helper.ts')
    expect(helperFileNode).not.toBeNull()
    fixture.store.insertEdge(fixture.repoId, { src: helperFileNode!.id, dst: otherFile, kind: 'co_change' })

    let state: SessionState = emptySessionState()
    state = recordWrite(state, 'src/helper.ts', makeSync(fixture.repoId, 'src/helper.ts'), [])

    // gateConfig floor is 'high'; the only available finding (co-change) is 'medium'.
    const result = runCompletionGate(fixture.store, gateConfig, state)

    expect(result.shouldGate).toBe(false)
  })
})
