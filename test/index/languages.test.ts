import { describe, expect, it } from 'vitest'
import { extensionOf, isTestPath, languageForPath, SUPPORTED_EXTENSIONS } from '../../src/index/languages.js'

describe('languageForPath', () => {
  it('maps common extensions to the right language + wasm file', () => {
    expect(languageForPath('src/foo.ts')).toEqual({ language: 'typescript', wasmFile: 'tree-sitter-typescript.wasm' })
    expect(languageForPath('src/foo.tsx')).toEqual({ language: 'tsx', wasmFile: 'tree-sitter-tsx.wasm' })
    expect(languageForPath('src/foo.js')).toEqual({ language: 'javascript', wasmFile: 'tree-sitter-javascript.wasm' })
    expect(languageForPath('src/foo.jsx')).toEqual({ language: 'javascript', wasmFile: 'tree-sitter-javascript.wasm' })
    expect(languageForPath('src/foo.mjs')).toEqual({ language: 'javascript', wasmFile: 'tree-sitter-javascript.wasm' })
    expect(languageForPath('src/foo.cjs')).toEqual({ language: 'javascript', wasmFile: 'tree-sitter-javascript.wasm' })
    expect(languageForPath('a/b.py')).toEqual({ language: 'python', wasmFile: 'tree-sitter-python.wasm' })
    expect(languageForPath('a/b.go')).toEqual({ language: 'go', wasmFile: 'tree-sitter-go.wasm' })
    expect(languageForPath('a/b.java')).toEqual({ language: 'java', wasmFile: 'tree-sitter-java.wasm' })
    expect(languageForPath('a/b.rs')).toEqual({ language: 'rust', wasmFile: 'tree-sitter-rust.wasm' })
  })

  it('returns null for unsupported extensions', () => {
    expect(languageForPath('README.md')).toBeNull()
    expect(languageForPath('image.png')).toBeNull()
    expect(languageForPath('noext')).toBeNull()
  })

  it('is case-insensitive on extension', () => {
    expect(languageForPath('FOO.TS')?.language).toBe('typescript')
  })

  it('lists all supported extensions', () => {
    expect(SUPPORTED_EXTENSIONS).toContain('.ts')
    expect(SUPPORTED_EXTENSIONS).toContain('.rs')
    expect(SUPPORTED_EXTENSIONS.length).toBeGreaterThanOrEqual(10)
  })
})

describe('extensionOf', () => {
  it('extracts a lowercase extension', () => {
    expect(extensionOf('a/b/Foo.TS')).toBe('.ts')
    expect(extensionOf('noext')).toBe('')
    expect(extensionOf('.gitignore')).toBe('')
  })
})

describe('isTestPath', () => {
  it('recognizes common test-file naming patterns', () => {
    expect(isTestPath('src/foo.test.ts')).toBe(true)
    expect(isTestPath('src/foo.spec.ts')).toBe(true)
    expect(isTestPath('src/foo_test.py')).toBe(true)
    expect(isTestPath('pkg/foo_test.go')).toBe(true)
    expect(isTestPath('com/FooTest.java')).toBe(true)
    expect(isTestPath('com/FooTests.java')).toBe(true)
  })

  it('recognizes test/tests/__tests__ directories', () => {
    expect(isTestPath('__tests__/foo.ts')).toBe(true)
    expect(isTestPath('test/foo.ts')).toBe(true)
    expect(isTestPath('tests/foo.ts')).toBe(true)
    expect(isTestPath('src/test/foo.ts')).toBe(true)
  })

  it('does not misclassify regular source files', () => {
    expect(isTestPath('src/foo.ts')).toBe(false)
    expect(isTestPath('src/contest.ts')).toBe(false)
    expect(isTestPath('src/latest.ts')).toBe(false)
    expect(isTestPath('src/testimonial.ts')).toBe(false)
  })
})
