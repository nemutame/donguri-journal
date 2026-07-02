/**
 * Schema: createSchema validates the vec dimension, and migrate() is idempotent
 * and backfills `deleted_at` onto a pre-tombstone database.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import Database from "better-sqlite3";
import { load as loadSqliteVec } from "sqlite-vec";
import { createSchema, migrate } from "../src/db/schema.js";
import { type TempDir, makeTempDir } from "./helpers/tmp.js";

function columns(db: Database.Database): string[] {
  return (db.prepare("PRAGMA table_info(entries)").all() as Array<{ name: string }>).map(
    (c) => c.name,
  );
}

describe("schema", () => {
  let tmp: TempDir;
  before(() => {
    tmp = makeTempDir();
  });
  after(() => {
    tmp.cleanup();
  });

  it("createSchema rejects a non-positive dimension", () => {
    const db = new Database(":memory:");
    loadSqliteVec(db);
    assert.throws(() => createSchema(db, 0), /positive integer/);
    assert.throws(() => createSchema(db, -5), /positive integer/);
    db.close();
  });

  it("migrate() adds deleted_at to a pre-tombstone table and is idempotent", () => {
    const db = new Database(tmp.file("old.db"));
    // Simulate a v1 table with no deleted_at column.
    db.exec(`CREATE TABLE entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      body TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      content_hash TEXT NOT NULL
    );`);
    assert.ok(!columns(db).includes("deleted_at"));

    migrate(db);
    assert.ok(columns(db).includes("deleted_at"));

    // Running again must not throw or duplicate the column.
    migrate(db);
    assert.equal(columns(db).filter((c) => c === "deleted_at").length, 1);
    db.close();
  });

  it("createSchema adds entry_links to a pre-v3 database and is idempotent", () => {
    const db = new Database(tmp.file("pre-v3.db"));
    loadSqliteVec(db);
    createSchema(db, 3);
    db.exec("DROP TABLE entry_links"); // simulate a database created before v3
    createSchema(db, 3);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'entry_links'")
      .all();
    assert.equal(tables.length, 1);
    // Running again must not throw.
    createSchema(db, 3);
    db.close();
  });
});
