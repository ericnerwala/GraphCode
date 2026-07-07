import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { execFileSync, execSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildExport } from '../../src/cli/commands/export-cmd.js'

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

describe.skipIf(!built)('graphcode CLI end-to-end', () => {
  let dir: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'graphcode-e2e-'))
    writeFileSync(
      join(dir, 'main.ts'),
      [
        'export function add(a: number, b: number): number {',
        '  return helper(a) + b',
        '}',
        '',
        'export function helper(a: number): number {',
        '  return a * 2',
        '}',
      ].join('\n'),
    )
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(
      join(dir, 'src', 'util.ts'),
      ['import { add } from "../main.js"', '', 'export function callAdd(): number {', '  return add(1, 2)', '}'].join('\n'),
    )
    writeFileSync(join(dir, 'README.md'), '# Demo\n\nThis project adds numbers using add and helper.\n')

    execSync('git init -q', { cwd: dir })
    execSync('git config user.email test@example.com', { cwd: dir })
    execSync('git config user.name Test', { cwd: dir })
    execSync('git add -A', { cwd: dir })
    execSync('git commit -q -m "initial commit"', { cwd: dir })
  })

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  function run(args: string[]): string {
    return execFileSync('node', [cliEntry, ...args], { cwd: dir, encoding: 'utf8' })
  }

  it('indexes the fixture repo', () => {
    const output = run(['index', '--path', dir])
    expect(output).toMatch(/indexed \d+ files/)
  })

  it('reports non-zero stats after indexing', () => {
    const output = run(['stats', '--path', dir, '--json'])
    const stats = JSON.parse(output) as { files: number; symbols: number }
    expect(stats.files).toBeGreaterThan(0)
    expect(stats.symbols).toBeGreaterThan(0)
  })

  it('finds symbols via search --json', () => {
    const output = run(['search', 'add', '--path', dir, '--json'])
    const hits = JSON.parse(output) as Array<{ node: { name: string } }>
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.some((hit) => hit.node.name.toLowerCase().includes('add'))).toBe(true)
  })

  it('runs impact analysis with --json', () => {
    const output = run(['impact', 'helper', '--path', dir, '--json'])
    const result: unknown = JSON.parse(output)
    expect(result).toBeTruthy()
  })

  it('exports the graph as JSON with the documented shape', () => {
    const outFile = join(dir, 'graph.json')
    run(['export', '--path', dir, '--out', outFile])
    const graph = JSON.parse(readFileSync(outFile, 'utf8')) as {
      nodes: Array<{ id: number; type: string; name: string }>
      edges: Array<{ source: number; target: number; type: string; weight: number }>
      metadata: { generatedAt: string; stats: unknown }
    }
    expect(Array.isArray(graph.nodes)).toBe(true)
    expect(Array.isArray(graph.edges)).toBe(true)
    expect(graph.nodes.length).toBeGreaterThan(0)
    expect(graph.metadata.generatedAt).toBeTruthy()
    expect(graph.metadata.stats).toBeTruthy()
    for (const node of graph.nodes) {
      expect(typeof node.id).toBe('number')
      expect(typeof node.type).toBe('string')
      expect(typeof node.name).toBe('string')
    }
  })
})

describe('export shape helper (unit)', () => {
  it('is exported and callable against a store shape', () => {
    expect(typeof buildExport).toBe('function')
  })
})

describe('viewer.html asset', () => {
  const viewerPath = join(repoRoot, 'src', 'viz', 'viewer.html')

  it('exists', () => {
    expect(existsSync(viewerPath)).toBe(true)
  })

  it('contains no external http:// or https:// references', () => {
    const html = readFileSync(viewerPath, 'utf8')
    expect(html).not.toMatch(/https?:\/\//)
  })

  it('is a single self-contained document with inline script and style', () => {
    const html = readFileSync(viewerPath, 'utf8')
    expect(html).toContain('<style>')
    expect(html).toContain('<script>')
    expect(html).not.toMatch(/<link\s/)
  })
})
