// Connects a flow across named symbols: resolves each name, finds pairwise
// shortest paths (BFS over calls/imports/contains/references, both directions,
// bounded hops), unions the path nodes, and inlines verbatim source for each
// symbol on the path. Replaces a chain of file reads for "how does X reach Y".

import { readFileSync } from 'node:fs'
import { resolveInRoot } from '../agent/tools/path-safety.js'
import type { GraphStore } from '../graph/store.js'
import type { EdgeKind, GraphNode } from '../graph/types.js'
import { resolveSymbol } from './locate.js'
import type { ExplorePath, ExploreResult, ExploreSymbol, PathEdge, ResolveResult } from './query-types.js'

const EXPLORE_EDGE_KINDS: readonly EdgeKind[] = ['calls', 'imports', 'contains', 'references']
const MAX_HOPS = 4
const MAX_SNIPPET_LINES = 120

export interface ExploreOptions {
  readonly maxHops?: number
  readonly maxSnippetLines?: number
}

export function explore(store: GraphStore, root: string, names: readonly string[], opts: ExploreOptions = {}): ExploreResult {
  const maxHops = opts.maxHops ?? MAX_HOPS
  const maxSnippetLines = opts.maxSnippetLines ?? MAX_SNIPPET_LINES

  const resolved: Record<string, ResolveResult> = {}
  for (const name of names) resolved[name] = resolveSymbol(store, name)

  const paths: ExplorePath[] = []
  const pathNodeIds = new Set<number>()
  // Always include every resolved seed name, even when there is only one
  // name (no pairwise path to compute) or a name stands alone because its
  // neighbor failed to resolve.
  for (const name of names) {
    const node = resolved[name]?.node
    if (node) pathNodeIds.add(node.id)
  }
  for (let i = 0; i < names.length - 1; i++) {
    const fromName = names[i]
    const toName = names[i + 1]
    if (fromName === undefined || toName === undefined) continue
    const fromNode = resolved[fromName]?.node ?? null
    const toNode = resolved[toName]?.node ?? null
    if (!fromNode || !toNode) {
      paths.push({ from: fromName, to: toName, found: false, edges: [] })
      continue
    }
    const edges = shortestPath(store, fromNode, toNode, maxHops)
    if (edges) {
      for (const edge of edges) {
        pathNodeIds.add(edge.from.id)
        pathNodeIds.add(edge.to.id)
      }
      paths.push({ from: fromName, to: toName, found: true, edges })
    } else {
      pathNodeIds.add(fromNode.id)
      pathNodeIds.add(toNode.id)
      paths.push({ from: fromName, to: toName, found: false, edges: [] })
    }
  }

  const symbols: ExploreSymbol[] = []
  for (const id of pathNodeIds) {
    const node = store.getNode(id)
    if (!node) continue
    symbols.push(inlineSource(root, node, maxSnippetLines))
  }
  symbols.sort((a, b) => (a.node.filePath ?? '').localeCompare(b.node.filePath ?? '') || (a.node.startLine ?? 0) - (b.node.startLine ?? 0))

  return { resolved, paths, symbols }
}

/** Undirected BFS (both edge directions) over the explore edge kinds, bounded
 * by maxHops. Returns the edge sequence from `from` to `to`, or null. */
function shortestPath(store: GraphStore, from: GraphNode, to: GraphNode, maxHops: number): PathEdge[] | null {
  if (from.id === to.id) return []

  interface Frame {
    readonly node: GraphNode
    readonly edges: readonly PathEdge[]
  }

  const visited = new Set<number>([from.id])
  let frontier: Frame[] = [{ node: from, edges: [] }]

  for (let hop = 0; hop < maxHops; hop++) {
    const next: Frame[] = []
    for (const frame of frontier) {
      const neighbors = store.neighbors(frame.node.id, { direction: 'both', kinds: EXPLORE_EDGE_KINDS })
      for (const neighbor of neighbors) {
        if (visited.has(neighbor.node.id)) continue
        visited.add(neighbor.node.id)
        const edge: PathEdge =
          neighbor.direction === 'out'
            ? { from: frame.node, to: neighbor.node, kind: neighbor.edge.kind }
            : { from: neighbor.node, to: frame.node, kind: neighbor.edge.kind }
        const edges = [...frame.edges, edge]
        if (neighbor.node.id === to.id) return edges
        next.push({ node: neighbor.node, edges })
      }
    }
    frontier = next
    if (frontier.length === 0) break
  }
  return null
}

function inlineSource(root: string, node: GraphNode, maxLines: number): ExploreSymbol {
  if (!node.filePath || node.startLine === undefined) {
    return { node, source: undefined, truncated: false }
  }
  try {
    const fullPath = resolveInRoot(root, node.filePath)
    const content = readFileSync(fullPath, 'utf8')
    const lines = content.split('\n')
    const startIdx = Math.max(0, node.startLine - 1)
    const endIdx = Math.min(lines.length, node.endLine ?? node.startLine)
    const clampedEndIdx = Math.min(endIdx, startIdx + maxLines)
    const snippet = lines.slice(startIdx, clampedEndIdx).join('\n')
    return { node, source: snippet, truncated: endIdx > clampedEndIdx }
  } catch {
    // Covers PathEscapeError from resolveInRoot as well as ordinary
    // unreadable-file errors: omit the snippet, never throw.
    return { node, source: undefined, truncated: false }
  }
}
