import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
export const GRAPH_DIR_NAME = '.graphcode';
export const CONFIG_FILE_NAME = 'graphcode.json';
const DEFAULT_EDIT_GUARD = {
    enabled: true,
    minImpactedFiles: 2,
    topFiles: 5,
    topCoChanges: 3,
    maxSymbolsPerFile: 40,
    depth: undefined,
};
const DEFAULTS = {
    model: process.env.GRAPHCODE_MODEL ?? 'claude-sonnet-5',
    contextPackTokens: 6000,
    maxCommits: 2000,
    ignore: [],
    workspaceRepos: [],
    // All reliability levers default off: the harness behaves exactly as before
    // until a user opts in via graphcode.json. editGuard.enabled defaults true but
    // is gated on liveGraphSync in computeEditGuardAdvisory — so with liveGraphSync
    // off (the default) it never fires, and turning liveGraphSync on bundles the
    // advisory in automatically without a second flag. Net: zero behavior change
    // for a user who hasn't opted into anything.
    liveGraphSync: false,
    editGuard: DEFAULT_EDIT_GUARD,
    postEditVerify: false,
    completionGateEnabled: false,
    completionGateMaxIterations: 2,
    completionGateMinSeverity: 'high',
};
function mergeEditGuard(fromFile) {
    return {
        enabled: fromFile?.enabled ?? DEFAULT_EDIT_GUARD.enabled,
        minImpactedFiles: fromFile?.minImpactedFiles ?? DEFAULT_EDIT_GUARD.minImpactedFiles,
        topFiles: fromFile?.topFiles ?? DEFAULT_EDIT_GUARD.topFiles,
        topCoChanges: fromFile?.topCoChanges ?? DEFAULT_EDIT_GUARD.topCoChanges,
        maxSymbolsPerFile: fromFile?.maxSymbolsPerFile ?? DEFAULT_EDIT_GUARD.maxSymbolsPerFile,
        depth: fromFile?.depth ?? DEFAULT_EDIT_GUARD.depth,
    };
}
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
        liveGraphSync: fromFile.liveGraphSync ?? DEFAULTS.liveGraphSync,
        editGuard: mergeEditGuard(fromFile.editGuard),
        postEditVerify: fromFile.postEditVerify ?? DEFAULTS.postEditVerify,
        completionGateEnabled: fromFile.completionGateEnabled ?? DEFAULTS.completionGateEnabled,
        completionGateMaxIterations: fromFile.completionGateMaxIterations ?? DEFAULTS.completionGateMaxIterations,
        completionGateMinSeverity: fromFile.completionGateMinSeverity ?? DEFAULTS.completionGateMinSeverity,
    };
}
