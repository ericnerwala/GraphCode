import { describe, expect, it } from 'vitest'
import { findTestedFilePath } from '../../src/index/indexer.js'

describe('findTestedFilePath', () => {
  it('matches foo.test.ts to foo.ts in the same directory', () => {
    const allPaths = ['src/foo.ts', 'src/foo.test.ts', 'src/bar.ts']
    expect(findTestedFilePath('src/foo.test.ts', allPaths)).toBe('src/foo.ts')
  })

  it('matches foo_test.go to foo.go', () => {
    const allPaths = ['pkg/foo.go', 'pkg/foo_test.go']
    expect(findTestedFilePath('pkg/foo_test.go', allPaths)).toBe('pkg/foo.go')
  })

  it('matches FooTest.java to Foo.java', () => {
    const allPaths = ['com/example/Foo.java', 'com/example/FooTest.java']
    expect(findTestedFilePath('com/example/FooTest.java', allPaths)).toBe('com/example/Foo.java')
  })

  it('prefers the same-directory match when multiple basenames collide', () => {
    const allPaths = ['src/a/foo.ts', 'src/b/foo.ts', 'src/a/foo.test.ts']
    expect(findTestedFilePath('src/a/foo.test.ts', allPaths)).toBe('src/a/foo.ts')
  })

  it('falls back to nearest path by common directory prefix when no same-dir match exists', () => {
    const allPaths = ['src/a/deep/foo.ts', 'other/foo.ts', 'src/a/foo.test.ts']
    const result = findTestedFilePath('src/a/foo.test.ts', allPaths)
    expect(result).toBe('src/a/deep/foo.ts')
  })

  it('returns undefined when no tested file exists', () => {
    const allPaths = ['src/foo.test.ts', 'src/unrelated.ts']
    expect(findTestedFilePath('src/foo.test.ts', allPaths)).toBeUndefined()
  })

  it('returns undefined for a path that is not itself a recognizable test name', () => {
    const allPaths = ['src/foo.ts', 'src/bar.ts']
    expect(findTestedFilePath('src/bar.ts', allPaths)).toBeUndefined()
  })
})
