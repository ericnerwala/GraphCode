import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import type { GraphcodeConfig } from '../core/config.js'
import { fileBasename } from '../core/identifiers.js'
import type { GraphStore } from '../graph/store.js'
import type { EdgeKind, FileState, NewEdge, NewNode, SymbolKind } from '../graph/types.js'
import { extractFromTree } from './extractors/index.js'
import { hashContent } from './hash.js'
import { isTestPath, languageForPath, type IndexLanguage } from './languages.js'
import { getParserFor, initParsers } from './parser.js'
import {
  buildJavaPackageIndex,
  buildSymbolNameIndex,
  resolveGoPackageFiles,
  resolveImportPath,
  resolveJavaImportFiles,
  resolveRefTarget,
  type IndexedSymbolRef,
} from './resolve.js'
import { scanRepo, type ScannedFile } from './scanner.js'

export interface IndexResult {
  readonly repoId: number
  readonly filesIndexed: number
  readonly filesDeleted: number
  readonly symbols: number
  readonly edges: number
  readonly durationMs: number
}

export interface IndexOptions {
  readonly force?: boolean
  readonly onProgress?: (message: string) => void
}

const BATCH_SIZE = 200

function currentHeadSha(root: string): string | null {
  try {
    const out = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] })
    return out.toString().trim()
  } catch {
    return null
  }
}

export interface FileToIndex {
  readonly scanned: ScannedFile
  readonly hash: string
}

async function classifyChanges(
  files: readonly ScannedFile[],
  previous: ReadonlyMap<string, FileState>,
  force: boolean,
): Promise<{ changed: FileToIndex[]; unchangedPaths: Set<string> }> {
  const changed: FileToIndex[] = []
  const unchangedPaths = new Set<string>()
  for (const file of files) {
    const hash = hashContent(await readFile(file.absPath))
    const prior = previous.get(file.path)
    if (!force && prior && prior.hash === hash) {
      unchangedPaths.add(file.path)
      continue
    }
    changed.push({ scanned: file, hash })
  }
  return { changed, unchangedPaths }
}

export interface ParsedFile {
  readonly file: FileToIndex
  readonly language: IndexLanguage
  readonly source: string
  readonly loc: number
  readonly extraction: ReturnType<typeof extractFromTree>
}

export async function parseFiles(files: readonly FileToIndex[], onProgress?: (message: string) => void): Promise<ParsedFile[]> {
  await initParsers()
  const results: ParsedFile[] = []
  for (const file of files) {
    const def = languageForPath(file.scanned.path)
    if (!def) continue
    let source: string
    try {
      source = await readFile(file.scanned.absPath, 'utf8')
    } catch {
      continue
    }
    try {
      const parser = await getParserFor(def)
      const tree = parser.parse(source)
      const extraction = tree ? extractFromTree(def.language, tree) : { symbols: [], refs: [], imports: [] }
      results.push({ file, language: def.language, source, loc: source.split('\n').length, extraction })
    } catch (error) {
      onProgress?.(`warning: failed to parse ${file.scanned.path}: ${error instanceof Error ? error.message : String(error)}`)
      results.push({ file, language: def.language, source, loc: source.split('\n').length, extraction: { symbols: [], refs: [], imports: [] } })
    }
  }
  return results
}

export interface InsertedSymbol {
  readonly nodeId: number
  readonly bareName: string
  readonly qualifiedName: string
  readonly kind: SymbolKind
}

export interface InsertedFile {
  readonly path: string
  readonly fileNodeId: number
  readonly language: IndexLanguage
  readonly imports: readonly string[]
  readonly symbolIdByQualifiedName: Map<string, number>
  readonly symbols: readonly InsertedSymbol[]
  readonly refs: ParsedFile['extraction']['refs']
  /** Java's `package a.b.c;` declaration, when present (undefined for other languages). */
  readonly packageName?: string
}

/** Insert file + symbol nodes and contains edges for one parsed file. Returns bookkeeping for pass 2. */
export function insertFileGraph(store: GraphStore, repoId: number, parsed: ParsedFile): InsertedFile {
  const path = parsed.file.scanned.path
  const fileNode: NewNode = {
    kind: 'file',
    name: basename(path),
    filePath: path,
    language: parsed.language,
    meta: { loc: parsed.loc },
  }
  const fileNodeId = store.insertNode(repoId, fileNode)

  const symbolIdByQualifiedName = new Map<string, number>()
  const symbolIdByBareName = new Map<string, number>()
  const symbols: InsertedSymbol[] = []
  const edges: NewEdge[] = []

  for (const symbol of parsed.extraction.symbols) {
    const node: NewNode = {
      kind: 'symbol',
      subkind: symbol.kind,
      name: symbol.name,
      qualifiedName: symbol.qualifiedName,
      filePath: path,
      startLine: symbol.startLine,
      endLine: symbol.endLine,
      language: parsed.language,
      signature: symbol.signature,
      doc: symbol.doc,
      exported: symbol.exported,
    }
    const nodeId = store.insertNode(repoId, node)
    symbolIdByQualifiedName.set(symbol.qualifiedName, nodeId)
    // Last-write-wins for bare-name lookup within a file; qualifiedName is the precise key.
    symbolIdByBareName.set(symbol.name, nodeId)
    symbols.push({ nodeId, bareName: symbol.name, qualifiedName: symbol.qualifiedName, kind: symbol.kind })

    if (symbol.parentName) {
      const parentId = symbolIdByQualifiedName.get(symbol.parentName) ?? symbolIdByBareName.get(symbol.parentName)
      edges.push({ src: parentId ?? fileNodeId, dst: nodeId, kind: 'contains' })
    } else {
      edges.push({ src: fileNodeId, dst: nodeId, kind: 'contains' })
    }
  }

  store.insertEdges(repoId, edges)

  return {
    path,
    fileNodeId,
    language: parsed.language,
    imports: parsed.extraction.imports.map((i) => i.raw),
    symbolIdByQualifiedName,
    symbols,
    refs: parsed.extraction.refs,
    packageName: parsed.extraction.packageName,
  }
}

/** Build the flat list of (name -> nodeId, filePath) for every symbol inserted this run. */
export function collectIndexedSymbols(inserted: readonly InsertedFile[]): IndexedSymbolRef[] {
  const refs: IndexedSymbolRef[] = []
  for (const file of inserted) {
    for (const symbol of file.symbols) {
      refs.push({ nodeId: symbol.nodeId, name: symbol.bareName, filePath: file.path, kind: symbol.kind, qualifiedName: symbol.qualifiedName })
    }
  }
  return refs
}

function findEnclosingSymbolId(file: InsertedFile, fromSymbolName: string | null): number | undefined {
  if (fromSymbolName === null) return undefined
  if (file.symbolIdByQualifiedName.has(fromSymbolName)) return file.symbolIdByQualifiedName.get(fromSymbolName)
  for (const [qualifiedName, nodeId] of file.symbolIdByQualifiedName) {
    const simple = qualifiedName.includes('.') ? (qualifiedName.split('.').at(-1) ?? qualifiedName) : qualifiedName
    if (simple === fromSymbolName) return nodeId
  }
  return undefined
}

/** Resolve imports (file->file edges) and refs (calls/extends/implements/references) for one file. */
export function resolveFileEdges(
  store: GraphStore,
  repoId: number,
  repoRoot: string,
  file: InsertedFile,
  allPathsIncludingUnchanged: ReadonlySet<string>,
  indexedSymbols: readonly IndexedSymbolRef[],
  symbolsByName: ReadonlyMap<string, readonly IndexedSymbolRef[]>,
  javaPackagesByName: ReadonlyMap<string, readonly string[]>,
  javaPackageNameByFile: ReadonlyMap<string, string>,
): { edgeCount: number; importedFiles: Set<string> } {
  const importedFiles = new Set<string>()
  let edgeCount = 0

  for (const raw of file.imports) {
    // A Go import path or Java import both name a PACKAGE (directory), not a
    // single file (Java: only for wildcard imports; a plain `import a.b.C;`
    // still resolves to the one file for class C in that package's dir(s)) —
    // resolve against module/package-relative paths rather than "./relative".
    const resolvedPaths =
      file.language === 'go'
        ? resolveGoPackageFiles(raw, repoRoot, allPathsIncludingUnchanged)
        : file.language === 'java'
          ? resolveJavaImportFiles(raw, javaPackagesByName, allPathsIncludingUnchanged)
          : (() => {
              const resolved = resolveImportPath(raw, file.path, file.language, allPathsIncludingUnchanged)
              return resolved ? [resolved] : []
            })()

    for (const resolved of resolvedPaths) {
      if (resolved === file.path) continue
      importedFiles.add(resolved)
      const targetFileNode = store.fileNode(repoId, resolved)
      if (targetFileNode) {
        store.insertEdge(repoId, { src: file.fileNodeId, dst: targetFileNode.id, kind: 'imports' })
        edgeCount += 1
      }
    }
  }

  for (const ref of file.refs) {
    const srcId = findEnclosingSymbolId(file, ref.fromSymbol) ?? file.fileNodeId
    const targetId = resolveRefTarget(ref.name, file.path, importedFiles, {
      store,
      repoId,
      indexedSymbols,
      symbolsByName,
      language: file.language,
      packageName: file.packageName,
      packageNameByFile: javaPackageNameByFile,
    })
    if (targetId !== undefined && targetId !== srcId) {
      store.insertEdge(repoId, { src: srcId, dst: targetId, kind: ref.kind })
      edgeCount += 1
    } else if (targetId === undefined) {
      store.addPendingRef(repoId, { srcNode: srcId, name: ref.name, kind: ref.kind })
    }
  }

  return { edgeCount, importedFiles }
}

/** Group paths by extension-less basename, for O(1) tested-file candidate lookup. */
export function buildBasenameIndex(allPaths: readonly string[]): Map<string, readonly string[]> {
  const index = new Map<string, string[]>()
  for (const path of allPaths) {
    const key = fileBasename(path)
    const bucket = index.get(key)
    if (bucket) bucket.push(path)
    else index.set(key, [path])
  }
  return index
}

/** Basename-based test-file heuristic: foo.test.ts -> foo.ts, preferring same/nearest directory. */
export function findTestedFilePath(
  testPath: string,
  allPaths: readonly string[],
  basenameIndex?: Map<string, readonly string[]>,
): string | undefined {
  const testBase = fileBasename(testPath)
  const strippedBase = testBase
    .replace(/[._-](test|spec)s?$/i, '') // foo.test, foo_test, foo-spec
    .replace(/^test[._-]/i, '') // test.foo, test_foo
    .replace(/Tests?$/, '') // JUnit-style FooTest / FooTests (camelCase, no separator)
  if (!strippedBase || strippedBase === testBase) return undefined

  const testDir = testPath.includes('/') ? testPath.slice(0, testPath.lastIndexOf('/')) : ''
  const candidates = basenameIndex
    ? (basenameIndex.get(strippedBase) ?? [])
    : allPaths.filter((path) => fileBasename(path) === strippedBase)
  const matches = candidates.filter((path) => path !== testPath)
  if (matches.length === 0) return undefined
  if (matches.length === 1) return matches[0]

  const sameDir = matches.filter((path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '') === testDir)
  if (sameDir.length >= 1) return sameDir[0]

  const scored = matches
    .map((path) => ({ path, dir: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '' }))
    .sort((a, b) => commonPrefixLength(b.dir, testDir) - commonPrefixLength(a.dir, testDir))
  return scored[0]?.path
}

function commonPrefixLength(a: string, b: string): number {
  const aParts = a.split('/')
  const bParts = b.split('/')
  let count = 0
  while (count < aParts.length && count < bParts.length && aParts[count] === bParts[count]) count += 1
  return count
}

function insertTestEdges(store: GraphStore, repoId: number, inserted: readonly InsertedFile[], allPaths: readonly string[]): number {
  let edgeCount = 0
  const basenameIndex = buildBasenameIndex(allPaths)
  for (const file of inserted) {
    if (!isTestPath(file.path)) continue
    const testedPath = findTestedFilePath(file.path, allPaths, basenameIndex)
    if (!testedPath) continue
    const testedFileNode = store.fileNode(repoId, testedPath)
    if (!testedFileNode) continue
    store.insertEdge(repoId, { src: file.fileNodeId, dst: testedFileNode.id, kind: 'tests' })
    edgeCount += 1

    const testedSymbolsByName = new Map(store.nodesForFile(repoId, testedPath).map((n) => [n.name, n]))
    for (const ref of file.refs) {
      const targetNode = testedSymbolsByName.get(ref.name)
      if (!targetNode) continue
      const srcId = findEnclosingSymbolId(file, ref.fromSymbol) ?? file.fileNodeId
      if (targetNode.id !== srcId) {
        store.insertEdge(repoId, { src: srcId, dst: targetNode.id, kind: 'tests' })
        edgeCount += 1
      }
    }
  }
  return edgeCount
}

function dirOf(path: string): string {
  const idx = path.lastIndexOf('/')
  return idx === -1 ? '' : path.slice(0, idx)
}

const PENDING_TYPE_DECL_KINDS: ReadonlySet<SymbolKind> = new Set(['class', 'interface', 'enum', 'struct', 'trait'])

/**
 * Collapse the same class-vs-own-constructor name collision handled in
 * resolveRefTarget (see resolve.ts's preferTypeOverOwnConstructor) for
 * pending-ref re-resolution, which disambiguates independently.
 */
function preferTypeOverOwnConstructor(targets: readonly IndexedSymbolRef[]): readonly IndexedSymbolRef[] {
  const typeDeclFiles = new Set(targets.filter((t) => t.kind && PENDING_TYPE_DECL_KINDS.has(t.kind)).map((t) => t.filePath))
  if (typeDeclFiles.size === 0) return targets
  return targets.filter((t) => t.kind !== 'method' || !typeDeclFiles.has(t.filePath))
}

/** Pick the best target when a pending ref's name matches multiple newly-inserted symbols. */
function pickPendingTarget(rawTargets: readonly IndexedSymbolRef[], srcFilePath: string | undefined): IndexedSymbolRef | undefined {
  const targets = preferTypeOverOwnConstructor(rawTargets)
  if (targets.length === 1) return targets[0]
  if (srcFilePath === undefined) return undefined
  const srcDir = dirOf(srcFilePath)
  const sameDir = targets.filter((t) => dirOf(t.filePath) === srcDir)
  return sameDir.length === 1 ? sameDir[0] : undefined
}

/** Index the run's symbols by bare name once, so pending-ref resolution is O(pending) not O(pending·symbols). */
function indexTargetsByName(indexedSymbols: readonly IndexedSymbolRef[]): Map<string, IndexedSymbolRef[]> {
  const targetsByName = new Map<string, IndexedSymbolRef[]>()
  for (const symbol of indexedSymbols) {
    const bucket = targetsByName.get(symbol.name)
    if (bucket) bucket.push(symbol)
    else targetsByName.set(symbol.name, [symbol])
  }
  return targetsByName
}

/**
 * Resolve every pending ref for one name against the run's newly-inserted
 * symbols, inserting the edge and clearing the pending rows for that name.
 * Shared by the full-run (reresolvePendingRefs) and scoped
 * (reresolvePendingRefsForNames) paths so they never diverge in how they
 * pick a target or when they clear the pending table.
 */
function resolvePendingRowsForName(
  store: GraphStore,
  repoId: number,
  name: string,
  targets: readonly IndexedSymbolRef[],
): number {
  if (targets.length === 0) return 0
  const pending = store.pendingRefsByName(repoId, name)
  if (pending.length === 0) return 0

  let resolvedCount = 0
  let anyResolved = false
  for (const ref of pending) {
    const srcFilePath = store.getNode(ref.srcNode)?.filePath
    const target = pickPendingTarget(targets, srcFilePath)
    if (!target || ref.srcNode === target.nodeId) continue
    store.insertEdge(repoId, { src: ref.srcNode, dst: target.nodeId, kind: ref.kind as EdgeKind })
    resolvedCount += 1
    anyResolved = true
  }
  if (anyResolved) store.raw('DELETE FROM pending_refs WHERE repo_id = ? AND name = ?', [repoId, name])
  return resolvedCount
}

/** Re-resolve pending refs whose target name now exists among newly inserted symbols. */
export function reresolvePendingRefs(store: GraphStore, repoId: number, indexedSymbols: readonly IndexedSymbolRef[]): number {
  // Index symbols by name once — a per-name filter over all symbols is O(n²)
  // and unusable at monorepo scale (observed: 12.5k-file corpus never finished).
  const targetsByName = indexTargetsByName(indexedSymbols)
  const pendingNameRows = store.raw('SELECT DISTINCT name FROM pending_refs WHERE repo_id = ?', [repoId]) as Array<{
    name: string
  }>
  let resolvedCount = 0
  for (const { name } of pendingNameRows) {
    resolvedCount += resolvePendingRowsForName(store, repoId, name, targetsByName.get(name) ?? [])
  }
  return resolvedCount
}

/**
 * Same mechanism as reresolvePendingRefs, but scoped to a caller-supplied name
 * set so single-file live sync never re-scans pending_refs for names unrelated
 * to the file just edited. indexRepo keeps using the unscoped variant (a full
 * run wants every pending name anyway); live sync passes only the edited file's
 * added/removed symbol names, keeping the pending scan O(this-file) at
 * monorepo scale.
 */
export function reresolvePendingRefsForNames(
  store: GraphStore,
  repoId: number,
  names: readonly string[],
  indexedSymbols: readonly IndexedSymbolRef[],
): number {
  if (names.length === 0) return 0
  const targetsByName = indexTargetsByName(indexedSymbols)
  const uniqueNames = [...new Set(names)]
  const placeholders = uniqueNames.map(() => '?').join(',')
  const pendingNameRows = store.raw(
    `SELECT DISTINCT name FROM pending_refs WHERE repo_id = ? AND name IN (${placeholders})`,
    [repoId, ...uniqueNames],
  ) as Array<{ name: string }>
  let resolvedCount = 0
  for (const { name } of pendingNameRows) {
    resolvedCount += resolvePendingRowsForName(store, repoId, name, targetsByName.get(name) ?? [])
  }
  return resolvedCount
}

/**
 * Index (or incrementally re-index) one repository's code layer: scans files,
 * diffs by content hash, parses changed files with tree-sitter, extracts
 * symbols/refs/imports, and writes the resulting subgraph into the store.
 */
export async function indexRepo(store: GraphStore, config: GraphcodeConfig, options: IndexOptions = {}): Promise<IndexResult> {
  const startedAt = Date.now()
  const onProgress = options.onProgress
  const force = options.force ?? false

  const repo = store.upsertRepo(basename(config.root), config.root)
  onProgress?.(`scanning ${config.root}`)
  const { codeFiles } = await scanRepo(config.root, { extraIgnore: config.ignore })
  const previousStates = store.getFileStates(repo.id)

  const currentPaths = new Set(codeFiles.map((f) => f.path))
  const deletedPaths = [...previousStates.keys()].filter((path) => !currentPaths.has(path))

  const { changed } = await classifyChanges(codeFiles, previousStates, force)
  onProgress?.(`indexing ${changed.length} changed file(s), ${deletedPaths.length} deleted`)

  let symbolCount = 0
  let edgeCount = 0
  let filesIndexed = 0

  store.transaction(() => {
    for (const path of deletedPaths) {
      store.deleteFileGraph(repo.id, path)
      store.deleteFileState(repo.id, path)
    }
  })

  const insertedAll: InsertedFile[] = []

  for (let i = 0; i < changed.length; i += BATCH_SIZE) {
    const batch = changed.slice(i, i + BATCH_SIZE)
    const parsed = await parseFiles(batch, onProgress)

    store.transaction(() => {
      for (const file of batch) {
        store.deleteFileGraph(repo.id, file.scanned.path)
      }
      for (const p of parsed) {
        const inserted = insertFileGraph(store, repo.id, p)
        insertedAll.push(inserted)
        symbolCount += p.extraction.symbols.length
        filesIndexed += 1
      }
    })
  }

  const indexedSymbols = collectIndexedSymbols(insertedAll)
  const allPaths = [...currentPaths]

  const symbolsByName = buildSymbolNameIndex(indexedSymbols)
  // Java package name -> source directories, and its inverse, built once per
  // run (not per-ref) from every Java file's parsed `package` declaration —
  // mirrors the once-per-run go.mod module-path lookup used for Go.
  const javaPackageNameByFile = new Map<string, string>()
  for (const file of insertedAll) {
    if (file.language === 'java' && file.packageName) javaPackageNameByFile.set(file.path, file.packageName)
  }
  const javaPackagesByName = buildJavaPackageIndex(javaPackageNameByFile)
  // Edge resolution AND file-state commit happen in one transaction. file_state
  // is the incremental-sync source of truth ("this file's hash is done"), so we
  // must not mark a file done until its edges are also committed — otherwise an
  // interruption between the two would leave the file looking up-to-date while
  // its call/import/reference edges are silently missing forever.
  const changedByHash = new Map(changed.map((f) => [f.scanned.path, f]))
  store.transaction(() => {
    for (const file of insertedAll) {
      const { edgeCount: fileEdges } = resolveFileEdges(
        store,
        repo.id,
        config.root,
        file,
        currentPaths,
        indexedSymbols,
        symbolsByName,
        javaPackagesByName,
        javaPackageNameByFile,
      )
      edgeCount += fileEdges
    }
    edgeCount += insertTestEdges(store, repo.id, insertedAll, allPaths)
    edgeCount += reresolvePendingRefs(store, repo.id, indexedSymbols)
    for (const file of insertedAll) {
      const source = changedByHash.get(file.path)
      if (source) {
        store.upsertFileState(repo.id, {
          path: file.path,
          hash: source.hash,
          size: source.scanned.size,
          mtime: source.scanned.mtime,
        })
      }
    }
  })

  const headSha = currentHeadSha(config.root)
  store.setRepoIndexed(repo.id, headSha, Date.now())

  return {
    repoId: repo.id,
    filesIndexed,
    filesDeleted: deletedPaths.length,
    symbols: symbolCount,
    edges: edgeCount,
    durationMs: Date.now() - startedAt,
  }
}
