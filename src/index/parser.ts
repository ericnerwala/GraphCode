import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { Language, Parser } from 'web-tree-sitter'
import type { IndexLanguage, LanguageDef } from './languages.js'

let initialized = false
const languageCache = new Map<IndexLanguage, Language>()

function wasmDir(): string {
  const require = createRequire(import.meta.url)
  const pkgPath = require.resolve('tree-sitter-wasms/package.json')
  return join(dirname(pkgPath), 'out')
}

/** Must be called once before getParserFor(). Idempotent. */
export async function initParsers(): Promise<void> {
  if (initialized) return
  await Parser.init()
  initialized = true
}

async function loadLanguage(def: LanguageDef): Promise<Language> {
  const cached = languageCache.get(def.language)
  if (cached) return cached
  const wasmPath = join(wasmDir(), def.wasmFile)
  // Read the wasm bytes ourselves and pass a Uint8Array (rather than a path
  // string) to Language.load(). Passing a path makes web-tree-sitter's ESM
  // build internally call `require('fs/promises')` via a `require` shim that
  // isn't available under bundler-transformed ESM (e.g. Vitest/Vite's SSR
  // module runner), which throws "Dynamic require of fs/promises is not
  // supported". Reading the bytes with real node:fs/promises avoids that path.
  const bytes = await readFile(wasmPath)
  const lang = await Language.load(new Uint8Array(bytes))
  languageCache.set(def.language, lang)
  return lang
}

/** Get a parser configured for the given language. Loads the grammar once, then reuses it. */
export async function getParserFor(def: LanguageDef): Promise<Parser> {
  if (!initialized) await initParsers()
  const lang = await loadLanguage(def)
  const parser = new Parser()
  parser.setLanguage(lang)
  return parser
}

/** Reset cached state (used by tests that need a clean parser cache). */
export function resetParserCache(): void {
  languageCache.clear()
  initialized = false
}
