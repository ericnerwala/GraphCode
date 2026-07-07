// Injection seam for the query layer (src/query/**). Declared here with the exact
// signatures the query module exports, so the dispatcher can depend on an
// interface (tests stub it) while defaulting to the real implementations.

import type { GraphStore } from '../graph/store.js'
import type {
  ContextPack,
  ExploreResult,
  ImpactResult,
  ResolveResult,
  TraversalHit,
} from '../query/query-types.js'

export type { ContextPack }

export interface TraversalOptions {
  readonly depth?: number
  readonly limit?: number
}

export interface ExploreOptions {
  readonly maxHops?: number
  readonly maxSnippetLines?: number
}

export interface ImpactOptions {
  readonly depth?: number
  readonly limit?: number
}

/** The query-layer surface the agent tools depend on. Real implementations live in
 * '../query/index.js'; tests inject a stub satisfying this shape. Note that
 * findCallers/findCallees/impactAnalysis take a resolved GraphNode, not a bare
 * name string — callers must resolveSymbol() first. */
export interface QueryApi {
  resolveSymbol(store: GraphStore, nameOrPath: string): ResolveResult
  findCallers(store: GraphStore, target: import('../graph/types.js').GraphNode, opts?: TraversalOptions): TraversalHit[]
  findCallees(store: GraphStore, target: import('../graph/types.js').GraphNode, opts?: TraversalOptions): TraversalHit[]
  explore(store: GraphStore, root: string, names: readonly string[], opts?: ExploreOptions): ExploreResult
  impactAnalysis(
    store: GraphStore,
    root: string,
    target: import('../graph/types.js').GraphNode,
    opts?: ImpactOptions,
  ): ImpactResult
  buildContextPack(store: GraphStore, root: string, task: string, budgetTokens: number): ContextPack
}
