import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitHeadSha, runGit } from '../../src/git/git-cli.js'
import { initRepo, writeAndCommit, resetCommitCounter } from './git-test-helpers.js'

describe('git-cli', () => {
  beforeEach(() => {
    resetCommitCounter()
  })

  it('returns null for a non-git directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'graphcode-nogit-'))
    try {
      expect(gitHeadSha(dir)).toBeNull()
      expect(runGit(dir, ['log'])).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns null for a git repo with no commits', () => {
    const dir = initRepo()
    try {
      expect(gitHeadSha(dir)).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns the HEAD sha for a repo with commits', () => {
    const dir = initRepo()
    try {
      const sha = writeAndCommit(dir, { 'a.txt': 'hello' }, 'initial commit')
      expect(gitHeadSha(dir)).toBe(sha)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns null for an unknown git command', () => {
    const dir = initRepo()
    try {
      expect(runGit(dir, ['not-a-real-command'])).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
