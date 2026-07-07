// Breadth-first caller/callee walks over 'calls' edges. Shared BFS core so
// the two directions stay symmetric and dedup/ordering semantics match.

import type { GraphStore } from '../graph/store.js'
import type { GraphNode } from '../graph/types.js'
import type { TraversalHit } from './query-types.js'

export interface TraverseOptions {
  readonly depth?: number
  readonly limit?: number
}

const DEFAULT_DEPTH = 1
const DEFAULT_LIMIT = 100

export function findCallers(store: GraphStore, target: GraphNode, options: TraverseOptions = {}): TraversalHit[] {
  return traverse(store, target, 'in', options)
}

export function findCallees(store: GraphStore, target: GraphNode, options: TraverseOptions = {}): TraversalHit[] {
  return traverse(store, target, 'out', options)
}

interface QueueItem {
  readonly node: GraphNode
  readonly depth: number
  readonly viaPath: readonly string[]
}

function traverse(
  store: GraphStore,
  target: GraphNode,
  direction: 'in' | 'out',
  options: TraverseOptions,
): TraversalHit[] {
  const maxDepth = options.depth ?? DEFAULT_DEPTH
  const limit = options.limit ?? DEFAULT_LIMIT

  const visited = new Set<number>([target.id])
  const results: TraversalHit[] = []
  let frontier: QueueItem[] = [{ node: target, depth: 0, viaPath: [target.name] }]

  for (let depth = 1; depth <= maxDepth && results.length < limit; depth++) {
    const next: QueueItem[] = []
    for (const item of frontier) {
      const neighbors = store.neighbors(item.node.id, { direction, kinds: ['calls'] })
      for (const neighbor of neighbors) {
        if (visited.has(neighbor.node.id)) continue
        visited.add(neighbor.node.id)
        const viaPath =
          direction === 'in' ? [neighbor.node.name, ...item.viaPath] : [...item.viaPath, neighbor.node.name]
        const hit: TraversalHit = {
          symbol: neighbor.node.name,
          file: neighbor.node.filePath,
          line: neighbor.node.startLine,
          depth,
          viaPath,
          node: neighbor.node,
        }
        results.push(hit)
        next.push({ node: neighbor.node, depth, viaPath })
        if (results.length >= limit) break
      }
      if (results.length >= limit) break
    }
    frontier = next
    if (frontier.length === 0) break
  }

  return results
    .slice(0, limit)
    .sort((a, b) => a.depth - b.depth || a.symbol.localeCompare(b.symbol))
}
