import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { PathEscapeError, resolveInRoot } from './path-safety.js'

export interface ReadFileInput {
  readonly path: string
  readonly offset?: number
  readonly limit?: number
}

export interface WriteFileInput {
  readonly path: string
  readonly content: string
}

export interface EditFileInput {
  readonly path: string
  readonly old_string: string
  readonly new_string: string
  readonly replace_all?: boolean
}

export interface ListDirInput {
  readonly path: string
}

/** Read a file, optionally windowed by 1-based line offset/limit, cat -n style. */
export function readFile(root: string, input: ReadFileInput): string {
  let absPath: string
  try {
    absPath = resolveInRoot(root, input.path)
  } catch (error) {
    if (error instanceof PathEscapeError) return `error: ${error.message}`
    throw error
  }
  let raw: string
  try {
    raw = readFileSync(absPath, 'utf8')
  } catch (error) {
    return `error: could not read ${input.path}: ${error instanceof Error ? error.message : String(error)}`
  }
  const lines = raw.split('\n')
  const offset = input.offset && input.offset > 0 ? input.offset : 1
  const limit = input.limit && input.limit > 0 ? input.limit : lines.length
  const startIdx = offset - 1
  const windowed = lines.slice(startIdx, startIdx + limit)
  return windowed.map((line, i) => `${startIdx + i + 1}\t${line}`).join('\n')
}

/** Write a file, creating parent directories as needed. Overwrites existing content. */
export function writeFile(root: string, input: WriteFileInput): string {
  let absPath: string
  try {
    absPath = resolveInRoot(root, input.path)
  } catch (error) {
    if (error instanceof PathEscapeError) return `error: ${error.message}`
    throw error
  }
  try {
    mkdirSync(dirname(absPath), { recursive: true })
    writeFileSync(absPath, input.content, 'utf8')
    return `wrote ${input.content.length} bytes to ${input.path}`
  } catch (error) {
    return `error: could not write ${input.path}: ${error instanceof Error ? error.message : String(error)}`
  }
}

/** Exact, unique string replacement. Actionable error text when the match is
 * missing or ambiguous (edit tools must never silently do the wrong thing). */
export function editFile(root: string, input: EditFileInput): string {
  let absPath: string
  try {
    absPath = resolveInRoot(root, input.path)
  } catch (error) {
    if (error instanceof PathEscapeError) return `error: ${error.message}`
    throw error
  }
  let raw: string
  try {
    raw = readFileSync(absPath, 'utf8')
  } catch (error) {
    return `error: could not read ${input.path}: ${error instanceof Error ? error.message : String(error)}`
  }
  if (input.old_string === input.new_string) {
    return 'error: old_string and new_string are identical - nothing to change'
  }
  const occurrences = countOccurrences(raw, input.old_string)
  if (occurrences === 0) {
    return `error: old_string not found in ${input.path} - re-read the file and copy the exact text (including whitespace)`
  }
  if (occurrences > 1 && !input.replace_all) {
    return `error: old_string matches ${occurrences} locations in ${input.path} - provide more surrounding context to make it unique, or pass replace_all: true`
  }
  const updated = input.replace_all
    ? raw.split(input.old_string).join(input.new_string)
    : replaceOnce(raw, input.old_string, input.new_string)
  try {
    writeFileSync(absPath, updated, 'utf8')
  } catch (error) {
    return `error: could not write ${input.path}: ${error instanceof Error ? error.message : String(error)}`
  }
  return `edited ${input.path} (${occurrences} replacement${occurrences === 1 ? '' : 's'})`
}

/** List a directory's immediate entries, directories suffixed with "/". */
export function listDir(root: string, input: ListDirInput): string {
  let absPath: string
  try {
    absPath = resolveInRoot(root, input.path)
  } catch (error) {
    if (error instanceof PathEscapeError) return `error: ${error.message}`
    throw error
  }
  let entries: string[]
  try {
    entries = readdirSync(absPath)
  } catch (error) {
    return `error: could not list ${input.path}: ${error instanceof Error ? error.message : String(error)}`
  }
  const rendered = entries
    .map((name) => {
      const full = join(absPath, name)
      const isDir = statSync(full).isDirectory()
      return isDir ? `${name}/` : name
    })
    .sort()
  const label = relative(root, absPath) || '.'
  return `${label}:\n${rendered.join('\n')}`
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0
  let count = 0
  let idx = haystack.indexOf(needle)
  while (idx !== -1) {
    count += 1
    idx = haystack.indexOf(needle, idx + needle.length)
  }
  return count
}

function replaceOnce(haystack: string, needle: string, replacement: string): string {
  const idx = haystack.indexOf(needle)
  if (idx === -1) return haystack
  return haystack.slice(0, idx) + replacement + haystack.slice(idx + needle.length)
}
