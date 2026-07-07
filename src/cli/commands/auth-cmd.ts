import type { Command } from 'commander'
import { createInterface } from 'node:readline/promises'
import { authStatus, clearApiKey, getAuthFilePath, saveApiKey } from '../../core/auth.js'
import { print, printError, printStatus } from '../../core/output.js'

/** Injectable so `auth login` is testable without a real TTY: production passes
 * `promptForApiKey`, tests pass a stub that returns a canned answer. */
export type ApiKeyPrompter = () => Promise<string>

const LOGIN_PROMPT = 'Paste your Anthropic API key (created at console.anthropic.com): '

/** Reads a single line from stdin. Not hidden-input — matches the opencode/pi UX of a
 * plain paste prompt rather than requiring a TTY raw-mode dependency. */
export async function promptForApiKey(promptText: string = LOGIN_PROMPT): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return await rl.question(promptText)
  } finally {
    rl.close()
  }
}

export function registerAuthCommand(program: Command): void {
  const auth = program.command('auth').description('Manage the stored Anthropic API key')

  auth
    .command('login')
    .description('Save an Anthropic API key for the built-in agent')
    .action(async () => {
      await runLogin(promptForApiKey)
    })

  auth
    .command('status')
    .description('Show whether an Anthropic API key is configured, and from where')
    .action(() => {
      runStatus()
    })

  auth
    .command('logout')
    .description('Remove the stored Anthropic API key')
    .action(() => {
      runLogout()
    })
}

/** Exported so `startAgentSession` can run the same login flow inline when a TTY user
 * hits a missing-key error mid-session. */
export async function runLogin(prompter: ApiKeyPrompter): Promise<void> {
  const key = await prompter()
  const result = saveApiKey(key)
  if (result.warning) printStatus(`warning: ${result.warning}`)
  print(`Saved. Stored in ${result.path}`)
}

function runStatus(): void {
  const status = authStatus()
  if (!status.configured) {
    print('not configured')
    return
  }
  print(`configured (source: ${status.source}, key: ${status.masked})`)
}

function runLogout(): void {
  const removed = clearApiKey()
  if (removed) {
    print(`Removed stored key from ${getAuthFilePath()}`)
    return
  }
  const status = authStatus()
  if (status.configured && status.source === 'env') {
    printError('No stored key to remove — the active key comes from an environment variable and is not removable by this command.')
    return
  }
  print('No stored key found.')
}
