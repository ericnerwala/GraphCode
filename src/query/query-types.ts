// Shared result types for the query engine. Kept separate from graph/types.ts
// because these are query-layer *shapes* (derived/aggregated views), not
// persisted graph entities.

import type { EdgeKind, GraphNode } from '../graph/types.js'

/** Result of resolving a user-supplied name or path to a graph node. */
export interface ResolveResult {
  readonly node: GraphNode | null
  /** Other candidates considered, best-effort, excluding `node`. */
  readonly alternatives: readonly GraphNode[]
}

/** One entry in a caller/callee traversal. */
export interface TraversalHit {
  readonly symbol: string
  readonly file: string | undefined
  readonly line: number | undefined
  readonly depth: number
  /** Symbol names from the target to this hit, inclusive of both ends. */
  readonly viaPath: readonly string[]
  readonly node: GraphNode
}

/** One edge in an explore() path segment. */
export interface PathEdge {
  readonly from: GraphNode
  readonly to: GraphNode
  readonly kind: EdgeKind
}

/** A resolved symbol on an explore() path, with inlined source. */
export interface ExploreSymbol {
  readonly node: GraphNode
  readonly source: string | undefined
  readonly truncated: boolean
}

/** Shortest-path connection between two of the requested explore() names. */
export interface ExplorePath {
  readonly from: string
  readonly to: string
  readonly found: boolean
  readonly edges: readonly PathEdge[]
}

export interface ExploreResult {
  readonly resolved: Record<string, ResolveResult>
  readonly paths: readonly ExplorePath[]
  readonly symbols: readonly ExploreSymbol[]
}

/** Per-file aggregation used by impact analysis and ranking. */
export interface ImpactFile {
  readonly filePath: string
  readonly maxScore: number
  readonly hitCount: number
  readonly minDepth: number
  readonly direct: boolean
  readonly symbols: readonly string[]
}

/** A ranked impact file, decorated with the rank.ts score breakdown. */
export interface RankedImpactFile extends ImpactFile {
  readonly rank: number
  readonly tier: 'direct' | 'strong' | 'weak' | 'test'
  readonly signals: RankSignals
}

/** A file co-changing with a top-ranked impact file (secondary history section). */
export interface CoChangeHit {
  readonly filePath: string
  readonly withFile: string
  readonly weight: number
}

export interface ImpactResult {
  readonly target: GraphNode
  readonly files: readonly RankedImpactFile[]
  readonly coChanges: readonly CoChangeHit[]
}

/** Structural signal breakdown behind a rank.ts score (mirrors impact-ranker-v2). */
export interface RankSignals {
  readonly refs: number
  readonly direct: boolean
  readonly samePkg: boolean
  readonly nameMatch: boolean
  readonly isTest: boolean
}

export interface RankedCandidate {
  readonly filePath: string
  readonly score: number
  readonly tier: 'direct' | 'strong' | 'weak' | 'test'
  readonly signals: RankSignals
}

/** Input candidate for rank.ts: pre-aggregated per-file structural facts. */
export interface RankCandidate {
  readonly filePath: string
  readonly refs: number
  readonly direct: boolean
}

export interface ContextPack {
  readonly markdown: string
  readonly tokens: number
  readonly coreFiles: string[]
  readonly symbols: string[]
}
