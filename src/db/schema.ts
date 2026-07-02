/**
 * Database schema.
 *
 * Two layers:
 *  - `entries` keeps the indexed text (`body`) plus a pointer to the verbatim
 *    original (`original_ref`). Extraction is lossy and non-final, so
 *    `extraction_state` records how `body` was produced for later re-extraction.
 *  - `vec_entries` is a disposable, rebuildable vector index (sqlite-vec vec0),
 *    keyed by `rowid = entries.id`.
 *
 * `entry_links` holds typed relations between entries (DESIGN §6). Links
 * always point new → old (`from_id` is the later entry), so relating entries
 * never mutates the past; rows are append-only.
 *
 * `embedding_meta` records the active model/dim so a backend switch can be
 * detected. `schema_meta` holds the schema version.
 */
import type Database from "better-sqlite3";

export const SCHEMA_VERSION = 3;

export function createSchema(db: Database.Database, dim: number): void {
  if (!Number.isInteger(dim) || dim <= 0) {
    throw new Error(`Embedding dimension must be a positive integer, got: ${dim}`);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      body TEXT NOT NULL,
      source_kind TEXT NOT NULL DEFAULT 'text',
      original_ref TEXT,
      extraction_state TEXT NOT NULL DEFAULT 'verbatim',
      tags TEXT NOT NULL DEFAULT '[]',
      meta TEXT NOT NULL DEFAULT '{}',
      occurred_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      deleted_at TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_entries_content_hash ON entries(content_hash);
    CREATE INDEX IF NOT EXISTS idx_entries_created_at ON entries(created_at);
    CREATE INDEX IF NOT EXISTS idx_entries_occurred_at ON entries(occurred_at);
    CREATE INDEX IF NOT EXISTS idx_entries_source_kind ON entries(source_kind);

    CREATE TABLE IF NOT EXISTS entry_links (
      from_id INTEGER NOT NULL,
      rel TEXT NOT NULL,
      to_id INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      CHECK (from_id != to_id),
      PRIMARY KEY (from_id, rel, to_id)
    );

    CREATE INDEX IF NOT EXISTS idx_entry_links_to ON entry_links(to_id);

    CREATE TABLE IF NOT EXISTS schema_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS embedding_meta (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      model_id TEXT NOT NULL,
      dim INTEGER NOT NULL
    );
  `);

  // `dim` is validated as a positive integer above, so it is safe to inline.
  // The dimension of a vec0 column is fixed at creation time.
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_entries USING vec0(embedding float[${dim}]);`);
}

/**
 * Apply idempotent migrations for databases created by an older schema.
 * Safe to run on every startup.
 */
export function migrate(db: Database.Database): void {
  const columns = db.prepare("PRAGMA table_info(entries)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "deleted_at")) {
    db.exec("ALTER TABLE entries ADD COLUMN deleted_at TEXT");
  }
  // Created here (not in createSchema) so it runs after the column is guaranteed.
  db.exec("CREATE INDEX IF NOT EXISTS idx_entries_deleted_at ON entries(deleted_at)");
}
