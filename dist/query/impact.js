// Reverse-BFS blast radius: walk incoming calls/references/extends/implements/imports
// edges from the target, hop-decay each hit, aggregate into files, then rank with
// rank.ts. Co-change edges of the top files are surfaced as a secondary,
// clearly-separated "history suggests" section.
import { rankCandidates } from './rank.js';
const IMPACT_EDGE_KINDS = ['calls', 'references', 'extends', 'implements', 'imports'];
const DEFAULT_DEPTH = 3;
const DEFAULT_LIMIT = 50;
const HOP_DECAY_BASE = 0.5;
const CO_CHANGE_TOP_FILES = 5;
const CO_CHANGE_PER_FILE_LIMIT = 5;
/** Subkinds whose callers are meaningfully found through their members: a
 * struct/class itself is rarely called directly — callers of NameNode.Serve()
 * or NameNode.blockSize() are exactly the callers `impact NameNode` should
 * surface, since changing the struct can break any of them. */
const CONTAINER_SUBKINDS = new Set(['class', 'struct', 'interface', 'trait', 'impl']);
export function impactAnalysis(store, root, target, options = {}) {
    const maxDepth = options.depth ?? DEFAULT_DEPTH;
    const limit = options.limit ?? DEFAULT_LIMIT;
    const seeds = target.subkind && CONTAINER_SUBKINDS.has(target.subkind) ? [target, ...containedSymbols(store, target)] : [target];
    const hits = seeds.flatMap((seed) => reverseBfs(store, seed, maxDepth));
    const filesByPath = aggregateByFile(hits, target);
    const subjectFile = target.filePath ?? '';
    // rank.ts's rankCandidates excludes any candidate sharing the subject
    // file's basename (by design — see rank.ts's "exclude the subject symbol's
    // own file" comment). Same-file callers legitimately share that basename
    // with the target, so they'd be silently dropped if ranked through the
    // normal call. Rank them separately with subjectFile '' (same workaround
    // contextpack.ts uses to disable that exclusion) so they still get scored,
    // then merge both ranked sets back together.
    const sameFileFiles = filesByPath.filter((f) => f.filePath === subjectFile);
    const otherFiles = filesByPath.filter((f) => f.filePath !== subjectFile);
    const otherCandidates = otherFiles.map((f) => ({ filePath: f.filePath, refs: f.hitCount, direct: f.direct }));
    const sameFileCandidates = sameFileFiles.map((f) => ({ filePath: f.filePath, refs: f.hitCount, direct: f.direct }));
    const ranked = [
        ...rankCandidates(otherCandidates, subjectFile, target.name),
        ...rankCandidates(sameFileCandidates, '', target.name),
    ].sort((a, b) => b.score - a.score || b.signals.refs - a.signals.refs || a.filePath.localeCompare(b.filePath));
    const byPath = new Map(filesByPath.map((f) => [f.filePath, f]));
    const files = ranked
        .map((r) => {
        const agg = byPath.get(r.filePath);
        if (!agg)
            return null;
        return { ...agg, rank: r.score, tier: r.tier, signals: r.signals };
    })
        .filter((f) => f !== null)
        .slice(0, limit);
    const coChanges = coChangeSection(store, files);
    return { target, files, coChanges };
}
/** Direct children of a container symbol (its methods/fields) via outgoing `contains` edges. */
function containedSymbols(store, container) {
    return store.neighbors(container.id, { direction: 'out', kinds: ['contains'] }).map((n) => n.node);
}
function reverseBfs(store, target, maxDepth) {
    const visited = new Set([target.id]);
    const hits = [];
    let frontier = [target];
    for (let depth = 1; depth <= maxDepth; depth++) {
        const next = [];
        const decay = HOP_DECAY_BASE ** (depth - 1); // 1.0, 0.5, 0.25, ...
        for (const node of frontier) {
            const neighbors = store.neighbors(node.id, { direction: 'in', kinds: IMPACT_EDGE_KINDS });
            for (const neighbor of neighbors) {
                if (visited.has(neighbor.node.id))
                    continue;
                visited.add(neighbor.node.id);
                hits.push({ node: neighbor.node, depth, score: decay, direct: depth === 1 });
                next.push(neighbor.node);
            }
        }
        frontier = next;
        if (frontier.length === 0)
            break;
    }
    return hits;
}
function aggregateByFile(hits, target) {
    const byPath = new Map();
    for (const hit of hits) {
        const filePath = hit.node.filePath;
        if (!filePath || hit.node.id === target.id)
            continue;
        const acc = byPath.get(filePath) ?? { maxScore: 0, hitCount: 0, minDepth: Infinity, direct: false, symbols: new Set() };
        acc.maxScore = Math.max(acc.maxScore, hit.score);
        acc.hitCount += 1;
        acc.minDepth = Math.min(acc.minDepth, hit.depth);
        acc.direct = acc.direct || hit.direct;
        acc.symbols.add(hit.node.name);
        byPath.set(filePath, acc);
    }
    return [...byPath.entries()].map(([filePath, acc]) => ({
        filePath,
        maxScore: acc.maxScore,
        hitCount: acc.hitCount,
        minDepth: acc.minDepth,
        direct: acc.direct,
        symbols: [...acc.symbols],
    }));
}
/** Secondary, clearly-separated section: co_change neighbors of the top-ranked
 * impact files, weight taken from edge meta/weight (history suggests, not
 * proven structural coupling — kept apart from the ranked structural list). */
function coChangeSection(store, topFiles) {
    const results = [];
    for (const file of topFiles.slice(0, CO_CHANGE_TOP_FILES)) {
        const fileNode = findFileNode(store, file.filePath);
        if (!fileNode)
            continue;
        const neighbors = store.neighbors(fileNode.id, { direction: 'both', kinds: ['co_change'] });
        const sorted = [...neighbors].sort((a, b) => (b.edge.weight ?? 0) - (a.edge.weight ?? 0)).slice(0, CO_CHANGE_PER_FILE_LIMIT);
        for (const neighbor of sorted) {
            if (!neighbor.node.filePath)
                continue;
            results.push({ filePath: neighbor.node.filePath, withFile: file.filePath, weight: neighbor.edge.weight ?? 0 });
        }
    }
    return results;
}
function findFileNode(store, filePath) {
    const rows = store.raw(`SELECT id FROM nodes WHERE kind = 'file' AND file_path = ? LIMIT 1`, [filePath]);
    const row = rows[0];
    if (!row)
        return null;
    return store.getNode(row.id);
}
