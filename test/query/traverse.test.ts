import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { rmSync } from 'node:fs'
import type { GraphStore } from '../../src/graph/store.js'
import { findCallees, findCallers } from '../../src/query/traverse.js'
import { buildDiamondGraph, makeTempStore } from './fixtures.js'

describe('findCallers / findCallees on a diamond call graph', () => {
  let dir: string
  let store: GraphStore

  beforeEach(() => {
    const t = makeTempStore()
    dir = t.dir
    store = t.store
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('finds direct callees of top (left, right) at depth 1', () => {
    const { top } = buildDiamondGraph(store)
    const node = store.getNode(top)
    if (!node) throw new Error('missing node')
    const callees = findCallees(store, node, { depth: 1 })
    expect(callees.map((c) => c.symbol).sort()).toEqual(['left', 'right'])
    expect(callees.every((c) => c.depth === 1)).toBe(true)
  })

  it('finds bottom at depth 2 from top, deduped (both paths converge)', () => {
    const { top } = buildDiamondGraph(store)
    const node = store.getNode(top)
    if (!node) throw new Error('missing node')
    const callees = findCallees(store, node, { depth: 2 })
    const bottomHits = callees.filter((c) => c.symbol === 'bottom')
    expect(bottomHits).toHaveLength(1)
    expect(bottomHits[0]?.depth).toBe(2)
  })

  it('sorts callees by depth then name', () => {
    const { top } = buildDiamondGraph(store)
    const node = store.getNode(top)
    if (!node) throw new Error('missing node')
    const callees = findCallees(store, node, { depth: 2 })
    const depths = callees.map((c) => c.depth)
    expect(depths).toEqual([...depths].sort((a, b) => a - b))
  })

  it('finds direct callers of bottom (left, right) at depth 1', () => {
    const { bottom } = buildDiamondGraph(store)
    const node = store.getNode(bottom)
    if (!node) throw new Error('missing node')
    const callers = findCallers(store, node, { depth: 1 })
    expect(callers.map((c) => c.symbol).sort()).toEqual(['left', 'right'])
  })

  it('finds top at depth 2 from bottom via reverse walk', () => {
    const { bottom } = buildDiamondGraph(store)
    const node = store.getNode(bottom)
    if (!node) throw new Error('missing node')
    const callers = findCallers(store, node, { depth: 2 })
    const topHits = callers.filter((c) => c.symbol === 'top')
    expect(topHits).toHaveLength(1)
    expect(topHits[0]?.depth).toBe(2)
  })

  it('includes file and line info on hits', () => {
    const { top } = buildDiamondGraph(store)
    const node = store.getNode(top)
    if (!node) throw new Error('missing node')
    const callees = findCallees(store, node, { depth: 1 })
    for (const c of callees) {
      expect(c.file).toBeDefined()
      expect(c.line).toBeDefined()
    }
  })

  it('respects the limit option', () => {
    const { top } = buildDiamondGraph(store)
    const node = store.getNode(top)
    if (!node) throw new Error('missing node')
    const callees = findCallees(store, node, { depth: 2, limit: 1 })
    expect(callees.length).toBeLessThanOrEqual(1)
  })

  it('builds a viaPath from target to hit', () => {
    const { top } = buildDiamondGraph(store)
    const node = store.getNode(top)
    if (!node) throw new Error('missing node')
    const callees = findCallees(store, node, { depth: 2 })
    const bottomHit = callees.find((c) => c.symbol === 'bottom')
    expect(bottomHit?.viaPath[0]).toBe('top')
    expect(bottomHit?.viaPath.at(-1)).toBe('bottom')
  })

  it('returns empty array when node has no calls edges', () => {
    const { bottom } = buildDiamondGraph(store)
    const node = store.getNode(bottom)
    if (!node) throw new Error('missing node')
    const callees = findCallees(store, node, { depth: 1 })
    expect(callees).toHaveLength(0)
  })
})
