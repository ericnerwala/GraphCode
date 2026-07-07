import { describe, expect, it, afterEach } from 'vitest'
import { rmSync } from 'node:fs'
import { runGit } from '../../src/git/git-cli.js'
import { gitLogArgs, parseGitLog } from '../../src/git/log-parser.js'
import { initRepo, writeAndCommit, renameFile, resetCommitCounter } from './git-test-helpers.js'

describe('log-parser', () => {
  afterEach(() => {
    resetCommitCounter()
  })

  it('parses commit metadata and numstat entries', () => {
    const dir = initRepo()
    try {
      writeAndCommit(dir, { 'a.ts': 'one\ntwo\n' }, 'feat(core): add a')
      writeAndCommit(dir, { 'a.ts': 'one\ntwo\nthree\n', 'b.ts': 'x\n' }, 'feat(core): add b')
      const output = runGit(dir, gitLogArgs(null, 100))
      expect(output).not.toBeNull()
      const commits = parseGitLog(output ?? '')
      expect(commits).toHaveLength(2)
      // newest first
      expect(commits[0]?.subject).toBe('feat(core): add b')
      expect(commits[0]?.files.map((f) => f.path).sort()).toEqual(['a.ts', 'b.ts'])
      const aFile = commits[0]?.files.find((f) => f.path === 'a.ts')
      expect(aFile?.insertions).toBe(1)
      expect(commits[1]?.subject).toBe('feat(core): add a')
      expect(commits[1]?.author).toBe('Test User')
      expect(commits[1]?.email).toBe('test@example.com')
      expect(commits[1]?.ts).toBeGreaterThan(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('resolves renamed paths to the new path (plain and brace form)', () => {
    const dir = initRepo()
    try {
      writeAndCommit(dir, { 'old.ts': 'content that is long enough to trigger a rename detection heuristic\n'.repeat(3) }, 'feat: add old')
      renameFile(dir, 'old.ts', 'new.ts', 'refactor: rename old to new')
      const output = runGit(dir, gitLogArgs(null, 100))
      const commits = parseGitLog(output ?? '')
      const renameCommit = commits.find((c) => c.subject === 'refactor: rename old to new')
      expect(renameCommit).toBeDefined()
      expect(renameCommit?.files.map((f) => f.path)).toContain('new.ts')
      expect(renameCommit?.files.map((f) => f.path)).not.toContain('old.ts')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns an empty array for empty output', () => {
    expect(parseGitLog('')).toEqual([])
  })
})
