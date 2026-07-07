import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
export const GRAPH_DIR_NAME = '.graphcode';
export const CONFIG_FILE_NAME = 'graphcode.json';
const DEFAULTS = {
    model: process.env.GRAPHCODE_MODEL ?? 'claude-sonnet-5',
    contextPackTokens: 6000,
    maxCommits: 2000,
    ignore: [],
    workspaceRepos: [],
};
/** Load config for a repo root, merging graphcode.json when present. */
export function loadConfig(rootInput) {
    const root = resolve(rootInput);
    const graphDir = join(root, GRAPH_DIR_NAME);
    const configPath = join(root, CONFIG_FILE_NAME);
    const fromFile = existsSync(configPath)
        ? JSON.parse(readFileSync(configPath, 'utf8'))
        : {};
    return {
        root,
        graphDir,
        dbPath: join(graphDir, 'graph.db'),
        model: fromFile.model ?? DEFAULTS.model,
        contextPackTokens: fromFile.contextPackTokens ?? DEFAULTS.contextPackTokens,
        maxCommits: fromFile.maxCommits ?? DEFAULTS.maxCommits,
        ignore: fromFile.ignore ?? DEFAULTS.ignore,
        workspaceRepos: fromFile.workspaceRepos ?? DEFAULTS.workspaceRepos,
    };
}
