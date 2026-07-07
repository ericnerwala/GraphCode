import { readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
const RESOLVE_EXTENSIONS_BY_LANGUAGE = {
    typescript: ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts'],
    tsx: ['.tsx', '.ts', '.jsx', '.js'],
    javascript: ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx'],
    python: ['.py'],
    go: ['.go'],
    java: ['.java'],
    rust: ['.rs'],
};
const INDEX_BASENAMES = ['index', '__init__', 'mod'];
/**
 * TS/JS ESM imports conventionally reference the compiled-output extension
 * (e.g. `import './base.js'`) even though the source file on disk uses a
 * TS extension (`base.ts`). Map each such runtime extension to the source
 * extensions it should resolve against, tried in order.
 */
const RUNTIME_EXTENSION_SWAPS = {
    '.js': ['.ts', '.tsx', '.js', '.jsx'],
    '.jsx': ['.tsx', '.jsx'],
    '.mjs': ['.mts', '.mjs'],
    '.cjs': ['.cts', '.cjs'],
};
/**
 * Resolve a relative import/use string (./foo, ../bar) to a repo-relative path
 * that exists among `knownPaths`. Returns undefined for bare package imports
 * (external dependencies) or when no match is found.
 */
export function resolveImportPath(raw, fromFile, language, knownPaths) {
    if (!raw.startsWith('.') && !raw.startsWith('/'))
        return undefined; // bare/package import: external
    const fromDir = dirname(fromFile);
    const base = raw.startsWith('/') ? raw.slice(1) : normalize(join(fromDir, raw)).split('\\').join('/');
    const candidates = [];
    const extensions = RESOLVE_EXTENSIONS_BY_LANGUAGE[language];
    // Exact match (import already has an extension, or is an extensionless language like Go dirs).
    candidates.push(base);
    for (const ext of extensions)
        candidates.push(`${base}${ext}`);
    for (const indexName of INDEX_BASENAMES) {
        for (const ext of extensions)
            candidates.push(`${base}/${indexName}${ext}`);
    }
    // Swap a runtime extension (./base.js) for the source extensions it may
    // have been compiled from (base.ts, base.tsx, ...).
    const runtimeExt = extensions.find((ext) => base.endsWith(ext) && RUNTIME_EXTENSION_SWAPS[ext]);
    if (runtimeExt) {
        const withoutExt = base.slice(0, -runtimeExt.length);
        for (const swapExt of RUNTIME_EXTENSION_SWAPS[runtimeExt] ?? [])
            candidates.push(`${withoutExt}${swapExt}`);
    }
    for (const candidate of candidates) {
        if (knownPaths.has(candidate))
            return candidate;
    }
    return undefined;
}
const GO_MOD_CAP = 20;
/** Cache of repo root -> parsed go.mod module path, since it's read-only-once per index run. */
const goModuleCache = new Map();
/** Read the `module` line from go.mod at the repo root, caching per root for the run. */
function readGoModule(repoRoot) {
    if (goModuleCache.has(repoRoot))
        return goModuleCache.get(repoRoot);
    let moduleName;
    try {
        const contents = readFileSync(join(repoRoot, 'go.mod'), 'utf8');
        const match = /^module\s+(\S+)/m.exec(contents);
        moduleName = match?.[1];
    }
    catch {
        moduleName = undefined;
    }
    goModuleCache.set(repoRoot, moduleName);
    return moduleName;
}
/** Clear the cached go.mod lookup (test-only escape hatch; each index run re-reads once). */
export function clearGoModuleCache() {
    goModuleCache.clear();
}
/**
 * Resolve a Go import path ("github.com/mod/internal/foo") to the repo-relative
 * .go files in the target package directory. A Go import always targets a
 * PACKAGE (a directory), never a single file — so unlike other languages this
 * can fan out to several files, capped to keep the edge count sane on wide
 * packages.
 */
export function resolveGoPackageFiles(raw, repoRoot, knownPaths) {
    const moduleName = readGoModule(repoRoot);
    if (!moduleName || !raw.startsWith(moduleName))
        return []; // external/stdlib import: not in this repo
    const rest = raw.slice(moduleName.length).replace(/^\/+/, '');
    const dirPrefix = rest.length > 0 ? `${rest}/` : '';
    const matches = [...knownPaths].filter((path) => path.startsWith(dirPrefix) && path.endsWith('.go') && dirOf(path) === rest);
    return matches.slice(0, GO_MOD_CAP);
}
/**
 * Java import paths name either a class (`import a.b.C;`) or, with a
 * wildcard, an entire package (`import a.b.*;`, encoded by the extractor as
 * raw text `a.b.*`). Both are resolved against a package -> directories map
 * built once per index run (see buildJavaPackageIndex), since Java's package
 * layout is derived from each file's own `package` declaration rather than a
 * single repo-root manifest like Go's go.mod.
 */
export function resolveJavaImportFiles(raw, packagesByName, knownPaths) {
    const isWildcard = raw.endsWith('.*');
    const body = isWildcard ? raw.slice(0, -2) : raw;
    const lastDot = body.lastIndexOf('.');
    if (lastDot === -1)
        return []; // no package qualifier: default-package import, not resolvable
    if (isWildcard) {
        return resolvePackageFiles(body, packagesByName, knownPaths);
    }
    const packageName = body.slice(0, lastDot);
    const className = body.slice(lastDot + 1);
    const files = resolvePackageFiles(packageName, packagesByName, knownPaths);
    return files.filter((path) => fileBaseNameOf(path) === `${className}.java`);
}
function resolvePackageFiles(packageName, packagesByName, knownPaths) {
    const dirs = packagesByName.get(packageName);
    if (!dirs || dirs.length === 0)
        return [];
    const matches = [...knownPaths].filter((path) => path.endsWith('.java') && dirs.includes(dirOf(path)));
    return matches.slice(0, GO_MOD_CAP);
}
function fileBaseNameOf(path) {
    const idx = path.lastIndexOf('/');
    return idx === -1 ? path : path.slice(idx + 1);
}
/** Build a package name -> directories map from each Java file's parsed packageName, once per index run. */
export function buildJavaPackageIndex(filePackages) {
    const index = new Map();
    for (const [filePath, packageName] of filePackages) {
        const dir = dirOf(filePath);
        const bucket = index.get(packageName);
        if (bucket) {
            if (!bucket.includes(dir))
                bucket.push(dir);
        }
        else {
            index.set(packageName, [dir]);
        }
    }
    return index;
}
/** Index run symbols by name, once per indexing run. */
export function buildSymbolNameIndex(symbols) {
    const index = new Map();
    for (const symbol of symbols) {
        const bucket = index.get(symbol.name);
        if (bucket)
            bucket.push(symbol);
        else
            index.set(symbol.name, [symbol]);
    }
    return index;
}
/**
 * Precedence: (a) same file, (b) file imported by this file — for Go, also
 * same-directory files, and for Java, also same-package files (Java package
 * visibility spans every file whose `package` declaration matches, with no
 * import statement needed) — since a package/directory can hold several
 * same-named candidates, disambiguate in order: imported file, same
 * package, same directory — (c) unique repo-wide name match.
 */
export function resolveRefTarget(name, fromFile, importedFiles, ctx) {
    const rawByName = ctx.symbolsByName?.get(name) ?? ctx.indexedSymbols.filter((s) => s.name === name);
    const byName = preferTypeOverOwnConstructor(rawByName);
    const sameFile = byName.filter((s) => s.filePath === fromFile);
    if (sameFile.length > 0)
        return sameFile[0]?.nodeId;
    const sameDirBonus = ctx.language === 'go' ? dirOf(fromFile) : undefined;
    const samePackageBonus = ctx.language === 'java' ? ctx.packageName : undefined;
    const inImported = byName.filter((s) => importedFiles.has(s.filePath) ||
        (sameDirBonus !== undefined && dirOf(s.filePath) === sameDirBonus) ||
        (samePackageBonus !== undefined && ctx.packageNameByFile?.get(s.filePath) === samePackageBonus));
    if (inImported.length === 1)
        return inImported[0]?.nodeId;
    if (inImported.length > 1)
        return pickAmongCandidates(inImported, fromFile, importedFiles, samePackageBonus, ctx.packageNameByFile)?.nodeId;
    // Repo-wide match: prefer the in-memory run index (full runs cover the whole
    // repo); fall back to the store only when this run didn't see the name at all
    // (incremental syncs, where the target lives in an unchanged file).
    if (byName.length === 1)
        return byName[0]?.nodeId;
    if (byName.length > 1)
        return pickBySameDirectory(byName, fromFile)?.nodeId;
    const stored = ctx.store.findNodesByName(name, { kinds: ['symbol'], limit: 50 });
    const candidates = stored.filter((n) => n.filePath !== undefined);
    if (candidates.length === 1)
        return candidates[0]?.id;
    if (candidates.length > 1) {
        const picked = pickBySameDirectoryNodes(candidates, fromFile);
        return picked?.id;
    }
    return undefined;
}
/**
 * Disambiguate among several same-named candidates already known to be
 * "in scope" (imported, same package, or same dir): prefer an actually
 * imported file first, then same-package, then same-directory.
 */
function pickAmongCandidates(symbols, fromFile, importedFiles, samePackageBonus, packageNameByFile) {
    const imported = symbols.filter((s) => importedFiles.has(s.filePath));
    if (imported.length === 1)
        return imported[0];
    if (samePackageBonus !== undefined && packageNameByFile) {
        const samePackage = symbols.filter((s) => packageNameByFile.get(s.filePath) === samePackageBonus);
        if (samePackage.length === 1)
            return samePackage[0];
    }
    return pickBySameDirectory(symbols, fromFile);
}
const TYPE_DECL_KINDS = new Set(['class', 'interface', 'enum', 'struct', 'trait']);
/**
 * Collapse a same-name, same-file collision between a type declaration and
 * its own constructor method (Java: `class Foo { Foo() {...} }` extracts two
 * symbols both named "Foo") down to the type declaration. Without this, a
 * bare reference like `new Foo()` sees two candidates in what should be a
 * single-match file and falls through to "ambiguous" instead of resolving.
 * Only applies when kind info is available (kind is optional on
 * IndexedSymbolRef in older/other call sites) and only drops the method
 * when a type-decl sibling of the same name exists in the same file.
 */
function preferTypeOverOwnConstructor(symbols) {
    const typeDeclFiles = new Set(symbols.filter((s) => s.kind && TYPE_DECL_KINDS.has(s.kind)).map((s) => s.filePath));
    if (typeDeclFiles.size === 0)
        return symbols;
    return symbols.filter((s) => s.kind !== 'method' || !typeDeclFiles.has(s.filePath));
}
function dirOf(path) {
    const idx = path.lastIndexOf('/');
    return idx === -1 ? '' : path.slice(0, idx);
}
function pickBySameDirectory(symbols, fromFile) {
    const fromDir = dirOf(fromFile);
    const sameDir = symbols.filter((s) => dirOf(s.filePath) === fromDir);
    return sameDir.length === 1 ? sameDir[0] : undefined;
}
function pickBySameDirectoryNodes(nodes, fromFile) {
    const fromDir = dirOf(fromFile);
    const sameDir = nodes.filter((n) => dirOf(n.filePath) === fromDir);
    return sameDir.length === 1 ? sameDir[0] : undefined;
}
