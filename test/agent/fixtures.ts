// Test-only fixtures for the agent module: a temp GraphStore seeded with a
// tiny call graph, plus real fixture source files in a temp root dir so file
// tools (read/write/edit/list_dir) exercise real filesystem behavior.

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GraphStore } from '../../src/graph/store.js'
import { loadConfig } from '../../src/core/config.js'
import type { GraphcodeConfig } from '../../src/core/config.js'

export interface AgentFixture {
  readonly root: string
  readonly dbDir: string
  readonly store: GraphStore
  readonly config: GraphcodeConfig
  readonly repoId: number
  readonly nodeIds: { readonly main: number; readonly helper: number }
}

/** Builds: a repo root dir with real source files (main.ts calls helper()),
 * and a GraphStore with matching symbol nodes + a 'calls' edge. */
export function makeAgentFixture(): AgentFixture {
  const root = mkdtempSync(join(tmpdir(), 'graphcode-agent-root-'))
  const dbDir = mkdtempSync(join(tmpdir(), 'graphcode-agent-db-'))
  const store = GraphStore.open(join(dbDir, 'graph.db'))

  writeFile(root, 'src/main.ts', "import { helper } from './helper.js'\n\nexport function main(): void {\n  helper()\n}\n")
  writeFile(root, 'src/helper.ts', 'export function helper(): number {\n  return 42\n}\n')
  writeFile(root, 'README.md', '# Fixture repo\n')

  const repo = store.upsertRepo('fixture', root)
  const mainFile = store.insertNode(repo.id, {
    kind: 'file',
    name: 'main.ts',
    filePath: 'src/main.ts',
    language: 'typescript',
  })
  const helperFile = store.insertNode(repo.id, {
    kind: 'file',
    name: 'helper.ts',
    filePath: 'src/helper.ts',
    language: 'typescript',
  })
  const main = store.insertNode(repo.id, {
    kind: 'symbol',
    subkind: 'function',
    name: 'main',
    qualifiedName: 'main',
    filePath: 'src/main.ts',
    startLine: 3,
    endLine: 5,
    language: 'typescript',
    signature: 'function main(): void',
    exported: true,
  })
  const helper = store.insertNode(repo.id, {
    kind: 'symbol',
    subkind: 'function',
    name: 'helper',
    qualifiedName: 'helper',
    filePath: 'src/helper.ts',
    startLine: 1,
    endLine: 3,
    language: 'typescript',
    signature: 'function helper(): number',
    exported: true,
  })
  store.insertEdge(repo.id, { src: mainFile, dst: main, kind: 'contains' })
  store.insertEdge(repo.id, { src: helperFile, dst: helper, kind: 'contains' })
  store.insertEdge(repo.id, { src: main, dst: helper, kind: 'calls' })

  const config = loadConfig(root)
  return { root, dbDir, store, config, repoId: repo.id, nodeIds: { main, helper } }
}

function writeFile(root: string, relPath: string, content: string): void {
  const fullPath = join(root, relPath)
  mkdirSync(join(fullPath, '..'), { recursive: true })
  writeFileSync(fullPath, content, 'utf8')
}
