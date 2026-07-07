import type { SymbolKind } from '../graph/types.js'

/** A symbol (function/class/etc.) found within one file, before graph insertion. */
export interface ExtractedSymbol {
  readonly name: string
  readonly kind: SymbolKind
  readonly qualifiedName: string
  readonly startLine: number
  readonly endLine: number
  /** First line / declaration signature, trimmed. */
  readonly signature: string
  /** Leading comment/docstring, trimmed to ~200 chars. */
  readonly doc?: string
  readonly exported: boolean
  /** Name of the enclosing symbol, if this is nested (e.g. a method within a class). */
  readonly parentName?: string
}

/** A reference from one symbol (or module scope) to a named identifier. */
export interface ExtractedRef {
  /** Name of the enclosing symbol, or null if the reference occurs at module scope. */
  readonly fromSymbol: string | null
  readonly name: string
  readonly kind: 'calls' | 'extends' | 'implements' | 'references'
}

/** A raw import/use statement, before path resolution. */
export interface ExtractedImport {
  readonly raw: string
  readonly resolvedPath?: string
}

export interface FileExtraction {
  readonly symbols: readonly ExtractedSymbol[]
  readonly refs: readonly ExtractedRef[]
  readonly imports: readonly ExtractedImport[]
  /** Java's `package a.b.c;` declaration, when present. Unused by other languages. */
  readonly packageName?: string
}

export const EMPTY_EXTRACTION: FileExtraction = { symbols: [], refs: [], imports: [] }
