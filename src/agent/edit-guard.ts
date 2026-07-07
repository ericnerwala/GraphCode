// Pre-edit impact guardrail (Lever 1). Before a write/edit's result is returned
// to the model, compute the blast radius of the edited file's symbols and append
// a compact advisory — so the agent cannot "forget" to check who depends on what
// it just changed. Pure and synchronous; never throws (returns '' on any issue).
//
// PATH INVARIANT: `path` is the repo-relative, forward-slash path (record.path),
// matching nodes.file_path exactly — never a resolved absolute path.

import type { EditGuardConfig } from '../core/config.js'
import type { GraphStore } from '../graph/store.js'
import type { GraphNode } from '../graph/types.js'
import type { CoChangeHit, RankedImpactFile } from '../query/query-types.js'
import type { QueryApi } from './query-api.js'

interface MergedFileImpact {
  readonly filePath: string
  readonly maxRank: number
  /** Tier taken from the SAME per-symbol impact result that produced maxRank — never mixed across calls. */
  readonly tier: RankedImpactFile['tier']
  readonly viaSymbols: ReadonlySet<string>
}

/** Build the "[impact guard] …" advisory for an edited file, or '' when there's nothing worth saying. */
export function buildEditGuardAdvisory(
  api: QueryApi,
  store: GraphStore,
  root: string,
  repoId: number,
  path: string,
  options: EditGuardConfig,
): string {
  if (!options.enabled) return ''
  try {
    const symbols = store.nodesForFile(repoId, path).filter((n) => n.kind === 'symbol')
    if (symbols.length === 0) return ''
    // Hard cost cap: on a file with very many symbols, N reverse-BFS traversals
    // is too expensive to run inline. Emit nothing rather than truncate silently.
    if (symbols.length > options.maxSymbolsPerFile) return ''

    const { files, coChanges } = aggregateImpact(api, store, root, path, symbols, options)
    if (files.length < options.minImpactedFiles) return ''
    return renderAdvisory(files, coChanges, options.topFiles, options.topCoChanges)
  } catch {
    return ''
  }
}

/** Merge the per-symbol impact results into one per-file view, keeping the tier consistent with the max rank. */
function aggregateImpact(
  api: QueryApi,
  store: GraphStore,
  root: string,
  path: string,
  symbols: readonly GraphNode[],
  options: EditGuardConfig,
): { files: MergedFileImpact[]; coChanges: CoChangeHit[] } {
  const merged = new Map<string, { maxRank: number; tier: RankedImpactFile['tier']; viaSymbols: Set<string> }>()
  const coChangeMerged = new Map<string, CoChangeHit>()

  for (const symbol of symbols) {
    const result = api.impactAnalysis(store, root, symbol, { depth: options.depth })
    for (const f of result.files) {
      if (f.filePath === path) continue
      const existing = merged.get(f.filePath)
      if (!existing) {
        merged.set(f.filePath, { maxRank: f.rank, tier: f.tier, viaSymbols: new Set([symbol.name]) })
      } else if (f.rank > existing.maxRank) {
        // New max rank: adopt this call's tier alongside it (never mix tier from
        // one call with rank from another).
        existing.viaSymbols.add(symbol.name)
        merged.set(f.filePath, { maxRank: f.rank, tier: f.tier, viaSymbols: existing.viaSymbols })
      } else {
        existing.viaSymbols.add(symbol.name)
      }
    }
    for (const c of result.coChanges) {
      const key = `${c.filePath}::${c.withFile}`
      const existing = coChangeMerged.get(key)
      if (!existing || c.weight > existing.weight) coChangeMerged.set(key, c)
    }
  }

  const files: MergedFileImpact[] = [...merged.entries()]
    .map(([filePath, v]) => ({ filePath, maxRank: v.maxRank, tier: v.tier, viaSymbols: v.viaSymbols }))
    .sort((a, b) => b.maxRank - a.maxRank || a.filePath.localeCompare(b.filePath))

  const coChanges = [...coChangeMerged.values()].sort((a, b) => b.weight - a.weight)
  return { files, coChanges }
}

function renderAdvisory(
  files: readonly MergedFileImpact[],
  coChanges: readonly CoChangeHit[],
  topFiles: number,
  topCoChanges: number,
): string {
  const shown = files.slice(0, topFiles)
  const lines = [`[impact guard] ${files.length} file(s) depend on symbols in this file — check them before finishing:`]
  for (const f of shown) lines.push(`  - [${f.tier}] ${f.filePath} (via ${[...f.viaSymbols].join(', ')})`)
  if (files.length > shown.length) {
    lines.push(`  … and ${files.length - shown.length} more (use graph_impact for the full list)`)
  }
  const ccShown = coChanges.slice(0, topCoChanges)
  if (ccShown.length > 0) {
    lines.push('  History co-changes:')
    for (const c of ccShown) lines.push(`  - ${c.filePath} with ${c.withFile} (weight ${c.weight.toFixed(2)})`)
  }
  return lines.join('\n')
}
