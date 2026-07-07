# Contributing to GraphCode

Thanks for your interest in improving GraphCode. This is a young project — issues, discussion,
and PRs are all welcome.

## Development setup

Requires Node >= 22.5 (for `node:sqlite`).

```bash
git clone https://github.com/ericnerwala/GraphCode.git
cd GraphCode
npm install
npm run build
npm test
```

Useful scripts:

```bash
npm run dev        # tsc --watch
npm test           # vitest run
npm run test:watch # vitest, watch mode
npm run typecheck  # tsc --noEmit
```

Try your build against the repo itself:

```bash
node bin/graphcode.mjs stats --path .
```

## Project layout

```
src/
  core/       config, output, tokens, errors, identifiers — shared utilities
  graph/      types, schema.sql, GraphStore (the storage layer)
  index/      language parsers and the sync pipeline (code, git, knowledge layers)
  git/        git log mining and co-change analysis
  knowledge/  markdown doc parsing and feature clustering
  query/      search, callers/callees, impact ranking, explore, context pack
  agent/      the built-in Anthropic-API agent harness
  mcp/        the `graphcode mcp` server
  workspace/  cross-repo federation
  cli/        commander wiring and subcommands
```

Each area is deliberately small and single-purpose — prefer adding a new file over growing an
existing one past a few hundred lines.

## Making changes

- **Write tests first.** New logic in `src/` should land with a corresponding `test/**/*.test.ts`.
  Run `npm test` before opening a PR.
- **No `console.log`.** Library code takes an optional `onProgress` callback; CLI code prints via
  `src/core/output.ts` (`print`, `printError`, `printStatus`).
- **Immutability.** Don't mutate inputs — build new objects and return them.
- **TypeScript strict mode.** `npx tsc --noEmit` must be clean for any file you touch. All
  relative imports use NodeNext resolution, so they must end in `.js` even though the source is
  `.ts`.
- **Zero native dependencies.** GraphCode is deliberately `node:sqlite` + tree-sitter WASM only.
  PRs that add a native addon dependency will be declined.

## Commit messages

This project follows [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>: <short summary>

[optional body]
```

Types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`.

Commit scopes double as input to the knowledge-layer feature clustering (see
[docs/architecture.md](docs/architecture.md)), so a clear, consistent scope helps GraphCode
index its own history usefully — for example `feat(query): add impact ranking`.

## Pull requests

1. Fork, branch from `main`, and keep the diff focused.
2. Make sure `npm run build`, `npm test`, and `npm run typecheck` all pass.
3. Describe what changed and why in the PR body; link any related issue.
4. CI (`.github/workflows/ci.yml`) runs the same checks on Node 22 and Node 24 — both must
   be green before merge.

## Reporting bugs

Open a GitHub issue with your Node version, OS, the command you ran, and (if possible) a minimal
repro repo. If the bug is graph-content-specific (wrong edges, missed symbols), attaching the
output of `graphcode export --format json` for the affected file helps a lot.
