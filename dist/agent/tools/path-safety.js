import { realpathSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
export class PathEscapeError extends Error {
    requestedPath;
    constructor(requestedPath) {
        super(`path escapes repo root: ${requestedPath}`);
        this.requestedPath = requestedPath;
        this.name = 'PathEscapeError';
    }
}
/** True if `child` is `root` itself or lexically contained within it. */
function isInside(root, child) {
    const withSep = root.endsWith(sep) ? root : `${root}${sep}`;
    return child === root || child.startsWith(withSep);
}
/**
 * Resolve a repo-root-relative path and reject any attempt to escape the root —
 * via "..", absolute paths outside root, OR a symlink whose real target lies
 * outside root. The lexical check alone is insufficient: a symlink inside the
 * repo pointing at /etc or the home directory resolves lexically to an in-root
 * path but reads/writes outside it, so we also verify the realpath.
 */
export function resolveInRoot(root, requestedPath) {
    const absoluteRoot = resolve(root);
    const resolved = resolve(absoluteRoot, requestedPath);
    if (!isInside(absoluteRoot, resolved)) {
        throw new PathEscapeError(requestedPath);
    }
    // Resolve symlinks. For a not-yet-created target (write), the leaf won't exist,
    // so verify the nearest existing ancestor's realpath instead — that catches a
    // symlinked parent directory pointing outside the root.
    const realRoot = safeRealpath(absoluteRoot);
    const realTarget = realpathOfNearestExisting(resolved);
    if (realTarget !== null && !isInside(realRoot, realTarget)) {
        throw new PathEscapeError(requestedPath);
    }
    return resolved;
}
function safeRealpath(path) {
    try {
        return realpathSync(path);
    }
    catch {
        return path;
    }
}
/** realpath of `path`, or of its nearest existing ancestor if it doesn't exist yet. */
function realpathOfNearestExisting(path) {
    let current = path;
    for (;;) {
        try {
            return realpathSync(current);
        }
        catch {
            const parent = dirname(current);
            if (parent === current)
                return null;
            current = parent;
        }
    }
}
