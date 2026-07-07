# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
uses [Conventional Commits](https://www.conventionalcommits.org/) for its commit history.

## [Unreleased]

### Added

- **Reliability guards** — the code graph now audits the built-in agent's output, not just its
  input. All off by default; all opt-in via `graphcode.json`; none can throw into the agent loop.
  - **Live graph sync** (`liveGraphSync`): re-index a single file in place after the agent writes or
    edits it, so subsequent graph queries and guards reflect the agent's own change. Backed by a new
    single-file reindex path (`src/agent/graph-sync.ts`) reusing the incremental indexer internals in
    one transaction, plus a scoped pending-ref re-resolver (`reresolvePendingRefsForNames`) that keeps
    the pending-table scan `O(edited file)` at monorepo scale.
  - **Pre-edit impact guardrail** (`editGuard`): append each edited file's blast radius (impacted
    files + tier + history co-changes) to the edit's own tool result, with a symbol-count cost cap.
  - **Post-edit verification** (`postEditVerify`, requires `liveGraphSync`): surface stale callers of
    a removed/renamed symbol, references that now dangle, and unresolved imports the edit introduced.
  - **Completion gate** (`completionGateEnabled`): an end-of-turn sweep that can hold the turn open
    for graph-visible loose ends, bounded by `completionGateMaxIterations` / `completionGateMinSeverity`.
- Richer Java type graph: method-parameter and field types now emit `references` edges, and same-name
  type/constructor collisions disambiguate by qualified name.

### Changed

- The agent's tool dispatch is now asynchronous; within a turn, read-only tools run concurrently
  while file-mutating tools (`write_file`/`edit_file`) run sequentially so each edit's live re-index
  observes a consistent graph. No change to tool results or ordering as seen by the model.

## [0.1.0] - 2026-07-06

Initial release.

### Added

- Code graph indexer for TypeScript, TSX, JavaScript, Python, Go, Java, and Rust (files,
  symbols, calls, imports, extends/implements/references, tests edges) via tree-sitter WASM
  grammars, with incremental sync on every `graphcode` run.
- Git layer: commit nodes, `touched_by` edges, and co-change coupling mined from history.
- Knowledge layer: markdown docs/specs as nodes with `mentions` edges, and feature nodes
  clustered from conventional-commit scopes.
- Embedded storage via `node:sqlite` — no native dependencies, one `.graphcode/graph.db` file
  per repo, FTS5 full-text search over symbol names and docs.
- Built-in agent harness (Anthropic API, streaming) with a validated turn-0 context pack:
  deterministic rank-and-inject of graph structure before the first token.
- `graphcode mcp` — serve the graph to any MCP-capable agent (Claude Code, Cursor, and others).
- Query CLI, no API key required: `search`, `callers`, `callees`, `impact`, `explore`,
  `context`, `stats`, `export`, `viz` (built-in dark-theme graph viewer).
- `graphcode auth login` / `status` / `logout` — guided Anthropic key setup, stored at
  `~/.config/graphcode/auth.json`, with `ANTHROPIC_API_KEY`/`CLAUDE_API_KEY` taking precedence.
- Structural impact ranker (test-demotion, direct-caller bonus, package locality, name-match).
- Cross-repo workspaces: `graphcode.json` `workspaceRepos` plus `graphcode workspace index` for
  federated search and impact analysis across separately-indexed repos.
