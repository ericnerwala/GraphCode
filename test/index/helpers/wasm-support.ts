import { getParserFor, initParsers } from '../../../src/index/parser.js'
import { languageForPath } from '../../../src/index/languages.js'

let cached: Promise<boolean> | null = null

/**
 * Probe whether tree-sitter grammars can actually load in this environment.
 * Tests that require real parsing should `describe.skipIf(!(await wasmGrammarsLoad()))`
 * so environment-level wasm-loader incompatibilities show as SKIPPED, not silently green.
 */
export async function wasmGrammarsLoad(): Promise<boolean> {
  if (cached) return cached
  cached = (async () => {
    await initParsers()
    const def = languageForPath('probe.ts')
    if (!def) return false
    try {
      const parser = await getParserFor(def)
      const tree = parser.parse('const x = 1')
      return tree !== null
    } catch {
      return false
    }
  })()
  return cached
}
