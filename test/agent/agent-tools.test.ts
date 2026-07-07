import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { dispatchTool, type DispatchContext } from '../../src/agent/agent-tools.js'
import type { QueryApi } from '../../src/agent/query-api.js'
import { makeAgentFixture, type AgentFixture } from './fixtures.js'

describe('dispatchTool - graph tools (real query layer)', () => {
  let fixture: AgentFixture
  let ctx: DispatchContext

  beforeEach(() => {
    fixture = makeAgentFixture()
    ctx = { store: fixture.store, root: fixture.root, config: fixture.config }
  })

  afterEach(() => {
    fixture.store.close()
    rmSync(fixture.root, { recursive: true, force: true })
    rmSync(fixture.dbDir, { recursive: true, force: true })
  })

  it('graph_search finds a seeded symbol', () => {
    const result = dispatchTool('graph_search', { query: 'helper' }, ctx)
    expect(result).toContain('helper')
    expect(result).toContain('src/helper.ts')
  })

  it('graph_search steers when nothing matches', () => {
    const result = dispatchTool('graph_search', { query: 'totallyUnknownSymbolXyz' }, ctx)
    expect(result).toContain('No graph match for search')
    expect(result).toContain('graph_search with different terms')
  })

  it('graph_callers finds main as a caller of helper', () => {
    const result = dispatchTool('graph_callers', { symbol: 'helper' }, ctx)
    expect(result).toContain('main')
  })

  it('graph_callers steers on unresolvable symbol', () => {
    const result = dispatchTool('graph_callers', { symbol: 'doesNotExist' }, ctx)
    expect(result).toContain('No graph match for callers')
  })

  it('graph_callees finds helper as a callee of main', () => {
    const result = dispatchTool('graph_callees', { symbol: 'main' }, ctx)
    expect(result).toContain('helper')
  })

  it('graph_explore connects main -> helper and inlines source', () => {
    const result = dispatchTool('graph_explore', { symbols: ['main', 'helper'] }, ctx)
    expect(result).toContain('main -> helper')
    expect(result).toContain('function helper')
  })

  it('graph_impact reports helper as impacting main via calls edge', () => {
    const result = dispatchTool('graph_impact', { target: 'helper' }, ctx)
    expect(result).toContain('Impact of helper')
  })

  it('graph_context builds a markdown pack for a task description', () => {
    const result = dispatchTool('graph_context', { task: 'helper' }, ctx)
    expect(result).toContain('Graph context')
  })
})

describe('dispatchTool - graph tools with a stubbed QueryApi', () => {
  let fixture: AgentFixture

  beforeEach(() => {
    fixture = makeAgentFixture()
  })

  afterEach(() => {
    fixture.store.close()
    rmSync(fixture.root, { recursive: true, force: true })
    rmSync(fixture.dbDir, { recursive: true, force: true })
  })

  it('steers when resolveSymbol finds nothing', () => {
    const stub: QueryApi = {
      resolveSymbol: vi.fn(() => ({ node: null, alternatives: [] })),
      findCallers: vi.fn(() => []),
      findCallees: vi.fn(() => []),
      explore: vi.fn(() => ({ resolved: {}, paths: [], symbols: [] })),
      impactAnalysis: vi.fn(),
      buildContextPack: vi.fn(),
    }
    const ctx: DispatchContext = { store: fixture.store, root: fixture.root, config: fixture.config, queryApi: stub }
    const result = dispatchTool('graph_callers', { symbol: 'anything' }, ctx)
    expect(result).toContain('No graph match for callers')
    expect(stub.findCallers).not.toHaveBeenCalled()
  })

  it('never throws to the model when the query API throws', () => {
    const stub: QueryApi = {
      resolveSymbol: vi.fn(() => {
        throw new Error('boom')
      }),
      findCallers: vi.fn(() => []),
      findCallees: vi.fn(() => []),
      explore: vi.fn(),
      impactAnalysis: vi.fn(),
      buildContextPack: vi.fn(),
    }
    const ctx: DispatchContext = { store: fixture.store, root: fixture.root, config: fixture.config, queryApi: stub }
    const result = dispatchTool('graph_search', { query: 'anything' }, ctx)
    expect(result).toContain('graph search failed for "anything"')
    expect(result).toContain('boom')
  })

  it('graph_explore steers on an empty ExploreResult', () => {
    const stub: QueryApi = {
      resolveSymbol: vi.fn(() => ({ node: null, alternatives: [] })),
      findCallers: vi.fn(),
      findCallees: vi.fn(),
      explore: vi.fn(() => ({ resolved: {}, paths: [], symbols: [] })),
      impactAnalysis: vi.fn(),
      buildContextPack: vi.fn(),
    }
    const ctx: DispatchContext = { store: fixture.store, root: fixture.root, config: fixture.config, queryApi: stub }
    const result = dispatchTool('graph_explore', { symbols: ['x', 'y'] }, ctx)
    expect(result).toContain('No graph match for explore')
  })
})

describe('dispatchTool - file tools', () => {
  let fixture: AgentFixture
  let ctx: DispatchContext

  beforeEach(() => {
    fixture = makeAgentFixture()
    ctx = { store: fixture.store, root: fixture.root, config: fixture.config }
  })

  afterEach(() => {
    fixture.store.close()
    rmSync(fixture.root, { recursive: true, force: true })
    rmSync(fixture.dbDir, { recursive: true, force: true })
  })

  it('read_file returns numbered lines', () => {
    const result = dispatchTool('read_file', { path: 'src/helper.ts' }, ctx)
    expect(result).toContain('1\texport function helper')
  })

  it('read_file respects offset/limit', () => {
    const result = dispatchTool('read_file', { path: 'src/main.ts', offset: 2, limit: 1 }, ctx)
    expect(result.split('\n')).toHaveLength(1)
    expect(result).toMatch(/^2\t/)
  })

  it('read_file rejects a path escaping the root', () => {
    const result = dispatchTool('read_file', { path: '../../etc/passwd' }, ctx)
    expect(result).toContain('error')
    expect(result).toContain('escapes repo root')
  })

  it('write_file creates a new file and parent dirs', () => {
    const result = dispatchTool('write_file', { path: 'src/new/deep/file.txt', content: 'hello' }, ctx)
    expect(result).toContain('wrote')
    const content = readFileSync(join(fixture.root, 'src/new/deep/file.txt'), 'utf8')
    expect(content).toBe('hello')
  })

  it('write_file rejects a path escaping the root', () => {
    const result = dispatchTool('write_file', { path: '../outside.txt', content: 'x' }, ctx)
    expect(result).toContain('escapes repo root')
  })

  it('edit_file requires a unique match', () => {
    dispatchTool('write_file', { path: 'dup.txt', content: 'foo\nfoo\n' }, ctx)
    const result = dispatchTool('edit_file', { path: 'dup.txt', old_string: 'foo', new_string: 'bar' }, ctx)
    expect(result).toContain('matches 2 locations')
  })

  it('edit_file replace_all replaces every occurrence', () => {
    dispatchTool('write_file', { path: 'dup2.txt', content: 'foo\nfoo\n' }, ctx)
    const result = dispatchTool(
      'edit_file',
      { path: 'dup2.txt', old_string: 'foo', new_string: 'bar', replace_all: true },
      ctx,
    )
    expect(result).toContain('2 replacements')
    const content = readFileSync(join(fixture.root, 'dup2.txt'), 'utf8')
    expect(content).toBe('bar\nbar\n')
  })

  it('edit_file errors with actionable text when old_string is not found', () => {
    const result = dispatchTool('edit_file', { path: 'src/helper.ts', old_string: 'nope', new_string: 'x' }, ctx)
    expect(result).toContain('not found')
    expect(result).toContain('re-read the file')
  })

  it('edit_file applies a unique replacement', () => {
    const result = dispatchTool(
      'edit_file',
      { path: 'src/helper.ts', old_string: 'return 42', new_string: 'return 43' },
      ctx,
    )
    expect(result).toContain('edited src/helper.ts')
    const content = readFileSync(join(fixture.root, 'src/helper.ts'), 'utf8')
    expect(content).toContain('return 43')
  })

  it('list_dir lists entries with trailing slash on directories', () => {
    const result = dispatchTool('list_dir', { path: 'src' }, ctx)
    expect(result).toContain('main.ts')
    expect(result).toContain('helper.ts')
  })

  it('list_dir rejects a path escaping the root', () => {
    const result = dispatchTool('list_dir', { path: '..' }, ctx)
    expect(result).toContain('escapes repo root')
  })
})

describe('dispatchTool - bash tool', () => {
  let fixture: AgentFixture
  let ctx: DispatchContext

  beforeEach(() => {
    fixture = makeAgentFixture()
    ctx = { store: fixture.store, root: fixture.root, config: fixture.config }
  })

  afterEach(() => {
    fixture.store.close()
    rmSync(fixture.root, { recursive: true, force: true })
    rmSync(fixture.dbDir, { recursive: true, force: true })
    delete process.env.GRAPHCODE_NO_BASH
  })

  it('runs a command in the repo root and returns stdout', () => {
    const result = dispatchTool('bash', { command: 'echo hello-from-bash' }, ctx)
    expect(result).toContain('hello-from-bash')
    expect(result).toContain('exit code: 0')
  })

  it('is disabled when GRAPHCODE_NO_BASH=1', () => {
    process.env.GRAPHCODE_NO_BASH = '1'
    const result = dispatchTool('bash', { command: 'echo should-not-run' }, ctx)
    expect(result).toContain('disabled')
    expect(result).not.toContain('should-not-run')
  })

  it('clamps very large output to roughly the token budget', () => {
    const result = dispatchTool(
      'bash',
      { command: 'node -e "process.stdout.write(\'x\'.repeat(200000))"' },
      ctx,
    )
    expect(result.length).toBeLessThan(200000)
    expect(result).toContain('truncated')
  })

  it('still surfaces pre-timeout output when a command times out', () => {
    const result = dispatchTool(
      'bash',
      {
        command: 'node -e "process.stdout.write(\'before-timeout\'); setTimeout(() => {}, 5000)"',
        timeout_ms: 200,
      },
      ctx,
    )
    expect(result).toContain('before-timeout')
    expect(result).toContain('timed out after 200ms')
    expect(result).not.toContain('failed to run command')
  })
})

describe('dispatchTool - unknown tool', () => {
  it('returns an error instead of throwing', () => {
    const fixture = makeAgentFixture()
    const ctx: DispatchContext = { store: fixture.store, root: fixture.root, config: fixture.config }
    const result = dispatchTool('not_a_real_tool', {}, ctx)
    expect(result).toContain('unknown tool')
    fixture.store.close()
    rmSync(fixture.root, { recursive: true, force: true })
    rmSync(fixture.dbDir, { recursive: true, force: true })
  })
})
