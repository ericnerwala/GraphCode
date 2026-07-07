import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { hashContent, hashFile } from '../../src/index/hash.js'

describe('hashContent', () => {
  it('matches node crypto sha256 for a known string', () => {
    const expected = createHash('sha256').update('hello').digest('hex')
    expect(hashContent('hello')).toBe(expected)
  })

  it('produces different hashes for different content', () => {
    expect(hashContent('a')).not.toBe(hashContent('b'))
  })

  it('accepts Buffer input', () => {
    expect(hashContent(Buffer.from('hello'))).toBe(hashContent('hello'))
  })
})

describe('hashFile', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'graphcode-hash-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('hashes file contents lazily from disk', async () => {
    const path = join(dir, 'a.txt')
    writeFileSync(path, 'content')
    expect(await hashFile(path)).toBe(hashContent('content'))
  })
})
