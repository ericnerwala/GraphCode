import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../../src/core/config.js'
import { GraphStore } from '../../src/graph/store.js'
import { indexRepo } from '../../src/index/indexer.js'
import { wasmGrammarsLoad } from './helpers/wasm-support.js'

function write(root: string, relPath: string, content: string): void {
  const full = join(root, relPath)
  mkdirSync(full.slice(0, full.lastIndexOf('/')), { recursive: true })
  writeFileSync(full, content)
}

const canLoadWasm = await wasmGrammarsLoad()

describe('indexRepo (file-level orchestration)', () => {
  let root: string
  let store: GraphStore

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'graphcode-indexer-'))
    store = GraphStore.open(join(root, 'graph.db'))
  })

  afterEach(() => {
    store.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('indexes all code files on first run and creates file nodes', async () => {
    write(root, 'src/a.ts', 'export const a = 1')
    write(root, 'src/b.ts', 'export const b = 2')
    const config = loadConfig(root)
    const result = await indexRepo(store, config)

    expect(result.filesIndexed).toBe(2)
    expect(result.filesDeleted).toBe(0)
    expect(store.fileNode(result.repoId, 'src/a.ts')).not.toBeNull()
    expect(store.fileNode(result.repoId, 'src/b.ts')).not.toBeNull()
  })

  it('is idempotent: re-indexing unchanged files indexes nothing new', async () => {
    write(root, 'src/a.ts', 'export const a = 1')
    const config = loadConfig(root)
    await indexRepo(store, config)
    const second = await indexRepo(store, config)
    expect(second.filesIndexed).toBe(0)
    expect(second.filesDeleted).toBe(0)
  })

  it('incrementally reindexes only a changed file', async () => {
    write(root, 'src/a.ts', 'export const a = 1')
    write(root, 'src/b.ts', 'export const b = 2')
    const config = loadConfig(root)
    await indexRepo(store, config)

    write(root, 'src/a.ts', 'export const a = 999')
    const result = await indexRepo(store, config)
    expect(result.filesIndexed).toBe(1)
    expect(result.filesDeleted).toBe(0)
  })

  it('removes a file subgraph when the file is deleted from disk', async () => {
    write(root, 'src/a.ts', 'export const a = 1')
    write(root, 'src/b.ts', 'export const b = 2')
    const config = loadConfig(root)
    const first = await indexRepo(store, config)
    expect(store.fileNode(first.repoId, 'src/b.ts')).not.toBeNull()

    rmSync(join(root, 'src/b.ts'))
    const second = await indexRepo(store, config)
    expect(second.filesDeleted).toBe(1)
    expect(store.fileNode(second.repoId, 'src/b.ts')).toBeNull()
    expect(store.fileNode(second.repoId, 'src/a.ts')).not.toBeNull()
  })

  it('force reindexes every file even when unchanged', async () => {
    write(root, 'src/a.ts', 'export const a = 1')
    const config = loadConfig(root)
    await indexRepo(store, config)
    const result = await indexRepo(store, config, { force: true })
    expect(result.filesIndexed).toBe(1)
  })

  it('reports progress via onProgress instead of console.log', async () => {
    write(root, 'src/a.ts', 'export const a = 1')
    const config = loadConfig(root)
    const messages: string[] = []
    await indexRepo(store, config, { onProgress: (m) => messages.push(m) })
    expect(messages.some((m) => m.includes('scanning'))).toBe(true)
  })

  it('sets repo head sha to null for a non-git directory', async () => {
    write(root, 'src/a.ts', 'export const a = 1')
    const config = loadConfig(root)
    const result = await indexRepo(store, config)
    const repo = store.listRepos().find((r) => r.id === result.repoId)
    expect(repo?.headSha).toBeNull()
    expect(repo?.indexedAt).not.toBeNull()
  })

  it('respects extra ignore globs from config', async () => {
    write(root, 'src/a.ts', 'export const a = 1')
    write(root, 'vendor/skip.ts', 'export const skip = 1')
    const config = { ...loadConfig(root), ignore: ['vendor/'] }
    const result = await indexRepo(store, config)
    expect(result.filesIndexed).toBe(1)
    expect(store.fileNode(result.repoId, 'vendor/skip.ts')).toBeNull()
  })

  it('does not mark a file done until its edges are committed (crash-safety invariant)', async () => {
    // Simulate a crash during the edge-resolution transaction by making one of
    // its store calls throw. The transaction must roll back atomically — leaving
    // NO file_state rows — so a later sync reprocesses the files rather than
    // treating them as done-with-missing-edges.
    write(root, 'src/a.ts', 'export const a = 1')
    const config = loadConfig(root)

    const original = store.upsertFileState.bind(store)
    let calls = 0
    // Throw on the first file-state write, which now lives inside the same
    // transaction as edge resolution.
    store.upsertFileState = () => {
      calls += 1
      throw new Error('simulated crash mid-transaction')
    }

    await expect(indexRepo(store, config)).rejects.toThrow('simulated crash')
    store.upsertFileState = original

    // No file was marked done, so a fresh run re-indexes it.
    expect(store.getFileStates(1).size).toBe(0)
    const recovery = await indexRepo(store, config)
    expect(recovery.filesIndexed).toBe(1)
    expect(store.getFileStates(recovery.repoId).size).toBe(1)
    expect(calls).toBeGreaterThan(0)
  })
})

describe.skipIf(!canLoadWasm)('indexRepo (symbol/edge extraction)', () => {
  let root: string
  let store: GraphStore

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'graphcode-indexer-sym-'))
    store = GraphStore.open(join(root, 'graph.db'))
  })

  afterEach(() => {
    store.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('extracts symbols and calls edges across a small multi-file TS project', async () => {
    write(
      root,
      'src/base.ts',
      `export function helper(x: number): number {
  return x + 1
}
`,
    )
    write(
      root,
      'src/main.ts',
      `import { helper } from './base.js'

export function run(): number {
  return helper(41)
}
`,
    )
    const config = loadConfig(root)
    const result = await indexRepo(store, config)
    expect(result.symbols).toBeGreaterThanOrEqual(2)

    const mainFile = store.fileNode(result.repoId, 'src/main.ts')
    expect(mainFile).not.toBeNull()
    const importEdges = mainFile ? store.neighbors(mainFile.id, { direction: 'out', kinds: ['imports'] }) : []
    expect(importEdges.some((n) => n.node.filePath === 'src/base.ts')).toBe(true)

    const runSymbol = store.findNodesByName('run', { kinds: ['symbol'] })[0]
    expect(runSymbol).toBeDefined()
    if (runSymbol) {
      const calls = store.neighbors(runSymbol.id, { direction: 'out', kinds: ['calls'] })
      expect(calls.some((n) => n.node.name === 'helper')).toBe(true)
    }
  })

  it('connects a pending ref once the target file is indexed later', async () => {
    write(
      root,
      'src/main.ts',
      `import { helper } from './base.js'

export function run(): number {
  return helper(41)
}
`,
    )
    const config = loadConfig(root)
    const first = await indexRepo(store, config)
    const runSymbol = store.findNodesByName('run', { kinds: ['symbol'] })[0]
    expect(runSymbol).toBeDefined()
    // Without base.ts present, helper() should be a pending ref, not a resolved edge.
    if (runSymbol) {
      const calls = store.neighbors(runSymbol.id, { direction: 'out', kinds: ['calls'] })
      expect(calls).toHaveLength(0)
      expect(store.pendingRefsByName(first.repoId, 'helper').length).toBeGreaterThan(0)
    }

    write(
      root,
      'src/base.ts',
      `export function helper(x: number): number {
  return x + 1
}
`,
    )
    await indexRepo(store, config)
    if (runSymbol) {
      const calls = store.neighbors(runSymbol.id, { direction: 'out', kinds: ['calls'] })
      expect(calls.some((n) => n.node.name === 'helper')).toBe(true)
      expect(store.pendingRefsByName(first.repoId, 'helper')).toHaveLength(0)
    }
  })

  it('creates a tests edge from a test file to the file it tests', async () => {
    write(
      root,
      'src/math.ts',
      `export function add(a: number, b: number): number {
  return a + b
}
`,
    )
    write(
      root,
      'src/math.test.ts',
      `import { add } from './math.js'

add(1, 2)
`,
    )
    const config = loadConfig(root)
    const result = await indexRepo(store, config)
    const testFile = store.fileNode(result.repoId, 'src/math.test.ts')
    expect(testFile).not.toBeNull()
    if (testFile) {
      const testsEdges = store.neighbors(testFile.id, { direction: 'out', kinds: ['tests'] })
      expect(testsEdges.some((n) => n.node.filePath === 'src/math.ts')).toBe(true)
    }
  })
})

describe.skipIf(!canLoadWasm)('indexRepo (Java package resolution)', () => {
  let root: string
  let store: GraphStore

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'graphcode-indexer-java-'))
    store = GraphStore.open(join(root, 'graph.db'))
  })

  afterEach(() => {
    store.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('resolves a call between two files in the same package with no import statement', async () => {
    write(
      root,
      'src/main/java/org/apache/hdfs/server/namenode/NameNode.java',
      `package org.apache.hdfs.server.namenode;

public class NameNode {
  public void start() {
    FSNamesystem.boot();
  }
}
`,
    )
    write(
      root,
      'src/main/java/org/apache/hdfs/server/namenode/FSNamesystem.java',
      `package org.apache.hdfs.server.namenode;

public class FSNamesystem {
  public static void boot() {}
}
`,
    )
    const config = loadConfig(root)
    const result = await indexRepo(store, config)

    const startSymbol = store.findNodesByName('start', { kinds: ['symbol'] })[0]
    expect(startSymbol).toBeDefined()
    if (startSymbol) {
      const calls = store.neighbors(startSymbol.id, { direction: 'out', kinds: ['calls'] })
      expect(calls.some((n) => n.node.filePath === 'src/main/java/org/apache/hdfs/server/namenode/FSNamesystem.java')).toBe(true)
    }
    expect(result.symbols).toBeGreaterThanOrEqual(2)
  })

  it('resolves a cross-package import to a file->file imports edge and the referenced symbol', async () => {
    write(
      root,
      'src/main/java/org/apache/hdfs/util/StringUtils.java',
      `package org.apache.hdfs.util;

public class StringUtils {
  public static String trim(String s) { return s; }
}
`,
    )
    write(
      root,
      'src/main/java/org/apache/hdfs/server/namenode/NameNode.java',
      `package org.apache.hdfs.server.namenode;

import org.apache.hdfs.util.StringUtils;

public class NameNode {
  public void start() {
    StringUtils.trim("x");
  }
}
`,
    )
    const config = loadConfig(root)
    const result = await indexRepo(store, config)

    const nameNodeFile = store.fileNode(result.repoId, 'src/main/java/org/apache/hdfs/server/namenode/NameNode.java')
    expect(nameNodeFile).not.toBeNull()
    if (nameNodeFile) {
      const importEdges = store.neighbors(nameNodeFile.id, { direction: 'out', kinds: ['imports'] })
      expect(importEdges.some((n) => n.node.filePath === 'src/main/java/org/apache/hdfs/util/StringUtils.java')).toBe(true)
    }

    const startSymbol = store.findNodesByName('start', { kinds: ['symbol'] })[0]
    if (startSymbol) {
      const calls = store.neighbors(startSymbol.id, { direction: 'out', kinds: ['calls'] })
      expect(calls.some((n) => n.node.name === 'trim')).toBe(true)
    }
  })

  it('resolves a cross-package `new Foo()` call to the imported class, not left ambiguous by its own constructor', async () => {
    // A Java class with an explicit constructor extracts two same-named
    // symbols (the class and its constructor). An importing file's `new
    // Foo()` call must resolve to the class despite that same-file collision.
    write(
      root,
      'src/main/java/org/apache/hdfs/server/resourcemanager/security/DelegationTokenRenewer.java',
      `package org.apache.hdfs.server.resourcemanager.security;

public class DelegationTokenRenewer {
  public DelegationTokenRenewer() {}
}
`,
    )
    write(
      root,
      'src/main/java/org/apache/hdfs/server/resourcemanager/ResourceManager.java',
      `package org.apache.hdfs.server.resourcemanager;

import org.apache.hdfs.server.resourcemanager.security.DelegationTokenRenewer;

public class ResourceManager {
  protected DelegationTokenRenewer createDelegationTokenRenewer() {
    return new DelegationTokenRenewer();
  }
}
`,
    )
    const config = loadConfig(root)
    const result = await indexRepo(store, config)
    expect(store.pendingRefsByName(result.repoId, 'DelegationTokenRenewer')).toHaveLength(0)

    const createSymbol = store.findNodesByName('createDelegationTokenRenewer', { kinds: ['symbol'] })[0]
    expect(createSymbol).toBeDefined()
    if (createSymbol) {
      const calls = store.neighbors(createSymbol.id, { direction: 'out', kinds: ['calls'] })
      const target = calls.find((n) => n.node.name === 'DelegationTokenRenewer')
      expect(target?.node.subkind).toBe('class')
      expect(target?.node.filePath).toBe(
        'src/main/java/org/apache/hdfs/server/resourcemanager/security/DelegationTokenRenewer.java',
      )
    }
  })

  it('resolves a wildcard import to every file in the target package', async () => {
    write(
      root,
      'src/main/java/org/apache/hdfs/util/StringUtils.java',
      `package org.apache.hdfs.util;

public class StringUtils {
  public static String trim(String s) { return s; }
}
`,
    )
    write(
      root,
      'src/main/java/org/apache/hdfs/util/ArrayUtils.java',
      `package org.apache.hdfs.util;

public class ArrayUtils {
  public static int[] copy(int[] a) { return a; }
}
`,
    )
    write(
      root,
      'src/main/java/org/apache/hdfs/server/namenode/NameNode.java',
      `package org.apache.hdfs.server.namenode;

import org.apache.hdfs.util.*;

public class NameNode {
  public void start() {
    StringUtils.trim("x");
    ArrayUtils.copy(new int[0]);
  }
}
`,
    )
    const config = loadConfig(root)
    const result = await indexRepo(store, config)

    const nameNodeFile = store.fileNode(result.repoId, 'src/main/java/org/apache/hdfs/server/namenode/NameNode.java')
    expect(nameNodeFile).not.toBeNull()
    if (nameNodeFile) {
      const importEdges = store.neighbors(nameNodeFile.id, { direction: 'out', kinds: ['imports'] })
      const importedPaths = importEdges.map((n) => n.node.filePath)
      expect(importedPaths).toContain('src/main/java/org/apache/hdfs/util/StringUtils.java')
      expect(importedPaths).toContain('src/main/java/org/apache/hdfs/util/ArrayUtils.java')
    }
  })

  it('disambiguates an ambiguous class name repo-wide by preferring the imported package', async () => {
    write(
      root,
      'src/main/java/org/apache/hdfs/server/namenode/Server.java',
      `package org.apache.hdfs.server.namenode;

public class Server {
  public static void run() {}
}
`,
    )
    write(
      root,
      'src/main/java/org/apache/hdfs/server/datanode/Server.java',
      `package org.apache.hdfs.server.datanode;

public class Server {
  public static void run() {}
}
`,
    )
    write(
      root,
      'src/main/java/org/apache/hdfs/client/Client.java',
      `package org.apache.hdfs.client;

import org.apache.hdfs.server.datanode.Server;

public class Client {
  public void connect() {
    Server.run();
  }
}
`,
    )
    const config = loadConfig(root)
    await indexRepo(store, config)

    const connectSymbol = store.findNodesByName('connect', { kinds: ['symbol'] })[0]
    expect(connectSymbol).toBeDefined()
    if (connectSymbol) {
      const calls = store.neighbors(connectSymbol.id, { direction: 'out', kinds: ['calls'] })
      const target = calls.find((n) => n.node.name === 'run')
      expect(target?.node.filePath).toBe('src/main/java/org/apache/hdfs/server/datanode/Server.java')
    }
  })
})

describe.skipIf(canLoadWasm)('indexRepo symbol extraction (wasm unavailable)', () => {
  it('documents that grammar loading is blocked in this environment', () => {
    expect(canLoadWasm).toBe(false)
  })
})
