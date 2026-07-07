import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanRepo } from '../../src/index/scanner.js'

function write(root: string, relPath: string, content: string): void {
  const full = join(root, relPath)
  mkdirSync(full.slice(0, full.lastIndexOf('/')), { recursive: true })
  writeFileSync(full, content)
}

describe('scanRepo', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'graphcode-scan-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('collects code files and doc files separately', async () => {
    write(root, 'src/index.ts', 'export const x = 1')
    write(root, 'README.md', '# hi')
    write(root, 'docs/guide.md', '# guide')
    const result = await scanRepo(root)
    expect(result.codeFiles.map((f) => f.path).sort()).toEqual(['src/index.ts'])
    expect(result.docFiles.map((f) => f.path).sort()).toEqual(['README.md', 'docs/guide.md'])
  })

  it('respects .gitignore', async () => {
    write(root, '.gitignore', 'ignored/\n*.generated.ts\n')
    write(root, 'src/keep.ts', 'x')
    write(root, 'ignored/skip.ts', 'x')
    write(root, 'src/skip.generated.ts', 'x')
    const result = await scanRepo(root)
    expect(result.codeFiles.map((f) => f.path).sort()).toEqual(['src/keep.ts'])
  })

  it('excludes built-in directories regardless of .gitignore', async () => {
    write(root, 'node_modules/pkg/index.js', 'x')
    write(root, '.git/HEAD', 'ref: refs/heads/main')
    write(root, 'dist/out.js', 'x')
    write(root, 'build/out.js', 'x')
    write(root, 'src/real.ts', 'x')
    const result = await scanRepo(root)
    expect(result.codeFiles.map((f) => f.path)).toEqual(['src/real.ts'])
  })

  it('excludes binary/media extensions and minified files', async () => {
    write(root, 'src/real.ts', 'x')
    write(root, 'assets/logo.png', 'binary')
    write(root, 'assets/photo.jpg', 'binary')
    write(root, 'dist/bundle.min.js', 'x')
    const result = await scanRepo(root)
    expect(result.codeFiles.map((f) => f.path)).toEqual(['src/real.ts'])
  })

  it('excludes files over the size limit', async () => {
    write(root, 'src/small.ts', 'x')
    write(root, 'src/huge.ts', 'a'.repeat(1.6 * 1024 * 1024))
    const result = await scanRepo(root)
    expect(result.codeFiles.map((f) => f.path)).toEqual(['src/small.ts'])
  })

  it('applies extra ignore patterns from config', async () => {
    write(root, 'src/keep.ts', 'x')
    write(root, 'src/vendor-extra/skip.ts', 'x')
    const result = await scanRepo(root, { extraIgnore: ['src/vendor-extra/'] })
    expect(result.codeFiles.map((f) => f.path)).toEqual(['src/keep.ts'])
  })

  it('returns size and mtime metadata for each file', async () => {
    write(root, 'src/a.ts', 'hello world')
    const result = await scanRepo(root)
    const file = result.codeFiles[0]
    expect(file?.size).toBe(11)
    expect(typeof file?.mtime).toBe('number')
    expect(file?.mtime).toBeGreaterThan(0)
  })

  it('handles a repo with no .gitignore', async () => {
    write(root, 'src/a.ts', 'x')
    const result = await scanRepo(root)
    expect(result.codeFiles).toHaveLength(1)
  })
})
