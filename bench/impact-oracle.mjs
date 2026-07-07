#!/usr/bin/env node
// Deterministic retrieval-oracle benchmark: raw vs ranked impact F1 at a budget,
// measured on GraphCode's own index — no agent, no API key, fully reproducible.
//
// Usage:
//   npm run build
//   node bin/graphcode.mjs index --path /path/to/hadoop --no-docs
//   node bench/impact-oracle.mjs --repo /path/to/hadoop [--budget 20] [--json]
//
// "raw" = impact candidates ordered purely by BFS propagation score (hop decay ×
// hit count), i.e. what the graph says before the structural ranker touches it.
// "ranked" = the same candidates ordered by the impact-ranker port (test
// demotion, direct-caller bonus, package locality, name match).
//
// Matching is by basename (class-file granularity, matching the predecessor
// methodology): gold "a/b/Resources.java" matches candidate "x/y/Resources.java".

import { readFileSync, existsSync } from 'node:fs'
import { join, resolve, basename, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const dist = join(here, '..', 'dist')
if (!existsSync(join(dist, 'query', 'index.js'))) {
  process.stderr.write('dist/ missing — run `npm run build` first\n')
  process.exit(1)
}

const { GraphStore } = await import(join(dist, 'graph', 'store.js'))
const { loadConfig } = await import(join(dist, 'core', 'config.js'))
const query = await import(join(dist, 'query', 'index.js'))

function parseArgs(argv) {
  const args = { budget: 20, tasks: join(here, 'tasks-hadoop-impact.json'), json: false, repo: null }
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--repo') args.repo = argv[++i]
    else if (argv[i] === '--budget') args.budget = Number(argv[++i])
    else if (argv[i] === '--tasks') args.tasks = argv[++i]
    else if (argv[i] === '--json') args.json = true
  }
  if (!args.repo) {
    process.stderr.write('usage: node bench/impact-oracle.mjs --repo /path/to/corpus [--budget 20] [--json]\n')
    process.exit(1)
  }
  return args
}

const baseKey = (path) => basename(path)

function scoreSet(orderedFiles, goldFiles, budget) {
  const gold = new Set(goldFiles.map(baseKey))
  const capped = [...new Set(orderedFiles.map(baseKey))].slice(0, budget)
  const matched = capped.filter((key) => gold.has(key))
  const precision = capped.length ? matched.length / capped.length : 0
  const recall = gold.size ? matched.length / gold.size : 0
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0
  return { precision, recall, f1, matched: matched.length, returned: capped.length, gold: gold.size }
}

const args = parseArgs(process.argv)
const config = loadConfig(resolve(args.repo))
if (!existsSync(config.dbPath)) {
  process.stderr.write(`no index at ${config.dbPath} — run: node bin/graphcode.mjs index --path ${args.repo}\n`)
  process.exit(1)
}
const spec = JSON.parse(readFileSync(args.tasks, 'utf8'))
const store = GraphStore.open(config.dbPath)

const perTask = []
for (const task of spec.tasks) {
  const resolved = query.resolveSymbol(store, task.anchor)
  if (!resolved.node) {
    perTask.push({ id: task.id, anchor: task.anchor, error: 'anchor not found in graph' })
    continue
  }
  const impact = query.impactAnalysis(store, config.root, resolved.node, { depth: 3, limit: 400 })
  const subjectKey = task.subjectFile ? baseKey(task.subjectFile) : null
  const candidates = impact.files.filter((f) => baseKey(f.filePath) !== subjectKey)

  const rankedOrder = candidates.map((f) => f.filePath)
  const rawOrder = [...candidates]
    .sort((a, b) => b.maxScore - a.maxScore || b.hitCount - a.hitCount || a.filePath.localeCompare(b.filePath))
    .map((f) => f.filePath)

  perTask.push({
    id: task.id,
    anchor: task.anchor,
    raw: scoreSet(rawOrder, task.goldCallerFiles, args.budget),
    ranked: scoreSet(rankedOrder, task.goldCallerFiles, args.budget),
  })
}
store.close()

const scored = perTask.filter((t) => !t.error)
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
const summary = {
  tasks: perTask.length,
  scored: scored.length,
  budget: args.budget,
  meanRawF1: mean(scored.map((t) => t.raw.f1)),
  meanRankedF1: mean(scored.map((t) => t.ranked.f1)),
  rankedBeatsRaw: scored.filter((t) => t.ranked.f1 > t.raw.f1).length,
  rankedTiesRaw: scored.filter((t) => t.ranked.f1 === t.raw.f1).length,
}

if (args.json) {
  process.stdout.write(`${JSON.stringify({ summary, perTask }, null, 2)}\n`)
} else {
  process.stdout.write(`impact retrieval oracle — budget ${args.budget}, ${scored.length}/${perTask.length} tasks scored\n\n`)
  for (const t of perTask) {
    if (t.error) {
      process.stdout.write(`  ${t.id.padEnd(4)} ${t.anchor.padEnd(24)} ERROR: ${t.error}\n`)
    } else {
      process.stdout.write(
        `  ${t.id.padEnd(4)} ${t.anchor.padEnd(24)} raw F1 ${t.raw.f1.toFixed(3)}  ranked F1 ${t.ranked.f1.toFixed(3)}  (gold ${t.ranked.gold})\n`,
      )
    }
  }
  process.stdout.write(`\n  mean raw F1    ${summary.meanRawF1.toFixed(3)}\n`)
  process.stdout.write(`  mean ranked F1 ${summary.meanRankedF1.toFixed(3)}\n`)
  process.stdout.write(`  ranked > raw on ${summary.rankedBeatsRaw}/${scored.length} tasks (${summary.rankedTiesRaw} ties)\n`)
}
