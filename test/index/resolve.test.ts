import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GraphStore } from '../../src/graph/store.js'
import {
  buildJavaPackageIndex,
  clearGoModuleCache,
  resolveGoPackageFiles,
  resolveImportPath,
  resolveJavaImportFiles,
  resolveRefTarget,
  type IndexedSymbolRef,
} from '../../src/index/resolve.js'

describe('resolveImportPath', () => {
  const known = new Set(['src/foo.ts', 'src/bar/index.ts', 'src/baz.ts', 'pkg/mod.py', 'pkg/__init__.py'])

  it('resolves a relative import with an implied extension', () => {
    expect(resolveImportPath('./foo', 'src/entry.ts', 'typescript', known)).toBe('src/foo.ts')
  })

  it('resolves a relative import to an index file in a directory', () => {
    expect(resolveImportPath('./bar', 'src/entry.ts', 'typescript', known)).toBe('src/bar/index.ts')
  })

  it('resolves parent-relative imports', () => {
    expect(resolveImportPath('../baz', 'src/nested/entry.ts', 'typescript', known)).toBe('src/baz.ts')
  })

  it('resolves python package imports to __init__', () => {
    expect(resolveImportPath('./__init__', 'pkg/mod.py', 'python', known)).toBe('pkg/__init__.py')
  })

  it('returns undefined for bare package imports (external deps)', () => {
    expect(resolveImportPath('react', 'src/entry.ts', 'typescript', known)).toBeUndefined()
    expect(resolveImportPath('lodash/debounce', 'src/entry.ts', 'typescript', known)).toBeUndefined()
  })

  it('returns undefined when no match exists', () => {
    expect(resolveImportPath('./missing', 'src/entry.ts', 'typescript', known)).toBeUndefined()
  })
})

describe('resolveRefTarget', () => {
  let dir: string
  let store: GraphStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'graphcode-resolve-'))
    store = GraphStore.open(join(dir, 'graph.db'))
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('prefers a same-file symbol over anything else', () => {
    const repo = store.upsertRepo('demo', '/tmp/demo')
    const localHelper = store.insertNode(repo.id, { kind: 'symbol', name: 'helper', filePath: 'a.ts' })
    store.insertNode(repo.id, { kind: 'symbol', name: 'helper', filePath: 'b.ts' })
    const indexedSymbols: IndexedSymbolRef[] = [
      { nodeId: localHelper, name: 'helper', filePath: 'a.ts' },
    ]
    const target = resolveRefTarget('helper', 'a.ts', new Set(), { store, repoId: repo.id, indexedSymbols })
    expect(target).toBe(localHelper)
  })

  it('falls back to a uniquely-named symbol in an imported file', () => {
    const repo = store.upsertRepo('demo', '/tmp/demo')
    const imported = store.insertNode(repo.id, { kind: 'symbol', name: 'helper', filePath: 'b.ts' })
    const indexedSymbols: IndexedSymbolRef[] = [{ nodeId: imported, name: 'helper', filePath: 'b.ts' }]
    const target = resolveRefTarget('helper', 'a.ts', new Set(['b.ts']), { store, repoId: repo.id, indexedSymbols })
    expect(target).toBe(imported)
  })

  it('falls back to a unique repo-wide name match via the store', () => {
    const repo = store.upsertRepo('demo', '/tmp/demo')
    const target = store.insertNode(repo.id, { kind: 'symbol', name: 'GlobalThing', filePath: 'z.ts' })
    const result = resolveRefTarget('GlobalThing', 'a.ts', new Set(), { store, repoId: repo.id, indexedSymbols: [] })
    expect(result).toBe(target)
  })

  it('picks the same-directory candidate when repo-wide name is ambiguous', () => {
    const repo = store.upsertRepo('demo', '/tmp/demo')
    const sameDir = store.insertNode(repo.id, { kind: 'symbol', name: 'Widget', filePath: 'src/ui/widget.ts' })
    store.insertNode(repo.id, { kind: 'symbol', name: 'Widget', filePath: 'other/widget.ts' })
    const result = resolveRefTarget('Widget', 'src/ui/entry.ts', new Set(), { store, repoId: repo.id, indexedSymbols: [] })
    expect(result).toBe(sameDir)
  })

  it('returns undefined when repo-wide name is ambiguous with no directory tiebreak', () => {
    const repo = store.upsertRepo('demo', '/tmp/demo')
    store.insertNode(repo.id, { kind: 'symbol', name: 'Widget', filePath: 'a/widget.ts' })
    store.insertNode(repo.id, { kind: 'symbol', name: 'Widget', filePath: 'b/widget.ts' })
    const result = resolveRefTarget('Widget', 'c/entry.ts', new Set(), { store, repoId: repo.id, indexedSymbols: [] })
    expect(result).toBeUndefined()
  })

  it('returns undefined when nothing matches', () => {
    const repo = store.upsertRepo('demo', '/tmp/demo')
    const result = resolveRefTarget('Nonexistent', 'a.ts', new Set(), { store, repoId: repo.id, indexedSymbols: [] })
    expect(result).toBeUndefined()
  })

  it('for Go, promotes a same-directory symbol to (a/b) precedence even without an import', () => {
    const repo = store.upsertRepo('demo', '/tmp/demo')
    // Go's implicit same-package visibility: two files in internal/namenode/
    // share symbols without an import statement between them.
    const sibling = store.insertNode(repo.id, { kind: 'symbol', name: 'blockSize', filePath: 'internal/namenode/namenode.go' })
    store.insertNode(repo.id, { kind: 'symbol', name: 'blockSize', filePath: 'internal/datanode/datanode.go' })
    const indexedSymbols: IndexedSymbolRef[] = [
      { nodeId: sibling, name: 'blockSize', filePath: 'internal/namenode/namenode.go' },
      { nodeId: 999, name: 'blockSize', filePath: 'internal/datanode/datanode.go' },
    ]
    const result = resolveRefTarget('blockSize', 'internal/namenode/server.go', new Set(), {
      store,
      repoId: repo.id,
      indexedSymbols,
      language: 'go',
    })
    expect(result).toBe(sibling)
  })

  it('does not apply the same-directory bonus for non-Go languages', () => {
    const repo = store.upsertRepo('demo', '/tmp/demo')
    const target = store.insertNode(repo.id, { kind: 'symbol', name: 'GlobalThing', filePath: 'a/thing.ts' })
    const indexedSymbols: IndexedSymbolRef[] = [{ nodeId: target, name: 'GlobalThing', filePath: 'a/thing.ts' }]
    // Falls through indexedSymbols (no import, no Go bonus) to the store-wide unique match.
    const result = resolveRefTarget('GlobalThing', 'a/entry.ts', new Set(), {
      store,
      repoId: repo.id,
      indexedSymbols,
      language: 'typescript',
    })
    expect(result).toBe(target)
  })

  it('for Java, promotes a same-package symbol to (a/b) precedence even without an import', () => {
    const repo = store.upsertRepo('demo', '/tmp/demo')
    // Same packageName in different files implies Java's implicit package
    // visibility, with no import statement needed between them.
    const sibling = store.insertNode(repo.id, {
      kind: 'symbol',
      name: 'DEFAULT_BLOCK_SIZE',
      filePath: 'src/main/java/org/apache/hdfs/server/namenode/NameNode.java',
    })
    store.insertNode(repo.id, { kind: 'symbol', name: 'DEFAULT_BLOCK_SIZE', filePath: 'src/main/java/org/apache/hdfs/server/datanode/DataNode.java' })
    const indexedSymbols: IndexedSymbolRef[] = [
      { nodeId: sibling, name: 'DEFAULT_BLOCK_SIZE', filePath: 'src/main/java/org/apache/hdfs/server/namenode/NameNode.java' },
      { nodeId: 999, name: 'DEFAULT_BLOCK_SIZE', filePath: 'src/main/java/org/apache/hdfs/server/datanode/DataNode.java' },
    ]
    const packageNameByFile = new Map([
      ['src/main/java/org/apache/hdfs/server/namenode/NameNode.java', 'org.apache.hdfs.server.namenode'],
      ['src/main/java/org/apache/hdfs/server/namenode/Server.java', 'org.apache.hdfs.server.namenode'],
      ['src/main/java/org/apache/hdfs/server/datanode/DataNode.java', 'org.apache.hdfs.server.datanode'],
    ])
    const result = resolveRefTarget('DEFAULT_BLOCK_SIZE', 'src/main/java/org/apache/hdfs/server/namenode/Server.java', new Set(), {
      store,
      repoId: repo.id,
      indexedSymbols,
      language: 'java',
      packageName: 'org.apache.hdfs.server.namenode',
      packageNameByFile,
    })
    expect(result).toBe(sibling)
  })

  it('for Java, prefers an imported file over a same-package or same-directory candidate when ambiguous', () => {
    const repo = store.upsertRepo('demo', '/tmp/demo')
    const imported = store.insertNode(repo.id, { kind: 'symbol', name: 'Server', filePath: 'org/other/pkg/Server.java' })
    const samePackage = store.insertNode(repo.id, { kind: 'symbol', name: 'Server', filePath: 'org/apache/hdfs/Server.java' })
    const indexedSymbols: IndexedSymbolRef[] = [
      { nodeId: imported, name: 'Server', filePath: 'org/other/pkg/Server.java' },
      { nodeId: samePackage, name: 'Server', filePath: 'org/apache/hdfs/Server.java' },
    ]
    const packageNameByFile = new Map([
      ['org/apache/hdfs/Server.java', 'org.apache.hdfs'],
      ['org/apache/hdfs/Caller.java', 'org.apache.hdfs'],
    ])
    const result = resolveRefTarget('Server', 'org/apache/hdfs/Caller.java', new Set(['org/other/pkg/Server.java']), {
      store,
      repoId: repo.id,
      indexedSymbols,
      language: 'java',
      packageName: 'org.apache.hdfs',
      packageNameByFile,
    })
    expect(result).toBe(imported)
  })

  it('resolves an imported class over its own same-named constructor method (Java constructor collision)', () => {
    // Java extracts a constructor with the class's own name, so a class file
    // with an explicit constructor has two same-named symbols. A bare
    // `new Foo()` call from another file must resolve to the class, not be
    // left ambiguous by the class/constructor pair both living in the
    // imported file.
    const repo = store.upsertRepo('demo', '/tmp/demo')
    const classNode = store.insertNode(repo.id, {
      kind: 'symbol',
      subkind: 'class',
      name: 'DelegationTokenRenewer',
      filePath: 'org/apache/hdfs/security/DelegationTokenRenewer.java',
    })
    const ctorNode = store.insertNode(repo.id, {
      kind: 'symbol',
      subkind: 'method',
      name: 'DelegationTokenRenewer',
      filePath: 'org/apache/hdfs/security/DelegationTokenRenewer.java',
    })
    const indexedSymbols: IndexedSymbolRef[] = [
      { nodeId: classNode, name: 'DelegationTokenRenewer', filePath: 'org/apache/hdfs/security/DelegationTokenRenewer.java', kind: 'class' },
      { nodeId: ctorNode, name: 'DelegationTokenRenewer', filePath: 'org/apache/hdfs/security/DelegationTokenRenewer.java', kind: 'method' },
    ]
    const result = resolveRefTarget(
      'DelegationTokenRenewer',
      'org/apache/hdfs/ResourceManager.java',
      new Set(['org/apache/hdfs/security/DelegationTokenRenewer.java']),
      { store, repoId: repo.id, indexedSymbols, language: 'java' },
    )
    expect(result).toBe(classNode)
  })
})

describe('resolveJavaImportFiles', () => {
  it('resolves a single-class import to the file for that class in the package directory', () => {
    const known = new Set([
      'src/main/java/org/apache/hdfs/server/namenode/NameNode.java',
      'src/main/java/org/apache/hdfs/server/namenode/FSNamesystem.java',
    ])
    const packagesByName = buildJavaPackageIndex(
      new Map([
        ['src/main/java/org/apache/hdfs/server/namenode/NameNode.java', 'org.apache.hdfs.server.namenode'],
        ['src/main/java/org/apache/hdfs/server/namenode/FSNamesystem.java', 'org.apache.hdfs.server.namenode'],
      ]),
    )
    const result = resolveJavaImportFiles('org.apache.hdfs.server.namenode.FSNamesystem', packagesByName, known)
    expect(result).toEqual(['src/main/java/org/apache/hdfs/server/namenode/FSNamesystem.java'])
  })

  it('resolves a wildcard import to every .java file in the package directory, capped', () => {
    const files = Array.from({ length: 25 }, (_, i) => `src/main/java/org/apache/hdfs/util/File${i}.java`)
    const known = new Set(files)
    const packagesByName = buildJavaPackageIndex(new Map(files.map((f) => [f, 'org.apache.hdfs.util'])))
    const result = resolveJavaImportFiles('org.apache.hdfs.util.*', packagesByName, known)
    expect(result.length).toBeLessThanOrEqual(20)
    expect(result.every((f) => f.startsWith('src/main/java/org/apache/hdfs/util/'))).toBe(true)
  })

  it('returns an empty list for a package with no known files (external/stdlib import)', () => {
    const packagesByName = buildJavaPackageIndex(new Map())
    expect(resolveJavaImportFiles('java.util.List', packagesByName, new Set())).toEqual([])
    expect(resolveJavaImportFiles('java.util.*', packagesByName, new Set())).toEqual([])
  })

  it('returns an empty list for a default-package (unqualified) import', () => {
    const packagesByName = buildJavaPackageIndex(new Map())
    expect(resolveJavaImportFiles('Standalone', packagesByName, new Set())).toEqual([])
  })
})

describe('buildJavaPackageIndex', () => {
  it('groups multiple files in the same package under one directory list', () => {
    const index = buildJavaPackageIndex(
      new Map([
        ['src/main/java/org/apache/hdfs/A.java', 'org.apache.hdfs'],
        ['src/main/java/org/apache/hdfs/B.java', 'org.apache.hdfs'],
      ]),
    )
    expect(index.get('org.apache.hdfs')).toEqual(['src/main/java/org/apache/hdfs'])
  })

  it('records both main and test source roots for the same package name', () => {
    const index = buildJavaPackageIndex(
      new Map([
        ['src/main/java/org/apache/hdfs/A.java', 'org.apache.hdfs'],
        ['src/test/java/org/apache/hdfs/ATest.java', 'org.apache.hdfs'],
      ]),
    )
    expect([...(index.get('org.apache.hdfs') ?? [])].sort()).toEqual(
      ['src/main/java/org/apache/hdfs', 'src/test/java/org/apache/hdfs'].sort(),
    )
  })
})

describe('resolveGoPackageFiles', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'graphcode-gomod-'))
    clearGoModuleCache()
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    clearGoModuleCache()
  })

  it('resolves a module-path import to every .go file in the target package directory', () => {
    writeFileSync(join(dir, 'go.mod'), 'module github.com/hdfs-go/hdfs\n\ngo 1.26\n')
    const known = new Set([
      'internal/namenode/namenode.go',
      'internal/namenode/server.go',
      'internal/namenode/namenode_test.go',
      'internal/datanode/datanode.go',
      'cmd/namenode/main.go',
    ])
    const result = resolveGoPackageFiles('github.com/hdfs-go/hdfs/internal/namenode', dir, known)
    expect([...result].sort()).toEqual(['internal/namenode/namenode.go', 'internal/namenode/namenode_test.go', 'internal/namenode/server.go'])
  })

  it('returns an empty list for a bare/external import outside the module', () => {
    writeFileSync(join(dir, 'go.mod'), 'module github.com/hdfs-go/hdfs\n\ngo 1.26\n')
    const known = new Set(['internal/namenode/namenode.go'])
    expect(resolveGoPackageFiles('fmt', dir, known)).toEqual([])
    expect(resolveGoPackageFiles('github.com/google/uuid', dir, known)).toEqual([])
  })

  it('returns an empty list when go.mod is missing', () => {
    const known = new Set(['internal/namenode/namenode.go'])
    expect(resolveGoPackageFiles('github.com/hdfs-go/hdfs/internal/namenode', dir, known)).toEqual([])
  })

  it('caps the number of resolved files per import', () => {
    writeFileSync(join(dir, 'go.mod'), 'module github.com/hdfs-go/hdfs\n\ngo 1.26\n')
    const known = new Set(Array.from({ length: 30 }, (_, i) => `internal/big/file${i}.go`))
    const result = resolveGoPackageFiles('github.com/hdfs-go/hdfs/internal/big', dir, known)
    expect(result.length).toBeLessThanOrEqual(20)
  })
})
