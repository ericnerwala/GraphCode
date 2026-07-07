// Public query API barrel.

export { resolveSymbol } from './locate.js'
export { findCallers, findCallees } from './traverse.js'
export type { TraverseOptions } from './traverse.js'
export { explore } from './explore.js'
export type { ExploreOptions } from './explore.js'
export { impactAnalysis } from './impact.js'
export type { ImpactOptions } from './impact.js'
export { rankCandidates, isTestFile, basenameOf, RANK_WEIGHTS } from './rank.js'
export type { RankWeights } from './rank.js'
export { buildContextPack } from './contextpack.js'
export type {
  ResolveResult,
  TraversalHit,
  PathEdge,
  ExploreSymbol,
  ExplorePath,
  ExploreResult,
  ImpactFile,
  RankedImpactFile,
  CoChangeHit,
  ImpactResult,
  RankSignals,
  RankedCandidate,
  RankCandidate,
  ContextPack,
} from './query-types.js'
