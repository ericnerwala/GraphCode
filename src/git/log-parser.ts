// Parses `git log --numstat` output produced with a marker-delimited pretty
// format. Shared by history.ts (node/edge ingest) and cochange.ts (mining),
// so both layers agree on exactly what a "commit" and a "file touch" are.

/** One file touched by a commit, as reported by --numstat. */
export interface NumstatEntry {
  /** Path to record against (new path for renames). */
  readonly path: string
  readonly insertions: number
  readonly deletions: number
}

export interface ParsedCommit {
  readonly sha: string
  readonly author: string
  readonly email: string
  /** Unix seconds, from the committer date. */
  readonly ts: number
  readonly subject: string
  readonly files: readonly NumstatEntry[]
}

// Fields: sha, author name, author email, committer timestamp, subject.
// Unit separators (\x1f) avoid collisions with commit subjects containing
// commas or pipes; \x1e marks the record end so numstat lines (which follow
// on their own lines) can be associated with the right commit.
const FIELD_SEP = '\x1f'
const RECORD_END = '\x1e'
const PRETTY_FORMAT = `--pretty=format:${RECORD_END}%H${FIELD_SEP}%an${FIELD_SEP}%ae${FIELD_SEP}%ct${FIELD_SEP}%s`

export function gitLogArgs(range: string | null, maxCommits: number): string[] {
  const args = ['log', '--no-merges', '--numstat', PRETTY_FORMAT, `-n`, String(maxCommits)]
  if (range) args.push(range)
  return args
}

/** Parse a rename numstat path like `old/path.ts => new/path.ts` or the
 * brace form `src/{old => new}/path.ts`. Returns the new-path side. */
function resolveRenamedPath(rawPath: string): string {
  const braceMatch = rawPath.match(/^(.*)\{(.*) => (.*)\}(.*)$/)
  if (braceMatch) {
    const [, prefix, , after, suffix] = braceMatch
    return `${prefix ?? ''}${after ?? ''}${suffix ?? ''}`.replace(/\/{2,}/g, '/')
  }
  const plainMatch = rawPath.match(/^(.*) => (.*)$/)
  if (plainMatch) {
    const [, , after] = plainMatch
    return (after ?? rawPath).trim()
  }
  return rawPath
}

/** Parse the full output of `git log` run with gitLogArgs into commits. */
export function parseGitLog(output: string): ParsedCommit[] {
  if (output.length === 0) return []
  const records = output.split(RECORD_END).filter((r) => r.length > 0)
  const commits: ParsedCommit[] = []
  for (const record of records) {
    const newlineIdx = record.indexOf('\n')
    const header = newlineIdx === -1 ? record : record.slice(0, newlineIdx)
    const rest = newlineIdx === -1 ? '' : record.slice(newlineIdx + 1)
    const parts = header.split(FIELD_SEP)
    const sha = parts[0]
    const author = parts[1]
    const email = parts[2]
    const tsRaw = parts[3]
    const subject = parts[4]
    if (!sha || tsRaw === undefined || subject === undefined) continue
    const ts = Number.parseInt(tsRaw, 10)
    const files: NumstatEntry[] = []
    for (const line of rest.split('\n')) {
      const trimmed = line.trim()
      if (trimmed.length === 0) continue
      const cols = trimmed.split('\t')
      if (cols.length < 3) continue
      const [insRaw, delRaw, rawPath] = cols
      if (rawPath === undefined) continue
      const path = resolveRenamedPath(rawPath)
      const insertions = insRaw === '-' ? 0 : Number.parseInt(insRaw ?? '0', 10)
      const deletions = delRaw === '-' ? 0 : Number.parseInt(delRaw ?? '0', 10)
      files.push({ path, insertions: Number.isNaN(insertions) ? 0 : insertions, deletions: Number.isNaN(deletions) ? 0 : deletions })
    }
    commits.push({
      sha,
      author: author ?? '',
      email: email ?? '',
      ts: Number.isNaN(ts) ? 0 : ts,
      subject,
      files,
    })
  }
  return commits
}
