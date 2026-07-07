import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { spawn, execSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const repoRoot = join(import.meta.dirname, '..', '..')
const cliEntry = join(repoRoot, 'dist', 'cli', 'main.js')

function buildSucceeded(): boolean {
  try {
    execSync('npx tsc', { cwd: repoRoot, stdio: 'pipe' })
    execSync('node scripts/copy-assets.mjs', { cwd: repoRoot, stdio: 'pipe' })
    return existsSync(cliEntry)
  } catch {
    return false
  }
}

const built = buildSucceeded()

/** Minimal JSON-RPC-over-stdio client for talking to the MCP server under test. */
class JsonRpcClient {
  private buffer = ''
  private nextId = 1
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void }>()

  constructor(private readonly proc: ChildProcessWithoutNullStreams) {
    this.proc.stdout.on('data', (chunk: Buffer) => this.onData(chunk))
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString('utf8')
    let newlineIndex = this.buffer.indexOf('\n')
    while (newlineIndex !== -1) {
      const line = this.buffer.slice(0, newlineIndex).trim()
      this.buffer = this.buffer.slice(newlineIndex + 1)
      if (line.length > 0) this.handleLine(line)
      newlineIndex = this.buffer.indexOf('\n')
    }
  }

  private handleLine(line: string): void {
    let message: { id?: number; result?: unknown; error?: unknown }
    try {
      message = JSON.parse(line) as { id?: number; result?: unknown; error?: unknown }
    } catch {
      return
    }
    if (typeof message.id !== 'number') return
    const waiter = this.pending.get(message.id)
    if (!waiter) return
    this.pending.delete(message.id)
    if (message.error) {
      waiter.reject(new Error(JSON.stringify(message.error)))
    } else {
      waiter.resolve(message.result)
    }
  }

  request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++
    const payload = { jsonrpc: '2.0', id, method, params: params ?? {} }
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.proc.stdin.write(`${JSON.stringify(payload)}\n`)
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`timed out waiting for response to ${method}`))
        }
      }, 10_000)
    })
  }

  notify(method: string, params?: unknown): void {
    const payload = { jsonrpc: '2.0', method, params: params ?? {} }
    this.proc.stdin.write(`${JSON.stringify(payload)}\n`)
  }
}

describe.skipIf(!built)('graphcode mcp server', () => {
  let dir: string
  let proc: ChildProcessWithoutNullStreams
  let client: JsonRpcClient

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'graphcode-mcp-'))
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(
      join(dir, 'src', 'main.ts'),
      ['export function add(a: number, b: number): number {', '  return a + b', '}'].join('\n'),
    )
    execSync('git init -q', { cwd: dir })
    execSync('git config user.email test@example.com', { cwd: dir })
    execSync('git config user.name Test', { cwd: dir })
    execSync('git add -A', { cwd: dir })
    execSync('git commit -q -m "initial commit"', { cwd: dir })

    // Seed the index up front so `mcp --no-sync` has a graph to serve.
    execSync(`node ${JSON.stringify(cliEntry)} index --path ${JSON.stringify(dir)}`, { cwd: dir })

    proc = spawn('node', [cliEntry, 'mcp', '--path', dir, '--no-sync'], { cwd: dir })
    client = new JsonRpcClient(proc)

    await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'graphcode-test', version: '0.0.0' },
    })
    client.notify('notifications/initialized')
  }, 20_000)

  afterAll(() => {
    proc?.kill()
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('lists exactly the 6 graph tools', async () => {
    const result = (await client.request('tools/list')) as { tools: Array<{ name: string }> }
    const names = result.tools.map((tool) => tool.name).sort()
    expect(names).toEqual(
      ['graph_callees', 'graph_callers', 'graph_context', 'graph_explore', 'graph_impact', 'graph_search'].sort(),
    )
  })

  it('calls graph_search and gets text content back', async () => {
    const result = (await client.request('tools/call', {
      name: 'graph_search',
      arguments: { query: 'add' },
    })) as { content: Array<{ type: string; text: string }>; isError?: boolean }
    expect(result.isError).toBeFalsy()
    expect(result.content[0]?.type).toBe('text')
    expect(result.content[0]?.text.length).toBeGreaterThan(0)
  })
})
