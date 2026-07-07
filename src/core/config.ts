import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** Pre-edit blast-radius advisory settings (Lever 1). */
export interface EditGuardConfig {
  /** Emit the advisory at all. */
  readonly enabled: boolean
  /** Suppress the advisory when fewer than this many files depend on the edited file (avoid spam on leaf helpers). */
  readonly minImpactedFiles: number
  /** Max impacted files listed before collapsing the rest into a "+N more" line. */
  readonly topFiles: number
  /** Max co-change files listed. */
  readonly topCoChanges: number
  /** Above this many symbols in the edited file, skip impact computation entirely (cost cap — never truncate silently mid-loop). */
  readonly maxSymbolsPerFile: number
  /** Impact traversal depth override; undefined uses impactAnalysis's default. */
  readonly depth?: number
}

export interface GraphcodeConfig {
  /** Repo root being indexed/queried. */
  readonly root: string
  /** Directory holding the index database. */
  readonly graphDir: string
  /** Path to the SQLite database. */
  readonly dbPath: string
  /** Model used by the agent harness. */
  readonly model: string
  /** Token budget for the turn-0 injected context pack. */
  readonly contextPackTokens: number
  /** Max commits ingested into the git layer. */
  readonly maxCommits: number
  /** Extra ignore globs beyond .gitignore. */
  readonly ignore: readonly string[]
  /** Workspace member roots for cross-repo indexing (absolute or relative to root). */
  readonly workspaceRepos: readonly string[]
  /** Lever: live incremental graph sync after write_file/edit_file. Off by default. */
  readonly liveGraphSync: boolean
  /** Lever: pre-edit blast-radius advisory appended to write/edit tool_results. */
  readonly editGuard: EditGuardConfig
  /** Lever: post-edit graph verification (dangling refs / stale callers / unresolved imports). Requires liveGraphSync. */
  readonly postEditVerify: boolean
  /** Lever: end-of-turn completion gate nagging on unresolved high-severity findings. */
  readonly completionGateEnabled: boolean
  /** Max end-of-turn gate cycles per session (backstop against nagging loops). */
  readonly completionGateMaxIterations: number
  /** Minimum finding severity that can trigger the gate. */
  readonly completionGateMinSeverity: 'high' | 'medium' | 'low'
}

export const GRAPH_DIR_NAME = '.graphcode'
export const CONFIG_FILE_NAME = 'graphcode.json'

const DEFAULT_EDIT_GUARD: EditGuardConfig = {
  enabled: true,
  minImpactedFiles: 2,
  topFiles: 5,
  topCoChanges: 3,
  maxSymbolsPerFile: 40,
  depth: undefined,
}

const DEFAULTS = {
  model: process.env.GRAPHCODE_MODEL ?? 'claude-sonnet-5',
  contextPackTokens: 6000,
  maxCommits: 2000,
  ignore: [] as readonly string[],
  workspaceRepos: [] as readonly string[],
  // All reliability levers default off: the harness behaves exactly as before
  // until a user opts in via graphcode.json. editGuard.enabled defaults true but
  // is gated on liveGraphSync in computeEditGuardAdvisory — so with liveGraphSync
  // off (the default) it never fires, and turning liveGraphSync on bundles the
  // advisory in automatically without a second flag. Net: zero behavior change
  // for a user who hasn't opted into anything.
  liveGraphSync: false,
  editGuard: DEFAULT_EDIT_GUARD,
  postEditVerify: false,
  completionGateEnabled: false,
  completionGateMaxIterations: 2,
  completionGateMinSeverity: 'high' as const,
}

interface ConfigFile {
  readonly model?: string
  readonly contextPackTokens?: number
  readonly maxCommits?: number
  readonly ignore?: readonly string[]
  readonly workspaceRepos?: readonly string[]
  readonly liveGraphSync?: boolean
  readonly editGuard?: Partial<EditGuardConfig>
  readonly postEditVerify?: boolean
  readonly completionGateEnabled?: boolean
  readonly completionGateMaxIterations?: number
  readonly completionGateMinSeverity?: 'high' | 'medium' | 'low'
}

function mergeEditGuard(fromFile: Partial<EditGuardConfig> | undefined): EditGuardConfig {
  return {
    enabled: fromFile?.enabled ?? DEFAULT_EDIT_GUARD.enabled,
    minImpactedFiles: fromFile?.minImpactedFiles ?? DEFAULT_EDIT_GUARD.minImpactedFiles,
    topFiles: fromFile?.topFiles ?? DEFAULT_EDIT_GUARD.topFiles,
    topCoChanges: fromFile?.topCoChanges ?? DEFAULT_EDIT_GUARD.topCoChanges,
    maxSymbolsPerFile: fromFile?.maxSymbolsPerFile ?? DEFAULT_EDIT_GUARD.maxSymbolsPerFile,
    depth: fromFile?.depth ?? DEFAULT_EDIT_GUARD.depth,
  }
}

/** Load config for a repo root, merging graphcode.json when present. */
export function loadConfig(rootInput: string): GraphcodeConfig {
  const root = resolve(rootInput)
  const graphDir = join(root, GRAPH_DIR_NAME)
  const configPath = join(root, CONFIG_FILE_NAME)
  const fromFile: ConfigFile = existsSync(configPath)
    ? (JSON.parse(readFileSync(configPath, 'utf8')) as ConfigFile)
    : {}
  return {
    root,
    graphDir,
    dbPath: join(graphDir, 'graph.db'),
    model: fromFile.model ?? DEFAULTS.model,
    contextPackTokens: fromFile.contextPackTokens ?? DEFAULTS.contextPackTokens,
    maxCommits: fromFile.maxCommits ?? DEFAULTS.maxCommits,
    ignore: fromFile.ignore ?? DEFAULTS.ignore,
    workspaceRepos: fromFile.workspaceRepos ?? DEFAULTS.workspaceRepos,
    liveGraphSync: fromFile.liveGraphSync ?? DEFAULTS.liveGraphSync,
    editGuard: mergeEditGuard(fromFile.editGuard),
    postEditVerify: fromFile.postEditVerify ?? DEFAULTS.postEditVerify,
    completionGateEnabled: fromFile.completionGateEnabled ?? DEFAULTS.completionGateEnabled,
    completionGateMaxIterations: fromFile.completionGateMaxIterations ?? DEFAULTS.completionGateMaxIterations,
    completionGateMinSeverity: fromFile.completionGateMinSeverity ?? DEFAULTS.completionGateMinSeverity,
  }
}
