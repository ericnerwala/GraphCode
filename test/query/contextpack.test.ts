import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { rmSync } from 'node:fs'
import { estimateTokens } from '../../src/core/tokens.js'
import type { GraphStore } from '../../src/graph/store.js'
import { buildContextPack } from '../../src/query/contextpack.js'
import { insertSymbol, makeTempStore, writeFixtureFile } from './fixtures.js'

function seedRealisticGraph(store: GraphStore, dir: string): void {
  const repo = store.upsertRepo('demo', '/tmp/demo')
  writeFixtureFile(
    dir,
    'src/auth/login.ts',
    Array.from({ length: 10 }, (_, i) => `// line ${i}`).concat(['export function login() {', '  return checkPassword()', '}']).join('\n'),
  )
  writeFixtureFile(dir, 'src/auth/password.ts', 'export function checkPassword() {\n  return true\n}\n')
  writeFixtureFile(dir, 'src/auth/session.ts', 'export function createSession() {\n  return {}\n}\n')
  writeFixtureFile(dir, 'src/auth/token.ts', 'export function signToken() {\n  return "x"\n}\n')

  const login = insertSymbol(store, repo.id, { name: 'login', filePath: 'src/auth/login.ts', startLine: 11, endLine: 13 }).symbolId
  const checkPassword = insertSymbol(store, repo.id, { name: 'checkPassword', filePath: 'src/auth/password.ts', startLine: 1, endLine: 3 }).symbolId
  const createSession = insertSymbol(store, repo.id, { name: 'createSession', filePath: 'src/auth/session.ts', startLine: 1, endLine: 3 }).symbolId
  const signToken = insertSymbol(store, repo.id, { name: 'signToken', filePath: 'src/auth/token.ts', startLine: 1, endLine: 3 }).symbolId

  store.insertEdge(repo.id, { src: login, dst: checkPassword, kind: 'calls' })
  store.insertEdge(repo.id, { src: login, dst: createSession, kind: 'calls' })
  store.insertEdge(repo.id, { src: login, dst: signToken, kind: 'calls' })

  // A test file that should be excluded from seeding.
  insertSymbol(store, repo.id, { name: 'loginTest', filePath: 'src/auth/login.test.ts', startLine: 1 })
}

describe('buildContextPack', () => {
  let dir: string
  let store: GraphStore

  beforeEach(() => {
    const t = makeTempStore()
    dir = t.dir
    store = t.store
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('produces markdown with tier headers and the draft-to-refine framing', () => {
    seedRealisticGraph(store, dir)
    const pack = buildContextPack(store, dir, 'login', 6000)
    expect(pack.markdown).toContain('## Graph context (pre-computed from the code graph - verify, then refine; treat listed source as already read)')
    expect(pack.markdown).toContain('### Tier 1')
    expect(pack.markdown).toContain('### Tier 2')
    expect(pack.markdown).toContain('### Tier 3')
  })

  it('reports tokens <= budget under a generous budget', () => {
    seedRealisticGraph(store, dir)
    const pack = buildContextPack(store, dir, 'login', 6000)
    expect(pack.tokens).toBeLessThanOrEqual(6000)
  })

  it('reports tokens <= budget under a tiny budget, dropping tiers', () => {
    seedRealisticGraph(store, dir)
    const pack = buildContextPack(store, dir, 'login', 60)
    expect(pack.tokens).toBeLessThanOrEqual(60)
    expect(estimateTokens(pack.markdown)).toBeLessThanOrEqual(60)
  })

  it('drops tier 3 before tier 2 when the budget is tight', () => {
    seedRealisticGraph(store, dir)
    const generous = buildContextPack(store, dir, 'login', 6000)
    const tight = buildContextPack(store, dir, 'login', 150)
    expect(tight.tokens).toBeLessThan(generous.tokens)
  })

  it('returns coreFiles and symbols drawn from tier 1', () => {
    seedRealisticGraph(store, dir)
    const pack = buildContextPack(store, dir, 'login', 6000)
    expect(pack.coreFiles.length).toBeGreaterThan(0)
    expect(pack.coreFiles).toContain('src/auth/login.ts')
  })

  it('excludes test files from the seed set', () => {
    seedRealisticGraph(store, dir)
    const pack = buildContextPack(store, dir, 'login', 6000)
    expect(pack.markdown).not.toContain('login.test.ts')
  })

  it('handles an empty graph without throwing', () => {
    store.upsertRepo('empty', '/tmp/empty')
    const pack = buildContextPack(store, dir, 'nonexistent thing', 1000)
    expect(pack.markdown).toContain('## Graph context')
    expect(pack.coreFiles).toHaveLength(0)
    expect(pack.tokens).toBeLessThanOrEqual(1000)
  })

  it('never exceeds the budget even at an extremely tiny cap', () => {
    seedRealisticGraph(store, dir)
    const pack = buildContextPack(store, dir, 'login', 10)
    expect(pack.tokens).toBeLessThanOrEqual(10)
  })

  it('returns a minimal valid header with empty coreFiles/symbols at budget 0', () => {
    seedRealisticGraph(store, dir)
    const pack = buildContextPack(store, dir, 'login', 0)
    expect(pack.markdown).toContain('## Graph context')
    expect(pack.markdown.length).toBeGreaterThan(0)
    expect(pack.coreFiles).toHaveLength(0)
    expect(pack.symbols).toHaveLength(0)
  })

  it('returns a minimal valid header for a negative budget too', () => {
    seedRealisticGraph(store, dir)
    const pack = buildContextPack(store, dir, 'login', -5)
    expect(pack.markdown).toContain('## Graph context')
    expect(pack.coreFiles).toHaveLength(0)
    expect(pack.symbols).toHaveLength(0)
  })

  it('every coreFile at a small budget is actually named in the returned markdown', () => {
    seedRealisticGraph(store, dir)
    const pack = buildContextPack(store, dir, 'login', 40)
    expect(pack.markdown).toContain('## Graph context')
    for (const file of pack.coreFiles) {
      expect(pack.markdown).toContain(file)
    }
  })

  it('always contains the header markdown at budgets generous enough to fit it', () => {
    seedRealisticGraph(store, dir)
    for (const budget of [40, 150, 6000]) {
      const pack = buildContextPack(store, dir, 'login', budget)
      expect(pack.markdown).toContain('## Graph context')
    }
  })

  it('never returns an empty markdown string, even at budgets too tiny to fit the header', () => {
    seedRealisticGraph(store, dir)
    for (const budget of [0, 1, 5, 10]) {
      const pack = buildContextPack(store, dir, 'login', budget)
      expect(pack.markdown.length).toBeGreaterThan(0)
      if (budget > 0) expect(pack.tokens).toBeLessThanOrEqual(budget)
    }
  })
})
