import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

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
}

export const GRAPH_DIR_NAME = '.graphcode'
export const CONFIG_FILE_NAME = 'graphcode.json'

const DEFAULTS = {
  model: process.env.GRAPHCODE_MODEL ?? 'claude-sonnet-5',
  contextPackTokens: 6000,
  maxCommits: 2000,
  ignore: [] as readonly string[],
  workspaceRepos: [] as readonly string[],
}

interface ConfigFile {
  readonly model?: string
  readonly contextPackTokens?: number
  readonly maxCommits?: number
  readonly ignore?: readonly string[]
  readonly workspaceRepos?: readonly string[]
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
  }
}
