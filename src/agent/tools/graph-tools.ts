// Graph query tools. These must NEVER throw to the model: on failure or an empty
// result they return a short steering message that nudges the model back toward
// a different graph query or a file-based fallback, rather than aborting the turn.

import type { GraphStore } from '../../graph/store.js'
import type { GraphNode } from '../../graph/types.js'
import type { ExploreResult, ImpactResult, TraversalHit } from '../../query/query-types.js'
import type { QueryApi } from '../query-api.js'

function steer(label: string, query: string): string {
  return `No graph match for ${label} "${query}" - try graph_search with different terms, or fall back to list_dir/read_file.`
}

function safely(label: string, query: string, fn: () => string): string {
  try {
    const result = fn()
    return result.trim().length > 0 ? result : steer(label, query)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return `graph ${label} failed for "${query}": ${message}\n\n${steer(label, query)}`
  }
}

function describeNode(node: GraphNode): string {
  const loc = node.filePath ? `${node.filePath}${node.startLine ? `:${node.startLine}` : ''}` : '(no file)'
  return `${node.kind}${node.subkind ? `/${node.subkind}` : ''} ${node.qualifiedName ?? node.name} — ${loc}`
}

function describeHit(hit: TraversalHit): string {
  const loc = hit.file ? `${hit.file}${hit.line ? `:${hit.line}` : ''}` : '(no file)'
  return `${hit.symbol} — ${loc} (depth ${hit.depth}, via ${hit.viaPath.join(' -> ')})`
}

/** Resolve a name to a node, or return null with the caller responsible for
 * steering. Prefers the primary match; falls back to the best alternative kind. */
function resolveOrNull(api: QueryApi, store: GraphStore, name: string): GraphNode | null {
  return api.resolveSymbol(store, name).node
}

export interface GraphSearchInput {
  readonly query: string
}

export function graphSearch(api: QueryApi, store: GraphStore, input: GraphSearchInput): string {
  return safely('search', input.query, () => {
    const result = api.resolveSymbol(store, input.query)
    const nodes = [result.node, ...result.alternatives].filter((n): n is GraphNode => n !== null)
    if (nodes.length === 0) return ''
    return nodes.map(describeNode).join('\n')
  })
}

export interface GraphExploreInput {
  readonly symbols: readonly string[]
}

export function graphExplore(api: QueryApi, store: GraphStore, root: string, input: GraphExploreInput): string {
  const label = input.symbols.join(', ')
  return safely('explore', label, () => renderExploreResult(api.explore(store, root, input.symbols)))
}

function renderExploreResult(result: ExploreResult): string {
  const lines: string[] = []
  for (const path of result.paths) {
    if (path.found) {
      const chain = path.edges.map((e) => `${e.from.name} --${e.kind}--> ${e.to.name}`).join('\n  ')
      lines.push(`${path.from} -> ${path.to}:\n  ${chain}`)
    } else {
      lines.push(`${path.from} -> ${path.to}: no path found`)
    }
  }
  for (const sym of result.symbols) {
    lines.push('')
    lines.push(`### ${sym.node.qualifiedName ?? sym.node.name} (${sym.node.filePath ?? 'unknown'}:${sym.node.startLine ?? '?'})`)
    if (sym.source) {
      lines.push('```')
      lines.push(sym.source)
      if (sym.truncated) lines.push('… [truncated]')
      lines.push('```')
    }
  }
  return lines.join('\n')
}

export interface GraphCallersInput {
  readonly symbol: string
  readonly depth?: number
}

export function graphCallers(api: QueryApi, store: GraphStore, input: GraphCallersInput): string {
  return safely('callers', input.symbol, () => {
    const target = resolveOrNull(api, store, input.symbol)
    if (!target) return ''
    const hits = api.findCallers(store, target, { depth: input.depth })
    return hits.map(describeHit).join('\n')
  })
}

export interface GraphCalleesInput {
  readonly symbol: string
  readonly depth?: number
}

export function graphCallees(api: QueryApi, store: GraphStore, input: GraphCalleesInput): string {
  return safely('callees', input.symbol, () => {
    const target = resolveOrNull(api, store, input.symbol)
    if (!target) return ''
    const hits = api.findCallees(store, target, { depth: input.depth })
    return hits.map(describeHit).join('\n')
  })
}

export interface GraphImpactInput {
  readonly target: string
  readonly depth?: number
}

export function graphImpact(api: QueryApi, store: GraphStore, root: string, input: GraphImpactInput): string {
  return safely('impact', input.target, () => {
    const target = resolveOrNull(api, store, input.target)
    if (!target) return ''
    return renderImpactResult(api.impactAnalysis(store, root, target, { depth: input.depth }))
  })
}

function renderImpactResult(result: ImpactResult): string {
  const lines: string[] = [`Impact of ${result.target.qualifiedName ?? result.target.name}:`]
  for (const file of result.files) {
    lines.push(`- [${file.tier}] ${file.filePath} (rank ${file.rank.toFixed(2)}, ${file.symbols.join(', ')})`)
  }
  if (result.coChanges.length > 0) {
    lines.push('')
    lines.push('History suggests co-changes:')
    for (const co of result.coChanges) {
      lines.push(`- ${co.filePath} co-changes with ${co.withFile} (weight ${co.weight.toFixed(2)})`)
    }
  }
  return lines.join('\n')
}

export interface GraphContextInput {
  readonly task: string
}

export function graphContext(
  api: QueryApi,
  store: GraphStore,
  root: string,
  input: GraphContextInput,
  budgetTokens: number,
): string {
  return safely('context', input.task, () => api.buildContextPack(store, root, input.task, budgetTokens).markdown)
}
