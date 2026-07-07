// Tool definitions + dispatcher for the coding-agent harness. Graph tools resolve
// through an injected QueryApi (defaulting to the real '../query/index.js' impls)
// so tests can stub graph behavior without a fully-populated store.
import * as realQuery from '../query/index.js';
import { TOOL_DEFS } from './tools/tool-defs.js';
import { graphSearch, graphExplore, graphCallers, graphCallees, graphImpact, graphContext, } from './tools/graph-tools.js';
import { readFile, writeFile, editFile, listDir } from './tools/file-tools.js';
import { runBash } from './tools/bash-tool.js';
export { TOOL_DEFS };
const DEFAULT_QUERY_API = realQuery;
/** Dispatch a single tool_use call by name. Returns the text to put in the
 * tool_result. Never throws — unknown tools and bad input produce error text. */
export function dispatchTool(name, input, ctx) {
    const api = ctx.queryApi ?? DEFAULT_QUERY_API;
    const record = isRecord(input) ? input : {};
    switch (name) {
        case 'graph_search':
            return graphSearch(api, ctx.store, { query: asString(record.query) });
        case 'graph_explore':
            return graphExplore(api, ctx.store, ctx.root, { symbols: asStringArray(record.symbols) });
        case 'graph_callers':
            return graphCallers(api, ctx.store, { symbol: asString(record.symbol), depth: asOptionalNumber(record.depth) });
        case 'graph_callees':
            return graphCallees(api, ctx.store, { symbol: asString(record.symbol), depth: asOptionalNumber(record.depth) });
        case 'graph_impact':
            return graphImpact(api, ctx.store, ctx.root, {
                target: asString(record.target),
                depth: asOptionalNumber(record.depth),
            });
        case 'graph_context':
            return graphContext(api, ctx.store, ctx.root, { task: asString(record.task) }, ctx.config.contextPackTokens);
        case 'read_file':
            return readFile(ctx.root, {
                path: asString(record.path),
                offset: asOptionalNumber(record.offset),
                limit: asOptionalNumber(record.limit),
            });
        case 'write_file':
            return writeFile(ctx.root, { path: asString(record.path), content: asString(record.content) });
        case 'edit_file':
            return editFile(ctx.root, {
                path: asString(record.path),
                old_string: asString(record.old_string),
                new_string: asString(record.new_string),
                replace_all: record.replace_all === true,
            });
        case 'list_dir':
            return listDir(ctx.root, { path: asString(record.path) });
        case 'bash':
            return runBash(ctx.root, { command: asString(record.command), timeout_ms: asOptionalNumber(record.timeout_ms) });
        default:
            return `error: unknown tool "${name}"`;
    }
}
function isRecord(value) {
    return typeof value === 'object' && value !== null;
}
function asString(value) {
    return typeof value === 'string' ? value : '';
}
function asOptionalNumber(value) {
    return typeof value === 'number' ? value : undefined;
}
function asStringArray(value) {
    return Array.isArray(value) ? value.filter((v) => typeof v === 'string') : [];
}
