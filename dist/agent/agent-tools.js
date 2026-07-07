// Tool definitions + dispatcher for the coding-agent harness. Graph tools resolve
// through an injected QueryApi (defaulting to the real '../query/index.js' impls)
// so tests can stub graph behavior without a fully-populated store.
//
// write_file/edit_file run through finishEditDispatch, which is the single merge
// point for the reliability levers: pre-edit impact advisory, live graph sync,
// and post-edit verification — all appended to the tool_result, and all skipped
// when the underlying write failed.
import * as realQuery from '../query/index.js';
import { TOOL_DEFS } from './tools/tool-defs.js';
import { graphSearch, graphExplore, graphCallers, graphCallees, graphImpact, graphContext, } from './tools/graph-tools.js';
import { readFile, writeFile, editFile, listDir, ERROR_PREFIX } from './tools/file-tools.js';
import { runBash } from './tools/bash-tool.js';
import { reindexFile } from './graph-sync.js';
import { buildEditGuardAdvisory } from './edit-guard.js';
import { verifyEditedFile, renderFindings } from './post-edit-verify.js';
export { TOOL_DEFS };
const DEFAULT_QUERY_API = realQuery;
/** The tools that mutate files. The loop serializes these within a turn (see loop.ts). */
export const MUTATING_TOOLS = new Set(['write_file', 'edit_file']);
/** Dispatch a single tool_use call by name. Returns the text to put in the
 * tool_result. Never throws — unknown tools and bad input produce error text. */
export async function dispatchTool(name, input, ctx) {
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
        case 'write_file': {
            const path = asString(record.path);
            const guardAdvisory = computeEditGuardAdvisory(api, ctx, path);
            const result = writeFile(ctx.root, { path, content: asString(record.content) });
            return finishEditDispatch(ctx, path, result, guardAdvisory);
        }
        case 'edit_file': {
            const path = asString(record.path);
            const guardAdvisory = computeEditGuardAdvisory(api, ctx, path);
            const result = editFile(ctx.root, {
                path,
                old_string: asString(record.old_string),
                new_string: asString(record.new_string),
                replace_all: record.replace_all === true,
            });
            return finishEditDispatch(ctx, path, result, guardAdvisory);
        }
        case 'list_dir':
            return listDir(ctx.root, { path: asString(record.path) });
        case 'bash':
            return runBash(ctx.root, { command: asString(record.command), timeout_ms: asOptionalNumber(record.timeout_ms) });
        default:
            return `error: unknown tool "${name}"`;
    }
}
/**
 * The reliability pipeline for one successful write/edit, in order:
 *   1. If the write itself failed, return as-is — never attach advisories to a
 *      failure (the model must see the bare error and retry).
 *   2. Append the pre-edit impact advisory (computed before the write).
 *   3. Live-sync the file into the graph.
 *   4. Append a one-line sync note.
 *   5. Post-edit verify (only when enabled and sync succeeded); append findings.
 *   6. Record the write for the completion gate.
 */
async function finishEditDispatch(ctx, path, result, guardAdvisory) {
    if (result.startsWith(ERROR_PREFIX))
        return result;
    const withGuard = guardAdvisory ? `${result}\n${guardAdvisory}` : result;
    const sync = await safeReindex(ctx, path);
    const withSync = sync.synced ? `${withGuard}\n${renderSyncNote(sync)}` : withGuard;
    const findings = ctx.config.postEditVerify && sync.synced ? safeVerify(ctx, path, sync) : [];
    ctx.sessionState?.recordWrite(path, sync, findings);
    return findings.length > 0 ? `${withSync}\n${renderFindings(findings)}` : withSync;
}
/**
 * Compute the pre-edit advisory; never throws (returns '' on any failure or
 * when disabled). Gated on liveGraphSync so that a user who has opted into
 * nothing sees zero behavior change — the advisory only rides along once the
 * agent's live-sync feature set is on. Runs BEFORE the write, so a throw here
 * (e.g. SQLITE_BUSY on a concurrent reindex) must never escape and drop the
 * write; the whole body is wrapped defensively.
 */
function computeEditGuardAdvisory(api, ctx, path) {
    if (!ctx.config.liveGraphSync || !ctx.config.editGuard.enabled)
        return '';
    try {
        const repo = ctx.store.getRepoByRoot(ctx.root);
        if (!repo)
            return '';
        return buildEditGuardAdvisory(api, ctx.store, ctx.root, repo.id, path, ctx.config.editGuard);
    }
    catch {
        return '';
    }
}
async function safeReindex(ctx, path) {
    try {
        return await reindexFile(ctx.store, ctx.config, path);
    }
    catch (error) {
        return {
            synced: false,
            skippedReason: `sync errored: ${error instanceof Error ? error.message : String(error)}`,
            repoId: -1,
            path,
            addedSymbols: [],
            removedSymbols: [],
            edgesAdded: 0,
            newlyDanglingRefCount: 0,
            priorInboundCallerFiles: [],
            durationMs: 0,
        };
    }
}
function safeVerify(ctx, path, sync) {
    try {
        return verifyEditedFile(ctx.store, ctx.config, path, sync);
    }
    catch {
        return [];
    }
}
function renderSyncNote(sync) {
    const parts = [];
    if (sync.addedSymbols.length > 0)
        parts.push(`+${sync.addedSymbols.length} symbol(s): ${sync.addedSymbols.join(', ')}`);
    if (sync.removedSymbols.length > 0)
        parts.push(`-${sync.removedSymbols.length} symbol(s): ${sync.removedSymbols.join(', ')}`);
    const detail = parts.length > 0 ? ` ${parts.join('; ')}` : ' no symbol changes';
    return `[graph-sync] re-indexed ${sync.path};${detail} (graph now reflects this edit)`;
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
