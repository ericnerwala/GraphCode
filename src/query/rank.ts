// Port of the author's validated impact-ranker-v2 research prototype (held-out
// F1 0.519 vs 0.169 raw-impact oracle; the prototype is not part of this repo).
// Semantics are ported faithfully: same additive score, same signal set, same
// tiering. Only the surface shape changes (TS types, GraphCode's file-path
// convention) to fit this codebase.

import type { RankCandidate, RankedCandidate, RankSignals } from './query-types.js'

/** Origin: impact-ranker-v2.mjs WEIGHTS. Each constant's provenance is documented there;
 * reproduced here so the port stays traceable to the validated source. */
export const RANK_WEIGHTS = {
  /** Additive 1-hop-caller bonus — a direct caller that is also dense wins; a
   * low-density direct caller does not leapfrog a dense production dependent. */
  direct: 8,
  /** Same-package (directory) locality: a small tiebreak-grade nudge, not the
   * dominant term (v1's mistake was making this +20 and dominant). */
  pkg: 4,
  /** Basename-contains-anchor-word bonus: implementor/subclass naming convention
   * (`MonotonicClock` implements `Clock`). Reaches 2-hop, low-density gold that
   * neither density nor direct-caller sets surface. */
  nameMatch: 10,
  /** Anchor words shorter than this are not used for name-match (avoids
   * short anchors like "id"/"rpc" over-firing). */
  minAnchorWord: 4,
  /** Test files are pushed below everything real — additive penalty, not a
   * hard drop, so ordering among test files is still density-driven. */
  testPenalty: 100000,
} as const

export type RankWeights = typeof RANK_WEIGHTS

/** Structural test-file detector, duplicated locally per task instructions
 * (avoid cross-module deps on the v2 source). Matches the same conventions:
 * a `/test/` or `/tests/` path segment, or a `*.test.*` / `*_test.*` /
 * `__tests__/` style basename. */
const TEST_PATH_RE = /(^|\/)(test|tests|__tests__)(\/|$)/i
const TEST_NAME_RE = /(\.test\.|\.spec\.|_test\.|_spec\.)/i

export function isTestFile(filePath: string): boolean {
  const path = normalizePath(filePath)
  if (TEST_PATH_RE.test(path)) return true
  const base = path.split('/').at(-1) ?? path
  return TEST_NAME_RE.test(base)
}

function normalizePath(filePath: string): string {
  return filePath.replaceAll('\\', '/')
}

/** Basename without extension, lowercased — the key name-match is keyed on. */
export function basenameOf(filePath: string): string {
  const base = normalizePath(filePath).split('/').at(-1) ?? filePath
  const dot = base.lastIndexOf('.')
  return (dot > 0 ? base.slice(0, dot) : base).toLowerCase()
}

function packageOf(filePath: string): string {
  const parts = normalizePath(filePath).split('/')
  parts.pop()
  return parts.join('/')
}

/** Anchor "word" for name-matching: lowercased, non-alnum stripped, trailing
 * version digits stripped so `HttpServer2` still matches `NameNodeHttpServer`. */
function anchorWord(anchor: string): string {
  return anchor
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .replace(/\d+$/, '')
}

/**
 * Score and tier a set of candidate files against a changing symbol (`anchor`)
 * defined in `subjectFile`. Pure function — same semantics as impact-ranker-v2's
 * `rankImpact`, adapted to take pre-aggregated candidates instead of raw
 * impact/callers JSON (the graph store already gives us aggregated hits).
 */
export function rankCandidates(
  candidates: readonly RankCandidate[],
  subjectFile: string,
  anchor: string,
  weights: RankWeights = RANK_WEIGHTS,
): RankedCandidate[] {
  const subjectPkg = packageOf(subjectFile)
  const aWord = anchorWord(anchor)
  const useNameMatch = aWord.length >= weights.minAnchorWord
  const anchorFileKey = basenameOf(subjectFile)

  const rows: RankedCandidate[] = []
  for (const candidate of candidates) {
    const key = basenameOf(candidate.filePath)
    if (key === anchorFileKey) continue // exclude the subject symbol's own file

    const samePkg = subjectPkg.length > 0 && packageOf(candidate.filePath) === subjectPkg
    const isTest = isTestFile(candidate.filePath)
    const nameMatch = useNameMatch && key.includes(aWord)

    let score =
      candidate.refs +
      (candidate.direct ? weights.direct : 0) +
      (samePkg ? weights.pkg : 0) +
      (nameMatch ? weights.nameMatch : 0)
    if (isTest) score -= weights.testPenalty

    const signals: RankSignals = { refs: candidate.refs, direct: candidate.direct, samePkg, nameMatch, isTest }
    rows.push({ filePath: candidate.filePath, score, tier: tierFor(signals), signals })
  }

  rows.sort((a, b) => b.score - a.score || b.signals.refs - a.signals.refs || a.filePath.localeCompare(b.filePath))
  return rows
}

function tierFor(signals: RankSignals): RankedCandidate['tier'] {
  if (signals.isTest) return 'test'
  if (signals.direct) return 'direct'
  if (signals.nameMatch) return 'strong'
  if (signals.refs >= 3) return 'strong'
  return 'weak'
}
