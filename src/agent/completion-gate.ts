// Completion gate (Lever 3). When the model wants to end its turn, sweep the
// files it wrote this session for unresolved, graph-visible loose ends. If any
// clear the configured severity floor, return a synthetic user message asking
// the agent to resolve or justify them, and the loop continues instead of
// returning. Bounded by completionGateMaxIterations so it can never nag forever.
//
// Framed as "possible loose ends (may already be addressed)" so a false positive
// costs the agent one cheap acknowledgement, not a wrong edit. Never throws.

import type { GraphcodeConfig } from '../core/config.js'
import type { GraphStore } from '../graph/store.js'
import type { SessionState } from './session-state.js'
import type { Finding, Severity } from './post-edit-verify.js'

export interface GateResult {
  readonly shouldGate: boolean
  readonly message?: string
}

const SEVERITY_FLOOR: Record<Severity, number> = { high: 2, medium: 1, low: 0 }

/** Decide whether to hold the turn open with a follow-up. Read-only; never throws. */
export function runCompletionGate(store: GraphStore, config: GraphcodeConfig, state: SessionState): GateResult {
  if (!config.completionGateEnabled) return { shouldGate: false }
  if (state.gateIterations >= config.completionGateMaxIterations) return { shouldGate: false }
  if (state.writtenFiles.size === 0) return { shouldGate: false }

  try {
    const floor = SEVERITY_FLOOR[config.completionGateMinSeverity]
    const writtenPaths = new Set(state.writtenFiles.keys())

    // A: stale callers the agent hasn't already touched this turn. A caller file
    // already written this turn is presumed addressed (the graph just may not
    // have caught up), so it's suppressed — this is the key false-positive guard.
    const staleCallers = [...state.writtenFiles.values()]
      .flatMap((r) => r.findings)
      .filter((f) => f.kind === 'stale_caller')
      .filter((f) => !(f.filePath && writtenPaths.has(f.filePath)))
      .filter((f) => SEVERITY_FLOOR[f.severity] >= floor)

    // B: co-change files never opened this turn — direct co_change neighbors,
    // not impactAnalysis (which never surfaces a node's own co-changes).
    const coChanges = checkUnopenedCoChanges(store, state).filter((f) => SEVERITY_FLOOR[f.severity] >= floor)

    const all = dedupeByMessage([...staleCallers, ...coChanges])
    if (all.length === 0) return { shouldGate: false }

    const message = [
      'Before finishing, double-check these possible loose ends (from the graph as of the last sync — some may already be handled):',
      ...all.map((f) => `  - ${f.message}`),
      'If each is already handled or not applicable, say so briefly and finish; otherwise address it first.',
    ].join('\n')
    return { shouldGate: true, message }
  } catch {
    return { shouldGate: false }
  }
}

function checkUnopenedCoChanges(store: GraphStore, state: SessionState): Finding[] {
  const findings: Finding[] = []
  const seen = new Set<string>()
  for (const [path, record] of state.writtenFiles) {
    if (!record.sync.synced) continue
    const fileNode = store.fileNode(record.sync.repoId, path)
    if (!fileNode) continue
    const neighbors = store.neighbors(fileNode.id, { direction: 'both', kinds: ['co_change'] })
    for (const n of neighbors) {
      const neighborPath = n.node.filePath
      if (!neighborPath || state.writtenFiles.has(neighborPath) || seen.has(neighborPath)) continue
      seen.add(neighborPath)
      findings.push({
        kind: 'unopened_co_change',
        severity: 'medium',
        filePath: neighborPath,
        message: `${neighborPath} historically changes together with ${path}, but wasn't touched this turn`,
      })
    }
  }
  return findings
}

function dedupeByMessage(findings: readonly Finding[]): Finding[] {
  const byMessage = new Map<string, Finding>()
  for (const f of findings) if (!byMessage.has(f.message)) byMessage.set(f.message, f)
  return [...byMessage.values()]
}
