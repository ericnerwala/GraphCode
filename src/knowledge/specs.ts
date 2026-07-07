// Ingests markdown docs (README, ADRs, specs, changelogs) into the graph as
// `doc` nodes, linked to the files and symbols they mention.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { GraphcodeConfig } from '../core/config.js'
import type { GraphStore } from '../graph/store.js'
import type { RepoInfo } from '../graph/types.js'

export interface DocsIngestResult {
  readonly docs: number
  readonly mentionEdges: number
}

export interface DocFileRef {
  readonly path: string
}

export interface DocsIngestOptions {
  readonly onProgress?: (message: string) => void
}

const MAX_DOCS = 300
const MAX_MENTIONS_PER_DOC = 50
const DOC_SUMMARY_CHARS = 300
const MAX_AMBIGUOUS_MATCHES = 3

type DocSubkind = 'readme' | 'adr' | 'spec' | 'changelog' | 'doc'

function classifyDoc(path: string): DocSubkind {
  const base = (path.split('/').at(-1) ?? path).toLowerCase()
  if (base.startsWith('readme')) return 'readme'
  if (base.startsWith('changelog') || base.startsWith('history')) return 'changelog'
  if (/adr[-_]?\d/.test(base) || path.toLowerCase().includes('/adr')) return 'adr'
  if (base.includes('spec') || path.toLowerCase().includes('/specs/') || path.toLowerCase().includes('/rfcs/')) return 'spec'
  return 'doc'
}

function titleFor(path: string, body: string): string {
  const headingMatch = body.match(/^#\s+(.+)$/m)
  if (headingMatch?.[1]) return headingMatch[1].trim()
  const base = path.split('/').at(-1) ?? path
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(0, dot) : base
}

function summarize(body: string): string {
  // Strip the leading title heading so the summary is actual body content.
  const withoutTitle = body.replace(/^#[^\n]*\n+/, '')
  const trimmed = withoutTitle.trim()
  return trimmed.length <= DOC_SUMMARY_CHARS ? trimmed : `${trimmed.slice(0, DOC_SUMMARY_CHARS)}…`
}

/** Repo-relative-looking path tokens, e.g. `src/core/config.ts` or `README.md`. */
function extractPathMentions(body: string): string[] {
  const pattern = /(?:`)?((?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]+)(?:`)?/g
  const found = new Set<string>()
  for (const match of body.matchAll(pattern)) {
    const candidate = match[1]
    if (candidate) found.add(candidate)
  }
  return [...found]
}

/** Backtick-quoted spans that look like identifiers, e.g. `` `GraphStore` ``. */
function extractBacktickSpans(body: string): string[] {
  const pattern = /`([A-Za-z_$][A-Za-z0-9_$]*)`/g
  const found = new Set<string>()
  for (const match of body.matchAll(pattern)) {
    const candidate = match[1]
    if (candidate) found.add(candidate)
  }
  return [...found]
}

/**
 * Rebuild the doc layer: delete existing doc nodes, then ingest markdown
 * files (capped at MAX_DOCS), linking each to files and symbols it mentions.
 */
export function ingestDocs(
  store: GraphStore,
  repo: RepoInfo,
  config: GraphcodeConfig,
  docFiles: readonly DocFileRef[],
  options: DocsIngestOptions = {},
): DocsIngestResult {
  const onProgress = options.onProgress ?? (() => {})
  store.deleteNodesByKind(repo.id, 'doc')

  const files = docFiles.slice(0, MAX_DOCS)
  let docs = 0
  let mentionEdges = 0

  store.transaction(() => {
    for (const docFile of files) {
      let body: string
      try {
        body = readFileSync(join(config.root, docFile.path), 'utf8')
      } catch {
        continue
      }

      onProgress(`ingesting doc ${docFile.path}`)
      const docNodeId = store.insertNode(repo.id, {
        kind: 'doc',
        subkind: classifyDoc(docFile.path),
        name: titleFor(docFile.path, body),
        filePath: docFile.path,
        doc: summarize(body),
      })
      docs += 1

      let mentionsForDoc = 0

      for (const candidatePath of extractPathMentions(body)) {
        if (mentionsForDoc >= MAX_MENTIONS_PER_DOC) break
        if (candidatePath === docFile.path) continue
        const target = store.fileNode(repo.id, candidatePath)
        if (!target) continue
        store.insertEdge(repo.id, { src: docNodeId, dst: target.id, kind: 'mentions' })
        mentionEdges += 1
        mentionsForDoc += 1
      }

      for (const symbolName of extractBacktickSpans(body)) {
        if (mentionsForDoc >= MAX_MENTIONS_PER_DOC) break
        const matches = store.findNodesByName(symbolName, { kinds: ['symbol'], limit: MAX_AMBIGUOUS_MATCHES + 1 })
        if (matches.length === 0 || matches.length > MAX_AMBIGUOUS_MATCHES) continue
        for (const match of matches) {
          if (mentionsForDoc >= MAX_MENTIONS_PER_DOC) break
          store.insertEdge(repo.id, { src: docNodeId, dst: match.id, kind: 'mentions' })
          mentionEdges += 1
          mentionsForDoc += 1
        }
      }
    }
  })

  return { docs, mentionEdges }
}
