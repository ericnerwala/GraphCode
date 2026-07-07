import type { Command } from 'commander'
import { existsSync } from 'node:fs'
import { loadConfig } from '../../core/config.js'
import { NotIndexedError } from '../../core/errors.js'
import { print } from '../../core/output.js'
import { GraphStore } from '../../graph/store.js'

export function registerStatsCommand(program: Command): void {
  program
    .command('stats')
    .description('Show index statistics for the current repo')
    .option('--path <dir>', 'repo root', process.cwd())
    .option('--json', 'machine-readable output')
    .action((options: { path: string; json?: boolean }) => {
      const config = loadConfig(options.path)
      if (!existsSync(config.dbPath)) throw new NotIndexedError(config.root)
      const store = GraphStore.open(config.dbPath)
      try {
        const stats = store.stats()
        if (options.json) {
          print(JSON.stringify(stats, null, 2))
          return
        }
        print(`GraphCode index: ${config.dbPath}`)
        print(`  files:    ${stats.files}`)
        print(`  symbols:  ${stats.symbols}`)
        print(`  commits:  ${stats.commits}`)
        print(`  docs:     ${stats.docs}`)
        print(`  features: ${stats.features}`)
        print(`  edges:    ${stats.edges}`)
        const byKind = Object.entries(stats.edgesByKind)
          .sort((a, b) => b[1] - a[1])
          .map(([kind, count]) => `${kind}=${count}`)
          .join(' ')
        print(`  edge kinds: ${byKind}`)
        const langs = Object.entries(stats.languages)
          .sort((a, b) => b[1] - a[1])
          .map(([lang, count]) => `${lang}=${count}`)
          .join(' ')
        print(`  languages: ${langs}`)
      } finally {
        store.close()
      }
    })
}
