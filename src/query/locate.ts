// Best-effort target resolution shared by every query command: turns a name
// or path typed by a human ("Foo", "src/foo.ts", "pkg/Foo.bar") into a graph
// node, so `graphcode impact Foo` just works without exact-match ceremony.

import type { GraphStore } from '../graph/store.js'
import type { GraphNode } from '../graph/types.js'
import type { ResolveResult } from './query-types.js'

const RESOLVE_LIMIT = 20

/**
 * Resolution order: exact name/qualified-name match -> FTS fallback over
 * symbols and files -> exact file-path match. The first tier that produces
 * any hit wins; `alternatives` carries the rest of that tier (never mixes
 * tiers, so callers can trust `node` is the best candidate from the
 * strongest tier that matched).
 */
export function resolveSymbol(store: GraphStore, nameOrPath: string): ResolveResult {
  const query = nameOrPath.trim()
  if (query.length === 0) return { node: null, alternatives: [] }

  const exact = store.findNodesByName(query, { limit: RESOLVE_LIMIT })
  if (exact.length > 0) {
    return { node: pickBest(exact), alternatives: exact.filter((n) => n !== pickBest(exact)) }
  }

  const byPath = findByFilePath(store, query)
  if (byPath.length > 0) {
    return { node: pickBest(byPath), alternatives: byPath.filter((n) => n !== pickBest(byPath)) }
  }

  const hits = store.search(query, { limit: RESOLVE_LIMIT })
  if (hits.length > 0) {
    const nodes = hits.map((h) => h.node)
    return { node: nodes[0] ?? null, alternatives: nodes.slice(1) }
  }

  return { node: null, alternatives: [] }
}

function findByFilePath(store: GraphStore, query: string): GraphNode[] {
  const normalized = query.replaceAll('\\', '/')
  let rows: Array<{ id: number }>
  try {
    // An extremely long query can make SQLite throw on the LIKE pattern
    // (rather than just return no rows) — treat that as no-match for this
    // tier instead of crashing the whole resolve.
    rows = store.raw(`SELECT id FROM nodes WHERE kind = 'file' AND (file_path = ? OR file_path LIKE ?) LIMIT ?`, [
      normalized,
      `%/${normalized}`,
      RESOLVE_LIMIT,
    ]) as Array<{ id: number }>
  } catch {
    return []
  }
  const nodes: GraphNode[] = []
  for (const row of rows) {
    const node = store.getNode(row.id)
    if (node) nodes.push(node)
  }
  return nodes
}

/** Prefer exported symbols, then symbols over files, then shortest qualified name
 * (usually the least-nested / most "canonical" definition). */
function pickBest(nodes: readonly GraphNode[]): GraphNode | null {
  if (nodes.length === 0) return null
  const sorted = [...nodes].sort((a, b) => {
    if (a.exported !== b.exported) return a.exported ? -1 : 1
    if (a.kind !== b.kind) return a.kind === 'symbol' ? -1 : 1
    const aLen = a.qualifiedName?.length ?? a.name.length
    const bLen = b.qualifiedName?.length ?? b.name.length
    return aLen - bLen
  })
  return sorted[0] ?? null
}
