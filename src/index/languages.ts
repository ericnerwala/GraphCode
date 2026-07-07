// Language registry: maps file extensions to the tree-sitter grammar that
// parses them, plus heuristics for classifying test files.

export type IndexLanguage = 'typescript' | 'tsx' | 'javascript' | 'python' | 'go' | 'java' | 'rust'

export interface LanguageDef {
  readonly language: IndexLanguage
  /** Grammar wasm filename under node_modules/tree-sitter-wasms/out/. */
  readonly wasmFile: string
}

const EXTENSION_TO_LANGUAGE: Record<string, LanguageDef> = {
  '.ts': { language: 'typescript', wasmFile: 'tree-sitter-typescript.wasm' },
  '.mts': { language: 'typescript', wasmFile: 'tree-sitter-typescript.wasm' },
  '.cts': { language: 'typescript', wasmFile: 'tree-sitter-typescript.wasm' },
  '.tsx': { language: 'tsx', wasmFile: 'tree-sitter-tsx.wasm' },
  '.js': { language: 'javascript', wasmFile: 'tree-sitter-javascript.wasm' },
  '.jsx': { language: 'javascript', wasmFile: 'tree-sitter-javascript.wasm' },
  '.mjs': { language: 'javascript', wasmFile: 'tree-sitter-javascript.wasm' },
  '.cjs': { language: 'javascript', wasmFile: 'tree-sitter-javascript.wasm' },
  '.py': { language: 'python', wasmFile: 'tree-sitter-python.wasm' },
  '.pyi': { language: 'python', wasmFile: 'tree-sitter-python.wasm' },
  '.go': { language: 'go', wasmFile: 'tree-sitter-go.wasm' },
  '.java': { language: 'java', wasmFile: 'tree-sitter-java.wasm' },
  '.rs': { language: 'rust', wasmFile: 'tree-sitter-rust.wasm' },
}

/** All extensions the code-layer indexer will attempt to parse. */
export const SUPPORTED_EXTENSIONS: readonly string[] = Object.keys(EXTENSION_TO_LANGUAGE)

export function extensionOf(path: string): string {
  const base = path.split('/').at(-1) ?? path
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot).toLowerCase() : ''
}

/** Resolve a file path to its language definition, or null if unsupported. */
export function languageForPath(path: string): LanguageDef | null {
  return EXTENSION_TO_LANGUAGE[extensionOf(path)] ?? null
}

const TEST_NAME_PATTERNS: readonly RegExp[] = [
  /(^|[._-])test[._-]/i, // foo.test.ts, foo_test.py, foo-test.js
  /[._-]test$/i, // foo.test (no further extension segment)
  /(^|[._-])spec[._-]/i, // foo.spec.ts
  /[._-]spec$/i,
  /_test$/i, // go/python style: foo_test.go
  /Test\.java$/, // JUnit style: FooTest.java
  /Tests\.java$/,
]

const TEST_DIR_PATTERNS: readonly RegExp[] = [/(^|\/)__tests__(\/|$)/, /(^|\/)tests?(\/|$)/]

/** Heuristic classification of whether a repo-relative path is a test file. */
export function isTestPath(relativePath: string): boolean {
  const normalized = relativePath.replaceAll('\\', '/')
  const base = normalized.split('/').at(-1) ?? normalized
  const baseNoExt = base.includes('.') ? base.slice(0, base.lastIndexOf('.')) : base
  if (TEST_NAME_PATTERNS.some((pattern) => pattern.test(base) || pattern.test(baseNoExt))) return true
  return TEST_DIR_PATTERNS.some((pattern) => pattern.test(normalized))
}
