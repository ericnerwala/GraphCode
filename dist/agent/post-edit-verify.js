// Post-edit graph verification (Lever 2). After a write/edit is applied and the
// file is live-synced, surface graph-level consistency problems the edit may
// have introduced: callers left stale by a removed/renamed symbol, references
// elsewhere now pointing at nothing, and imports the edit couldn't resolve.
//
// Consumes the ReindexResult from graph-sync.ts — in particular its pre-delete
// snapshot — so it never re-queries the store for state the sync already
// captured. Never throws; returns [] when there's nothing to report.
const MAX_FINDINGS = 8;
/**
 * Verify one edited file's graph neighborhood. Requires postEditVerify AND a
 * successful sync (a ReindexResult with synced === true) — otherwise there's no
 * reliable before/after picture to reason about, so it returns [].
 */
export function verifyEditedFile(store, config, path, sync) {
    if (!config.postEditVerify || !sync.synced)
        return [];
    try {
        const findings = [
            ...checkStaleCallers(sync),
            ...checkDanglingPendingRefs(sync),
            ...checkUnresolvedImports(store, sync),
        ];
        // Sort by severity (stable secondary by filePath) so a truncation never
        // buries a high-severity stale_caller behind low-severity noise; append an
        // explicit "+N suppressed" tail so nothing is silently dropped. The tail
        // carries the HIGHEST suppressed severity — otherwise the completion gate's
        // severity floor could not tell that unresolved high-severity issues remain
        // beyond the cap.
        const sorted = [...findings].sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || (a.filePath ?? '').localeCompare(b.filePath ?? ''));
        if (sorted.length <= MAX_FINDINGS)
            return sorted;
        const shown = sorted.slice(0, MAX_FINDINGS);
        const suppressed = sorted.slice(MAX_FINDINGS);
        const topSuppressedSeverity = suppressed[0]?.severity ?? 'low';
        return [
            ...shown,
            {
                kind: 'dangling_reference',
                severity: topSuppressedSeverity,
                message: `(+${suppressed.length} more ${topSuppressedSeverity}-or-lower finding(s) suppressed — resolve the above and re-check)`,
            },
        ];
    }
    catch {
        return [];
    }
}
function severityRank(s) {
    return s === 'high' ? 2 : s === 'medium' ? 1 : 0;
}
/** Files that previously called/referenced a symbol this edit removed or renamed — likely now broken. */
function checkStaleCallers(sync) {
    if (sync.removedSymbols.length === 0 || sync.priorInboundCallerFiles.length === 0)
        return [];
    const removed = sync.removedSymbols.join(', ');
    return sync.priorInboundCallerFiles
        .filter((f) => f !== sync.path)
        .map((f) => ({
        kind: 'stale_caller',
        severity: 'high',
        filePath: f,
        message: `${f} previously referenced symbol(s) removed or renamed in ${sync.path} (${removed}) — verify it still compiles`,
    }));
}
/** References elsewhere in the repo that now resolve to nothing (exact count from the sync snapshot). */
function checkDanglingPendingRefs(sync) {
    if (sync.newlyDanglingRefCount === 0)
        return [];
    return [
        {
            kind: 'dangling_reference',
            severity: 'medium',
            message: `${sync.newlyDanglingRefCount} reference(s) elsewhere in the repo point to symbol(s) removed from ${sync.path} and no longer resolve`,
        },
    ];
}
/** Imports the edit introduced that resolveFileEdges couldn't map to a repo file (left in pending_refs). */
function checkUnresolvedImports(store, sync) {
    const rows = store.raw(`SELECT DISTINCT name FROM pending_refs
     WHERE repo_id = ? AND kind = 'imports'
       AND src_node IN (SELECT id FROM nodes WHERE repo_id = ? AND file_path = ?)`, [sync.repoId, sync.repoId, sync.path]);
    if (rows.length === 0)
        return [];
    const sample = rows.slice(0, 5).map((r) => r.name).join(', ');
    return [
        {
            kind: 'unresolved_import',
            severity: 'medium',
            message: `${rows.length} import(s) in ${sync.path} did not resolve to a file in the repo (${sample})`,
        },
    ];
}
/** Render findings into the "[verify] …" block appended to the tool_result. */
export function renderFindings(findings) {
    if (findings.length === 0)
        return '';
    return ['[verify]', ...findings.map((f) => `  - (${f.severity}) ${f.message}`)].join('\n');
}
