-- GraphCode knowledge-graph schema.
-- One SQLite database per indexed repository, stored at <repo>/.graphcode/graph.db.
-- Cross-repo workspaces federate multiple databases at the query layer.

PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
-- Wait up to 5s for a competing writer (e.g. a second `graphcode` on the same
-- repo, or the MCP daemon syncing) instead of crashing with SQLITE_BUSY.
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS repos (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  root       TEXT NOT NULL UNIQUE,
  head_sha   TEXT,
  indexed_at INTEGER
);

-- Bookkeeping for incremental sync: what we saw last time, keyed by content hash.
CREATE TABLE IF NOT EXISTS files_state (
  repo_id INTEGER NOT NULL REFERENCES repos(id),
  path    TEXT    NOT NULL,
  hash    TEXT    NOT NULL,
  size    INTEGER NOT NULL,
  mtime   INTEGER NOT NULL,
  PRIMARY KEY (repo_id, path)
);

-- Unified node space: files, symbols, commits, docs, features.
CREATE TABLE IF NOT EXISTS nodes (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id        INTEGER NOT NULL REFERENCES repos(id),
  kind           TEXT    NOT NULL,
  subkind        TEXT,
  name           TEXT    NOT NULL,
  qualified_name TEXT,
  file_path      TEXT,
  start_line     INTEGER,
  end_line       INTEGER,
  language       TEXT,
  signature      TEXT,
  doc            TEXT,
  exported       INTEGER NOT NULL DEFAULT 0,
  meta           TEXT
);

CREATE INDEX IF NOT EXISTS idx_nodes_kind_name ON nodes(kind, name);
CREATE INDEX IF NOT EXISTS idx_nodes_file      ON nodes(repo_id, file_path);
CREATE INDEX IF NOT EXISTS idx_nodes_qname     ON nodes(qualified_name);

CREATE TABLE IF NOT EXISTS edges (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id INTEGER NOT NULL REFERENCES repos(id),
  src     INTEGER NOT NULL REFERENCES nodes(id),
  dst     INTEGER NOT NULL REFERENCES nodes(id),
  kind    TEXT    NOT NULL,
  weight  REAL    NOT NULL DEFAULT 1.0,
  meta    TEXT
);

CREATE INDEX IF NOT EXISTS idx_edges_src ON edges(src, kind);
CREATE INDEX IF NOT EXISTS idx_edges_dst ON edges(dst, kind);
CREATE UNIQUE INDEX IF NOT EXISTS uq_edges ON edges(src, dst, kind);

-- Cross-file references that could not be resolved at extraction time,
-- kept so sync can re-resolve them when the target file changes.
CREATE TABLE IF NOT EXISTS pending_refs (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id  INTEGER NOT NULL REFERENCES repos(id),
  src_node INTEGER NOT NULL REFERENCES nodes(id),
  name     TEXT    NOT NULL,
  kind     TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pending_refs_name ON pending_refs(repo_id, name);
CREATE INDEX IF NOT EXISTS idx_pending_refs_src  ON pending_refs(src_node);

-- Full-text search over node names/docs. rowid mirrors nodes.id.
-- `tokens` holds camelCase/snake_case-split terms so "monotonic clock"
-- matches MonotonicClock.
CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
  name,
  qualified_name,
  tokens,
  doc,
  tokenize = "unicode61 tokenchars '_$'"
);
