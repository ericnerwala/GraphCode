import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { resolveSymbol, findCallers, findCallees, explore, impactAnalysis, buildContextPack } from '../query/index.js';
import { TOOL_DEFINITIONS } from './tools.js';
function textResult(text) {
    return { content: [{ type: 'text', text }] };
}
function errorResult(text) {
    return { content: [{ type: 'text', text }], isError: true };
}
function stringify(value) {
    return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}
function argString(args, key) {
    const value = args[key];
    return typeof value === 'string' ? value : undefined;
}
function argStringArray(args, key) {
    const value = args[key];
    if (Array.isArray(value))
        return value.filter((v) => typeof v === 'string');
    if (typeof value === 'string')
        return [value];
    return [];
}
function argNumber(args, key) {
    const value = args[key];
    return typeof value === 'number' ? value : undefined;
}
/** Resolve a name/path typed by the model to a graph node, or null if nothing matched. */
function resolveOrNull(store, nameOrPath) {
    return resolveSymbol(store, nameOrPath).node;
}
/**
 * Handle one tool call against the query layer. Never throws — steering
 * text is returned to the calling agent instead so a bad tool call doesn't
 * kill the MCP session.
 */
function callTool(name, args, store, config) {
    switch (name) {
        case 'graph_search': {
            const query = argString(args, 'query');
            if (!query)
                return errorResult('graph_search requires a "query" string argument');
            const hits = store.search(query, { limit: argNumber(args, 'limit') ?? 20 });
            if (hits.length === 0)
                return textResult(`no matches for "${query}" — try different terms or graph_explore.`);
            return textResult(stringify(hits));
        }
        case 'graph_explore': {
            const symbols = argStringArray(args, 'symbols');
            if (symbols.length === 0)
                return errorResult('graph_explore requires a non-empty "symbols" array argument');
            const result = explore(store, config.root, symbols);
            return textResult(stringify(result));
        }
        case 'graph_callers': {
            const symbol = argString(args, 'symbol');
            if (!symbol)
                return errorResult('graph_callers requires a "symbol" string argument');
            const target = resolveOrNull(store, symbol);
            if (!target)
                return textResult(`no graph match for "${symbol}" — try graph_search first.`);
            const hits = findCallers(store, target, { depth: argNumber(args, 'depth') ?? 1 });
            return textResult(stringify(hits));
        }
        case 'graph_callees': {
            const symbol = argString(args, 'symbol');
            if (!symbol)
                return errorResult('graph_callees requires a "symbol" string argument');
            const target = resolveOrNull(store, symbol);
            if (!target)
                return textResult(`no graph match for "${symbol}" — try graph_search first.`);
            const hits = findCallees(store, target, { depth: argNumber(args, 'depth') ?? 1 });
            return textResult(stringify(hits));
        }
        case 'graph_impact': {
            const targetName = argString(args, 'target');
            if (!targetName)
                return errorResult('graph_impact requires a "target" string argument');
            const target = resolveOrNull(store, targetName);
            if (!target)
                return textResult(`no graph match for "${targetName}" — try graph_search first.`);
            const result = impactAnalysis(store, config.root, target, {
                depth: argNumber(args, 'depth') ?? 2,
                limit: argNumber(args, 'limit') ?? 50,
            });
            return textResult(stringify(result));
        }
        case 'graph_context': {
            const task = argString(args, 'task');
            if (!task)
                return errorResult('graph_context requires a "task" string argument');
            const pack = buildContextPack(store, config.root, task, argNumber(args, 'budget') ?? config.contextPackTokens);
            return textResult(pack.markdown);
        }
        default: {
            const exhaustive = name;
            return errorResult(`unknown tool: ${String(exhaustive)}`);
        }
    }
}
/** Start the GraphCode MCP server on stdio. Resolves once the transport closes. */
export async function startMcpServer(store, config) {
    const server = new Server({ name: 'graphcode', version: '0.1.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, () => ({
        tools: TOOL_DEFINITIONS,
    }));
    server.setRequestHandler(CallToolRequestSchema, (request, _extra) => {
        const name = request.params.name;
        const args = (request.params.arguments ?? {});
        try {
            return callTool(name, args, store, config);
        }
        catch (error) {
            return errorResult(`graph tool "${name}" failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    });
    const transport = new StdioServerTransport();
    await server.connect(transport);
    await new Promise((resolvePromise) => {
        transport.onclose = () => resolvePromise();
    });
}
