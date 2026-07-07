import { mkdirSync } from 'node:fs';
import { loadConfig } from '../../core/config.js';
import { printStatus } from '../../core/output.js';
import { GraphStore } from '../../graph/store.js';
import { startMcpServer } from '../../mcp/server.js';
import { ensureIndexed } from './index-cmd.js';
export function registerMcpCommand(program) {
    program
        .command('mcp')
        .description('Start the GraphCode MCP server (stdio transport)')
        .option('--path <dir>', 'repo root', process.cwd())
        .option('--no-sync', 'skip the startup graph sync')
        .action(async (options) => {
        const config = loadConfig(options.path);
        // stdout is the MCP transport: all progress must go to stderr only.
        let store;
        if (options.sync === false) {
            mkdirSync(config.graphDir, { recursive: true });
            store = GraphStore.open(config.dbPath);
        }
        else {
            printStatus('syncing graph...');
            store = await ensureIndexed(config, { onProgress: (message) => printStatus(message) });
        }
        try {
            await startMcpServer(store, config);
        }
        finally {
            store.close();
        }
    });
}
