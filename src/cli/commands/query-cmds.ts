import type { Command } from 'commander'
import { existsSync } from 'node:fs'
import { loadConfig, type GraphcodeConfig } from '../../core/config.js'
import { GraphcodeError, NotIndexedError } from '../../core/errors.js'
import { print } from '../../core/output.js'
import { GraphStore } from '../../graph/store.js'
import type { GraphNode } from '../../graph/types.js'
import {
  resolveSymbol,
  findCallers,
  findCallees,
  explore,
  impactAnalysis,
  buildContextPack,
} from '../../query/index.js'
import type { ExploreResult, ImpactResult, TraversalHit } from '../../query/query-types.js'
import { openWorkspace, workspaceSearch, workspaceImpact, closeWorkspace } from '../../workspace/federation.js'

interface BaseOptions {
  readonly path: string
  readonly json?: boolean
}

function requireStore(config: GraphcodeConfig): GraphStore {
  if (!existsSync(config.dbPath)) throw new NotIndexedError(config.root)
  return GraphStore.open(config.dbPath)
}

function emit<T>(json: boolean | undefined, data: T, humanize: (data: T) => void): void {
  if (json) {
    print(JSON.stringify(data, null, 2))
    return
  }
  humanize(data)
}

/** Resolve a name/path to a node or raise a friendly error. Shared by every
 * command that takes a symbol/target argument, since the query layer works
 * against resolved GraphNodes rather than bare strings. */
function resolveOrThrow(store: GraphStore, nameOrPath: string): GraphNode {
  const result = resolveSymbol(store, nameOrPath)
  if (!result.node) {
    throw new GraphcodeError(`no match for "${nameOrPath}"`, 'Try `graphcode search` to find the right name.')
  }
  return result.node
}

function describeNode(node: GraphNode): string {
  const loc = node.filePath ? `${node.filePath}${node.startLine ? `:${node.startLine}` : ''}` : '(no file)'
  return `[${node.kind}${node.subkind ? `/${node.subkind}` : ''}] ${node.qualifiedName ?? node.name} — ${loc}`
}

function printSearchHits(hits: readonly { node: GraphNode; score: number }[]): void {
  if (hits.length === 0) {
    print('no matches')
    return
  }
  for (const hit of hits) print(`${hit.score.toFixed(2)}  ${describeNode(hit.node)}`)
}

function printTraversalHits(hits: readonly TraversalHit[]): void {
  if (hits.length === 0) {
    print('none')
    return
  }
  for (const hit of hits) {
    const loc = hit.file ? `${hit.file}${hit.line ? `:${hit.line}` : ''}` : '(no file)'
    print(`  depth ${hit.depth}  ${hit.symbol} — ${loc}  (via ${hit.viaPath.join(' -> ')})`)
  }
}

function printImpactResult(result: ImpactResult): void {
  print(`impact of ${result.target.qualifiedName ?? result.target.name}:`)
  if (result.files.length === 0) print('  no impacted files found')
  for (const file of result.files) {
    print(`  [${file.tier}] ${file.filePath} (rank ${file.rank.toFixed(2)}, ${file.symbols.join(', ')})`)
  }
  if (result.coChanges.length > 0) {
    print('')
    print('history suggests co-changes:')
    for (const co of result.coChanges) {
      print(`  ${co.filePath} co-changes with ${co.withFile} (weight ${co.weight.toFixed(2)})`)
    }
  }
}

function printExploreResult(result: ExploreResult): void {
  for (const path of result.paths) {
    if (path.found) {
      const chain = path.edges.map((e) => `${e.from.name} --${e.kind}--> ${e.to.name}`).join('\n    ')
      print(`${path.from} -> ${path.to}:\n    ${chain}`)
    } else {
      print(`${path.from} -> ${path.to}: no path found`)
    }
  }
  for (const sym of result.symbols) {
    print('')
    print(`### ${sym.node.qualifiedName ?? sym.node.name} (${sym.node.filePath ?? 'unknown'}:${sym.node.startLine ?? '?'})`)
    if (sym.source) {
      print(sym.source)
      if (sym.truncated) print('… [truncated]')
    }
  }
}

export function registerQueryCommands(program: Command): void {
  program
    .command('search <query>')
    .description('Full-text search the knowledge graph')
    .option('--path <dir>', 'repo root', process.cwd())
    .option('--json', 'machine-readable output')
    .option('--workspace', 'search across all workspace member repos')
    .action((query: string, options: BaseOptions & { workspace?: boolean }) => {
      const config = loadConfig(options.path)
      if (options.workspace && config.workspaceRepos.length > 0) {
        const workspace = openWorkspace(config)
        try {
          const hits = workspaceSearch(workspace, query)
          emit(options.json, hits, () => {
            if (hits.length === 0) {
              print('no matches')
              return
            }
            for (const hit of hits) print(`${hit.score.toFixed(2)}  [${hit.repo}] ${describeNode(hit.node)}`)
          })
        } finally {
          closeWorkspace(workspace)
        }
        return
      }
      const store = requireStore(config)
      try {
        const hits = store.search(query)
        emit(options.json, hits, printSearchHits)
      } finally {
        store.close()
      }
    })

  program
    .command('callers <symbol>')
    .description('Find callers of a symbol')
    .option('--path <dir>', 'repo root', process.cwd())
    .option('--depth <n>', 'traversal depth', (v) => Number.parseInt(v, 10), 1)
    .option('--json', 'machine-readable output')
    .action((symbol: string, options: BaseOptions & { depth: number }) => {
      const config = loadConfig(options.path)
      const store = requireStore(config)
      try {
        const target = resolveOrThrow(store, symbol)
        const hits = findCallers(store, target, { depth: options.depth })
        emit(options.json, hits, printTraversalHits)
      } finally {
        store.close()
      }
    })

  program
    .command('callees <symbol>')
    .description('Find callees of a symbol')
    .option('--path <dir>', 'repo root', process.cwd())
    .option('--depth <n>', 'traversal depth', (v) => Number.parseInt(v, 10), 1)
    .option('--json', 'machine-readable output')
    .action((symbol: string, options: BaseOptions & { depth: number }) => {
      const config = loadConfig(options.path)
      const store = requireStore(config)
      try {
        const target = resolveOrThrow(store, symbol)
        const hits = findCallees(store, target, { depth: options.depth })
        emit(options.json, hits, printTraversalHits)
      } finally {
        store.close()
      }
    })

  program
    .command('impact <target>')
    .description('Impact analysis: what breaks if this symbol/file changes')
    .option('--path <dir>', 'repo root', process.cwd())
    .option('--depth <n>', 'traversal depth', (v) => Number.parseInt(v, 10), 2)
    .option('--limit <n>', 'max results', (v) => Number.parseInt(v, 10), 50)
    .option('--json', 'machine-readable output')
    .option('--workspace', 'analyze impact across all workspace member repos')
    .action((targetName: string, options: BaseOptions & { depth: number; limit: number; workspace?: boolean }) => {
      const config = loadConfig(options.path)
      if (options.workspace && config.workspaceRepos.length > 0) {
        const workspace = openWorkspace(config)
        try {
          const results = workspaceImpact(workspace, targetName, { depth: options.depth, limit: options.limit })
          emit(options.json, results, () => {
            if (results.length === 0) {
              print(`no match for "${targetName}" in any workspace repo`)
              return
            }
            for (const entry of results) {
              print(`--- ${entry.repo} ---`)
              printImpactResult(entry.result)
            }
          })
        } finally {
          closeWorkspace(workspace)
        }
        return
      }
      const store = requireStore(config)
      try {
        const target = resolveOrThrow(store, targetName)
        const result = impactAnalysis(store, config.root, target, { depth: options.depth, limit: options.limit })
        emit(options.json, result, printImpactResult)
      } finally {
        store.close()
      }
    })

  program
    .command('explore <symbols...>')
    .description('Explore the neighborhood of one or more symbols/files')
    .option('--path <dir>', 'repo root', process.cwd())
    .option('--json', 'machine-readable output')
    .action((symbols: string[], options: BaseOptions) => {
      const config = loadConfig(options.path)
      const store = requireStore(config)
      try {
        const result = explore(store, config.root, symbols)
        emit(options.json, result, printExploreResult)
      } finally {
        store.close()
      }
    })

  program
    .command('context <task...>')
    .description('Print the turn-0 context pack for a task description')
    .option('--path <dir>', 'repo root', process.cwd())
    .option('--budget <tokens>', 'token budget', (v) => Number.parseInt(v, 10))
    .option('--json', 'machine-readable output')
    .action((task: string[], options: BaseOptions & { budget?: number }) => {
      const config = loadConfig(options.path)
      const store = requireStore(config)
      try {
        const pack = buildContextPack(store, config.root, task.join(' '), options.budget ?? config.contextPackTokens)
        emit(options.json, pack, () => print(pack.markdown))
      } finally {
        store.close()
      }
    })

  program
    .command('resolve <symbol>')
    .description('Resolve a symbol name to graph node(s)')
    .option('--path <dir>', 'repo root', process.cwd())
    .option('--json', 'machine-readable output')
    .action((symbol: string, options: BaseOptions) => {
      const config = loadConfig(options.path)
      const store = requireStore(config)
      try {
        const result = resolveSymbol(store, symbol)
        emit(options.json, result, () => {
          if (!result.node) {
            print(`no match for "${symbol}"`)
            return
          }
          print(describeNode(result.node))
          for (const alt of result.alternatives) print(`  alt: ${describeNode(alt)}`)
        })
      } finally {
        store.close()
      }
    })
}
