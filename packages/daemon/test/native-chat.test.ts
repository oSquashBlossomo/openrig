import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import stringWidth from "string-width";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createFullTestDb } from "./helpers/test-app.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { NativeChatService } from "../src/domain/native-chat.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import { ContextUsageStore } from "../src/domain/context-usage-store.js";

const clean: Array<() => void> = [];
afterEach(() => clean.splice(0).forEach(fn => fn()));
function fixture(runtime: "codex" | "claude-code" = "codex") {
  const db = createFullTestDb(); const root = mkdtempSync(join(tmpdir(), "native-chat-"));
  clean.push(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  const repo = new RigRepository(db), registry = new SessionRegistry(db);
  const rig = repo.createRig("chat-test"); const node = repo.addNode(rig.id, "worker", { runtime, cwd: root });
  const session = registry.registerSession(node.id, "worker@chat-test");
  const token = randomUUID();
  const claude = runtime === "claude-code";
  db.prepare("UPDATE sessions SET status='running', resume_type='codex_id', resume_token=?, startup_status='ready' WHERE id=?").run(token, session.id);
  db.prepare("INSERT INTO bindings(id,node_id,tmux_session,tmux_pane) VALUES(?,?,?,?)").run(randomUUID(), node.id, session.sessionName, "%1");
  if (claude) db.prepare("UPDATE sessions SET resume_type='claude_id' WHERE id=?").run(session.id);
  const historyRoot = claude ? join(root, "projects", "test") : root;
  mkdirSync(historyRoot, { recursive: true });
  const path = join(historyRoot, `${token}.jsonl`);
  writeFileSync(path, JSON.stringify(claude ? { type: "user", sessionId: token, message: { role: "user", content: "prior" } } : { type: "session_meta", payload: { id: token } }) + "\n");
  const composer = (text: string) => claude ? `Prior answer\n────────────────────\n❯ ${text}\n────────────────────\n⏵⏵ auto mode on (shift+tab to cycle)` : `› ${text}\n\n? for shortcuts`;
  let pane = composer(claude ? "" : "Ask Codex to do anything");
  const tmux = {
    deliveryGuard: { preference: () => ({ desired: false, effective: false }) },
    operation: async (_target: string, fn: () => Promise<unknown>) => fn(),
    getPanePid: async () => 10,
    listPanes: async () => [{ id: "%1" }],
    capturePaneScreen: async () => pane,
    capturePaneObservation: vi.fn(async () => ({ snapshot: pane, cursor: { x: (() => { const line = pane.split("\n").findLast(line => /^[❯›»]/.test(line)) ?? ""; return line.includes("Ask Codex to do anything") ? 2 : stringWidth(line); })(), y: pane.split("\n").findLastIndex(line => /^[❯›»]/.test(line)), width: 80, height: 24 } })),
    sendText: vi.fn(async (_target: string, text: string, before?: () => void | Promise<void>) => { await before?.(); pane = composer(text); return { ok: true }; }),
    sendKeys: vi.fn(async (_target: string, _keys: string[], before?: () => void | Promise<void>) => { await before?.(); return { ok: true }; }),
  };
  const rows = () => [{ pid: 10, ppid: 1, pgid: 10, tpgid: 10, executableName: claude ? "claude" : "codex", command: claude ? `claude --session-id ${token} --name ${session.sessionName}` : `codex resume ${token}`, startedAt: "Sat Jan 1 12:00:00 2000" }];
  const deps = { db, sessionRegistry: registry, tmux: tmux as unknown as TmuxAdapter,
    contextUsageStore: { readCodexTranscriptPath: () => path, readSidecar: () => ({ ok: true, data: { session_id: token, session_name: session.sessionName, occupant_generation: registry.currentOccupantTenure(node.id)?.generationUuid, transcript_path: path } }) } as unknown as ContextUsageStore,
    listProcesses: rows, codexHome: root, claudeConfigDir: root, settleMs: 0 };
  const service = new NativeChatService(deps);
  return { db, root, node, token, session, path, tmux, service, deps, setPane: (value: string) => { pane = value; } };
}
it("sends once to the same owner, then observes the later native user record without claiming model completion", async () => {
  const f = fixture(), view = await f.service.read(f.node.id);
  expect(view.availability.canSend).toBe(true);
  const request = { requestId: randomUUID(), ownerKey: view.identity.ownerKey, text: "hello native" };
  expect((await f.service.send(f.node.id, request)).state).toBe("submitted");
  expect(f.tmux.sendKeys).toHaveBeenCalledWith("%1", ["Enter"], expect.any(Function));
  expect((await f.service.send(f.node.id, request)).state).toBe("submitted");
  expect(f.tmux.sendText).toHaveBeenCalledTimes(1);
  appendFileSync(f.path, JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: request.text }] } }) + "\n");
  expect((await f.service.read(f.node.id)).requests[0]!.state).toBe("observed");
  f.db.prepare("UPDATE sessions SET resume_token=? WHERE id=?").run(randomUUID(), f.session.id);
  expect((await f.service.send(f.node.id, request)).state).toBe("observed");
  await expect(f.service.send(f.node.id, { ...request, text: "different" })).rejects.toThrow(/conflict/i);
});
it.each(["› saved draft\n? for shortcuts", "Would you like to run the following command?\n› 1. Yes\n? for shortcuts", "unknown screen"])("refuses before input when the native composer is not positively empty", async pane => {
  const f = fixture(), view = await f.service.read(f.node.id); f.setPane(pane);
  expect((await f.service.send(f.node.id, { requestId: randomUUID(), ownerKey: view.identity.ownerKey, text: "hello" })).state).toBe("failed");
  expect(f.tmux.sendText).not.toHaveBeenCalled(); expect(f.tmux.sendKeys).not.toHaveBeenCalled();
});
it("does not press Enter on a question that appears after paste; receipt remains indeterminate on restart and retry", async () => {
  const f = fixture(), view = await f.service.read(f.node.id);
  f.tmux.sendText.mockImplementation(async (_target, _text, before) => { await before?.(); f.setPane("Do you want to proceed?\n› 1. Yes"); return { ok: true }; });
  const request = { requestId: randomUUID(), ownerKey: view.identity.ownerKey, text: "hello" };
  expect((await f.service.send(f.node.id, request)).state).toBe("indeterminate");
  expect(f.tmux.sendKeys).not.toHaveBeenCalled();
  expect((await new NativeChatService(f.deps).send(f.node.id, request)).state).toBe("indeterminate");
  expect(f.tmux.sendText).toHaveBeenCalledTimes(1);
});
it("treats an ambiguous paste failure as indeterminate and never retries it", async () => {
  const f = fixture(), view = await f.service.read(f.node.id);
  f.tmux.sendText.mockImplementation(async (_target, _text, before) => { await before?.(); return { ok: false }; });
  const request = { requestId: randomUUID(), ownerKey: view.identity.ownerKey, text: "hello" };
  expect((await f.service.send(f.node.id, request)).state).toBe("indeterminate");
  expect((await f.service.send(f.node.id, request)).state).toBe("indeterminate");
  expect(f.tmux.sendText).toHaveBeenCalledTimes(1);
});
it("refuses changed process identity and literal terminal controls before effects", async () => {
  const f = fixture(), view = await f.service.read(f.node.id);
  for (const text of ["/clear", " \n/model", "hello\u001b[A", "hi\rbye"]) {
    await expect(f.service.send(f.node.id, { requestId: randomUUID(), ownerKey: view.identity.ownerKey, text })).rejects.toThrow();
  }
  f.deps.listProcesses = () => [];
  const service = new NativeChatService(f.deps);
  expect((await service.send(f.node.id, { requestId: randomUUID(), ownerKey: view.identity.ownerKey, text: "hello" })).state).toBe("failed");
  expect(f.tmux.sendText).not.toHaveBeenCalled();
});
it("allows a verified fresh native owner before its first transcript exists without manufacturing an observed receipt", async () => {
  const f = fixture(), view = await f.service.read(f.node.id); rmSync(f.path);
  expect((await f.service.read(f.node.id)).history.state).toBe("unavailable");
  expect((await f.service.send(f.node.id, { requestId: randomUUID(), ownerKey: view.identity.ownerKey, text: "first message" })).state).toBe("submitted");
});
it("keeps a crash-pending UUID indeterminate rather than replaying it", async () => {
  const f = fixture(), view = await f.service.read(f.node.id), requestId = randomUUID(), now = new Date().toISOString();
  f.db.prepare("INSERT INTO native_chat_requests(request_id,node_id,owner_key,conversation_id,kind,text,state,detail,created_at,updated_at) VALUES(?,?,?,?,'message','hello','sending','pending',?,?)").run(requestId, f.node.id, view.identity.ownerKey, f.token, now, now);
  expect((await f.service.send(f.node.id, { requestId, ownerKey: view.identity.ownerKey, text: "hello" })).state).toBe("indeterminate");
  expect(f.tmux.sendText).not.toHaveBeenCalled();
});
it("refuses a same-process owner token or binding change between paste and submit", async () => {
  const f = fixture(), view = await f.service.read(f.node.id);
  f.tmux.sendText.mockImplementation(async (_target, _text, before) => { await before?.(); f.db.prepare("UPDATE bindings SET tmux_pane='%2' WHERE node_id=?").run(f.node.id); return { ok: true }; });
  expect((await f.service.send(f.node.id, { requestId: randomUUID(), ownerKey: view.identity.ownerKey, text: "hello" })).state).toBe("indeterminate");
  expect(f.tmux.sendKeys).not.toHaveBeenCalled();
});
it("only interrupts positively busy native work and never answers a picker", async () => {
  const f = fixture(), view = await f.service.read(f.node.id);
  f.setPane("• Working (2s • esc to interrupt)\n› Ask Codex to do anything\n\n? for shortcuts");
  expect((await f.service.send(f.node.id, { requestId: randomUUID(), ownerKey: view.identity.ownerKey }, "interrupt")).state).toBe("submitted");
  expect(f.tmux.sendKeys).toHaveBeenCalledWith("%1", ["Escape"], expect.any(Function));
  f.tmux.sendKeys.mockClear(); f.setPane("Do you want to proceed?\n› 1. Yes\n? for shortcuts");
  expect((await f.service.send(f.node.id, { requestId: randomUUID(), ownerKey: view.identity.ownerKey }, "interrupt")).state).toBe("failed");
  expect(f.tmux.sendKeys).not.toHaveBeenCalled();
});
it("never replays after a post-input receipt write failure", async () => {
  const f = fixture(), view = await f.service.read(f.node.id);
  // A real SQLite failure after Enter leaves the committed sending/effects marker.
  f.tmux.sendKeys.mockImplementation(async (_target, _keys, before) => {
    await before?.(); f.db.exec("CREATE TRIGGER fail_receipt_update BEFORE UPDATE OF state ON native_chat_requests BEGIN SELECT RAISE(ABORT,'receipt disk failure'); END;"); return { ok: true };
  });
  const request = { requestId: randomUUID(), ownerKey: view.identity.ownerKey, text: "hello" };
  await expect(f.service.send(f.node.id, request)).rejects.toThrow("receipt disk failure");
  expect(f.db.prepare("SELECT state,effects_started FROM native_chat_requests WHERE request_id=?").get(request.requestId)).toEqual({ state: "sending", effects_started: 1 });
  f.db.exec("DROP TRIGGER fail_receipt_update");
  expect((await new NativeChatService(f.deps).send(f.node.id, request)).state).toBe("indeterminate");
  expect(f.tmux.sendText).toHaveBeenCalledTimes(1); expect(f.tmux.sendKeys).toHaveBeenCalledTimes(1);
});
it("uses the same verified Claude auto conversation and refuses a rotated PID-record token despite old launch argv", async () => {
  const f = fixture("claude-code"), view = await f.service.read(f.node.id);
  expect(view.availability.canSend).toBe(true); expect(view.messages[0]!.text).toBe("prior");
  expect((await f.service.send(f.node.id, { requestId: randomUUID(), ownerKey: view.identity.ownerKey, text: "hello Claude" })).state).toBe("submitted");
  mkdirSync(join(f.root, "sessions"));
  writeFileSync(join(f.root, "sessions", "10.json"), JSON.stringify({ name: f.session.sessionName, sessionId: randomUUID() }));
  await expect(f.service.read(f.node.id)).rejects.toThrow(/verified/);
});
it.each(["running", "needs_input"] as const)("fresh hook %s vetoes an apparently empty composer", async state => {
  const f = fixture(), view = await f.service.read(f.node.id);
  const service = new NativeChatService({ ...f.deps, agentActivityStore: { getLatestForNode: () => ({ state }) } as never });
  expect((await service.read(f.node.id)).availability.canSend).toBe(false);
  expect((await service.send(f.node.id, { requestId: randomUUID(), ownerKey: view.identity.ownerKey, text: "hello" })).state).toBe("failed");
  expect(f.tmux.sendText).not.toHaveBeenCalled();
});
it("refuses collapsed staged pastes and human edits without Enter", async () => {
  const f = fixture("claude-code"), view = await f.service.read(f.node.id);
  f.tmux.sendText.mockImplementation(async (_target, _text, before) => { await before?.(); f.setPane("Prior answer\n────────────────────\n❯ [Pasted text #1 +2 lines]\n────────────────────\n⏵⏵ auto mode on (shift+tab to cycle)"); return { ok: true }; });
  expect((await f.service.send(f.node.id, { requestId: randomUUID(), ownerKey: view.identity.ownerKey, text: "one two three" })).state).toBe("indeterminate");
  expect(f.tmux.sendKeys).not.toHaveBeenCalled();
});
it("refuses a typed empty-placeholder draft and unsupported atomic observation", async () => {
  const f = fixture(), view = await f.service.read(f.node.id);
  f.tmux.capturePaneObservation.mockImplementation(async () => ({ snapshot: "› Ask Codex to do anything\n\n? for shortcuts", cursor: { x: 25, y: 0, width: 80, height: 24 } }));
  expect((await f.service.send(f.node.id, { requestId: randomUUID(), ownerKey: view.identity.ownerKey, text: "hello" })).state).toBe("failed");
  f.tmux.capturePaneObservation.mockResolvedValue(null as never);
  expect((await f.service.read(f.node.id)).availability.canSend).toBe(false);
  expect(f.tmux.sendText).not.toHaveBeenCalled();
});
it("bounds the managed history locator without changing ordinary telemetry reads", () => {
  const f = fixture(), store = new ContextUsageStore(f.db, { stateDir: f.root });
  const path = store.getSidecarPath(f.session.sessionName); mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ session_id: f.token, transcript_path: "x".repeat(70 * 1024) }));
  expect(store.readSidecar(f.session.sessionName, 64 * 1024)).toEqual({ ok: false, reason: "parse_error" });
  expect(store.readSidecar(f.session.sessionName).ok).toBe(true);
});
it("rechecks an unsolicited draft at the actual paste callback after adapter preparation", async () => {
  const f = fixture(), view = await f.service.read(f.node.id); let written = 0;
  f.tmux.sendText.mockImplementation(async (_target, _text, before) => {
    f.setPane("› HUMAN_UNSENT_DRAFT\n\n? for shortcuts"); await before?.(); written++; return { ok: true };
  });
  const result = await f.service.send(f.node.id, { requestId: randomUUID(), ownerKey: view.identity.ownerKey, text: "hello" });
  expect(result.state).toBe("failed"); expect(written).toBe(0); expect(f.tmux.sendKeys).not.toHaveBeenCalled();
});
it("rechecks a newly appeared picker at the interrupt callback", async () => {
  const f = fixture(), view = await f.service.read(f.node.id); let written = 0;
  f.setPane("• Working (2s • esc to interrupt)\n› Ask Codex to do anything\n\n? for shortcuts");
  f.tmux.sendKeys.mockImplementation(async (_target, _keys, before) => {
    f.setPane("Do you want to proceed?\n› 1. Yes\n? for shortcuts"); await before?.(); written++; return { ok: true };
  });
  expect((await f.service.send(f.node.id, { requestId: randomUUID(), ownerKey: view.identity.ownerKey }, "interrupt")).state).toBe("failed"); expect(written).toBe(0);
});
it.each(["first\nsecond", "firstsecond "])("does not erase literal newline/space changes from staged proof (%j)", async staged => {
  const f = fixture(), view = await f.service.read(f.node.id);
  f.tmux.sendText.mockImplementation(async (_target, _text, before) => { await before?.(); f.setPane(`› ${staged}\n\n? for shortcuts`); return { ok: true }; });
  expect((await f.service.send(f.node.id, { requestId: randomUUID(), ownerKey: view.identity.ownerKey, text: "firstsecond" })).state).toBe("indeterminate");
  expect(f.tmux.sendKeys).not.toHaveBeenCalled();
});
it("does not advertise sending without the required delivery lease", async () => {
  const f = fixture(); f.tmux.deliveryGuard = undefined as never;
  expect((await f.service.read(f.node.id)).availability).toMatchObject({ state: "unavailable", canSend: false, canInterrupt: false });
});
it("submits exact Unicode prose when its rendered cells and cursor agree", async () => {
  const f = fixture(), view = await f.service.read(f.node.id);
  expect((await f.service.send(f.node.id, { requestId: randomUUID(), ownerKey: view.identity.ownerKey, text: "I’m here — café 👩🏽‍💻" })).state).toBe("submitted");
  expect(f.tmux.sendText).toHaveBeenCalledWith("%1", "I’m here — café 👩🏽‍💻", expect.any(Function));
  expect(f.tmux.sendKeys).toHaveBeenCalledWith("%1", ["Enter"], expect.any(Function));
});

// Sanitized shapes from the actual 0.161.0 / 2.1.294 isolated native screens.
const nativeClaude = (rows: string[]) => ["Claude Code v2.1.294", "Opus 5.5 with high effort · Claude Max", "", "────────────────────────────────────────────────────────────────────────────────", ...rows, "────────────────────────────────────────────────────────────────────────────────", "  ⏵⏵ auto mode on (shift+tab to cycle)"].join("\n");
it.each(["codex", "claude-code"] as const)("admits the actual padded %s empty layout and preserves literal staged trailing spaces", async runtime => {
  const f = fixture(runtime), claude = runtime === "claude-code";
  let snapshot = claude ? nativeClaude(["❯\u00a0                  "]) : "› Ask Codex to do anything              \n\n  GPT-6.1-Sol high · /tmp/chat-proof\n  ? for shortcuts   ";
  let x = 2;
  f.tmux.capturePaneObservation.mockImplementation(async () => ({ snapshot, cursor: { x, y: claude ? 4 : 0, width: 80, height: 24 } }));
  const view = await f.service.read(f.node.id);
  expect(view.availability.canSend).toBe(true);
  const text = "Hello native  ";
  f.tmux.sendText.mockImplementation(async (_target, value, before) => { await before?.(); snapshot = claude ? nativeClaude(["❯\u00a0" + value + "    "]) : "› " + value + "    \n\n  GPT-6.1-Sol high · /tmp/chat-proof\n  ? for shortcuts   "; x = 2 + stringWidth(value); return { ok: true }; });
  expect((await f.service.send(f.node.id, { requestId: randomUUID(), ownerKey: view.identity.ownerKey, text })).state).toBe("submitted");
  expect(f.tmux.sendKeys).toHaveBeenCalledWith("%1", ["Enter"], expect.any(Function));
});
it("submits the actual Claude wordwrapped ordinary paragraph with exact cursor and paint padding", async () => {
  const f = fixture("claude-code"), view = await f.service.read(f.node.id);
  const text = "CHAT_PROBE helloThis is an isolated chat rendering check. Please reply briefly without tools. I want to verify that an ordinary paragraph remains readable and reaches the same conversation without alteration.";
  f.tmux.sendText.mockImplementation(async (_target, _value, before) => { await before?.();
    f.tmux.capturePaneObservation.mockResolvedValue({ snapshot: nativeClaude([
      "❯\u00a0CHAT_PROBE helloThis is an isolated chat rendering check. Please reply        ",
      "  briefly without tools. I want to verify that an ordinary paragraph remains    ",
      "  readable and reaches the same conversation without alteration.                ",
    ]), cursor: { x: 64, y: 6, width: 80, height: 24 } }); return { ok: true };
  });
  expect((await f.service.send(f.node.id, { requestId: randomUUID(), ownerKey: view.identity.ownerKey, text })).state).toBe("submitted");
});
function freshCodexFixture() {
  const f = fixture();
  f.db.prepare("UPDATE sessions SET resume_type=NULL,resume_token=NULL WHERE id=?").run(f.session.id);
  f.deps.listProcesses = () => [{ pid: 10, ppid: 1, pgid: 10, tpgid: 10, executableName: "codex", command: "codex", startedAt: "Sat Jan 1 12:00:00 2000" }];
  const logs = new Database(join(f.root, "logs_2.sqlite"));
  logs.exec("CREATE TABLE logs(ts INTEGER,target TEXT,thread_id TEXT,process_uuid TEXT,feedback_log_body TEXT)");
  logs.prepare("INSERT INTO logs VALUES(?,?,?,?,?)").run(1000000000, "codex_core::shell_snapshot", f.token, "pid:10:" + randomUUID(), `app_server.request{rpc.method="thread/start" rpc.transport="in-process" app_server.client_name="codex-tui"}:app_server.thread_start.create_thread{otel.name="app_server.thread_start.create_thread"}:thread_spawn{otel.name="thread_spawn"}:session_init:environments.resolve{environment_id=local remote=false}:shell_snapshot{thread_id=${f.token}}: Shell snapshot successfully created: /tmp/private`);
  logs.close(); rmSync(f.path);
  return f;
}
it("derives a pristine Codex chat ID from its positive native TUI creation witness without declaring it resumable", async () => {
  const f = freshCodexFixture();
  const service = new NativeChatService(f.deps), view = await service.read(f.node.id);
  expect(view.identity.conversationId).toBe(f.token); expect(view.availability.canSend).toBe(true);
  expect(view.history.state).toBe("unavailable");
  expect((await service.send(f.node.id, { requestId: randomUUID(), ownerKey: view.identity.ownerKey, text: "first message" })).state).toBe("submitted");
  expect(f.db.prepare("SELECT resume_type,resume_token,resume_last_probe_status FROM sessions WHERE id=?").get(f.session.id)).toEqual({ resume_type: null, resume_token: null, resume_last_probe_status: null });
});
it("refuses hard newlines before any paste even when the text could look like native wordwrap", async () => {
  const f = fixture(), view = await f.service.read(f.node.id);
  await expect(f.service.send(f.node.id, { requestId: randomUUID(), ownerKey: view.identity.ownerKey, text: "first\nsecond" })).rejects.toMatchObject({ status: 400 });
  expect(f.tmux.sendText).not.toHaveBeenCalled(); expect(f.tmux.sendKeys).not.toHaveBeenCalled();
});

it.each(["claimed", "saved-disagreement", "resume-argv", "binding-race", "process-race"])("refuses a fresh Codex witness with %s", async failure => {
  const f = freshCodexFixture();
  if (failure === "claimed") f.db.prepare("UPDATE sessions SET origin='claimed' WHERE id=?").run(f.session.id);
  if (failure === "saved-disagreement") f.db.prepare("UPDATE sessions SET resume_type='codex_id',resume_token=? WHERE id=?").run(randomUUID(), f.session.id);
  const original = f.deps.listProcesses; let calls = 0;
  f.deps.listProcesses = () => {
    const rows = original(); calls++;
    if (failure === "resume-argv") rows[0]!.command = `codex resume ${f.token}`;
    if (failure === "binding-race" && calls === 3) f.db.prepare("UPDATE bindings SET tmux_pane='%2' WHERE node_id=?").run(f.node.id);
    if (failure === "process-race" && calls >= 3) rows[0]!.startedAt = "Sat Jan 1 13:00:00 2000";
    return rows;
  };
  await expect(new NativeChatService(f.deps).read(f.node.id)).rejects.toMatchObject({ code: "owner_unverified" });
  expect(f.tmux.sendText).not.toHaveBeenCalled(); expect(f.tmux.sendKeys).not.toHaveBeenCalled();
});
it("retains fresh receipt and owner identity when the normal resolver persists the same native token", async () => {
  const f = freshCodexFixture(), service = new NativeChatService(f.deps), view = await service.read(f.node.id);
  const request = { requestId: randomUUID(), ownerKey: view.identity.ownerKey, text: "first message" };
  const sent = await service.send(f.node.id, request);
  expect(sent.state).toBe("submitted"); expect(sent.detail).toMatch(/No pre-send history watermark/);
  const state = new Database(join(f.root, "state_5.sqlite"));
  state.exec("CREATE TABLE threads(id TEXT,source TEXT,rollout_path TEXT)");
  state.prepare("INSERT INTO threads VALUES(?,'cli',?)").run(f.token, f.path); state.close();
  f.db.prepare("UPDATE sessions SET resume_type='codex_id',resume_token=? WHERE id=?").run(f.token, f.session.id);
  const after = await service.read(f.node.id);
  expect(after.identity.ownerKey).toBe(view.identity.ownerKey); expect(after.requests[0]!.requestId).toBe(request.requestId);
  expect((await service.send(f.node.id, request)).state).toBe("submitted"); expect(f.tmux.sendText).toHaveBeenCalledTimes(1);
});
