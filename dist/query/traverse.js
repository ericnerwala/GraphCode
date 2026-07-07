// Breadth-first caller/callee walks over 'calls' edges. Shared BFS core so
// the two directions stay symmetric and dedup/ordering semantics match.
const DEFAULT_DEPTH = 1;
const DEFAULT_LIMIT = 100;
export function findCallers(store, target, options = {}) {
    return traverse(store, target, 'in', options);
}
export function findCallees(store, target, options = {}) {
    return traverse(store, target, 'out', options);
}
function traverse(store, target, direction, options) {
    const maxDepth = options.depth ?? DEFAULT_DEPTH;
    const limit = options.limit ?? DEFAULT_LIMIT;
    const visited = new Set([target.id]);
    const results = [];
    let frontier = [{ node: target, depth: 0, viaPath: [target.name] }];
    for (let depth = 1; depth <= maxDepth && results.length < limit; depth++) {
        const next = [];
        for (const item of frontier) {
            const neighbors = store.neighbors(item.node.id, { direction, kinds: ['calls'] });
            for (const neighbor of neighbors) {
                if (visited.has(neighbor.node.id))
                    continue;
                visited.add(neighbor.node.id);
                const viaPath = direction === 'in' ? [neighbor.node.name, ...item.viaPath] : [...item.viaPath, neighbor.node.name];
                const hit = {
                    symbol: neighbor.node.name,
                    file: neighbor.node.filePath,
                    line: neighbor.node.startLine,
                    depth,
                    viaPath,
                    node: neighbor.node,
                };
                results.push(hit);
                next.push({ node: neighbor.node, depth, viaPath });
                if (results.length >= limit)
                    break;
            }
            if (results.length >= limit)
                break;
        }
        frontier = next;
        if (frontier.length === 0)
            break;
    }
    return results
        .slice(0, limit)
        .sort((a, b) => a.depth - b.depth || a.symbol.localeCompare(b.symbol));
}
