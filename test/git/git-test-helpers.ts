// Shared helpers for building throwaway git repos in tests. Not a .test.ts
// file itself, so vitest won't try to run it as a suite.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

export function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'graphcode-git-'))
  run(dir, ['init', '-q', '-b', 'main'])
  run(dir, ['config', 'user.name', 'Test User'])
  run(dir, ['config', 'user.email', 'test@example.com'])
  return dir
}

export function run(cwd: string, args: readonly string[], env?: Record<string, string>): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...env } })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  }
}

let commitCounter = 0

/** Write files (path -> content) and commit them with a fixed, monotonically
 * increasing timestamp so ordering is deterministic across test runs. */
export function writeAndCommit(
  dir: string,
  files: Record<string, string>,
  subject: string,
  options: { author?: string; email?: string } = {},
): string {
  commitCounter += 1
  const date = new Date(2024, 0, 1, 0, commitCounter, 0).toISOString()
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content)
    run(dir, ['add', path])
  }
  run(dir, ['commit', '-q', '-m', subject], {
    GIT_AUTHOR_NAME: options.author ?? 'Test User',
    GIT_AUTHOR_EMAIL: options.email ?? 'test@example.com',
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_NAME: options.author ?? 'Test User',
    GIT_COMMITTER_EMAIL: options.email ?? 'test@example.com',
    GIT_COMMITTER_DATE: date,
  })
  const sha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).stdout.trim()
  return sha
}

export function renameFile(dir: string, from: string, to: string, subject: string): string {
  commitCounter += 1
  const date = new Date(2024, 0, 1, 0, commitCounter, 0).toISOString()
  mkdirSync(dirname(join(dir, to)), { recursive: true })
  run(dir, ['mv', from, to])
  run(dir, ['commit', '-q', '-m', subject], {
    GIT_AUTHOR_NAME: 'Test User',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_NAME: 'Test User',
    GIT_COMMITTER_EMAIL: 'test@example.com',
    GIT_COMMITTER_DATE: date,
  })
  const sha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).stdout.trim()
  return sha
}

export function resetCommitCounter(): void {
  commitCounter = 0
}
