import type { Command } from 'commander'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig, type GraphcodeConfig } from '../../core/config.js'
import { print, printStatus } from '../../core/output.js'
import { GraphStore } from '../../graph/store.js'
import { indexRepo } from '../../index/indexer.js'
import { scanRepo } from '../../index/scanner.js'
import { ingestGitHistory } from '../../git/history.js'
import { ingestDocs } from '../../knowledge/specs.js'
import { ingestFeatures } from '../../knowledge/features.js'

export interface SyncOptions {
  readonly force?: boolean
  readonly noGit?: boolean
  readonly noDocs?: boolean
  readonly onProgress?: (message: string) => void
}

export interface SyncSummary {
  readonly repoId: number
  readonly filesIndexed: number
  readonly filesDeleted: number
  readonly symbols: number
  readonly edges: number
  readonly commits: number
  readonly touchEdges: number
  readonly cochangeEdges: number
  readonly docs: number
  readonly mentionEdges: number
  readonly features: number
  readonly featureEdges: number
  readonly durationMs: number
}

/**
 * Run the full sync pipeline (code index, git history, docs, features)
 * against an already-open store. Shared by the `index`/`sync` commands and
 * by `ensureIndexed` so every entry point refreshes the graph identically.
 */
async function runSyncPipeline(
  store: GraphStore,
  config: GraphcodeConfig,
  options: SyncOptions = {},
): Promise<SyncSummary> {
  const started = Date.now()
  const onProgress = options.onProgress ?? ((): void => undefined)

  const indexResult = await indexRepo(store, config, {
    force: options.force,
    onProgress,
  })

  let commits = 0
  let touchEdges = 0
  let cochangeEdges = 0
  let features = 0
  let featureEdges = 0
  let docs = 0
  let mentionEdges = 0

  const repo = store.getRepoByRoot(config.root)
  if (!repo) throw new Error(`repo not found after indexing: ${config.root}`)

  if (!options.noGit) {
    const gitResult = ingestGitHistory(store, repo, config, { onProgress })
    commits = gitResult.commits
    touchEdges = gitResult.touchEdges
    cochangeEdges = gitResult.cochangeEdges

    const featureResult = ingestFeatures(store, repo)
    features = featureResult.features
    featureEdges = featureResult.featureEdges
  }

  if (!options.noDocs) {
    const { docFiles } = await scanRepo(config.root, { extraIgnore: config.ignore })
    const docResult = ingestDocs(store, repo, config, docFiles, { onProgress })
    docs = docResult.docs
    mentionEdges = docResult.mentionEdges
  }

  return {
    repoId: indexResult.repoId,
    filesIndexed: indexResult.filesIndexed,
    filesDeleted: indexResult.filesDeleted,
    symbols: indexResult.symbols,
    edges: indexResult.edges,
    commits,
    touchEdges,
    cochangeEdges,
    docs,
    mentionEdges,
    features,
    featureEdges,
    durationMs: Date.now() - started,
  }
}

/**
 * Open the store for `config` and run the full sync pipeline. This is the
 * every-start refresh: `graphcode agent` and `graphcode mcp` both call this
 * before doing anything else so the graph is always fresh.
 */
export async function ensureIndexed(
  config: GraphcodeConfig,
  opts: SyncOptions = {},
): Promise<GraphStore> {
  mkdirSync(config.graphDir, { recursive: true })
  const store = GraphStore.open(config.dbPath)
  try {
    await runSyncPipeline(store, config, opts)
    return store
  } catch (error) {
    store.close()
    throw error
  }
}

function printSummary(summary: SyncSummary): void {
  print(
    `indexed ${summary.filesIndexed} files (${summary.filesDeleted} removed), ${summary.symbols} symbols, ${summary.edges} edges` +
      (summary.commits ? `, ${summary.commits} commits (${summary.touchEdges} touch, ${summary.cochangeEdges} co-change)` : '') +
      (summary.features ? `, ${summary.features} features` : '') +
      (summary.docs ? `, ${summary.docs} docs (${summary.mentionEdges} mentions)` : '') +
      ` in ${summary.durationMs}ms`,
  )
}

async function runIndex(
  path: string,
  options: { force?: boolean; git?: boolean; docs?: boolean },
): Promise<void> {
  const config = loadConfig(path)
  mkdirSync(config.graphDir, { recursive: true })
  const store = GraphStore.open(config.dbPath)
  try {
    const summary = await runSyncPipeline(store, config, {
      force: options.force,
      noGit: options.git === false,
      noDocs: options.docs === false,
      onProgress: (message) => printStatus(message),
    })
    printSummary(summary)
  } finally {
    store.close()
  }
}

async function runWorkspaceIndex(path: string): Promise<void> {
  const config = loadConfig(path)
  if (config.workspaceRepos.length === 0) {
    print('no workspaceRepos configured in graphcode.json')
    return
  }
  for (const member of config.workspaceRepos) {
    const memberRoot = join(config.root, member)
    printStatus(`indexing workspace member: ${member}`)
    const memberConfig = loadConfig(memberRoot)
    mkdirSync(memberConfig.graphDir, { recursive: true })
    const store = GraphStore.open(memberConfig.dbPath)
    try {
      const summary = await runSyncPipeline(store, memberConfig, {
        onProgress: (message) => printStatus(`  [${member}] ${message}`),
      })
      print(`${member}:`)
      printSummary(summary)
    } finally {
      store.close()
    }
  }
}

export function registerIndexCommands(program: Command): void {
  program
    .command('index')
    .description('Index the current repo into the GraphCode knowledge graph')
    .option('--path <dir>', 'repo root', process.cwd())
    .option('--force', 'reindex all files, ignoring incremental state')
    .option('--no-git', 'skip git history + feature ingestion')
    .option('--no-docs', 'skip docs ingestion')
    .action(async (options: { path: string; force?: boolean; git?: boolean; docs?: boolean }) => {
      await runIndex(options.path, options)
    })

  program
    .command('sync')
    .description('Incrementally sync the graph for the current repo (alias for index)')
    .option('--path <dir>', 'repo root', process.cwd())
    .option('--no-git', 'skip git history + feature ingestion')
    .option('--no-docs', 'skip docs ingestion')
    .action(async (options: { path: string; git?: boolean; docs?: boolean }) => {
      await runIndex(options.path, { ...options, force: false })
    })

  const workspace = program.command('workspace').description('Operate on a GraphCode workspace (multiple member repos)')

  workspace
    .command('index')
    .description('Index every member repo of a GraphCode workspace')
    .option('--path <dir>', 'workspace root', process.cwd())
    .action(async (options: { path: string }) => {
      await runWorkspaceIndex(options.path)
    })
}
