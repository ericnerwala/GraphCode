# Cross-repo workspaces

Real systems usually aren't one repo. GraphCode's workspace model lets you index a set of
separately-versioned repos independently, then query across all of them as if they were one
graph — without ever merging their storage.

## Why per-repo databases, not one shared graph

The 1M+ LOC problem isn't just that an agent's context window can't hold the code — it's that a
single monolithic graph over a huge multi-repo system becomes its own bottleneck: one giant
database to lock, re-sync, and keep consistent every time any one team pushes to any one repo.

GraphCode's answer is **federation, not consolidation**:

- Each repo gets its own `.graphcode/graph.db`, synced independently, on its own schedule, by
  whoever owns that repo.
- A workspace is just a *list of repo roots* declared in one repo's `graphcode.json`.
- Federated queries open each member's `GraphStore`, run the same query against each, and merge
  results by score — no cross-repo writes, no shared lock, no single point of slowness.

This keeps every individual repo's graph small (fast to sync, fast to query) no matter how large
the *workspace* as a whole gets. A 1M+ LOC system split across 20 repos indexes as 20 small,
fast, independently-maintained graphs rather than one 1M+ LOC graph that's slow to touch.

## Setting up a workspace

In the "hub" repo (wherever you'll run federated queries from), add `workspaceRepos` to
`graphcode.json`:

```json
{
  "workspaceRepos": [
    "../shared-lib",
    "../billing-service",
    "../frontend"
  ]
}
```

Paths are resolved relative to the hub repo's root (or use absolute paths). Each listed path must
itself be a valid repo root — it does not need its own `graphcode.json` unless you want to
customize its indexing.

## Indexing the workspace

```bash
graphcode workspace index
```

This walks `workspaceRepos` and runs the normal incremental sync (see
[docs/architecture.md](architecture.md#sync-pipeline)) against each member repo in turn, creating
or updating each one's own `.graphcode/graph.db`. Run it again any time — like the single-repo
sync, it only re-parses what changed per member repo.

## Federated queries

Once every member is indexed, the same query commands operate across the whole workspace:

```bash
graphcode search "rate limiter" --workspace
graphcode impact RateLimiter.acquire --workspace
```

Each member repo's database is queried independently and results are merged and re-ranked in the
query layer — a symbol defined in `shared-lib` and called from `billing-service` shows up as a
single coherent impact analysis even though the two live in separate databases with separate
commit histories.

`graphcode mcp` run from the hub repo federates the same way, so any MCP client gets cross-repo
answers without extra configuration.

## What does and doesn't cross repo boundaries

- **Does:** search, impact analysis, explore/neighbor queries — anything that's fundamentally
  "rank these candidates," which composes cleanly across independently-scored result sets.
- **Doesn't:** a single graph traversal never follows an edge from one repo's database into
  another's, because there is no such edge — repos are related only by name/symbol matching at
  query time (e.g., "this call site references a symbol named X, and X is exported from
  shared-lib"), not by a stored cross-repo edge. If two repos share a symbol name that isn't
  actually the same code, federated results can include a false match — treat federated impact
  results as candidates to verify, same as any single-repo impact analysis.

## Strategy for very large (1M+ LOC) systems

1. **Index at natural repo/service boundaries**, not artificially split chunks — each member
   graph should correspond to something a team actually owns and versions independently.
2. **Keep `workspaceRepos` scoped to what's actually coupled.** A workspace with 40 unrelated
   repos federates slower for no benefit; list only the repos your current work actually spans.
3. **Let each repo sync on its own cadence.** There's no requirement that all members be indexed
   at the same time or by the same person — `graphcode workspace index` is safe to run
   incrementally, and a stale member simply serves slightly older results until it's re-synced.
4. **Use `graphcode stats --path <member>`** on individual members if a federated query feels
   slow or incomplete — it's often faster to debug one repo's graph in isolation than to reason
   about the merged result set.
