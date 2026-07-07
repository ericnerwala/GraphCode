// THE turn-0 injection. Exact contract — the agent harness compiles against
// this module's exports. Pipeline: FTS seed -> 2-hop expansion with decay ->
// rank -> tier segmentation -> graph context (commits/docs) -> budget clamp.
//
// Framed as draft-to-refine (see RESEARCH.md turn-0 injection notes): the
// agent must verify and refine the listed context, not transcribe it.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { estimateTokens, clampToTokens } from '../core/tokens.js';
import { isTestFile, rankCandidates } from './rank.js';
const SEED_LIMIT = 12;
const EXPAND_EDGE_KINDS = ['calls', 'imports', 'contains'];
const EXPAND_HOPS = 2;
const TIER1_COUNT = 5;
const TIER2_COUNT = 8;
const TIER1_SNIPPET_LINES = 40;
const RECENT_COMMITS_LIMIT = 5;
const MIN_HEADER_MARKDOWN = '## Graph context (pre-computed from the code graph - verify, then refine; treat listed source as already read)';
export function buildContextPack(store, root, task, budgetTokens) {
    // At <=0 the turn-0 contract still requires a valid markdown string
    // containing the header — never an empty string or a hard slice
    // mid-header. Short-circuit here rather than let the fallback chain below
    // produce garbage; clamp negative budgets to 0 chars but always keep the
    // header line itself (never returned truncated mid-word).
    if (budgetTokens <= 0) {
        return { markdown: MIN_HEADER_MARKDOWN, tokens: estimateTokens(MIN_HEADER_MARKDOWN), coreFiles: [], symbols: [] };
    }
    const seedNodes = seedSearch(store, task);
    const expanded = expandSeeds(store, seedNodes);
    const files = aggregateFiles(expanded, seedNodes);
    // No single subjectFile to exclude here (contextpack has many seeds, not
    // one changing symbol) — rank.ts's "exclude the anchor's own file" rule is
    // for impact.ts's single-target case. Passing '' means no file's basename
    // can match an empty package/anchor exclusion key, so every seed file
    // (including the top seed's own file) is scored and can land in tier 1.
    const anchor = seedNodes[0]?.name ?? task;
    const candidates = files.map((f) => ({ filePath: f.filePath, refs: f.hitCount, direct: f.seed }));
    const ranked = rankCandidates(candidates, '', anchor);
    const byPath = new Map(files.map((f) => [f.filePath, f]));
    const rankedFiles = ranked
        .map((r) => {
        const agg = byPath.get(r.filePath);
        return agg ? { ...r, symbols: agg.symbols, nodes: agg.nodes } : null;
    })
        .filter((f) => f !== null);
    let tier1 = rankedFiles.slice(0, TIER1_COUNT);
    let tier2 = rankedFiles.slice(TIER1_COUNT, TIER1_COUNT + TIER2_COUNT);
    let tier3 = rankedFiles.slice(TIER1_COUNT + TIER2_COUNT);
    let markdown = renderMarkdown(store, root, task, tier1, tier2, tier3, TIER1_SNIPPET_LINES);
    let tokens = estimateTokens(markdown);
    // Enforce budget by progressively dropping detail: tier 3 first, then
    // snippets, then tier 2 — never tier 1's file/symbol listing.
    if (tokens > budgetTokens && tier3.length > 0) {
        tier3 = [];
        markdown = renderMarkdown(store, root, task, tier1, tier2, tier3, TIER1_SNIPPET_LINES);
        tokens = estimateTokens(markdown);
    }
    if (tokens > budgetTokens) {
        markdown = renderMarkdown(store, root, task, tier1, tier2, tier3, 0);
        tokens = estimateTokens(markdown);
    }
    if (tokens > budgetTokens && tier2.length > 0) {
        tier2 = [];
        markdown = renderMarkdown(store, root, task, tier1, tier2, tier3, 0);
        tokens = estimateTokens(markdown);
    }
    if (tokens > budgetTokens) {
        markdown = clampToTokens(markdown, budgetTokens);
        tokens = estimateTokens(markdown);
    }
    // clampToTokens appends a "[truncated]" suffix that can itself push an
    // already-tiny budget back over — a known edge case of that shared helper
    // at very small budgets. Guarantee the contract (tokens <= budget) with a
    // hard character-level cut as the final fallback. Prefer leaving a short
    // truncation marker over an unmarked mid-word/mid-header slice, but never
    // let the marker itself push tokens back over budget — degrade to a bare
    // slice (still non-empty, never the empty string) if there's no room.
    if (tokens > budgetTokens) {
        const maxChars = Math.max(0, budgetTokens * 4);
        const marker = '…';
        const withMarker = maxChars > marker.length ? `${markdown.slice(0, maxChars - marker.length)}${marker}` : null;
        markdown = withMarker ?? markdown.slice(0, maxChars);
        tokens = estimateTokens(markdown);
    }
    // The hard character-level cut above can slice away part or all of a
    // tier-1 file's own section (its `#### path` heading), so coreFiles/symbols
    // must reflect only what actually survived into the final markdown, not
    // the pre-truncation tier1 list.
    const survivingTier1 = tier1.filter((f) => markdown.includes(`#### ${f.filePath}`));
    const coreFiles = survivingTier1.map((f) => f.filePath);
    const symbols = survivingTier1.flatMap((f) => f.symbols);
    return { markdown, tokens, coreFiles, symbols };
}
function seedSearch(store, task) {
    const hits = store.search(task, { kinds: ['symbol', 'file'], limit: SEED_LIMIT });
    const nodes = hits.map((h) => h.node).filter((n) => !n.filePath || !isTestFile(n.filePath));
    const exact = store.findNodesByName(task, { limit: SEED_LIMIT });
    const seen = new Set(nodes.map((n) => n.id));
    for (const node of exact) {
        if (seen.has(node.id))
            continue;
        if (node.filePath && isTestFile(node.filePath))
            continue;
        seen.add(node.id);
        nodes.push(node);
    }
    return nodes;
}
function expandSeeds(store, seeds) {
    const visited = new Set(seeds.map((n) => n.id));
    const all = [...seeds];
    let frontier = seeds;
    for (let hop = 0; hop < EXPAND_HOPS; hop++) {
        const next = [];
        for (const node of frontier) {
            const neighbors = store.neighbors(node.id, { direction: 'both', kinds: EXPAND_EDGE_KINDS });
            for (const neighbor of neighbors) {
                if (visited.has(neighbor.node.id))
                    continue;
                visited.add(neighbor.node.id);
                all.push(neighbor.node);
                next.push(neighbor.node);
            }
        }
        frontier = next;
        if (frontier.length === 0)
            break;
    }
    return all;
}
function aggregateFiles(nodes, seeds) {
    const seedIds = new Set(seeds.map((n) => n.id));
    const byPath = new Map();
    for (const node of nodes) {
        if (!node.filePath)
            continue;
        const acc = byPath.get(node.filePath) ?? { filePath: node.filePath, hitCount: 0, seed: false, symbols: [], nodes: [] };
        acc.hitCount += 1;
        acc.seed = acc.seed || seedIds.has(node.id);
        if (node.kind === 'symbol')
            acc.symbols.push(node.name);
        acc.nodes.push(node);
        byPath.set(node.filePath, acc);
    }
    return [...byPath.values()];
}
function renderMarkdown(store, root, task, tier1, tier2, tier3, snippetLines) {
    const lines = [];
    lines.push('## Graph context (pre-computed from the code graph - verify, then refine; treat listed source as already read)');
    lines.push('');
    lines.push(`Task: ${task}`);
    lines.push('');
    lines.push('### Tier 1 — almost-certainly-relevant');
    if (tier1.length === 0) {
        lines.push('(none found)');
    }
    for (const file of tier1) {
        lines.push('');
        lines.push(`#### ${file.filePath}`);
        const symbolLines = renderSymbolList(file.nodes);
        for (const s of symbolLines)
            lines.push(s);
        if (snippetLines > 0) {
            const topSymbol = pickMostHitSymbol(file.nodes);
            if (topSymbol) {
                const snippet = readSnippet(root, topSymbol, snippetLines);
                if (snippet) {
                    lines.push('');
                    lines.push(`\`\`\`${topSymbol.language ?? ''}`);
                    lines.push(snippet);
                    lines.push('```');
                }
            }
        }
    }
    lines.push('');
    lines.push('### Tier 2 — directly-connected');
    if (tier2.length === 0) {
        lines.push('(none)');
    }
    for (const file of tier2) {
        lines.push('');
        lines.push(`#### ${file.filePath}`);
        for (const s of renderSymbolList(file.nodes))
            lines.push(s);
    }
    lines.push('');
    lines.push('### Tier 3 — periphery');
    if (tier3.length === 0) {
        lines.push('(none)');
    }
    for (const file of tier3) {
        lines.push(file.filePath);
    }
    const graphContext = renderGraphContext(store, tier1);
    if (graphContext.length > 0) {
        lines.push('');
        lines.push(...graphContext);
    }
    return lines.join('\n');
}
function renderSymbolList(nodes) {
    const symbolNodes = nodes.filter((n) => n.kind === 'symbol');
    if (symbolNodes.length === 0)
        return [];
    return symbolNodes.map((n) => `- \`${n.signature ?? n.name}\`${n.startLine !== undefined ? ` (line ${n.startLine})` : ''}`);
}
function pickMostHitSymbol(nodes) {
    const symbolNodes = nodes.filter((n) => n.kind === 'symbol' && n.filePath && n.startLine !== undefined);
    if (symbolNodes.length === 0)
        return null;
    // "Most-hit" proxy: longest span (endLine - startLine), a stand-in for
    // significance when we don't carry per-symbol hit counts through aggregation.
    return [...symbolNodes].sort((a, b) => spanOf(b) - spanOf(a))[0] ?? null;
}
function spanOf(node) {
    if (node.startLine === undefined || node.endLine === undefined)
        return 0;
    return node.endLine - node.startLine;
}
function readSnippet(root, node, maxLines) {
    if (!node.filePath || node.startLine === undefined)
        return null;
    try {
        const content = readFileSync(join(root, node.filePath), 'utf8');
        const lines = content.split('\n');
        const startIdx = Math.max(0, node.startLine - 1);
        const endIdx = Math.min(lines.length, node.endLine ?? node.startLine, startIdx + maxLines);
        return lines.slice(startIdx, endIdx).join('\n');
    }
    catch {
        return null;
    }
}
function renderGraphContext(store, tier1) {
    const lines = [];
    const commitLines = renderRecentCommits(store, tier1);
    const docLines = renderDocMentions(store, tier1);
    const featureLines = renderFeatureMembership(store, tier1);
    if (commitLines.length === 0 && docLines.length === 0 && featureLines.length === 0)
        return [];
    lines.push('### Graph context');
    if (commitLines.length > 0) {
        lines.push('');
        lines.push('**Recent commits touching tier-1 files:**');
        lines.push(...commitLines);
    }
    if (docLines.length > 0) {
        lines.push('');
        lines.push('**Doc mentions:**');
        lines.push(...docLines);
    }
    if (featureLines.length > 0) {
        lines.push('');
        lines.push('**Feature membership:**');
        lines.push(...featureLines);
    }
    return lines;
}
function renderRecentCommits(store, tier1) {
    const seen = new Set();
    const lines = [];
    for (const file of tier1) {
        const fileNode = findFileNode(store, file.filePath);
        if (!fileNode)
            continue;
        const commits = store.neighbors(fileNode.id, { direction: 'out', kinds: ['touched_by'] });
        for (const c of commits) {
            const sha = c.node.name.slice(0, 7);
            const subject = c.node.doc ?? c.node.signature ?? '';
            const key = `${sha}:${file.filePath}`;
            if (seen.has(key))
                continue;
            seen.add(key);
            lines.push(`- ${sha} ${subject} (${file.filePath})`);
            if (lines.length >= RECENT_COMMITS_LIMIT)
                return lines;
        }
    }
    return lines;
}
function renderDocMentions(store, tier1) {
    const lines = [];
    for (const file of tier1) {
        const fileNode = findFileNode(store, file.filePath);
        if (!fileNode)
            continue;
        const docs = store.neighbors(fileNode.id, { direction: 'in', kinds: ['mentions'] });
        for (const d of docs) {
            lines.push(`- ${d.node.name}${d.node.filePath ? ` (${d.node.filePath})` : ''} mentions ${file.filePath}`);
        }
    }
    return lines;
}
function renderFeatureMembership(store, tier1) {
    const lines = [];
    for (const file of tier1) {
        const fileNode = findFileNode(store, file.filePath);
        if (!fileNode)
            continue;
        const features = store.neighbors(fileNode.id, { direction: 'out', kinds: ['in_feature'] });
        for (const feat of features) {
            lines.push(`- ${file.filePath} is part of feature "${feat.node.name}"`);
        }
    }
    return lines;
}
function findFileNode(store, filePath) {
    const rows = store.raw(`SELECT id FROM nodes WHERE kind = 'file' AND file_path = ? LIMIT 1`, [filePath]);
    const row = rows[0];
    if (!row)
        return null;
    return store.getNode(row.id);
}
