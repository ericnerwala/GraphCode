// Shared test fixtures: builds synthetic graphs directly via GraphStore in
// temp dirs, no indexer dependency.

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { GraphStore } from '../../src/graph/store.js'
import type { NodeKind } from '../../src/graph/types.js'

export function makeTempStore(): { dir: string; store: GraphStore } {
  const dir = mkdtempSync(join(tmpdir(), 'graphcode-query-'))
  const store = GraphStore.open(join(dir, 'graph.db'))
  return { dir, store }
}

export function writeFixtureFile(root: string, relPath: string, content: string): void {
  const fullPath = join(root, relPath)
  mkdirSync(dirname(fullPath), { recursive: true })
  writeFileSync(fullPath, content, 'utf8')
}

interface SymbolSpec {
  readonly name: string
  readonly filePath: string
  readonly startLine?: number
  readonly endLine?: number
  readonly kind?: NodeKind
  readonly signature?: string
  readonly exported?: boolean
}

/** Insert a file node + a symbol node contained in it. Returns both ids. */
export function insertSymbol(
  store: GraphStore,
  repoId: number,
  spec: SymbolSpec,
): { fileId: number; symbolId: number } {
  let fileId = store.fileNode(repoId, spec.filePath)?.id
  if (fileId === undefined) {
    fileId = store.insertNode(repoId, { kind: 'file', name: spec.filePath, filePath: spec.filePath, language: 'typescript' })
  }
  const symbolId = store.insertNode(repoId, {
    kind: spec.kind ?? 'symbol',
    subkind: 'function',
    name: spec.name,
    qualifiedName: spec.name,
    filePath: spec.filePath,
    startLine: spec.startLine ?? 1,
    endLine: spec.endLine ?? (spec.startLine ?? 1) + 2,
    signature: spec.signature ?? `function ${spec.name}()`,
    language: 'typescript',
    exported: spec.exported ?? true,
  })
  store.insertEdge(repoId, { src: fileId, dst: symbolId, kind: 'contains' })
  return { fileId, symbolId }
}

/**
 * Diamond call graph:
 *   top -> left -> bottom
 *   top -> right -> bottom
 * Each symbol lives in its own file (a.ts, b.ts, c.ts, d.ts).
 */
export function buildDiamondGraph(store: GraphStore): {
  repoId: number
  top: number
  left: number
  right: number
  bottom: number
} {
  const repo = store.upsertRepo('diamond', '/tmp/diamond')
  const top = insertSymbol(store, repo.id, { name: 'top', filePath: 'a.ts', startLine: 1 }).symbolId
  const left = insertSymbol(store, repo.id, { name: 'left', filePath: 'b.ts', startLine: 1 }).symbolId
  const right = insertSymbol(store, repo.id, { name: 'right', filePath: 'c.ts', startLine: 1 }).symbolId
  const bottom = insertSymbol(store, repo.id, { name: 'bottom', filePath: 'd.ts', startLine: 1 }).symbolId

  store.insertEdge(repo.id, { src: top, dst: left, kind: 'calls' })
  store.insertEdge(repo.id, { src: top, dst: right, kind: 'calls' })
  store.insertEdge(repo.id, { src: left, dst: bottom, kind: 'calls' })
  store.insertEdge(repo.id, { src: right, dst: bottom, kind: 'calls' })

  return { repoId: repo.id, top, left, right, bottom }
}
