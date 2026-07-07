// Graph query tools. These must NEVER throw to the model: on failure or an empty
// result they return a short steering message that nudges the model back toward
// a different graph query or a file-based fallback, rather than aborting the turn.
function steer(label, query) {
    return `No graph match for ${label} "${query}" - try graph_search with different terms, or fall back to list_dir/read_file.`;
}
function safely(label, query, fn) {
    try {
        const result = fn();
        return result.trim().length > 0 ? result : steer(label, query);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return `graph ${label} failed for "${query}": ${message}\n\n${steer(label, query)}`;
    }
}
function describeNode(node) {
    const loc = node.filePath ? `${node.filePath}${node.startLine ? `:${node.startLine}` : ''}` : '(no file)';
    return `${node.kind}${node.subkind ? `/${node.subkind}` : ''} ${node.qualifiedName ?? node.name} — ${loc}`;
}
function describeHit(hit) {
    const loc = hit.file ? `${hit.file}${hit.line ? `:${hit.line}` : ''}` : '(no file)';
    return `${hit.symbol} — ${loc} (depth ${hit.depth}, via ${hit.viaPath.join(' -> ')})`;
}
/** Resolve a name to a node, or return null with the caller responsible for
 * steering. Prefers the primary match; falls back to the best alternative kind. */
function resolveOrNull(api, store, name) {
    return api.resolveSymbol(store, name).node;
}
export function graphSearch(api, store, input) {
    return safely('search', input.query, () => {
        const result = api.resolveSymbol(store, input.query);
        const nodes = [result.node, ...result.alternatives].filter((n) => n !== null);
        if (nodes.length === 0)
            return '';
        return nodes.map(describeNode).join('\n');
    });
}
export function graphExplore(api, store, root, input) {
    const label = input.symbols.join(', ');
    return safely('explore', label, () => renderExploreResult(api.explore(store, root, input.symbols)));
}
function renderExploreResult(result) {
    const lines = [];
    for (const path of result.paths) {
        if (path.found) {
            const chain = path.edges.map((e) => `${e.from.name} --${e.kind}--> ${e.to.name}`).join('\n  ');
            lines.push(`${path.from} -> ${path.to}:\n  ${chain}`);
        }
        else {
            lines.push(`${path.from} -> ${path.to}: no path found`);
        }
    }
    for (const sym of result.symbols) {
        lines.push('');
        lines.push(`### ${sym.node.qualifiedName ?? sym.node.name} (${sym.node.filePath ?? 'unknown'}:${sym.node.startLine ?? '?'})`);
        if (sym.source) {
            lines.push('```');
            lines.push(sym.source);
            if (sym.truncated)
                lines.push('… [truncated]');
            lines.push('```');
        }
    }
    return lines.join('\n');
}
export function graphCallers(api, store, input) {
    return safely('callers', input.symbol, () => {
        const target = resolveOrNull(api, store, input.symbol);
        if (!target)
            return '';
        const hits = api.findCallers(store, target, { depth: input.depth });
        return hits.map(describeHit).join('\n');
    });
}
export function graphCallees(api, store, input) {
    return safely('callees', input.symbol, () => {
        const target = resolveOrNull(api, store, input.symbol);
        if (!target)
            return '';
        const hits = api.findCallees(store, target, { depth: input.depth });
        return hits.map(describeHit).join('\n');
    });
}
export function graphImpact(api, store, root, input) {
    return safely('impact', input.target, () => {
        const target = resolveOrNull(api, store, input.target);
        if (!target)
            return '';
        return renderImpactResult(api.impactAnalysis(store, root, target, { depth: input.depth }));
    });
}
function renderImpactResult(result) {
    const lines = [`Impact of ${result.target.qualifiedName ?? result.target.name}:`];
    for (const file of result.files) {
        lines.push(`- [${file.tier}] ${file.filePath} (rank ${file.rank.toFixed(2)}, ${file.symbols.join(', ')})`);
    }
    if (result.coChanges.length > 0) {
        lines.push('');
        lines.push('History suggests co-changes:');
        for (const co of result.coChanges) {
            lines.push(`- ${co.filePath} co-changes with ${co.withFile} (weight ${co.weight.toFixed(2)})`);
        }
    }
    return lines.join('\n');
}
export function graphContext(api, store, root, input, budgetTokens) {
    return safely('context', input.task, () => api.buildContextPack(store, root, input.task, budgetTokens).markdown);
}
