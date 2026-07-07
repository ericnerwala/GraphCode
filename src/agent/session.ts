// Session driver: print mode (single prompt, chain to completion, exit) and
// interactive REPL mode (multi-turn history, local slash commands).

import Anthropic from '@anthropic-ai/sdk'
import { createInterface } from 'node:readline/promises'
import type { GraphStore } from '../graph/store.js'
import type { GraphcodeConfig } from '../core/config.js'
import { resolveApiKey } from '../core/auth.js'
import { runLogin, promptForApiKey } from '../cli/commands/auth-cmd.js'
import { GraphcodeError } from '../core/errors.js'
import { print, printStatus } from '../core/output.js'
import { buildSystemPrompt } from './prompts.js'
import { runAgentLoop, type MessageParam, type MessagesClient } from './loop.js'
import { buildContextPack } from '../query/index.js'

export interface StartAgentSessionOptions {
  readonly prompt?: string
  readonly maxTurns?: number
}

const CONTEXT_SEPARATOR = '\n\n---\n\n'

/** Entry point for the `graphcode agent` command. Requires an Anthropic API key
 * unless a client is injected (tests always inject one). */
export async function startAgentSession(
  store: GraphStore,
  config: GraphcodeConfig,
  options: StartAgentSessionOptions = {},
  client?: MessagesClient,
): Promise<void> {
  const messagesClient = client ?? (await buildRealClient())
  const stats = store.stats()
  const systemPrompt = buildSystemPrompt(config.root, stats)

  if (options.prompt !== undefined) {
    await runPrintMode(messagesClient, config, store, systemPrompt, options.prompt, options.maxTurns)
    return
  }
  await runInteractiveMode(messagesClient, config, store, systemPrompt, options.maxTurns)
}

async function buildRealClient(): Promise<MessagesClient> {
  const apiKey = await resolveOrPromptForApiKey()
  const sdk = new Anthropic({ apiKey })
  return {
    create: (params) => sdk.messages.create(params as never) as unknown as ReturnType<MessagesClient['create']>,
    stream: (params) => sdk.messages.stream(params as never) as unknown as ReturnType<Required<MessagesClient>['stream']>,
  }
}

/** Resolves an API key from env/auth-file, or — for an interactive TTY session with
 * neither configured — runs the same `auth login` flow inline before continuing. */
async function resolveOrPromptForApiKey(): Promise<string> {
  const resolved = resolveApiKey()
  if (resolved) return resolved.key

  if (process.stdin.isTTY) {
    printStatus("No Anthropic API key found — let's set one up (stored in ~/.config/graphcode/auth.json).")
    await runLogin(promptForApiKey)
    const afterLogin = resolveApiKey()
    if (afterLogin) return afterLogin.key
  }

  throw new GraphcodeError(
    'No Anthropic API key configured.',
    'Run `graphcode auth login` or set ANTHROPIC_API_KEY. Graph queries (graphcode search/impact/explore) and `graphcode mcp` work without a key.',
  )
}

function firstUserContent(contextMarkdown: string, prompt: string): string {
  return `${contextMarkdown}${CONTEXT_SEPARATOR}${prompt}`
}

async function runPrintMode(
  client: MessagesClient,
  config: GraphcodeConfig,
  store: GraphStore,
  systemPrompt: string,
  prompt: string,
  maxTurns: number | undefined,
): Promise<void> {
  const pack = buildContextPack(store, config.root, prompt, config.contextPackTokens)
  const history: MessageParam[] = [{ role: 'user', content: firstUserContent(pack.markdown, prompt) }]
  await runAgentLoop(client, config.model, systemPrompt, history, { store, root: config.root, config }, { maxTurns })
}

async function runInteractiveMode(
  client: MessagesClient,
  config: GraphcodeConfig,
  store: GraphStore,
  systemPrompt: string,
  maxTurns: number | undefined,
): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  let history: MessageParam[] = []
  let isFirstMessage = true
  try {
    for (;;) {
      const line = await rl.question('graphcode> ')
      const trimmed = line.trim()
      if (trimmed.length === 0) continue
      if (trimmed === '/quit') return
      if (trimmed === '/clear') {
        history = []
        isFirstMessage = true
        print('history cleared')
        continue
      }
      if (trimmed === '/stats') {
        const stats = store.stats()
        print(`files=${stats.files} symbols=${stats.symbols} edges=${stats.edges}`)
        continue
      }

      const userContent = isFirstMessage
        ? firstUserContent(buildContextPack(store, config.root, trimmed, config.contextPackTokens).markdown, trimmed)
        : trimmed
      isFirstMessage = false
      history.push({ role: 'user', content: userContent })
      history = await runAgentLoop(client, config.model, systemPrompt, history, { store, root: config.root, config }, { maxTurns })
    }
  } finally {
    rl.close()
  }
}

// Re-exported so callers that only need the "is a key configured" check don't
// have to duplicate the resolution order (env vars, then the auth file).
export { hasApiKey } from '../core/auth.js'
