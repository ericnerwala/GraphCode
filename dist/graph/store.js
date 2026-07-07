import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { splitIdentifier } from '../core/identifiers.js';
const SCHEMA_PATH = join(dirname(fileURLToPath(import.meta.url)), 'schema.sql');
function rowToNode(row) {
    return {
        id: row.id,
        repoId: row.repo_id,
        kind: row.kind,
        subkind: row.subkind ?? undefined,
        name: row.name,
        qualifiedName: row.qualified_name ?? undefined,
        filePath: row.file_path ?? undefined,
        startLine: row.start_line ?? undefined,
        endLine: row.end_line ?? undefined,
        language: row.language ?? undefined,
        signature: row.signature ?? undefined,
        doc: row.doc ?? undefined,
        exported: row.exported === 1,
        meta: row.meta ? JSON.parse(row.meta) : undefined,
    };
}
function rowToEdge(row) {
    return {
        id: row.id,
        repoId: row.repo_id,
        src: row.src,
        dst: row.dst,
        kind: row.kind,
        weight: row.weight,
        meta: row.meta ? JSON.parse(row.meta) : undefined,
    };
}
/** Escape a user query into an FTS5 MATCH expression (prefix-matched terms). */
export function toFtsQuery(input) {
    const terms = input
        .split(/[^\p{L}\p{N}_$]+/u)
        .filter((t) => t.length > 0)
        .flatMap((t) => [t, ...splitIdentifier(t)]);
    const unique = [...new Set(terms.map((t) => t.toLowerCase()))];
    if (unique.length === 0)
        return '""';
    return unique.map((t) => `"${t.replaceAll('"', '""')}"*`).join(' OR ');
}
/**
 * The GraphCode store: one SQLite database holding the full knowledge graph
 * for one repository. All writes go through this class so the FTS index and
 * graph tables never drift apart.
 */
export class GraphStore {
    db;
    dbPath;
    /** Lazy cache of prepared statements keyed by SQL text; avoids re-compiling on every call. */
    statementCache = new Map();
    constructor(db, dbPath) {
        this.db = db;
        this.dbPath = dbPath;
    }
    static open(dbPath) {
        const db = new DatabaseSync(dbPath, { allowExtension: false });
        db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
        return new GraphStore(db, dbPath);
    }
    /** Prepare-once, reuse-forever: node:sqlite recompiles SQL on every `prepare()` call otherwise. */
    stmt(sql) {
        let cached = this.statementCache.get(sql);
        if (!cached) {
            cached = this.db.prepare(sql);
            this.statementCache.set(sql, cached);
        }
        return cached;
    }
    close() {
        this.db.close();
    }
    transaction(fn) {
        this.db.exec('BEGIN');
        try {
            const result = fn();
            this.db.exec('COMMIT');
            return result;
        }
        catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
    }
    // ---- meta ----------------------------------------------------------------
    getMeta(key) {
        const row = this.stmt('SELECT value FROM meta WHERE key = ?').get(key);
        return row?.value ?? null;
    }
    setMeta(key, value) {
        this.stmt('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
    }
    // ---- repos ---------------------------------------------------------------
    upsertRepo(name, root) {
        this.stmt('INSERT INTO repos(name, root) VALUES(?, ?) ON CONFLICT(root) DO UPDATE SET name = excluded.name').run(name, root);
        const repo = this.getRepoByRoot(root);
        if (!repo)
            throw new Error(`repo upsert failed for ${root}`);
        return repo;
    }
    getRepoByRoot(root) {
        const row = this.stmt('SELECT * FROM repos WHERE root = ?').get(root);
        if (!row)
            return null;
        return { id: row.id, name: row.name, root: row.root, headSha: row.head_sha, indexedAt: row.indexed_at };
    }
    listRepos() {
        const rows = this.stmt('SELECT * FROM repos ORDER BY id').all();
        return rows.map((row) => ({
            id: row.id,
            name: row.name,
            root: row.root,
            headSha: row.head_sha,
            indexedAt: row.indexed_at,
        }));
    }
    setRepoIndexed(repoId, headSha, indexedAt) {
        this.stmt('UPDATE repos SET head_sha = ?, indexed_at = ? WHERE id = ?').run(headSha, indexedAt, repoId);
    }
    // ---- incremental sync bookkeeping -----------------------------------------
    getFileStates(repoId) {
        const rows = this.stmt('SELECT path, hash, size, mtime FROM files_state WHERE repo_id = ?').all(repoId);
        return new Map(rows.map((row) => [row.path, { path: row.path, hash: row.hash, size: row.size, mtime: row.mtime }]));
    }
    upsertFileState(repoId, state) {
        this.stmt(`INSERT INTO files_state(repo_id, path, hash, size, mtime) VALUES(?, ?, ?, ?, ?)
       ON CONFLICT(repo_id, path) DO UPDATE SET hash = excluded.hash, size = excluded.size, mtime = excluded.mtime`).run(repoId, state.path, state.hash, state.size, state.mtime);
    }
    deleteFileState(repoId, path) {
        this.stmt('DELETE FROM files_state WHERE repo_id = ? AND path = ?').run(repoId, path);
    }
    // ---- writes ----------------------------------------------------------------
    insertNode(repoId, node) {
        const result = this.stmt(`INSERT INTO nodes(repo_id, kind, subkind, name, qualified_name, file_path, start_line, end_line, language, signature, doc, exported, meta)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(repoId, node.kind, node.subkind ?? null, node.name, node.qualifiedName ?? null, node.filePath ?? null, node.startLine ?? null, node.endLine ?? null, node.language ?? null, node.signature ?? null, node.doc ?? null, node.exported ? 1 : 0, node.meta ? JSON.stringify(node.meta) : null);
        const id = Number(result.lastInsertRowid);
        this.insertFtsRow(id, node);
        return id;
    }
    insertFtsRow(id, node) {
        const tokens = splitIdentifier(node.name).join(' ');
        this.stmt('INSERT INTO nodes_fts(rowid, name, qualified_name, tokens, doc) VALUES(?, ?, ?, ?, ?)').run(id, node.name, node.qualifiedName ?? '', tokens, node.doc ?? '');
    }
    insertEdge(repoId, edge) {
        this.stmt(`INSERT INTO edges(repo_id, src, dst, kind, weight, meta) VALUES(?, ?, ?, ?, ?, ?)
       ON CONFLICT(src, dst, kind) DO UPDATE SET weight = excluded.weight, meta = excluded.meta`).run(repoId, edge.src, edge.dst, edge.kind, edge.weight ?? 1.0, edge.meta ? JSON.stringify(edge.meta) : null);
    }
    insertEdges(repoId, edges) {
        for (const edge of edges)
            this.insertEdge(repoId, edge);
    }
    addPendingRef(repoId, ref) {
        this.stmt('INSERT INTO pending_refs(repo_id, src_node, name, kind) VALUES(?, ?, ?, ?)').run(repoId, ref.srcNode, ref.name, ref.kind);
    }
    pendingRefsByName(repoId, name) {
        const rows = this.stmt('SELECT src_node, name, kind FROM pending_refs WHERE repo_id = ? AND name = ?').all(repoId, name);
        return rows.map((row) => ({ srcNode: row.src_node, name: row.name, kind: row.kind }));
    }
    /** Remove a file's nodes, their edges, FTS rows, and pending refs. */
    deleteFileGraph(repoId, path) {
        const rows = this.stmt('SELECT id FROM nodes WHERE repo_id = ? AND file_path = ?').all(repoId, path);
        if (rows.length === 0)
            return;
        const ids = rows.map((row) => row.id);
        this.deleteNodesAndDependents(ids);
    }
    /** Remove all nodes of a kind (used to rebuild the git/doc/feature layers). */
    deleteNodesByKind(repoId, kind) {
        const rows = this.stmt('SELECT id FROM nodes WHERE repo_id = ? AND kind = ?').all(repoId, kind);
        if (rows.length === 0)
            return;
        for (let i = 0; i < rows.length; i += 500) {
            this.deleteNodesAndDependents(rows.slice(i, i + 500).map((row) => row.id));
        }
    }
    /** Delete edges/pending_refs/FTS rows/nodes for a batch of node ids, sharing one prepared statement per fixed batch size. */
    deleteNodesAndDependents(ids) {
        const placeholders = ids.map(() => '?').join(',');
        const params = ids;
        this.stmt(`DELETE FROM edges WHERE src IN (${placeholders}) OR dst IN (${placeholders})`).run(...params, ...params);
        this.stmt(`DELETE FROM pending_refs WHERE src_node IN (${placeholders})`).run(...params);
        this.stmt(`DELETE FROM nodes_fts WHERE rowid IN (${placeholders})`).run(...params);
        this.stmt(`DELETE FROM nodes WHERE id IN (${placeholders})`).run(...params);
    }
    // ---- reads -----------------------------------------------------------------
    getNode(id) {
        const row = this.stmt('SELECT * FROM nodes WHERE id = ?').get(id);
        return row ? rowToNode(row) : null;
    }
    findNodesByName(name, options = {}) {
        const kinds = options.kinds ?? [];
        const kindFilter = kinds.length > 0 ? `AND kind IN (${kinds.map(() => '?').join(',')})` : '';
        // A single `name = ? OR qualified_name = ?` predicate defeats SQLite's index
        // selection (it falls back to a full scan of the kind-filtered rows). Splitting
        // into a UNION lets each branch use its own index (idx_nodes_kind_name / idx_nodes_qname).
        const rows = this.stmt(`SELECT * FROM nodes WHERE name = ? ${kindFilter}
       UNION
       SELECT * FROM nodes WHERE qualified_name = ? ${kindFilter}
       LIMIT ?`).all(name, ...kinds, name, ...kinds, options.limit ?? 50);
        return rows.map(rowToNode);
    }
    nodesForFile(repoId, path) {
        const rows = this.stmt('SELECT * FROM nodes WHERE repo_id = ? AND file_path = ? ORDER BY start_line').all(repoId, path);
        return rows.map(rowToNode);
    }
    fileNode(repoId, path) {
        const row = this.stmt("SELECT * FROM nodes WHERE repo_id = ? AND kind = 'file' AND file_path = ?").get(repoId, path);
        return row ? rowToNode(row) : null;
    }
    search(query, options = {}) {
        const kinds = options.kinds ?? [];
        const kindFilter = kinds.length > 0 ? `AND n.kind IN (${kinds.map(() => '?').join(',')})` : '';
        const rows = this.stmt(`SELECT n.*, bm25(nodes_fts, 10.0, 5.0, 8.0, 1.0) AS score
       FROM nodes_fts f JOIN nodes n ON n.id = f.rowid
       WHERE nodes_fts MATCH ? ${kindFilter}
       ORDER BY score LIMIT ?`).all(toFtsQuery(query), ...kinds, options.limit ?? 20);
        // bm25() returns lower-is-better; invert so callers sort descending.
        return rows.map((row) => ({ node: rowToNode(row), score: -row.score }));
    }
    neighbors(nodeId, options = {}) {
        const direction = options.direction ?? 'both';
        const kinds = options.kinds ?? [];
        const kindFilter = kinds.length > 0 ? `AND e.kind IN (${kinds.map(() => '?').join(',')})` : '';
        // Generous default: a hub symbol can have thousands of callers, and silently
        // capping at a small number would understate impact/traverse results. Callers
        // that want a tighter bound pass an explicit limit.
        const limit = options.limit ?? 100_000;
        const collected = [];
        if (direction === 'out' || direction === 'both') {
            const rows = this.stmt(`SELECT e.*, n.id AS n_id FROM edges e JOIN nodes n ON n.id = e.dst WHERE e.src = ? ${kindFilter} LIMIT ?`).all(nodeId, ...kinds, limit);
            for (const row of rows) {
                const node = this.getNode(row.n_id);
                if (node)
                    collected.push({ node, edge: rowToEdge(row), direction: 'out' });
            }
        }
        if (direction === 'in' || direction === 'both') {
            const rows = this.stmt(`SELECT e.*, n.id AS n_id FROM edges e JOIN nodes n ON n.id = e.src WHERE e.dst = ? ${kindFilter} LIMIT ?`).all(nodeId, ...kinds, limit);
            for (const row of rows) {
                const node = this.getNode(row.n_id);
                if (node)
                    collected.push({ node, edge: rowToEdge(row), direction: 'in' });
            }
        }
        return collected;
    }
    stats() {
        const count = (sql) => {
            const row = this.stmt(sql).get();
            return row.c;
        };
        const kindRows = this.stmt('SELECT kind, COUNT(*) AS c FROM edges GROUP BY kind').all();
        const langRows = this.stmt("SELECT language, COUNT(*) AS c FROM nodes WHERE kind = 'file' AND language IS NOT NULL GROUP BY language").all();
        return {
            repos: count('SELECT COUNT(*) AS c FROM repos'),
            files: count("SELECT COUNT(*) AS c FROM nodes WHERE kind = 'file'"),
            symbols: count("SELECT COUNT(*) AS c FROM nodes WHERE kind = 'symbol'"),
            commits: count("SELECT COUNT(*) AS c FROM nodes WHERE kind = 'commit'"),
            docs: count("SELECT COUNT(*) AS c FROM nodes WHERE kind = 'doc'"),
            features: count("SELECT COUNT(*) AS c FROM nodes WHERE kind = 'feature'"),
            edges: count('SELECT COUNT(*) AS c FROM edges'),
            edgesByKind: Object.fromEntries(kindRows.map((row) => [row.kind, row.c])),
            languages: Object.fromEntries(langRows.map((row) => [row.language, row.c])),
        };
    }
    /** Escape hatch for the query layer. Read-only by convention. */
    raw(sql, params = []) {
        return this.stmt(sql).all(...params);
    }
}
