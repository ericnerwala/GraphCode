// Thin wrapper over `git` invocations. Every caller must tolerate git being
// absent or the cwd not being a repo — the graph degrades to a no-op rather
// than throwing, since GraphCode must work in plain (non-git) directories.
import { spawnSync } from 'node:child_process';
const MAX_BUFFER = 64 * 1024 * 1024;
/** Run a git subcommand in `cwd`. Returns trimmed stdout, or null on any failure. */
export function runGit(cwd, args) {
    try {
        const result = spawnSync('git', args, {
            cwd,
            encoding: 'utf8',
            maxBuffer: MAX_BUFFER,
        });
        if (result.error)
            return null;
        if (result.status !== 0)
            return null;
        return result.stdout;
    }
    catch {
        return null;
    }
}
/** The current HEAD commit sha for `root`, or null if not a git repo / no commits. */
export function gitHeadSha(root) {
    const sha = runGit(root, ['rev-parse', 'HEAD']);
    if (sha === null)
        return null;
    const trimmed = sha.trim();
    return trimmed.length > 0 ? trimmed : null;
}
