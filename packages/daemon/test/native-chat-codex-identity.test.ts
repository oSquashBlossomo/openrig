import { afterEach, expect, it } from "vitest";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFreshCodexChatThread } from "../src/domain/native-chat-codex-identity.js";
import { lstartToMinTs } from "../src/domain/codex-thread-id.js";
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
const start = "Sat Jan 1 12:00:00 2000";
function setup() {
  const root = mkdtempSync(join(tmpdir(), "chat-codex-identity-")); roots.push(root);
  const db = new Database(join(root, "logs_2.sqlite"));
  db.exec("CREATE TABLE logs(ts INTEGER,target TEXT,thread_id TEXT,process_uuid TEXT,feedback_log_body TEXT)");
  const token = randomUUID(), process = `pid:10:${randomUUID()}`;
  const body = `app_server.request{otel.kind="server" rpc.method="thread/start" rpc.transport="in-process" app_server.client_name="codex-tui" app_server.client_version="0.161.0"}:app_server.thread_start.create_thread{otel.name="app_server.thread_start.create_thread"}:thread_spawn{otel.name="thread_spawn"}:session_init:environments.resolve{environment_id=local remote=false configuration_pending=false}:shell_snapshot{thread_id=${token}}: Shell snapshot successfully created: /tmp/private`;
  const row = { ts: lstartToMinTs(start)! + 4, target: "codex_core::shell_snapshot", token, process, body };
  function insert(patch: Partial<typeof row> = {}) { const r = { ...row, ...patch }; db.prepare("INSERT INTO logs VALUES(?,?,?,?,?)").run(r.ts, r.target, r.token, r.process, r.body); }
  return { root, db, token, process, body, row, insert, read: () => readFreshCodexChatThread(10, start, root) };
}
it("reads only the explicit current TUI creation witness, ignoring title and generic PID log IDs", () => {
  const f = setup(); f.insert(); f.insert({ token: randomUUID(), body: "native title generation" }); f.db.close();
  expect(f.read()).toBe(f.token);
});
it.each(["old-second", "wrong-pid", "wrong-target", "other-client", "external-transport", "resume", "unstructured", "mismatched-id", "oversized", "missing-init"])("refuses %s without inventing a current chat ID", variant => {
  const f = setup();
  const patch: Partial<typeof f.row> = variant === "old-second" ? { ts: lstartToMinTs(start)! }
    : variant === "wrong-pid" ? { process: `pid:11:${randomUUID()}` }
    : variant === "wrong-target" ? { target: "other" }
    : variant === "other-client" ? { body: f.body.replace('"codex-tui"', '"codex-exec"') }
    : variant === "external-transport" ? { body: f.body.replace('"in-process"', '"websocket"') }
    : variant === "resume" ? { body: f.body.replace('"thread/start"', '"thread/resume"') }
    : variant === "unstructured" ? { body: "Please use thread " + f.token }
    : variant === "mismatched-id" ? { token: randomUUID() }
    : variant === "oversized" ? { body: f.body + "x".repeat(8193) }
    : { body: f.body.replace(":session_init:", ":other:") };
  f.insert(patch); f.db.close(); expect(f.read()).toBeUndefined();
});
it.each(["two-threads", "two-process-generations", "too-many-rows"])("refuses %s instead of selecting the newest event", variant => {
  const f = setup(); f.insert(); const other = randomUUID();
  if (variant === "two-threads") f.insert({ token: other, body: f.body.replaceAll(f.token, other) });
  else if (variant === "two-process-generations") f.insert({ process: `pid:10:${randomUUID()}` });
  else for (let i = 0; i < 64; i++) f.insert();
  f.db.close(); expect(f.read()).toBeUndefined();
});
it("requires a parseable process start identity and never creates missing native state", () => {
  const f = setup(); f.insert(); f.db.close();
  expect(readFreshCodexChatThread(10, undefined, f.root)).toBeUndefined();
  expect(readFreshCodexChatThread(10, "unknown", f.root)).toBeUndefined();
  expect(readFreshCodexChatThread(0, start, f.root)).toBeUndefined();
  expect(readFreshCodexChatThread(10, start, join(f.root, "missing"))).toBeUndefined();
});
