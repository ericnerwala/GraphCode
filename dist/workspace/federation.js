// Cross-repo layer: opens the root store plus each configured workspaceRepos
// member's index, and federates search/impact across them with repo labels.
import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { printStatus } from '../core/output.js';
import { GraphStore } from '../graph/store.js';
import { impactAnalysis } from '../query/impact.js';
import { resolveSymbol } from '../query/locate.js';
/** Opens the root repo's store plus each configured workspaceRepos member's
 * .graphcode/graph.db when present. Members missing an index are skipped
 * (and noted via onProgress / printStatus) rather than failing the whole
 * workspace open. */
export function openWorkspace(config, options = {}) {
    const note = options.onProgress ?? printStatus;
    const repos = [];
    if (existsSync(config.dbPath)) {
        try {
            const store = GraphStore.open(config.dbPath);
            repos.push({ name: repoName(store, config.root), root: config.root, store });
        }
        catch (err) {
            note(`workspace: skipping root repo ${config.root} (failed to open index: ${errorMessage(err)})`);
        }
    }
    else {
        note(`workspace: skipping root repo ${config.root} (no index found)`);
    }
    for (const member of config.workspaceRepos) {
        const memberRoot = isAbsolute(member) ? member : join(config.root, member);
        const memberDbPath = join(memberRoot, '.graphcode', 'graph.db');
        if (!existsSync(memberDbPath)) {
            note(`workspace: skipping ${memberRoot} (no index found at ${memberDbPath})`);
            continue;
        }
        // A member failing to open (corrupt db, locked file, etc.) must not take
        // down the whole workspace, and must not leak the handles already opened
        // above — skip-and-note, matching the missing-index case's resilience.
        try {
            const store = GraphStore.open(memberDbPath);
            repos.push({ name: repoName(store, memberRoot), root: memberRoot, store });
        }
        catch (err) {
            note(`workspace: skipping ${memberRoot} (failed to open index at ${memberDbPath}: ${errorMessage(err)})`);
        }
    }
    return { repos };
}
function errorMessage(err) {
    return err instanceof Error ? err.message : String(err);
}
/** Prefer the name recorded in the store's repos table (set at index time);
 * fall back to the root directory's basename when the store has no matching
 * repo row (e.g. an index opened from an unexpected path). */
function repoName(store, root) {
    const repo = store.getRepoByRoot(root);
    if (repo)
        return repo.name;
    return root.split('/').filter(Boolean).at(-1) ?? root;
}
/** Merged, score-sorted search across every repo in the workspace. */
export function workspaceSearch(ws, query, limit = 20) {
    const all = [];
    for (const repo of ws.repos) {
        const hits = repo.store.search(query, { limit });
        for (const hit of hits)
            all.push({ ...hit, repo: repo.name });
    }
    return all.sort((a, b) => b.score - a.score).slice(0, limit);
}
/** Per-repo impact analysis for `target`, merged with repo labels. Since a
 * symbol lives in exactly one repo's graph, each repo is searched
 * independently for the target name; repos where it does not resolve
 * contribute no entry (cross-repo blast radius via repeated name lookup,
 * not a shared node space). */
export function workspaceImpact(ws, target, opts = {}) {
    const results = [];
    for (const repo of ws.repos) {
        const resolved = resolveSymbol(repo.store, target);
        if (!resolved.node)
            continue;
        const result = impactAnalysis(repo.store, repo.root, resolved.node, opts);
        results.push({ repo: repo.name, result });
    }
    return results;
}
export function closeWorkspace(ws) {
    for (const repo of ws.repos)
        repo.store.close();
}
