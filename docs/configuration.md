# Configuration

GraphCode is configured by an optional `graphcode.json` in your repo root, plus a small number of
environment variables. Nothing is required to get started — every field has a default.

## `graphcode.json`

```json
{
  "model": "claude-sonnet-5",
  "contextPackTokens": 6000,
  "maxCommits": 2000,
  "ignore": ["**/generated/**", "**/*.min.js"],
  "workspaceRepos": ["../shared-lib", "../billing-service"]
}
```

| Field | Type | Default | Meaning |
|---|---|---|---|
| `model` | `string` | `claude-sonnet-5` (or `GRAPHCODE_MODEL` if set) | Model used by the built-in agent harness. |
| `contextPackTokens` | `number` | `6000` | Token budget for the turn-0 context pack injected before the agent's first response. |
| `maxCommits` | `number` | `2000` | Maximum commits walked into the git layer (commit nodes, `touched_by`, `co_change`). |
| `ignore` | `string[]` | `[]` | Extra ignore globs, on top of whatever `.gitignore` already excludes. |
| `workspaceRepos` | `string[]` | `[]` | Paths (absolute or relative to this repo's root) to other GraphCode-indexed repos, for federated search/impact. See [docs/workspaces.md](workspaces.md). |
| `liveGraphSync` | `boolean` | `false` | Re-index each file the built-in agent writes/edits, in place, so subsequent graph queries and the reliability guards reflect the agent's own changes. See [Reliability guards](#reliability-guards). |
| `editGuard` | `object` | see below | Pre-edit blast-radius advisory settings. |
| `postEditVerify` | `boolean` | `false` | Post-edit graph verification (stale callers, dangling refs, unresolved imports). Requires `liveGraphSync`. |
| `completionGateEnabled` | `boolean` | `false` | End-of-turn loose-ends sweep. |
| `completionGateMaxIterations` | `number` | `2` | Max end-of-turn gate cycles per session (backstop against nagging loops). |
| `completionGateMinSeverity` | `"high"` \| `"medium"` \| `"low"` | `"high"` | Lowest finding severity that can trigger the gate. |

All fields are optional — an absent `graphcode.json` is equivalent to `{}`, and every field falls
back to its default independently, so you only need to set what you want to change.

Config is loaded fresh per invocation (`loadConfig` in `src/core/config.ts`); there's no daemon
holding stale config in memory.

## Reliability guards

The reliability guards let the code graph audit the built-in agent's **output** — every edit — in
addition to shaping its input via the turn-0 context pack. They are all **off by default**: with no
configuration, the agent harness behaves exactly as it did before these existed. None of them can
throw into the agent loop; each only appends advisory text to a tool result (or, for the completion
gate, a single follow-up message).

```json
{
  "liveGraphSync": true,
  "editGuard": {
    "enabled": true,
    "minImpactedFiles": 2,
    "topFiles": 5,
    "topCoChanges": 3,
    "maxSymbolsPerFile": 40
  },
  "postEditVerify": true,
  "completionGateEnabled": true,
  "completionGateMaxIterations": 2,
  "completionGateMinSeverity": "high"
}
```

- **`liveGraphSync`** is the foundation — `postEditVerify` and the most useful part of the
  completion gate depend on the graph being current, so enabling either without `liveGraphSync` is a
  no-op. Enabling `liveGraphSync` alone is safe and cheap: a single edited file is re-parsed and
  re-resolved in one transaction; the scan of the cross-file pending-reference table is scoped to
  just the edited file's symbol names, so it stays fast even in a 1M+ LOC monorepo.

- **`editGuard`** is on by default *once an edit happens* (it costs nothing until then). Its
  sub-fields: `enabled` toggles it; `minImpactedFiles` (default 2) suppresses the advisory for leaf
  helpers whose blast radius is trivial; `topFiles`/`topCoChanges` bound how many impacted and
  co-changing files are listed; `maxSymbolsPerFile` (default 40) is a hard cost cap — a file
  defining more symbols than this skips impact computation entirely rather than run dozens of
  reverse-BFS traversals inline.

- **`postEditVerify`** reports graph-level breakage an edit introduced. Findings are severity-ranked
  and capped, so a high-severity stale-caller finding is never buried behind low-severity noise.

- **The completion gate** (`completionGateEnabled`) runs an end-of-turn sweep over every file the
  agent wrote that turn. It only fires on findings at or above `completionGateMinSeverity`, a caller
  the agent already touched this turn is presumed handled (suppressed), and it can hold the turn open
  at most `completionGateMaxIterations` times. It is framed as *possible* loose ends that may already
  be addressed, so a false positive costs the agent one cheap acknowledgement rather than a wrong
  edit — which is why it defaults off and conservative.

## Environment variables

| Variable | Effect |
|---|---|
| `ANTHROPIC_API_KEY` | Used to run the built-in agent (bare `graphcode`, or `graphcode agent`) if set. Not required for the query CLI or `graphcode mcp`. See [Authentication](#authentication) for the fallback when it's unset. |
| `CLAUDE_API_KEY` | Same effect as `ANTHROPIC_API_KEY`, checked second if the former is unset. |
| `GRAPHCODE_MODEL` | Overrides the default model. Takes effect only if `graphcode.json` doesn't set `model` explicitly (the config file wins if both are set). |
| `GRAPHCODE_QUIET` | Set to `1` to suppress `printStatus` progress output (sync progress, etc.) on stderr. Errors and command output are unaffected. |

## Authentication

The built-in agent needs an Anthropic API key. Resolution order:

1. `ANTHROPIC_API_KEY` environment variable
2. `CLAUDE_API_KEY` environment variable
3. A key stored via `graphcode auth login`, at `~/.config/graphcode/auth.json` (or
   `$XDG_CONFIG_HOME/graphcode/auth.json` if `XDG_CONFIG_HOME` is set), written with `0600`
   permissions.

Commands:

- `graphcode auth login` — prompts for a key (pasted from console.anthropic.com) and saves it.
- `graphcode auth status` — shows whether a key is configured and where it came from (`env` or
  `auth-file`), with the key masked.
- `graphcode auth logout` — deletes the stored key. If the active key actually comes from an
  environment variable, this reports that there's nothing to remove — unset the env var yourself.

If bare `graphcode` finds no key at all, an interactive terminal is walked through `auth login`
inline before the session starts; a non-interactive invocation (piped input, scripts, CI) instead
fails with a hint to run `graphcode auth login` or set `ANTHROPIC_API_KEY`. Graph queries
(`graphcode search`/`impact`/`explore`/etc.) and `graphcode mcp` never require a key.

## Where the index lives

The graph database is always at `<repo-root>/.graphcode/graph.db`, derived from wherever
`graphcode.json` would live (or the current directory if there's no config file). This directory
is meant to be gitignored — it's a local cache/index, not a source artifact. `graphcode` adds
`.graphcode/` to a repo's ignore rules as part of its own scaffolding expectations, but if you're
setting up a fresh repo by hand, add it to `.gitignore` yourself.

## `--path`

Every CLI command accepts `--path <dir>` to operate on a repo other than the current directory
(defaults to `process.cwd()`), which is how `graphcode.json`'s `workspaceRepos` and workspace
commands operate on member repos without you having to `cd` into each one.
