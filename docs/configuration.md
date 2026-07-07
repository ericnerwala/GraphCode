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

All fields are optional — an absent `graphcode.json` is equivalent to `{}`, and every field falls
back to its default independently, so you only need to set what you want to change.

Config is loaded fresh per invocation (`loadConfig` in `src/core/config.ts`); there's no daemon
holding stale config in memory.

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
