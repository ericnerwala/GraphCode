import { describe, expect, it } from 'vitest'
import { basenameOf, isTestFile, rankCandidates, RANK_WEIGHTS } from '../../src/query/rank.js'
import type { RankCandidate } from '../../src/query/query-types.js'

describe('isTestFile', () => {
  it('detects test/ and tests/ path segments', () => {
    expect(isTestFile('test/foo.ts')).toBe(true)
    expect(isTestFile('src/tests/foo.ts')).toBe(true)
    expect(isTestFile('__tests__/foo.ts')).toBe(true)
  })

  it('detects .test. and .spec. and _test. basenames', () => {
    expect(isTestFile('src/foo.test.ts')).toBe(true)
    expect(isTestFile('src/foo.spec.ts')).toBe(true)
    expect(isTestFile('src/foo_test.ts')).toBe(true)
    expect(isTestFile('src/foo_spec.ts')).toBe(true)
  })

  it('does not flag ordinary production files', () => {
    expect(isTestFile('src/core/clock.ts')).toBe(false)
    expect(isTestFile('src/attestation.ts')).toBe(false)
  })
})

describe('basenameOf', () => {
  it('strips directory and extension, lowercases', () => {
    expect(basenameOf('src/core/MonotonicClock.ts')).toBe('monotonicclock')
  })
})

describe('rankCandidates (impact-ranker-v2 port)', () => {
  it('excludes the anchor subject file itself', () => {
    const candidates: RankCandidate[] = [{ filePath: 'src/clock.ts', refs: 5, direct: true }]
    const ranked = rankCandidates(candidates, 'src/clock.ts', 'Clock')
    expect(ranked).toHaveLength(0)
  })

  it('gives an additive direct-caller bonus', () => {
    // Different directory from the candidates so the same-package bonus
    // does not confound the direct-caller delta being measured here.
    const candidates: RankCandidate[] = [
      { filePath: 'pkg-a/a.ts', refs: 2, direct: true },
      { filePath: 'pkg-a/b.ts', refs: 2, direct: false },
    ]
    const ranked = rankCandidates(candidates, 'pkg-b/target.ts', 'Target')
    const a = ranked.find((r) => r.filePath === 'pkg-a/a.ts')
    const b = ranked.find((r) => r.filePath === 'pkg-a/b.ts')
    expect(a?.score).toBe(2 + RANK_WEIGHTS.direct)
    expect(b?.score).toBe(2)
    expect(a && b && a.score > b.score).toBe(true)
  })

  it('gives a same-package bonus relative to the target file directory', () => {
    const candidates: RankCandidate[] = [
      { filePath: 'src/core/sibling.ts', refs: 1, direct: false },
      { filePath: 'src/other/far.ts', refs: 1, direct: false },
    ]
    const ranked = rankCandidates(candidates, 'src/core/target.ts', 'Target')
    const sibling = ranked.find((r) => r.filePath === 'src/core/sibling.ts')
    const far = ranked.find((r) => r.filePath === 'src/other/far.ts')
    expect(sibling?.signals.samePkg).toBe(true)
    expect(far?.signals.samePkg).toBe(false)
    expect(sibling?.score).toBe(1 + RANK_WEIGHTS.pkg)
  })

  it('applies name-match bonus when basename contains the anchor word', () => {
    const candidates: RankCandidate[] = [
      { filePath: 'src/core/MonotonicClock.ts', refs: 1, direct: false },
      { filePath: 'src/core/Unrelated.ts', refs: 1, direct: false },
    ]
    const ranked = rankCandidates(candidates, 'src/core/Clock.ts', 'Clock')
    const impl = ranked.find((r) => r.filePath === 'src/core/MonotonicClock.ts')
    const unrelated = ranked.find((r) => r.filePath === 'src/core/Unrelated.ts')
    expect(impl?.signals.nameMatch).toBe(true)
    // both are same-package (src/core), so isolate the name-match delta
    expect(impl && unrelated && impl.score - unrelated.score).toBe(RANK_WEIGHTS.nameMatch)
  })

  it('does not use name-match for anchor words shorter than minAnchorWord', () => {
    const candidates: RankCandidate[] = [{ filePath: 'src/rpcHandler.ts', refs: 1, direct: false }]
    const ranked = rankCandidates(candidates, 'src/target.ts', 'rpc')
    expect(ranked[0]?.signals.nameMatch).toBe(false)
  })

  it('demotes test files below real candidates even with much higher density (v2 semantics)', () => {
    const candidates: RankCandidate[] = [
      { filePath: 'src/core/clock.test.ts', refs: 50, direct: true }, // dense + direct but a test file
      { filePath: 'src/core/production-caller.ts', refs: 2, direct: false },
    ]
    const ranked = rankCandidates(candidates, 'src/core/Clock.ts', 'Clock')
    expect(ranked[0]?.filePath).toBe('src/core/production-caller.ts')
    expect(ranked[0]?.tier).not.toBe('test')
    expect(ranked.at(-1)?.filePath).toBe('src/core/clock.test.ts')
    expect(ranked.at(-1)?.tier).toBe('test')
    expect(ranked.at(-1)?.score).toBeLessThan(0)
  })

  it('assigns tiers: direct, strong (name-match or refs>=3), weak, test', () => {
    const candidates: RankCandidate[] = [
      { filePath: 'src/direct.ts', refs: 1, direct: true },
      { filePath: 'src/MonotonicClock.ts', refs: 1, direct: false },
      { filePath: 'src/dense.ts', refs: 3, direct: false },
      { filePath: 'src/thin.ts', refs: 1, direct: false },
      { filePath: 'src/thin.test.ts', refs: 1, direct: false },
    ]
    const ranked = rankCandidates(candidates, 'src/Clock.ts', 'Clock')
    const byPath = Object.fromEntries(ranked.map((r) => [r.filePath, r.tier]))
    expect(byPath['src/direct.ts']).toBe('direct')
    expect(byPath['src/MonotonicClock.ts']).toBe('strong')
    expect(byPath['src/dense.ts']).toBe('strong')
    expect(byPath['src/thin.ts']).toBe('weak')
    expect(byPath['src/thin.test.ts']).toBe('test')
  })

  it('sorts by score desc, then refs desc, then basename asc for stability', () => {
    const candidates: RankCandidate[] = [
      { filePath: 'src/z.ts', refs: 1, direct: false },
      { filePath: 'src/a.ts', refs: 1, direct: false },
    ]
    const ranked = rankCandidates(candidates, 'src/target.ts', 'Target')
    expect(ranked.map((r) => r.filePath)).toEqual(['src/a.ts', 'src/z.ts'])
  })

  it('accepts custom weights', () => {
    const candidates: RankCandidate[] = [{ filePath: 'pkg-a/a.ts', refs: 1, direct: true }]
    const ranked = rankCandidates(candidates, 'pkg-b/target.ts', 'Target', { ...RANK_WEIGHTS, direct: 100 })
    expect(ranked[0]?.score).toBe(101)
  })
})
