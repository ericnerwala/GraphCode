// Clusters conventional-commit history into `feature` nodes (one per
// scope), linking the commits and files that belong to each feature.
import type { GraphStore } from '../graph/store.js'
import type { RepoInfo } from '../graph/types.js'

export interface FeaturesIngestResult {
  readonly features: number
  readonly featureEdges: number
}

const MIN_COMMITS_PER_FEATURE = 2
const MIN_FILE_TOUCHES_PER_FEATURE = 2
const MAX_SAMPLE_SUBJECTS = 5

interface CommitRow {
  id: number
  qualified_name: string | null
  doc: string | null
}

// Conventional commit: type(scope)!: subject  (scope and ! are optional).
const CONVENTIONAL_COMMIT_RE = /^([a-zA-Z][\w-]*)(?:\(([^)]+)\))?!?:\s*(.+)$/

interface ParsedSubject {
  readonly type: string
  readonly scope: string
  readonly subject: string
}

function parseConventionalSubject(subject: string): ParsedSubject | null {
  const match = subject.match(CONVENTIONAL_COMMIT_RE)
  if (!match) return null
  const [, type, scope, rest] = match
  if (!type || !scope || !rest) return null
  return { type: type.toLowerCase(), scope, subject: rest.trim() }
}

/**
 * Rebuild the feature layer from commit nodes already present in the graph.
 * Commits are read via store.raw against the nodes table (no other index
 * needed). Scopes with fewer than MIN_COMMITS_PER_FEATURE commits are
 * dropped as noise.
 */
export function ingestFeatures(store: GraphStore, repo: RepoInfo): FeaturesIngestResult {
  store.deleteNodesByKind(repo.id, 'feature')

  const rows = store.raw("SELECT id, qualified_name, doc FROM nodes WHERE repo_id = ? AND kind = 'commit'", [
    repo.id,
  ]) as CommitRow[]

  const byScope = new Map<string, { commitIds: number[]; subjects: string[]; types: Set<string> }>()
  for (const row of rows) {
    const subject = row.doc ?? ''
    const parsed = parseConventionalSubject(subject)
    if (!parsed) continue
    const entry = byScope.get(parsed.scope) ?? { commitIds: [], subjects: [], types: new Set<string>() }
    entry.commitIds.push(row.id)
    entry.subjects.push(parsed.subject)
    entry.types.add(parsed.type)
    byScope.set(parsed.scope, entry)
  }

  let features = 0
  let featureEdges = 0

  store.transaction(() => {
    for (const [scope, entry] of byScope) {
      if (entry.commitIds.length < MIN_COMMITS_PER_FEATURE) continue

      const featureNodeId = store.insertNode(repo.id, {
        kind: 'feature',
        name: scope,
        doc: entry.subjects.slice(0, MAX_SAMPLE_SUBJECTS).join('; '),
        meta: {
          commitCount: entry.commitIds.length,
          types: [...entry.types],
        },
      })
      features += 1

      const fileTouchCounts = new Map<number, number>()
      for (const commitId of entry.commitIds) {
        store.insertEdge(repo.id, { src: commitId, dst: featureNodeId, kind: 'in_feature' })
        featureEdges += 1

        const touchedFiles = store.neighbors(commitId, { direction: 'in', kinds: ['touched_by'] })
        for (const neighbor of touchedFiles) {
          if (neighbor.node.kind !== 'file') continue
          fileTouchCounts.set(neighbor.node.id, (fileTouchCounts.get(neighbor.node.id) ?? 0) + 1)
        }
      }

      for (const [fileId, touchCount] of fileTouchCounts) {
        if (touchCount < MIN_FILE_TOUCHES_PER_FEATURE) continue
        store.insertEdge(repo.id, { src: fileId, dst: featureNodeId, kind: 'in_feature', weight: touchCount })
        featureEdges += 1
      }
    }
  })

  return { features, featureEdges }
}
