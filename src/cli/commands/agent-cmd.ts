import type { Command } from 'commander'
import { mkdirSync } from 'node:fs'
import { loadConfig } from '../../core/config.js'
import { printStatus } from '../../core/output.js'
import { GraphStore } from '../../graph/store.js'
import { startAgentSession } from '../../agent/session.js'
import { ensureIndexed } from './index-cmd.js'

interface AgentOptions {
  readonly path: string
  readonly print?: boolean
  readonly model?: string
  readonly maxTurns?: number
  readonly sync?: boolean
}

export function registerAgentCommand(program: Command): void {
  program
    .command('agent [prompt...]')
    .description('Start (or run) the GraphCode agent, graph-first')
    .option('--path <dir>', 'repo root', process.cwd())
    .option('-p, --print', 'print response and exit (non-interactive)')
    .option('--model <name>', 'model to use, overrides graphcode.json')
    .option('--max-turns <n>', 'maximum agent turns', (v) => Number.parseInt(v, 10))
    .option('--no-sync', 'skip the startup graph sync')
    .action(async (promptParts: string[], options: AgentOptions) => {
      const baseConfig = loadConfig(options.path)
      const config = options.model ? { ...baseConfig, model: options.model } : baseConfig

      let store: GraphStore
      if (options.sync === false) {
        mkdirSync(config.graphDir, { recursive: true })
        store = GraphStore.open(config.dbPath)
      } else {
        printStatus('syncing graph...')
        store = await ensureIndexed(config, { onProgress: (message) => printStatus(message) })
      }

      try {
        const prompt = promptParts.length > 0 ? promptParts.join(' ') : undefined
        await startAgentSession(store, config, { prompt, maxTurns: options.maxTurns })
      } finally {
        store.close()
      }
    })
}
