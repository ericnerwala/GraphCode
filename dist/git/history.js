import { applyCochangePairs, mineCochangePairs } from './cochange.js';
import { runGit } from './git-cli.js';
import { gitLogArgs, parseGitLog } from './log-parser.js';
const GIT_LAST_SHA_KEY = 'git_last_sha';
/**
 * Ingest git history into the graph. Incremental when `git_last_sha` meta
 * is set and still reachable (git log <last>..HEAD succeeds); otherwise
 * does a full rebuild of the commit-node subgraph. No-ops gracefully when
 * the repo root is not a git repository.
 */
export function ingestGitHistory(store, repo, config, options = {}) {
    const onProgress = options.onProgress ?? (() => { });
    const lastSha = store.getMeta(GIT_LAST_SHA_KEY);
    let range = null;
    let incremental = false;
    if (lastSha) {
        const probe = runGit(config.root, ['cat-file', '-e', lastSha]);
        if (probe !== null) {
            range = `${lastSha}..HEAD`;
            incremental = true;
        }
    }
    const output = runGit(config.root, gitLogArgs(range, config.maxCommits));
    if (output === null) {
        // Not a git repo, or the incremental range failed (e.g. rebase rewrote
        // history) and even a bare `git log` errors out. Degrade to a no-op.
        if (incremental) {
            // Range failed outright (not just "empty") - try a full rebuild once.
            const fullOutput = runGit(config.root, gitLogArgs(null, config.maxCommits));
            if (fullOutput === null)
                return { commits: 0, touchEdges: 0, cochangeEdges: 0 };
            return rebuildAndApply(store, repo, config, fullOutput, onProgress);
        }
        return { commits: 0, touchEdges: 0, cochangeEdges: 0 };
    }
    onProgress(`parsing git log${incremental ? ' (incremental)' : ''}`);
    const commits = parseGitLog(output);
    if (incremental) {
        return applyIncremental(store, repo, commits, onProgress);
    }
    return rebuildAndApply(store, repo, config, output, onProgress);
}
function rebuildAndApply(store, repo, config, rawOutput, onProgress) {
    const commits = parseGitLog(rawOutput);
    onProgress(`rebuilding commit graph (${commits.length} commits)`);
    store.deleteNodesByKind(repo.id, 'commit');
    return ingestCommits(store, repo, commits, onProgress);
}
function applyIncremental(store, repo, commits, onProgress) {
    onProgress(`applying ${commits.length} new commits`);
    return ingestCommits(store, repo, commits, onProgress);
}
function ingestCommits(store, repo, commits, onProgress) {
    let touchEdges = 0;
    store.transaction(() => {
        for (const commit of commits) {
            const shortSha = commit.sha.slice(0, 7);
            const totalInsertions = commit.files.reduce((sum, f) => sum + f.insertions, 0);
            const totalDeletions = commit.files.reduce((sum, f) => sum + f.deletions, 0);
            const commitNodeId = store.insertNode(repo.id, {
                kind: 'commit',
                name: shortSha,
                qualifiedName: commit.sha,
                doc: commit.subject,
                meta: {
                    author: commit.author,
                    email: commit.email,
                    ts: commit.ts,
                    insertions: totalInsertions,
                    deletions: totalDeletions,
                },
            });
            const seenPaths = new Set();
            for (const file of commit.files) {
                if (seenPaths.has(file.path))
                    continue;
                seenPaths.add(file.path);
                const fileNode = store.fileNode(repo.id, file.path);
                if (!fileNode)
                    continue;
                store.insertEdge(repo.id, {
                    src: fileNode.id,
                    dst: commitNodeId,
                    kind: 'touched_by',
                    meta: { insertions: file.insertions, deletions: file.deletions },
                });
                touchEdges += 1;
            }
        }
        if (commits.length > 0) {
            const newest = commits[0];
            if (newest)
                store.setMeta(GIT_LAST_SHA_KEY, newest.sha);
        }
    });
    onProgress('mining co-change pairs');
    const pairs = mineCochangePairs(commits);
    const { cochangeEdges } = applyCochangePairs(store, repo, pairs);
    return { commits: commits.length, touchEdges, cochangeEdges };
}
