// Live graph sync: after the agent writes or edits a file, re-index just that
// one file so every subsequent graph_* query and reliability guard reflects the
// agent's own change — not the stale index from session start.
//
// PATH INVARIANT: relPath is always the repo-relative, forward-slash path the
// tool received (record.path), matching exactly what insertFileGraph wrote to
// nodes.file_path. Never pass a resolveInRoot-resolved absolute path here, or
// nodesForFile/deleteFileGraph exact-match lookups will silently miss.
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { hashContent } from '../index/hash.js';
import { languageForPath } from '../index/languages.js';
import { collectIndexedSymbols, insertFileGraph, parseFiles, reresolvePendingRefsForNames, resolveFileEdges, } from '../index/indexer.js';
import { buildJavaPackageIndex, buildSymbolNameIndex } from '../index/resolve.js';
const INBOUND_REF_KINDS = "('calls','references','extends','implements')";
/** Re-index one file into the store. Never throws — a failure yields a skipped result. */
export async function reindexFile(store, config, relPath) {
    const startedAt = Date.now();
    const skip = (reason) => ({
        synced: false,
        skippedReason: reason,
        repoId: -1,
        path: relPath,
        addedSymbols: [],
        removedSymbols: [],
        edgesAdded: 0,
        newlyDanglingRefCount: 0,
        priorInboundCallerFiles: [],
        durationMs: Date.now() - startedAt,
    });
    if (!config.liveGraphSync)
        return skip('liveGraphSync disabled');
    const repo = store.getRepoByRoot(config.root);
    if (!repo)
        return skip('repo not indexed yet — run a full index first');
    if (!languageForPath(relPath))
        return skip(`unsupported language for ${relPath}`);
    const absPath = join(config.root, relPath);
    let source;
    let mtime;
    try {
        source = await readFile(absPath);
        mtime = Math.trunc((await stat(absPath)).mtimeMs);
    }
    catch {
        return reindexDeletedFile(store, repo.id, relPath, startedAt);
    }
    const priorSymbolNames = new Set(store.nodesForFile(repo.id, relPath).filter((n) => n.kind === 'symbol').map((n) => n.name));
    const fileToIndex = {
        scanned: { path: relPath, absPath, size: source.length, mtime },
        hash: hashContent(source),
    };
    let parsedList;
    try {
        parsedList = await parseFiles([fileToIndex]);
    }
    catch (error) {
        return skip(`parse failed: ${errText(error)}`);
    }
    const parsed = parsedList[0];
    if (!parsed)
        return skip(`unsupported or unparseable: ${relPath}`);
    let insertedFile;
    let edgesAdded = 0;
    let danglingCount = 0;
    let priorInboundCallerFiles = [];
    try {
        store.transaction(() => {
            // Snapshot inbound callers BEFORE any delete — the only point the
            // pre-edit reference state is observable.
            const priorRows = store.raw(`SELECT DISTINCT e.src AS src, n2.file_path AS file_path
         FROM edges e
         JOIN nodes n ON n.id = e.dst
         JOIN nodes n2 ON n2.id = e.src
         WHERE n.repo_id = ? AND n.file_path = ? AND n.kind = 'symbol'
           AND e.kind IN ${INBOUND_REF_KINDS}`, [repo.id, relPath]);
            // Intra-file callers (file_path === relPath) are deleted and reinserted
            // with fresh node ids on every reindex, so their edge is always faithfully
            // recreated by resolveFileEdges under a new id — comparing old-vs-new ids
            // for them would count a renumbered-but-intact edge as "dangling" on every
            // edit. Only CROSS-file callers can be left genuinely dangling, so scope
            // the dangling diff to them (matching priorInboundCallerFiles' own filter).
            const priorInboundSrcIds = priorRows
                .filter((r) => r.file_path !== null && r.file_path !== relPath)
                .map((r) => r.src);
            priorInboundCallerFiles = [
                ...new Set(priorRows.map((r) => r.file_path).filter((p) => p !== null && p !== relPath)),
            ];
            store.deleteFileGraph(repo.id, relPath);
            insertedFile = insertFileGraph(store, repo.id, parsed);
            const indexedSymbols = collectIndexedSymbols([insertedFile]);
            const symbolsByName = buildSymbolNameIndex(indexedSymbols);
            const javaPackageNameByFile = new Map();
            if (insertedFile.language === 'java' && insertedFile.packageName) {
                javaPackageNameByFile.set(insertedFile.path, insertedFile.packageName);
            }
            const javaPackagesByName = buildJavaPackageIndex(javaPackageNameByFile);
            const allPaths = new Set(store.getFileStates(repo.id).keys());
            allPaths.add(relPath);
            const { edgeCount } = resolveFileEdges(store, repo.id, config.root, insertedFile, allPaths, indexedSymbols, symbolsByName, javaPackagesByName, javaPackageNameByFile);
            edgesAdded += edgeCount;
            const newSymbolNames = new Set(insertedFile.symbols.map((s) => s.bareName));
            // Re-resolve only pending refs whose name is one this file just added or
            // removed — scoped so a monorepo's pending tail is never rescanned.
            const namesToRescope = [...new Set([...priorSymbolNames, ...newSymbolNames])];
            edgesAdded += reresolvePendingRefsForNames(store, repo.id, namesToRescope, indexedSymbols);
            store.upsertFileState(repo.id, {
                path: relPath,
                hash: fileToIndex.hash,
                size: fileToIndex.scanned.size,
                mtime: fileToIndex.scanned.mtime,
            });
            // Dangling count: prior CROSS-file inbound callers whose edge did not
            // survive, plus pending_refs still naming a removed symbol. The new-side
            // query mirrors the prior-side scoping — it joins the source node and
            // excludes intra-file (file_path === relPath) sources — so a renumbered
            // intra-file edge is on neither side of the diff.
            const newInboundSrcIds = new Set(store.raw(`SELECT DISTINCT e.src AS src
           FROM edges e
           JOIN nodes n ON n.id = e.dst
           JOIN nodes n2 ON n2.id = e.src
           WHERE n.repo_id = ? AND n.file_path = ? AND n.kind = 'symbol'
             AND e.kind IN ${INBOUND_REF_KINDS}
             AND (n2.file_path IS NULL OR n2.file_path <> ?)`, [repo.id, relPath, relPath]).map((r) => r.src));
            const removedNames = [...priorSymbolNames].filter((name) => !newSymbolNames.has(name));
            danglingCount =
                priorInboundSrcIds.filter((id) => !newInboundSrcIds.has(id)).length +
                    countDanglingPendingRefs(store, repo.id, removedNames);
        });
    }
    catch (error) {
        return skip(`sync failed: ${errText(error)}`);
    }
    const finalFile = insertedFile;
    if (!finalFile)
        return skip('internal: no inserted file after transaction');
    const newSymbolNames = new Set(finalFile.symbols.map((s) => s.bareName));
    return {
        synced: true,
        repoId: repo.id,
        path: relPath,
        addedSymbols: [...newSymbolNames].filter((n) => !priorSymbolNames.has(n)),
        removedSymbols: [...priorSymbolNames].filter((n) => !newSymbolNames.has(n)),
        edgesAdded,
        newlyDanglingRefCount: danglingCount,
        priorInboundCallerFiles,
        durationMs: Date.now() - startedAt,
    };
}
/** A file the agent deleted (or that no longer reads): drop its graph, count now-dangling inbound refs. */
function reindexDeletedFile(store, repoId, relPath, startedAt) {
    const priorSymbolNames = new Set(store.nodesForFile(repoId, relPath).filter((n) => n.kind === 'symbol').map((n) => n.name));
    let priorInboundCallerFiles = [];
    let danglingCount = 0;
    try {
        store.transaction(() => {
            const priorRows = store.raw(`SELECT DISTINCT e.src AS src, n2.file_path AS file_path
         FROM edges e
         JOIN nodes n ON n.id = e.dst
         JOIN nodes n2 ON n2.id = e.src
         WHERE n.repo_id = ? AND n.file_path = ? AND n.kind = 'symbol'
           AND e.kind IN ${INBOUND_REF_KINDS}`, [repoId, relPath]);
            priorInboundCallerFiles = [
                ...new Set(priorRows.map((r) => r.file_path).filter((p) => p !== null && p !== relPath)),
            ];
            danglingCount = priorRows.length;
            store.deleteFileGraph(repoId, relPath);
            store.deleteFileState(repoId, relPath);
        });
    }
    catch (error) {
        return {
            synced: false,
            skippedReason: `delete-sync failed: ${errText(error)}`,
            repoId,
            path: relPath,
            addedSymbols: [],
            removedSymbols: [],
            edgesAdded: 0,
            newlyDanglingRefCount: 0,
            priorInboundCallerFiles: [],
            durationMs: Date.now() - startedAt,
        };
    }
    return {
        synced: true,
        repoId,
        path: relPath,
        addedSymbols: [],
        removedSymbols: [...priorSymbolNames],
        edgesAdded: 0,
        newlyDanglingRefCount: danglingCount,
        priorInboundCallerFiles,
        durationMs: Date.now() - startedAt,
    };
}
/** Count pending_refs that name a removed symbol — those references are now unresolvable. */
function countDanglingPendingRefs(store, repoId, removedNames) {
    if (removedNames.length === 0)
        return 0;
    const placeholders = removedNames.map(() => '?').join(',');
    const rows = store.raw(`SELECT COUNT(*) AS c FROM pending_refs WHERE repo_id = ? AND name IN (${placeholders})`, [repoId, ...removedNames]);
    return rows[0]?.c ?? 0;
}
function errText(error) {
    return error instanceof Error ? error.message : String(error);
}
