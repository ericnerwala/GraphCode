# Benchmarks

This page reports the retrieval-quality numbers behind GraphCode's design, states exactly where
they come from, and documents a retracted headline from earlier in that research. Read the
caveats — they are not boilerplate, they materially change how much weight to put on each number.

## Provenance

GraphCode's turn-0 injection and structural ranking design was validated on an **experimental
predecessor harness**, not on the shipped GraphCode codebase itself. The harness lived in Eric
Nerwala's prior research corpus (`bench/` and `eval-graph-query-engine/` in the
`graphcode-cli` research tree) and reused a third-party graph engine
([`codegraph`](https://github.com/colbymchenry/codegraph) by Colby Mchenry) as its graph backend
for that experimentation. GraphCode reimplements the *validated design* — the ranking algorithm,
the turn-0 injection strategy — as an original, standalone implementation on its own graph
(`node:sqlite` + tree-sitter WASM, described in [docs/architecture.md](architecture.md)). None of
`codegraph`'s code was copied.

In short: **the numbers below measure the design GraphCode ports, not a release build of
GraphCode.** They are the reason GraphCode's ranker and injection pipeline look the way they do,
not a performance claim about the shipped tool. Treat them as directional evidence for an
architecture, not a certified benchmark of this repository.

## Retracted claim (read this first)

An early pass at this research reported a headline **0.80 recall** for the graph-native harness on
a Hadoop impact-analysis task. That number was **retracted as a scoring artifact**, and we're
documenting the retraction here rather than quietly dropping it, because a benchmark history that
hides its own mistakes isn't trustworthy.

What happened: the harness pasted the graph's raw blast-radius file list directly into the
model's context, and the agent copied that list into its answer with **zero real retrieval
calls** and **zero reasoning**. The old scorer computed recall by substring-scanning the whole
prose answer and never penalized false positives, so transcribing a 60-file firehose against a
25-file gold set scored a perfect-looking 0.80 recall — while precision on that same answer was
6%. A control run that did genuine grep-based search scored a *lower* 0.30 by the same metric,
even though it was doing real work and the paste was doing none.

The fix (documented in the corpus as `AUDIT-FINDINGS.md`) was structural:

1. **Single-field F1**, so precision and recall are computed over the *same* bounded answer —
   pasting the firehose now tanks precision and F1, exactly as it should.
2. **A graph-oracle ablation** — score the raw, unranked graph query with no agent in the loop, as
   the honest floor/ceiling any ranked or agentic arm must beat.
3. **A budget cap** (top-15 or top-20, stated per benchmark below) so the task becomes "rank the
   true dependents above the false positives within a budget," which a firehose-paste cannot fake.

**Do not use the retracted 0.80-recall number.** Every figure below was produced under the
hardened F1-at-budget methodology.

## What "GraphCode" does not claim

Some numbers circulating around graph-augmented coding agents belong to other projects. GraphCode
does not claim, and has not measured, any **"94% fewer tool calls"** or **"77% faster"** figure —
those are third-party `codegraph` marketing claims, not GraphCode's. Anywhere you see a number
below, it traces to one of the two corpora described here.

## Measured on GraphCode itself (v0.1.0)

Unlike everything under the two corpus sections below, the numbers in this section were produced
by the `graphcode` binary in this repository, and are reproducible from a clean checkout:

**Indexing scale** (Apache Hadoop trunk, shallow clone; Apple Silicon laptop, single-threaded):

| | |
|---|--:|
| Java files indexed | 13,344 |
| Symbols / edges | 232,275 / 290,313 |
| Cold full index | ~11.5 min (tree-sitter parse-bound) |
| **Incremental no-op sync** (the every-start refresh) | **3.5 s** |

```bash
git clone --depth 1 https://github.com/apache/hadoop
node bin/graphcode.mjs index --path ./hadoop        # cold
node bin/graphcode.mjs sync  --path ./hadoop        # every-start incremental
```

**Retrieval oracle** (raw vs ranked impact F1 @ top-20, the same held-out PR-derived gold tasks
as Corpus 1, vendored in [`bench/tasks-hadoop-impact.json`](../bench/tasks-hadoop-impact.json)):

```bash
node bench/impact-oracle.mjs --repo ./hadoop
```

Current v0.1.0 result: mean **raw F1 0.173 → ranked 0.338**, with the structural ranker beating
the raw ordering on 6 of 9 held-out tasks and tying on the rest — it nearly doubles the unranked
graph's precision-at-budget. Per-task highlights: HttpServer2 0.821, RouterRpcServer 0.667,
AbfsClient 0.513. This is still below the predecessor research engine's 0.519 mean — that engine
had years of Java-resolution maturity (nested/inner classes, static imports, generics) that
GraphCode's v0.1.0 resolver does not yet match. The gap is real, tracked, and this number will
move as resolution improves. We publish the number we measure, not the number we'd like.

## Corpus 1 — Apache Hadoop (Java), impact analysis

**Setup:** Apache Hadoop, 14,574 files / 472k nodes / 647k edges. Impact-analysis tasks ("what
depends on this symbol"), n=3 runs per task with 95% confidence intervals, scored as F1 of the
agent's committed dependent-file list against PR-derived gold, budget-capped top-20.

| Arm | Mean F1 | Cost per task |
|---|--:|--:|
| Graph-native harness | **0.79** | $0.27–$0.31 (cheapest on every task) |
| Plain agent (Read/Grep/Bash) | 0.56 | $0.53–$0.71 |
| Graph-as-MCP-tool | 0.50 | $0.53–$0.71 |

On every CI-backed task in this run, the graph-native harness made **0 file reads and 0 greps** —
all retrieval was satisfied from the graph.

### Structural ranker, held out (n=9, never tuned on the eval set)

The ranker (test-file demotion, additive direct-caller bonus, package locality, name-match) is
the core of the graph-native harness's edge. Scored against a held-out split that was never used
to tune ranker weights:

| | Raw graph blast-radius (unranked) | Ranked, top-20 |
|---|--:|--:|
| Mean F1 | 0.169 | **0.519** |
| Beats the raw-graph floor | — | **9 / 9 held-out tasks** |

A raw graph query recovers *every* true dependent (recall 1.0) but buries it in 6–18x too many
false positives; the ranker's entire job is surfacing the true dependents inside a small budget,
and it does so on every held-out task, not just the ones its weights were shaped on.

### Comparison to Potpie (a graph-based agent tool)

The same Hadoop gold was used to score [Potpie](https://github.com/potpie-ai/potpie)
(Apache-2.0) on identical anchors, both as a raw graph and as its own autonomous harness loop.
Potpie's Java parser is comparatively strong, and its raw graph out-recalls the unranked
`codegraph` floor (0.396 vs 0.170 held-out) — but the graph-native harness's deterministic
structural ranker still leads (0.520 held-out F1), and does so without an agent loop's cost:
Potpie's own harness loop tied its single-shot ranking (0.669 vs 0.669 on the common subset) at
one to two orders of magnitude more cost — a 22-minute, ~30K-output-token run for parity with an
~80-second single-shot call. Full numbers in `bench/ALL-HARNESSES-TOGETHER.md` in the research
corpus.

## Corpus 2 — 24k-LOC TypeScript/Python repo, 8 retrieval tasks

A second, smaller corpus (a ~24k-LOC React/Vite + Flask codebase) tests the same design outside
Java, across 6 task families (impact, caller-enumeration, data-flow, dead-code, refactor-triage,
test-selection):

| Arm | Retrieval-oracle mean F1 (n=8) |
|---|--:|
| Plain agent | 0.314 |
| Graph-as-MCP-tool | 0.702 |
| Graph-native harness | **0.768** |

A live A/B with a real running agent (not just the deterministic oracle) on the hardest task in
this set (a 39-file impact "firehose", mostly test files) confirmed the direction and the cost
story:

| Arm | Live F1 | Cost |
|---|--:|--:|
| Plain agent | 0.52 | $0.67 |
| Graph-native harness | **0.56** | **$0.61** |

The graph-native harness won on quality *and* was cheaper — the same dual pattern as Corpus 1,
this time reproduced with a real agent run rather than only the offline oracle.

On this same TypeScript-heavy corpus, Potpie's graph (whose tags query only captures
type-annotation and constructor references, with no rule for function-call references) covered
just 1 of 6 anchors and scored 0.027 mean F1 — last of all four arms including plain grep. This is
a real, disclosed weakness in Potpie's TypeScript parser, not a general claim about Potpie; on the
Java corpus above, the same tool performs respectably. Full write-up:
`eval-graph-query-engine/results/BENCHMARK-3HARNESS-RESULTS.md` and
`bench/POTPIE-4ARM-APPLES-TO-APPLES.md` in the research corpus.

## Token efficiency

A directional, n=1, 8-task matrix measured **~46% fewer output tokens** for the graph-native
harness versus a plain agent on the same tasks. This is a single matrix run, not a confidence
interval — read it as "the pattern points this way," not as a guaranteed reduction.

## Caveats (apply to every number on this page)

- **Small n.** Most figures are n=1 to n=9 per condition. The 95%-CI figures in Corpus 1 are the
  exception; everything else should be read as directional.
- **The metric is ranked-file-list F1 against PR-derived gold**, not "did the agent produce a
  correct patch" or any end-to-end coding-task success rate. These are retrieval-quality numbers.
- **Single model family** was used throughout (`claude-sonnet-4.6`/`claude -p` subscription runs
  across the two corpora) — no cross-model generalization claim is made.
- **Directional, not a guarantee.** "GraphCode wins on this benchmark" does not mean it will win
  on your repo, your language, or your task shape — Corpus 2's Potpie comparison is itself a
  demonstration that graph quality is language- and tool-dependent.
- **These numbers predate GraphCode's own codebase.** They validated the design GraphCode
  reimplements; they are not a benchmark run against the `graphcode` binary you install from this
  repo. As GraphCode accumulates its own benchmark runs, this page will be updated to distinguish
  "predecessor research" figures from "measured on GraphCode itself" figures.

## Full methodology

The complete task lists, scoring scripts, raw per-task results, and the audit that led to the
retraction above live in the research corpus referenced throughout this page
(`graphcode-cli/bench/` and `graphcode-cli/eval-graph-query-engine/`, notably `RESULTS.md`,
`AUDIT-FINDINGS.md`, `ALL-HARNESSES-TOGETHER.md`, and the `eval-graph-query-engine/report/`
LaTeX report with literal agent traces). That corpus is Eric Nerwala's prior research, kept
separate from this repository; this page is the honest summary of what it found and how much
weight it should carry.
