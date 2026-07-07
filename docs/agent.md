# The agent harness

When you run bare `graphcode` in a repo (no subcommand), it syncs the knowledge graph and then
runs its own coding agent against the Anthropic API — streaming, with graph tools plus file/bash
tools, and a context pack injected before the first token. This document describes that harness,
its tools, and shows a sample turn-0 pack.

## Why a harness, not just "give the model grep"

A plain agent loop discovers structure by reading and grepping — each exploratory step costs a
round trip and burns context on files that turn out to be irrelevant. GraphCode's graph has
already computed the structure (who calls what, what's coupled by history, what a doc mentions),
so the harness's job is to **inject the already-ranked answer to "what's relevant here" before the
model reasons at all**, and give it graph tools to go deeper only when it needs to. See
[docs/benchmarks.md](benchmarks.md) for the retrieval-quality evidence behind this design and
its caveats.

## Requirements

- An Anthropic API key, from `ANTHROPIC_API_KEY`/`CLAUDE_API_KEY` in the environment, or stored via
  `graphcode auth login`. If none is configured and you're at an interactive terminal, bare
  `graphcode` walks you through `auth login` on the spot instead of failing outright; in a
  non-interactive context (scripts, pipes, CI) it fails with a hint to run `graphcode auth login`
  or set `ANTHROPIC_API_KEY`. See [docs/configuration.md](configuration.md#authentication) for the
  full resolution order and the `auth status` / `auth logout` commands. None of this is needed for
  the query CLI (`graphcode search`, `graphcode impact`, etc.) or `graphcode mcp` — both work with
  no key at all.
- `GRAPHCODE_MODEL` optionally overrides the model (default: `claude-sonnet-5`).

## Turn-0 context pack

Before the first token is streamed, the harness:

1. Runs the user's request through FTS search and neighbor traversal over the graph to find
   candidate symbols/files.
2. Applies the structural ranker (test-file demotion, direct-caller bonus, package locality,
   name-match) to order candidates by relevance.
3. Assembles a token-budgeted preamble (`contextPackTokens` in `graphcode.json`, default 6000,
   trimmed with `clampToTokens` at a line boundary) containing the ranked symbols/files, their
   signatures, and the edges connecting them.
4. Injects that pack as context ahead of the system prompt's tool-use turn.

The agent can still call graph tools mid-conversation to go beyond the injected pack — the pack
is a head start, not a ceiling.

### Sample turn-0 pack

For the query "what breaks if I change RateLimiter.acquire?" against a mid-sized repo, the
injected pack looks approximately like:

```
# Context pack (ranked, budget: 6000 tokens)

## Target
symbol RateLimiter.acquire  (src/billing/rate-limiter.ts:42-58)
  signature: acquire(key: string, cost: number): Promise<boolean>

## Direct callers (ranked)
1. BillingWorker.charge        src/billing/worker.ts:88     [no test coverage]
2. ApiGateway.handle            src/gateway/api.ts:210
3. JobQueue.retry                src/jobs/queue.ts:64

## Transitive callers (depth 2, top 8 of 11)
4. CheckoutController.submit    src/checkout/controller.ts:130
5. WebhookDispatcher.deliver     src/webhooks/dispatcher.ts:52
...

## Co-change coupling (git layer)
- src/billing/worker.ts <-> src/billing/queue-config.ts   (weight 0.71, 8 of last 12 commits)

## Related docs
- docs/billing/rate-limits.md  mentions RateLimiter, acquire
```

The ranker demotes test files, weights direct callers above transitive ones, and boosts
name-matched symbols — the same algorithm used by `graphcode impact` (see
[docs/architecture.md](architecture.md) for the edge kinds this draws on).

## Tools available to the agent

| Tool | Purpose |
|---|---|
| `graph_search` | Full-text search over symbol/file names and docs (FTS5, identifier-aware). |
| `graph_explore` | Connect a flow across named symbols: shortest paths between them plus their verbatim source, inlined. Replaces a chain of file reads for "how does X reach Y". |
| `graph_callers` | Who calls this symbol (breadth-first, with depth). |
| `graph_callees` | What this symbol calls (breadth-first, with depth). |
| `graph_impact` | Ranked blast-radius analysis for a symbol or file. |
| `graph_context` | Re-run the turn-0 context-pack builder for a new query mid-conversation. |
| `read_file` | Read a file's contents (or a line range) from disk. |
| `write_file` | Create or overwrite a file. |
| `edit_file` | Apply a targeted string replacement to a file. |
| `list_dir` | List a directory inside the repo. |
| `bash` | Run a shell command in the repo root (tests, builds, git commands). |

Graph tools are backed directly by `GraphStore` reads — no subprocess, no re-parsing — so they're
fast enough to call repeatedly without the cost blowup a full re-index would cause.

## Streaming

Responses stream token-by-token from the Anthropic API; tool calls are interleaved with the
stream and their results fed back in the same turn loop until the agent produces a final answer
or exhausts its turn budget.

## Model selection

`GRAPHCODE_MODEL` overrides the default (`claude-sonnet-5`). This only affects the built-in agent
— the query CLI and `graphcode mcp` don't call the Anthropic API at all, so they work identically
regardless of this setting (and without an API key).
