import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { migrate } from "../src/db/migrate.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";

it("installs Chat last on a fresh database, after the upstream resume-rotation schema", () => {
  const db = new Database(":memory:");
  try {
    db.pragma("foreign_keys = ON");
    migrate(db, ALL_MIGRATIONS);
    const names = (db.prepare("SELECT name FROM schema_migrations ORDER BY rowid").all() as { name: string }[]).map(row => row.name);
    expect(names.slice(-2)).toEqual(["101_claude_resume_rotation.sql", "102_native_chat_requests.sql"]);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='native_chat_requests_node'").get()).toBeDefined();
    expect(db.prepare("SELECT * FROM native_chat_requests").all()).toEqual([]);
    migrate(db, ALL_MIGRATIONS);
    expect(db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()).toEqual({ count: names.length });
  } finally { db.close(); }
});

it("adds only Chat to a 0.6.10 database while preserving the native session and topology", () => {
  const db = new Database(":memory:");
  try {
    db.pragma("foreign_keys = ON");
    const upstream = ALL_MIGRATIONS.filter(migration => !migration.name.includes("_native_chat_requests"));
    migrate(db, upstream);
    expect(db.prepare("SELECT name FROM schema_migrations ORDER BY rowid DESC LIMIT 1").get()).toEqual({ name: "101_claude_resume_rotation.sql" });
    const repo = new RigRepository(db), rig = repo.createRig("upgrade-fixture");
    const node = repo.addNode(rig.id, "owner", { runtime: "claude-code" });
    const session = new SessionRegistry(db).registerSession(node.id, "owner@upgrade-fixture");
    db.prepare("UPDATE sessions SET status='running',resume_type='claude_id',resume_token=?,resume_launch_token=?,resume_rotated_from=?,resume_rotated_process=? WHERE id=?")
      .run("fixture-current", "fixture-launch", "fixture-launch", "fixture-process", session.id);
    const snapshot = () => ["rigs", "nodes", "sessions", "occupant_tenures"].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
    const before = snapshot();
    const names = db.prepare("SELECT * FROM schema_migrations ORDER BY rowid").all();
    migrate(db, ALL_MIGRATIONS);
    expect(snapshot()).toEqual(before);
    const after = db.prepare("SELECT * FROM schema_migrations ORDER BY rowid").all();
    expect(after.slice(0, -1)).toEqual(names);
    expect(after.at(-1)).toMatchObject({ name: "102_native_chat_requests.sql" });
    db.prepare("INSERT INTO native_chat_requests VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run("fixture-request", node.id, "fixture-owner", "fixture-current", "message", "fixture message", "submitted", "fixture receipt", 1, null, null, "fixture-time", "fixture-time");
    migrate(db, ALL_MIGRATIONS);
    expect(db.prepare("SELECT request_id,state FROM native_chat_requests").all()).toEqual([{ request_id: "fixture-request", state: "submitted" }]);
  } finally { db.close(); }
});
