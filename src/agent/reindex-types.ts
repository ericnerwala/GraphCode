// The shared contract produced by live graph sync (graph-sync.ts) and consumed
// by post-edit verification and the completion gate. Extracted into its own
// module so those consumers depend only on the shape, not on graph-sync.ts's
// implementation (which pulls in the indexer internals).

/** The outcome of reindexing one file after the agent wrote or edited it. */
export interface ReindexResult {
  /** True when the file was actually re-indexed; false when skipped (see skippedReason). */
  readonly synced: boolean
  /** Why sync was skipped (config off, repo not indexed, unsupported language, parse/sync error). */
  readonly skippedReason?: string
  readonly repoId: number
  /** Repo-relative, forward-slash path — the SAME key insertFileGraph wrote, never a resolved absolute path. */
  readonly path: string
  /** Bare symbol names present after the edit but not before (added or renamed-to). */
  readonly addedSymbols: readonly string[]
  /** Bare symbol names present before the edit but not after (removed or renamed-from). */
  readonly removedSymbols: readonly string[]
  readonly edgesAdded: number
  /**
   * Exact count of references elsewhere in the repo that pointed at a symbol
   * this edit removed and now resolve to nothing: prior inbound callers whose
   * edge did not survive the re-resolve, plus pending_refs naming a removed
   * symbol. Computed from the pre-delete snapshot, not a heuristic.
   */
  readonly newlyDanglingRefCount: number
  /**
   * file_path of each OTHER file that had a live inbound calls/references/
   * extends/implements edge into one of this file's symbols, captured BEFORE
   * deleteFileGraph ran. Lets post-edit verify flag stale callers without a
   * second store round-trip after the mutation.
   */
  readonly priorInboundCallerFiles: readonly string[]
  readonly durationMs: number
}
