import { spawnSync } from 'node:child_process'
import { clampToTokens } from '../../core/tokens.js'

export interface BashInput {
  readonly command: string
  readonly timeout_ms?: number
}

const DEFAULT_TIMEOUT_MS = 120_000
const OUTPUT_TOKEN_CLAMP = 8_000

/** Run a shell command in the repo root. Disabled entirely when
 * GRAPHCODE_NO_BASH=1 (tests, sandboxes without shell access). */
export function runBash(root: string, input: BashInput): string {
  if (process.env.GRAPHCODE_NO_BASH === '1') {
    return 'error: bash is disabled in this environment (GRAPHCODE_NO_BASH=1)'
  }
  const timeout = input.timeout_ms && input.timeout_ms > 0 ? input.timeout_ms : DEFAULT_TIMEOUT_MS
  const result = spawnSync(input.command, {
    shell: true,
    cwd: root,
    timeout,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })

  const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code
  const timedOut = result.signal === 'SIGTERM' || errorCode === 'ETIMEDOUT'
  // result.error is only fatal when there's nothing else to report (e.g. the
  // command couldn't be spawned at all) — on a timeout, spawnSync still
  // captures whatever stdout/stderr was produced before the kill, and that
  // output must reach the caller instead of being discarded.
  if (result.error && !timedOut && !result.signal && !result.stdout && !result.stderr) {
    return `error: failed to run command: ${result.error.message}`
  }

  const parts: string[] = []
  if (result.signal) parts.push(`killed by signal ${result.signal} (likely timeout after ${timeout}ms)`)
  parts.push(`exit code: ${result.status ?? 'unknown'}`)
  if (result.stdout) parts.push(`stdout:\n${result.stdout}`)
  if (result.stderr) parts.push(`stderr:\n${result.stderr}`)
  if (timedOut) parts.push(`[timed out after ${timeout}ms; output above was captured before timeout]`)
  return clampToTokens(parts.join('\n\n'), OUTPUT_TOKEN_CLAMP)
}
