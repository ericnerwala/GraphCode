// Core domain model for the GraphCode knowledge graph.
// Every layer (code, git, docs, features) stores into one node/edge space so
// traversal and ranking work uniformly across layers.

export type NodeKind = 'file' | 'symbol' | 'commit' | 'doc' | 'feature'

export type SymbolKind =
  | 'function'
  | 'method'
  | 'class'
  | 'interface'
  | 'type'
  | 'enum'
  | 'struct'
  | 'trait'
  | 'impl'
  | 'variable'
  | 'constant'
  | 'module'

export type EdgeKind =
  // code layer
  | 'contains' // file -> symbol, symbol -> nested symbol
  | 'calls' // symbol -> symbol
  | 'imports' // file -> file
  | 'extends' // symbol -> symbol
  | 'implements' // symbol -> symbol
  | 'references' // symbol -> symbol (non-call use: type refs, reads)
  | 'tests' // test file/symbol -> tested file/symbol
  // git layer
  | 'touched_by' // file -> commit
  | 'co_change' // file <-> file (weight = confidence)
  // knowledge layer
  | 'mentions' // doc -> file | doc -> symbol
  | 'in_feature' // commit -> feature, file -> feature

export interface NewNode {
  readonly kind: NodeKind
  readonly subkind?: string
  readonly name: string
  readonly qualifiedName?: string
  readonly filePath?: string
  readonly startLine?: number
  readonly endLine?: number
  readonly language?: string
  readonly signature?: string
  readonly doc?: string
  readonly exported?: boolean
  readonly meta?: Record<string, unknown>
}

export interface GraphNode extends NewNode {
  readonly id: number
  readonly repoId: number
}

export interface NewEdge {
  readonly src: number
  readonly dst: number
  readonly kind: EdgeKind
  readonly weight?: number
  readonly meta?: Record<string, unknown>
}

export interface GraphEdge extends NewEdge {
  readonly id: number
  readonly repoId: number
}

export interface RepoInfo {
  readonly id: number
  readonly name: string
  readonly root: string
  readonly headSha: string | null
  readonly indexedAt: number | null
}

export interface FileState {
  readonly path: string
  readonly hash: string
  readonly size: number
  readonly mtime: number
}

/** A cross-file reference recorded at extraction time, re-resolved on sync. */
export interface PendingRef {
  readonly srcNode: number
  readonly name: string
  readonly kind: EdgeKind
}

export interface SearchHit {
  readonly node: GraphNode
  readonly score: number
}

export interface Neighbor {
  readonly node: GraphNode
  readonly edge: GraphEdge
  readonly direction: 'out' | 'in'
}

export interface GraphStats {
  readonly repos: number
  readonly files: number
  readonly symbols: number
  readonly commits: number
  readonly docs: number
  readonly features: number
  readonly edges: number
  readonly edgesByKind: Record<string, number>
  readonly languages: Record<string, number>
}
