import { readFileSync } from 'node:fs'
import { dirname, join, normalize } from 'node:path'
import type { GraphStore } from '../graph/store.js'
import type { GraphNode, SymbolKind } from '../graph/types.js'
import type { IndexLanguage } from './languages.js'

/** A symbol inserted during this indexing run, keyed for fast local lookup. */
export interface IndexedSymbolRef {
  readonly nodeId: number
  readonly name: string
  readonly filePath: string
  /**
   * The symbol's kind, when known. Used to break a same-name tie between a
   * type declaration and a method of the same name — most notably Java,
   * where a constructor is extracted with the class's own name, so every
   * class with an explicit constructor has two same-named symbols in one
   * file (e.g. class `Foo` + constructor `Foo`). A bare reference like
   * `new Foo()` or `Foo.staticMethod()` should resolve to the class, not
   * be left ambiguous by its own constructor.
   */
  readonly kind?: SymbolKind
  /**
   * The symbol's dotted qualified name, when known. Used to prefer a
   * top-level declaration (qualifiedName === name) over a same-named nested
   * type (qualifiedName has a "." prefix, e.g. Outer.Foo) when a bare ref
   * name is otherwise ambiguous — `import a.b.Foo;` conventionally names the
   * top-level type, not an unrelated same-named nested member elsewhere.
   */
  readonly qualifiedName?: string
}

const RESOLVE_EXTENSIONS_BY_LANGUAGE: Record<IndexLanguage, readonly string[]> = {
  typescript: ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts'],
  tsx: ['.tsx', '.ts', '.jsx', '.js'],
  javascript: ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx'],
  python: ['.py'],
  go: ['.go'],
  java: ['.java'],
  rust: ['.rs'],
}

const INDEX_BASENAMES = ['index', '__init__', 'mod']

/**
 * TS/JS ESM imports conventionally reference the compiled-output extension
 * (e.g. `import './base.js'`) even though the source file on disk uses a
 * TS extension (`base.ts`). Map each such runtime extension to the source
 * extensions it should resolve against, tried in order.
 */
const RUNTIME_EXTENSION_SWAPS: Record<string, readonly string[]> = {
  '.js': ['.ts', '.tsx', '.js', '.jsx'],
  '.jsx': ['.tsx', '.jsx'],
  '.mjs': ['.mts', '.mjs'],
  '.cjs': ['.cts', '.cjs'],
}

/**
 * Resolve a relative import/use string (./foo, ../bar) to a repo-relative path
 * that exists among `knownPaths`. Returns undefined for bare package imports
 * (external dependencies) or when no match is found.
 */
export function resolveImportPath(
  raw: string,
  fromFile: string,
  language: IndexLanguage,
  knownPaths: ReadonlySet<string>,
): string | undefined {
  if (!raw.startsWith('.') && !raw.startsWith('/')) return undefined // bare/package import: external

  const fromDir = dirname(fromFile)
  const base = raw.startsWith('/') ? raw.slice(1) : normalize(join(fromDir, raw)).split('\\').join('/')

  const candidates: string[] = []
  const extensions = RESOLVE_EXTENSIONS_BY_LANGUAGE[language]
  // Exact match (import already has an extension, or is an extensionless language like Go dirs).
  candidates.push(base)
  for (const ext of extensions) candidates.push(`${base}${ext}`)
  for (const indexName of INDEX_BASENAMES) {
    for (const ext of extensions) candidates.push(`${base}/${indexName}${ext}`)
  }
  // Swap a runtime extension (./base.js) for the source extensions it may
  // have been compiled from (base.ts, base.tsx, ...).
  const runtimeExt = extensions.find((ext) => base.endsWith(ext) && RUNTIME_EXTENSION_SWAPS[ext])
  if (runtimeExt) {
    const withoutExt = base.slice(0, -runtimeExt.length)
    for (const swapExt of RUNTIME_EXTENSION_SWAPS[runtimeExt] ?? []) candidates.push(`${withoutExt}${swapExt}`)
  }

  for (const candidate of candidates) {
    if (knownPaths.has(candidate)) return candidate
  }
  return undefined
}

const GO_MOD_CAP = 20

/** Cache of repo root -> parsed go.mod module path, since it's read-only-once per index run. */
const goModuleCache = new Map<string, string | undefined>()

/** Read the `module` line from go.mod at the repo root, caching per root for the run. */
function readGoModule(repoRoot: string): string | undefined {
  if (goModuleCache.has(repoRoot)) return goModuleCache.get(repoRoot)
  let moduleName: string | undefined
  try {
    const contents = readFileSync(join(repoRoot, 'go.mod'), 'utf8')
    const match = /^module\s+(\S+)/m.exec(contents)
    moduleName = match?.[1]
  } catch {
    moduleName = undefined
  }
  goModuleCache.set(repoRoot, moduleName)
  return moduleName
}

/** Clear the cached go.mod lookup (test-only escape hatch; each index run re-reads once). */
export function clearGoModuleCache(): void {
  goModuleCache.clear()
}

/**
 * Resolve a Go import path ("github.com/mod/internal/foo") to the repo-relative
 * .go files in the target package directory. A Go import always targets a
 * PACKAGE (a directory), never a single file — so unlike other languages this
 * can fan out to several files, capped to keep the edge count sane on wide
 * packages.
 */
export function resolveGoPackageFiles(
  raw: string,
  repoRoot: string,
  knownPaths: ReadonlySet<string>,
): readonly string[] {
  const moduleName = readGoModule(repoRoot)
  if (!moduleName || !raw.startsWith(moduleName)) return [] // external/stdlib import: not in this repo
  const rest = raw.slice(moduleName.length).replace(/^\/+/, '')
  const dirPrefix = rest.length > 0 ? `${rest}/` : ''
  const matches = [...knownPaths].filter((path) => path.startsWith(dirPrefix) && path.endsWith('.go') && dirOf(path) === rest)
  return matches.slice(0, GO_MOD_CAP)
}

/**
 * Java import paths name either a class (`import a.b.C;`) or, with a
 * wildcard, an entire package (`import a.b.*;`, encoded by the extractor as
 * raw text `a.b.*`). Both are resolved against a package -> directories map
 * built once per index run (see buildJavaPackageIndex), since Java's package
 * layout is derived from each file's own `package` declaration rather than a
 * single repo-root manifest like Go's go.mod.
 */
export function resolveJavaImportFiles(
  raw: string,
  packagesByName: ReadonlyMap<string, readonly string[]>,
  knownPaths: ReadonlySet<string>,
): readonly string[] {
  const isWildcard = raw.endsWith('.*')
  const body = isWildcard ? raw.slice(0, -2) : raw
  const lastDot = body.lastIndexOf('.')
  if (lastDot === -1) return [] // no package qualifier: default-package import, not resolvable

  if (isWildcard) {
    // A wildcard import legitimately fans out to every file in the package,
    // so cap it (mirrors Go's GO_MOD_CAP) to keep the edge count sane.
    return resolvePackageFiles(body, packagesByName, knownPaths).slice(0, GO_MOD_CAP)
  }

  // A single-class import always names exactly one file — filter by class
  // name over the FULL (uncapped) directory listing first, so a package
  // with >20 files doesn't silently drop a class outside the cap window
  // before its name is even checked.
  const packageName = body.slice(0, lastDot)
  const className = body.slice(lastDot + 1)
  const files = resolvePackageFiles(packageName, packagesByName, knownPaths)
  return files.filter((path) => fileBaseNameOf(path) === `${className}.java`)
}

function resolvePackageFiles(
  packageName: string,
  packagesByName: ReadonlyMap<string, readonly string[]>,
  knownPaths: ReadonlySet<string>,
): readonly string[] {
  const dirs = packagesByName.get(packageName)
  if (!dirs || dirs.length === 0) return []
  return [...knownPaths].filter((path) => path.endsWith('.java') && dirs.includes(dirOf(path)))
}

function fileBaseNameOf(path: string): string {
  const idx = path.lastIndexOf('/')
  return idx === -1 ? path : path.slice(idx + 1)
}

/** Build a package name -> directories map from each Java file's parsed packageName, once per index run. */
export function buildJavaPackageIndex(
  filePackages: ReadonlyMap<string, string>,
): Map<string, readonly string[]> {
  const index = new Map<string, string[]>()
  for (const [filePath, packageName] of filePackages) {
    const dir = dirOf(filePath)
    const bucket = index.get(packageName)
    if (bucket) {
      if (!bucket.includes(dir)) bucket.push(dir)
    } else {
      index.set(packageName, [dir])
    }
  }
  return index
}

interface ResolveContext {
  readonly store: GraphStore
  readonly repoId: number
  /** Symbols inserted so far in this indexing run, across all files. */
  readonly indexedSymbols: readonly IndexedSymbolRef[]
  /**
   * Prebuilt name -> symbols index over indexedSymbols (see buildSymbolNameIndex).
   * Whole-repo callers must supply it: the fallback per-ref scan over
   * indexedSymbols is O(symbols) and turns quadratic across a full run.
   */
  readonly symbolsByName?: ReadonlyMap<string, readonly IndexedSymbolRef[]>
  /** Source language of the referencing file; enables Go's same-directory-as-import rule. */
  readonly language?: IndexLanguage
  /** Java package name of the referencing file, for the same-package visibility bonus. */
  readonly packageName?: string
  /** Java: file path -> package name, for looking up ref-target files' packages. */
  readonly packageNameByFile?: ReadonlyMap<string, string>
}

/** Index run symbols by name, once per indexing run. */
export function buildSymbolNameIndex(
  symbols: readonly IndexedSymbolRef[],
): Map<string, readonly IndexedSymbolRef[]> {
  const index = new Map<string, IndexedSymbolRef[]>()
  for (const symbol of symbols) {
    const bucket = index.get(symbol.name)
    if (bucket) bucket.push(symbol)
    else index.set(symbol.name, [symbol])
  }
  return index
}

/**
 * Precedence: (a) same file, (b) file imported by this file — for Go, also
 * same-directory files, and for Java, also same-package files (Java package
 * visibility spans every file whose `package` declaration matches, with no
 * import statement needed) — since a package/directory can hold several
 * same-named candidates, disambiguate in order: imported file, same
 * package, same directory — (c) unique repo-wide name match.
 */
export function resolveRefTarget(
  name: string,
  fromFile: string,
  importedFiles: ReadonlySet<string>,
  ctx: ResolveContext,
): number | undefined {
  const rawByName = ctx.symbolsByName?.get(name) ?? ctx.indexedSymbols.filter((s) => s.name === name)
  const byName = preferTypeOverOwnConstructor(rawByName)

  const sameFile = byName.filter((s) => s.filePath === fromFile)
  if (sameFile.length > 0) return sameFile[0]?.nodeId

  const sameDirBonus = ctx.language === 'go' ? dirOf(fromFile) : undefined
  const samePackageBonus = ctx.language === 'java' ? ctx.packageName : undefined
  const inImported = byName.filter(
    (s) =>
      importedFiles.has(s.filePath) ||
      (sameDirBonus !== undefined && dirOf(s.filePath) === sameDirBonus) ||
      (samePackageBonus !== undefined && ctx.packageNameByFile?.get(s.filePath) === samePackageBonus),
  )
  if (inImported.length === 1) return inImported[0]?.nodeId
  if (inImported.length > 1) return pickAmongCandidates(inImported, fromFile, importedFiles, samePackageBonus, ctx.packageNameByFile)?.nodeId

  // Repo-wide match: prefer the in-memory run index (full runs cover the whole
  // repo); fall back to the store only when this run didn't see the name at all
  // (incremental syncs, where the target lives in an unchanged file).
  if (byName.length === 1) return byName[0]?.nodeId
  if (byName.length > 1) return pickBySameDirectory(byName, fromFile)?.nodeId

  const stored = ctx.store.findNodesByName(name, { kinds: ['symbol'], limit: 50 })
  const candidates = stored.filter((n): n is GraphNode & { filePath: string } => n.filePath !== undefined)
  if (candidates.length === 1) return candidates[0]?.id
  if (candidates.length > 1) {
    const picked = pickBySameDirectoryNodes(candidates, fromFile)
    return picked?.id
  }
  return undefined
}

/**
 * Disambiguate among several same-named candidates already known to be
 * "in scope" (imported, same package, or same dir): prefer an actually
 * imported file first, then same-package, then same-directory.
 */
function pickAmongCandidates(
  symbols: readonly IndexedSymbolRef[],
  fromFile: string,
  importedFiles: ReadonlySet<string>,
  samePackageBonus: string | undefined,
  packageNameByFile: ReadonlyMap<string, string> | undefined,
): IndexedSymbolRef | undefined {
  const imported = symbols.filter((s) => importedFiles.has(s.filePath))
  if (imported.length === 1) return imported[0]
  if (imported.length > 1) {
    // Two different imported files each define something named `name` — e.g.
    // `import a.b.Foo;` and a second import whose file happens to contain an
    // unrelated *nested* type also named Foo (Outer.Foo). A bare `Foo`
    // reference means the top-level type, so prefer it over a nested one.
    const topLevel = imported.filter((s) => s.qualifiedName === undefined || s.qualifiedName === s.name)
    if (topLevel.length === 1) return topLevel[0]
  }

  if (samePackageBonus !== undefined && packageNameByFile) {
    const samePackage = symbols.filter((s) => packageNameByFile.get(s.filePath) === samePackageBonus)
    if (samePackage.length === 1) return samePackage[0]
  }

  return pickBySameDirectory(symbols, fromFile)
}

const TYPE_DECL_KINDS: ReadonlySet<SymbolKind> = new Set(['class', 'interface', 'enum', 'struct', 'trait'])

/**
 * Collapse a same-name, same-file collision between a type declaration and
 * its own constructor method (Java: `class Foo { Foo() {...} }` extracts two
 * symbols both named "Foo") down to the type declaration. Without this, a
 * bare reference like `new Foo()` sees two candidates in what should be a
 * single-match file and falls through to "ambiguous" instead of resolving.
 * Only applies when kind info is available (kind is optional on
 * IndexedSymbolRef in older/other call sites) and only drops the method
 * when a type-decl sibling of the same name exists in the same file.
 */
function preferTypeOverOwnConstructor(symbols: readonly IndexedSymbolRef[]): readonly IndexedSymbolRef[] {
  const typeDeclFiles = new Set(symbols.filter((s) => s.kind && TYPE_DECL_KINDS.has(s.kind)).map((s) => s.filePath))
  if (typeDeclFiles.size === 0) return symbols
  return symbols.filter((s) => s.kind !== 'method' || !typeDeclFiles.has(s.filePath))
}

function dirOf(path: string): string {
  const idx = path.lastIndexOf('/')
  return idx === -1 ? '' : path.slice(0, idx)
}

function pickBySameDirectory(symbols: readonly IndexedSymbolRef[], fromFile: string): IndexedSymbolRef | undefined {
  const fromDir = dirOf(fromFile)
  const sameDir = symbols.filter((s) => dirOf(s.filePath) === fromDir)
  return sameDir.length === 1 ? sameDir[0] : undefined
}

function pickBySameDirectoryNodes(
  nodes: readonly (GraphNode & { filePath: string })[],
  fromFile: string,
): GraphNode | undefined {
  const fromDir = dirOf(fromFile)
  const sameDir = nodes.filter((n) => dirOf(n.filePath) === fromDir)
  return sameDir.length === 1 ? sameDir[0] : undefined
}
