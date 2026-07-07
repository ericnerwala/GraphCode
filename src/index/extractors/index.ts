import type { Tree } from 'web-tree-sitter'
import type { IndexLanguage } from '../languages.js'
import { EMPTY_EXTRACTION, type FileExtraction } from '../extract-types.js'
import { extractTsJs } from './ts-js.js'
import { extractPython } from './python.js'
import { extractGo } from './go.js'
import { extractJava } from './java.js'
import { extractRust } from './rust.js'

/** Dispatch a parsed tree to the right per-language extractor. Never throws. */
export function extractFromTree(language: IndexLanguage, tree: Tree): FileExtraction {
  try {
    switch (language) {
      case 'typescript':
      case 'tsx':
      case 'javascript':
        return extractTsJs(tree)
      case 'python':
        return extractPython(tree)
      case 'go':
        return extractGo(tree)
      case 'java':
        return extractJava(tree)
      case 'rust':
        return extractRust(tree)
      default:
        return EMPTY_EXTRACTION
    }
  } catch {
    return EMPTY_EXTRACTION
  }
}
