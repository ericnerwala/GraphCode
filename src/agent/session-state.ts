// Per-session bookkeeping for the completion gate: which files the agent wrote
// this session, the sync result for each, and any post-edit findings. Immutable
// — every mutation returns a new SessionState (the loop holds the latest).

import type { ReindexResult } from './reindex-types.js'
import type { Finding } from './post-edit-verify.js'

export interface WrittenFileRecord {
  readonly path: string
  readonly sync: ReindexResult
  readonly findings: readonly Finding[]
}

export interface SessionState {
  /** Keyed by repo-relative path (same key everywhere — never normalized separately). */
  readonly writtenFiles: ReadonlyMap<string, WrittenFileRecord>
  /** How many end-of-turn gate cycles have fired (backstop against nagging loops). */
  readonly gateIterations: number
}

export function emptySessionState(): SessionState {
  return { writtenFiles: new Map(), gateIterations: 0 }
}

/** Record (or overwrite) the latest write for a path. Returns a new state. */
export function recordWrite(
  state: SessionState,
  path: string,
  sync: ReindexResult,
  findings: readonly Finding[],
): SessionState {
  const writtenFiles = new Map(state.writtenFiles)
  writtenFiles.set(path, { path, sync, findings })
  return { ...state, writtenFiles }
}

export function incrementGateIterations(state: SessionState): SessionState {
  return { ...state, gateIterations: state.gateIterations + 1 }
}
