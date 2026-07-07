import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../core/config.js';
import { GraphcodeError, NotIndexedError } from '../../core/errors.js';
import { print, printStatus } from '../../core/output.js';
import { GraphStore } from '../../graph/store.js';
function nodeToExport(node) {
    return {
        id: node.id,
        type: node.kind,
        subtype: node.subkind,
        name: node.name,
        filePath: node.filePath,
        startLine: node.startLine,
        endLine: node.endLine,
    };
}
/** Build the compact export shape from a store's raw tables. */
export function buildExport(store) {
    const nodeRows = store.raw('SELECT id FROM nodes');
    const nodes = nodeRows
        .map((row) => store.getNode(row.id))
        .filter((node) => node !== null)
        .map(nodeToExport);
    const edgeRows = store.raw('SELECT src, dst, kind, weight FROM edges');
    const edges = edgeRows.map((row) => ({ source: row.src, target: row.dst, type: row.kind, weight: row.weight }));
    return {
        nodes,
        edges,
        metadata: { generatedAt: new Date().toISOString(), stats: store.stats() },
    };
}
async function runExport(path, out) {
    const config = loadConfig(path);
    if (!existsSync(config.dbPath))
        throw new NotIndexedError(config.root);
    const store = GraphStore.open(config.dbPath);
    try {
        const graph = buildExport(store);
        await writeFile(out, JSON.stringify(graph, null, 2), 'utf8');
        return graph;
    }
    finally {
        store.close();
    }
}
/**
 * Resolve viewer.html relative to this file. Whether running from
 * dist/cli/commands/export-cmd.js or src/cli/commands/export-cmd.ts, the
 * sibling src/viz -> dist/viz layout is mirrored, so the same relative path
 * works in both; a repo-root src/ fallback covers unusual layouts.
 */
function viewerHtmlPath() {
    const here = dirname(fileURLToPath(import.meta.url));
    const nearPath = resolve(here, '../../viz/viewer.html');
    if (existsSync(nearPath))
        return nearPath;
    return resolve(here, '../../../src/viz/viewer.html');
}
const CONTENT_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
};
/** Map a viz http server startup error to a friendly GraphcodeError (consistent
 * with NotIndexedError's style) instead of letting a raw EADDRINUSE stack
 * trace reach the user. */
export function toVizServerError(err, port) {
    if (err.code === 'EADDRINUSE') {
        return new GraphcodeError(`port ${port} is already in use`, 'pass --port <n> to use a different port');
    }
    return err;
}
async function runViz(path, port) {
    const config = loadConfig(path);
    if (!existsSync(config.dbPath))
        throw new NotIndexedError(config.root);
    const store = GraphStore.open(config.dbPath);
    let graphJson;
    try {
        graphJson = JSON.stringify(buildExport(store));
    }
    finally {
        store.close();
    }
    const htmlPath = viewerHtmlPath();
    if (!existsSync(htmlPath)) {
        throw new Error(`viewer.html not found (looked at ${htmlPath}); run \`npm run build\` first`);
    }
    const html = await readFile(htmlPath, 'utf8');
    const server = createServer((req, res) => {
        const url = req.url ?? '/';
        if (url === '/graph.json') {
            res.writeHead(200, { 'Content-Type': CONTENT_TYPES['.json'] ?? 'application/json' });
            res.end(graphJson);
            return;
        }
        res.writeHead(200, { 'Content-Type': CONTENT_TYPES['.html'] ?? 'text/html' });
        res.end(html);
    });
    await new Promise((resolvePromise, reject) => {
        server.once('error', (err) => reject(toVizServerError(err, port)));
        server.listen(port, () => resolvePromise());
    });
    printStatus(`serving graph viewer at http://localhost:${port} (Ctrl-C to stop)`);
    await new Promise((resolvePromise) => {
        const shutdown = () => {
            server.close(() => resolvePromise());
        };
        process.once('SIGINT', shutdown);
        process.once('SIGTERM', shutdown);
    });
}
export function registerExportCommands(program) {
    program
        .command('export')
        .description('Export the knowledge graph as compact JSON')
        .option('--path <dir>', 'repo root', process.cwd())
        .option('--out <file>', 'output file', 'graph.json')
        .action(async (options) => {
        const graph = await runExport(options.path, options.out);
        print(`exported ${graph.nodes.length} nodes, ${graph.edges.length} edges -> ${options.out}`);
    });
    program
        .command('viz')
        .description('Serve an interactive graph viewer for the current repo')
        .option('--path <dir>', 'repo root', process.cwd())
        .option('--port <n>', 'port to serve on', (v) => Number.parseInt(v, 10), 5173)
        .action(async (options) => {
        await runViz(options.path, options.port);
    });
}
