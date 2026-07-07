import { readFileSync, statSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import ignore from 'ignore';
import { SUPPORTED_EXTENSIONS, extensionOf } from './languages.js';
const BUILTIN_EXCLUDE_DIRS = new Set([
    '.git',
    'node_modules',
    '.graphcode',
    'dist',
    'build',
    'out',
    'vendor',
    'coverage',
]);
const BINARY_MEDIA_EXTENSIONS = new Set([
    '.png',
    '.jpg',
    '.jpeg',
    '.gif',
    '.bmp',
    '.ico',
    '.svg',
    '.webp',
    '.avif',
    '.pdf',
    '.zip',
    '.tar',
    '.gz',
    '.bz2',
    '.7z',
    '.rar',
    '.mp3',
    '.mp4',
    '.mov',
    '.avi',
    '.webm',
    '.wav',
    '.flac',
    '.ogg',
    '.woff',
    '.woff2',
    '.ttf',
    '.otf',
    '.eot',
    '.exe',
    '.dll',
    '.so',
    '.dylib',
    '.bin',
    '.wasm',
    '.class',
    '.jar',
    '.o',
    '.a',
    '.node',
    '.sqlite',
    '.db',
    '.lock',
]);
const MAX_FILE_SIZE_BYTES = 1.5 * 1024 * 1024;
function toRelativePosix(root, absPath) {
    return relative(root, absPath).split('\\').join('/');
}
function isMinifiedJs(name) {
    return name.endsWith('.min.js') || name.endsWith('.min.css');
}
function loadRootIgnore(root) {
    const ig = ignore();
    try {
        const contents = readFileSync(join(root, '.gitignore'), 'utf8');
        ig.add(contents);
    }
    catch {
        // No .gitignore at root; that's fine.
    }
    return ig;
}
/**
 * Walk the repo root, respecting .gitignore plus built-in excludes.
 * Returns code files (parseable by a registered language) and doc files
 * (markdown, for the knowledge layer) separately.
 */
export async function scanRepo(root, options = {}) {
    const ig = loadRootIgnore(root);
    if (options.extraIgnore && options.extraIgnore.length > 0)
        ig.add([...options.extraIgnore]);
    const codeFiles = [];
    const docFiles = [];
    async function walk(dirAbs) {
        let entries;
        try {
            entries = await readdir(dirAbs, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const entry of entries) {
            const absPath = join(dirAbs, entry.name);
            const relPath = toRelativePosix(root, absPath);
            if (relPath === '')
                continue;
            if (entry.isDirectory()) {
                if (BUILTIN_EXCLUDE_DIRS.has(entry.name))
                    continue;
                if (ig.ignores(`${relPath}/`))
                    continue;
                await walk(absPath);
                continue;
            }
            if (!entry.isFile())
                continue;
            if (ig.ignores(relPath))
                continue;
            if (isMinifiedJs(entry.name))
                continue;
            const ext = extensionOf(entry.name);
            if (BINARY_MEDIA_EXTENSIONS.has(ext))
                continue;
            let stats;
            try {
                stats = statSync(absPath);
            }
            catch {
                continue;
            }
            if (stats.size > MAX_FILE_SIZE_BYTES)
                continue;
            const file = { path: relPath, absPath, size: stats.size, mtime: Math.trunc(stats.mtimeMs) };
            if (ext === '.md' || ext === '.mdx') {
                docFiles.push(file);
            }
            else if (SUPPORTED_EXTENSIONS.includes(ext)) {
                codeFiles.push(file);
            }
        }
    }
    await walk(root);
    return { codeFiles, docFiles };
}
