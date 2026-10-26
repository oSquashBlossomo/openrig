import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { operationalLaunchArgs } from "../src/adapters/kernel-authority.js";
import type Database from "better-sqlite3";
import { Hono } from "hono";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { SeatAttentionReconciler, rebindAndVerifyPaneIdentity } from "../src/domain/seat-attention-reconciler.js";
import { SeatIdentityReconciler } from "../src/domain/seat-identity-reconciler.js";
import { SeatIdentityStore } from "../src/domain/seat-identity-store.js";
import { verifyClaudePaneProcess, type NativeProcessRow } from "../src/domain/native-process-lineage.js";
import { sessionAdminRoutes } from "../src/routes/sessions.js";
import { resolveIdentityVerifiedClaudeRecord } from "../src/domain/model-divergence/current-generation-record.js";

// Same foreground/OS/argv specimen as the #197 diagnosis. These are process
// observations, not a provider, a conversation, or evidence of input consumption.
const startedAt = "Fri Oct  2 20:00:00 2026";
const root = { pid: 100, ppid: 1, pgid: 100, tpgid: 100, command: "/bin/bash wrapper.sh", executableName: "bash", startedAt };
const child = { pid: 101, ppid: 100, pgid: 100, tpgid: 100, command: "/tmp/review/.local/share/claude/versions/2.1.1 --session-id review-token", executableName: "2.1.1", startedAt };
const databases: Database.Database[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  vi.unstubAllEnvs();
  for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fixture(token: string | null = null) {
  const db = createFullTestDb(); databases.push(db);
  const repo = new RigRepository(db), registry = new SessionRegistry(db), bus = new EventBus(db);
  const activity = new AgentActivityStore({ db, eventBus: bus }), store = new SeatIdentityStore(db);
  const rig = repo.createRig("review197"), name = "worker@review197", pane = "%197";
  const node = repo.addNode(rig.id, "worker", { role: "worker", runtime: "claude-code" });
  const session = registry.registerSession(node.id, name);
  registry.updateStatus(session.id, "running");
  registry.updateStartupStatus(session.id, "attention_required");
  db.prepare("UPDATE sessions SET resume_token = ? WHERE id = ?").run(token, session.id);
  registry.updateBinding(node.id, { tmuxSession: name, tmuxPane: pane });
  store.upsert({ nodeId: node.id, verdict: "mismatch", evidenceSource: "pane_process", reason: "process_identity_mismatch",
    evidence: { registeredPane: pane, observedPid: 100, observedCommand: "bash", matchedLayer: null }, sessionName: name, observedAt: new Date().toISOString() });
  const tmux = {
    listSessions: vi.fn(async () => [{ name }] as never),
    listPanes: vi.fn(async () => [{ id: pane }] as never),
    getPanePid: vi.fn(async (): Promise<number | null> => 100),
    getPaneCommand: vi.fn(async (): Promise<string | null> => "bash"),
  };
  const listProcesses = vi.fn(async (): Promise<NativeProcessRow[]> => [root, child]);
  const sendVerify = vi.fn(async () => { throw new Error("no input allowed"); });
  const deps = { db, sessionRegistry: registry, eventBus: bus, agentActivityStore: activity, tmux, listProcesses, sendVerify };
  const clear = new SeatAttentionReconciler(deps);
  const poll = new SeatIdentityReconciler({ db, tmux, listProcesses });
  const app = new Hono();
  app.use("*", async (c, next) => { c.set("seatAttentionReconciler" as never, clear as never); c.set("terminalBearerToken" as never, "fixture" as never); await next(); });
  app.route("/api/sessions", sessionAdminRoutes);
  const post = async () => {
    const response = await app.request(`/api/sessions/${encodeURIComponent(name)}/clear-attention`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer fixture" }, body: "{}",
    });
    return { status: response.status, body: await response.json() };
  };
  const verify = (strict = false) => rebindAndVerifyPaneIdentity({ db, sessionRegistry: registry, tmux, nodeId: node.id,
    sessionName: name, runtime: "claude-code", expectedResumeToken: token, requireExactResumeLineage: strict, listProcesses });
  const startup = () => (db.prepare("SELECT startup_status FROM sessions WHERE id = ?").get(session.id) as { startup_status: string }).startup_status;
  return { db, registry, bus, rig, node, session, name, pane, tmux, listProcesses, sendVerify, clear, poll, store, post, verify, startup };
}

describe("Claude wrapper manual attention recovery", () => {
  function afterClear() {
    const token = "22222222-2222-4222-8222-222222222222";
    const f = fixture(token);
    f.registry.updateResumeToken(f.session.id, "claude_id", token, "hook");
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-clear-attention-"));
    directories.push(configDir);
    vi.stubEnv("CLAUDE_CONFIG_DIR", configDir);
    fs.mkdirSync(path.join(configDir, "sessions"));
    const file = path.join(configDir, "sessions", `${child.pid}.json`);
    fs.writeFileSync(file, JSON.stringify({ name: f.name, sessionId: token }));
    return { ...f, token, file };
  }

  it.each(["claude", "2.1.288", "bash"])("clears post-/clear %s identity only from the current PID's exact native session record", async label => {
    const f = afterClear();
    f.tmux.getPaneCommand.mockResolvedValue(label);
    expect((await f.post()).status).toBe(200);
    expect(f.store.getForNode(f.node.id)?.evidence.observedPid).toBe(child.pid);
    await f.poll.reconcileAll();
    expect(f.store.getForNode(f.node.id)?.verdict).toBe("verified");
    expect((await f.verify(true)).ok).toBe(false); // A rotated token is not proof of a strict restore attempt.
    expect(f.db.prepare("SELECT resume_token, resume_provenance FROM sessions WHERE id = ?").get(f.session.id))
      .toEqual({ resume_token: f.token, resume_provenance: "hook" });
    expect(f.sendVerify).not.toHaveBeenCalled();
  });

  it.each(["missing", "wrong token", "wrong seat", "stale PID file", "malformed", "background", "ambiguous", "replaced process", "changed record"])("retains post-/clear attention with %s evidence", async mode => {
    const f = afterClear();
    f.tmux.getPaneCommand.mockResolvedValue("claude");
    if (mode === "missing") fs.unlinkSync(f.file);
    if (mode === "wrong token") fs.writeFileSync(f.file, JSON.stringify({ name: f.name, sessionId: "33333333-3333-4333-8333-333333333333" }));
    if (mode === "wrong seat") fs.writeFileSync(f.file, JSON.stringify({ name: "other@rig", sessionId: f.token }));
    if (mode === "stale PID file") fs.utimesSync(f.file, new Date(0), new Date(0));
    if (mode === "malformed") fs.writeFileSync(f.file, "{");
    if (mode === "background") f.listProcesses.mockResolvedValue([root, { ...child, pgid: 999 }]);
    if (mode === "ambiguous") f.listProcesses.mockResolvedValue([root, child, { ...child, pid: 102 }]);
    if (mode === "replaced process") f.listProcesses.mockImplementation(async () => [root, { ...child, startedAt: `202${f.listProcesses.mock.calls.length}-01-01T00:00:00Z` }]);
    if (mode === "changed record") f.listProcesses.mockImplementation(async () => {
      if (f.listProcesses.mock.calls.length > 1) fs.writeFileSync(f.file, JSON.stringify({ name: f.name, sessionId: "another-session" }));
      return [root, child];
    });
    expect((await f.post()).status).toBe(422);
    expect(f.startup()).toBe("attention_required");
    expect(f.sendVerify).not.toHaveBeenCalled();
  });

  // #1077 — launched with review-token, continued as rotated-token; the hook recorded how.
  it.each([["resume", "review-token", 200, "ready"], ["clear", null, 422, "attention_required"]] as const)(
    "clear-attention after a %s into a new id answers %s", async (_source, rotatedFrom, status, startup) => {
      const f = fixture("rotated-token");
      // Only the first hook after OpenRig's --resume launch, a resume, records what it replaced.
      f.db.prepare("UPDATE sessions SET resume_provenance = 'hook', resume_rotated_from = ?, resume_rotated_process = ?, resume_launch_process = ? WHERE id = ?")
        .run(rotatedFrom, rotatedFrom ? JSON.stringify({ pid: child.pid, startedAt }) : null,
          JSON.stringify({ token: "review-token", pid: child.pid, startedAt }), f.session.id);
      const result = await f.post();
      expect(result.status, JSON.stringify(result.body)).toBe(status);
      expect(f.startup()).toBe(startup);
      expect(f.sendVerify).not.toHaveBeenCalled();
      // An exact-resume check names a launch token itself and never borrows the rotation.
      expect((await f.verify(true)).ok).toBe(false);
    });

  // Fork policy: a settings file is not identity evidence, so only the name case is covered here
  // (the settings-file variants below assert the refusal).
  it.each([
    ["name before identity", ["--name", '"review-desk', "--session-id", "review-token"]],
  ] as const)("a leading literal quote in %s preserves the real identity", async (_name, args) => {
    const f = fixture("review-token");
    f.listProcesses.mockResolvedValue([root, { ...child,
      command: "/tmp/review/.local/share/claude/versions/2.1.1 " + args.join(" "),
    }]);
    // Explicit verification persists its verdict; exercise recovery first.
    const result = await f.post();
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(f.startup()).toBe("ready");
    expect((await f.verify(true)).ok).toBe(true);
    expect(f.sendVerify).not.toHaveBeenCalled();
  });

  it("clear-attention names the conversation mismatch, not the sh label", async () => {
    // The running Claude keeps its launch conversation after the seat's recorded token moved on.
    const f = fixture("stored-token-0000");
    f.tmux.getPaneCommand.mockResolvedValue("sh");
    const result = await f.post();
    expect(result.status).toBe(422);
    const text = JSON.stringify(result.body);
    expect(text).toContain("does not match the seat's record");
    expect(text).not.toContain("review-t");
    expect(text).toContain("the seat records stored-t");
    expect(text).not.toContain("does not positively identify");
    expect(f.startup()).toBe("attention_required");
  });

  it("does not clear attention using identity text inside settings beside a literal quote", async () => {
    const f = fixture("review-token");
    f.listProcesses.mockResolvedValue([root, { ...child,
      command: ['/tmp/review/.local/share/claude/versions/2.1.1', '--settings',
        JSON.stringify({ env: { REVIEW_NOTE: 'text --session-id review-token --model trailing' } }),
        '--name', 'review"desk'].join(' '),
    }]);
    expect((await f.verify(true)).ok).toBe(false);
    expect((await f.post()).status).toBe(422);
    expect(f.startup()).toBe("attention_required");
    expect(f.sendVerify).not.toHaveBeenCalled();
  });

  it("resolves a post-/clear PID record against the seat cwd for a relative provider root", async () => {
    const f = afterClear();
    const configDir = path.dirname(path.dirname(f.file));
    f.db.prepare("UPDATE nodes SET cwd = ? WHERE id = ?").run(path.dirname(configDir), f.node.id);
    vi.stubEnv("CLAUDE_CONFIG_DIR", path.basename(configDir));
    expect((await f.post()).status).toBe(200);
    await f.poll.reconcileAll();
    expect(f.store.getForNode(f.node.id)?.verdict).toBe("verified");
  });

  it("clears a rewritten Claude title only with its OS executable mapping", async () => {
    const f = fixture("review-token");
    f.tmux.getPaneCommand.mockResolvedValue("2.1.288");
    f.listProcesses.mockResolvedValue([root, { ...child, executableName: "2.1.288",
      executablePath: "/fixture/.local/share/claude/versions/2.1.288", command: "claude --model example --resume review-token --name worker@fixture" }]);
    expect((await f.post()).status).toBe(200);
    expect(f.store.getForNode(f.node.id)?.evidence.observedPid).toBe(child.pid);
    expect(f.sendVerify).not.toHaveBeenCalled();
  });

  it.each(["2.1.288", "claude"])("clears %s labels only with exact saved Claude identity", async command => {
    const f = fixture("review-token");
    f.tmux.getPaneCommand.mockResolvedValue(command);
    expect((await f.post()).status).toBe(200);
    expect(f.store.getForNode(f.node.id)?.verdict).toBe("verified");
    expect(f.store.getForNode(f.node.id)?.evidence.observedPid).toBe(child.pid);
    expect(f.sendVerify).not.toHaveBeenCalled();
  });
  it.each([
    ["wrong native identity", { ...child, command: child.command.replace("review-token", "different-token") }],
    ["missing identity", { ...child, command: child.command.replace(" --session-id review-token", "") }],
    ["outside pane lineage", { ...child, ppid: 999 }],
    ["background process", { ...child, pgid: 999 }],
    ["wrong OS executable", { ...child, executableName: "python3" }],
  ])("rejects %s even behind an explicit Claude label", async (_name, observed) => {
    const f = fixture("review-token");
    f.tmux.getPaneCommand.mockResolvedValue("claude");
    f.listProcesses.mockResolvedValue([root, observed]);
    expect((await f.post()).status).toBe(422);
    expect(f.store.getForNode(f.node.id)?.verdict).toBe("mismatch");
    expect(f.sendVerify).not.toHaveBeenCalled();
  });

  it.each(["/fixture/review's-settings.json", '/fixture/review"settings.json', '"review.json'])(
    "clear-attention keeps attention when identity sits beside a settings file: %s", async path => {
      const f = fixture("review-token");
      f.listProcesses.mockResolvedValue([root, { ...child,
        command: `${child.command} --settings ${path}`,
      }]);
      const result = await f.post();
      expect(result.status, JSON.stringify(result.body)).toBe(422);
      expect(f.startup()).toBe("attention_required");
      expect((await f.verify(true)).ok).toBe(false);
      expect(f.sendVerify).not.toHaveBeenCalled();
    },
  );

  // The fork emits no kernel or team settings; cover the inline settings it does emit.
  it.each(["non-interruptive", "advisor"])("periodic identity and clear-attention accept inline %s settings", async kind => {
    const settings = kind === "advisor"
      ? ["--settings", JSON.stringify({ skipDangerousModePermissionPrompt: true, advisorModel: "claude-fable-5-1" })]
      : operationalLaunchArgs("claude-code", { nonInterruptive: true, launchPosture: "full_bypass" });
    const setup = () => {
      const f = fixture("review-token");
      f.listProcesses.mockResolvedValue([root, { ...child,
        command: ["/tmp/review/.local/share/claude/versions/2.1.1", "--permission-mode", "acceptEdits",
          ...settings, "--session-id", "review-token", "--name", f.name].join(" "),
      }]);
      return f;
    };
    const periodic = setup();
    await periodic.poll.reconcileAll();
    expect(periodic.store.getForNode(periodic.node.id)?.verdict).toBe("verified");
    // Periodic identity does not erase a separate startup attention marker.
    expect(periodic.startup()).toBe("attention_required");
    // Exercise clear-attention from its own still-active identity mismatch.
    const f = setup();
    const result = await f.post();
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body.evidence.kind).toBe("pane_identity_reverified");
    expect(f.startup()).toBe("ready");
    await f.poll.reconcileAll();
    expect(f.store.getForNode(f.node.id)?.verdict).toBe("verified");
    expect(f.sendVerify).not.toHaveBeenCalled();
  });

  it.each(["valid", "no token", "wrong token", "missing path", "background", "unrelated", "ambiguous", "PID reused", "unavailable"])("numeric Claude pane identity clear: %s", async mode => {
    const f = fixture(mode === "no token" ? null : "review-token");
    f.tmux.getPaneCommand.mockResolvedValue("2.1.289");
    const native = { ...child, executableName: "2.1.289", command: `claude --session-id ${mode === "wrong token" ? "other" : "review-token"}`,
      executablePath: mode === "missing path" ? undefined : "/fixture/.local/share/claude/versions/2.1.289" };
    f.listProcesses.mockImplementation(async () => {
      if (mode === "unavailable") throw new Error("process observation unavailable");
      return [root, { ...native,
        ...(mode === "background" ? { pgid: 200 } : {}),
        ...(mode === "unrelated" ? { ppid: 1 } : {}),
        ...(mode === "PID reused" && f.listProcesses.mock.calls.length === 2 ? { startedAt: "later" } : {}),
      }, ...(mode === "ambiguous" ? [{ ...native, pid: 102 }] : [])];
    });
    const result = await f.post();
    expect(result.status).toBe(mode === "valid" ? 200 : 422);
    expect(f.startup()).toBe(mode === "valid" ? "ready" : "attention_required");
    expect(f.store.getForNode(f.node.id)?.verdict).toBe(mode === "valid" ? "verified" : "mismatch");
    if (mode === "valid") {
      expect(result.body.evidence.kind).toBe("pane_identity_reverified");
      expect(f.listProcesses).toHaveBeenCalledTimes(2);
    }
    expect(f.sendVerify).not.toHaveBeenCalled();
  });

  it.each([null, "review-token", "different-token"])("batched wrapper proof retains saved-token semantics (%s)", async token => {
    const f = fixture(token);
    const batch = vi.fn(async () => new Map([[f.pane, { pid: 100, command: "bash" }]]));
    Object.assign(f.tmux, { readAllPaneProcesses: batch });
    await f.poll.reconcileAll();
    expect(batch).toHaveBeenCalledTimes(3); // selection/first sample, second sample, final verdict
    expect(f.listProcesses).toHaveBeenCalledTimes(2);
    expect(f.tmux.getPaneCommand).not.toHaveBeenCalled();
    expect(f.store.getForNode(f.node.id)?.verdict).toBe(token === "different-token" ? "mismatch" : "verified");
    expect(f.startup()).toBe("attention_required");
  });

  it.each(["pid", "command"])("uses the fresh final batch after native proof (%s changed)", async changed => {
    const f = fixture();
    const batch = vi.fn(async () => new Map([[f.pane, { pid: 100, command: "bash" as string | null }]]));
    batch.mockResolvedValueOnce(new Map([[f.pane, { pid: 100, command: "bash" }]]))
      .mockResolvedValueOnce(new Map([[f.pane, { pid: 100, command: "bash" }]]))
      .mockResolvedValue(new Map([[f.pane, { pid: changed === "pid" ? 999 : 100, command: changed === "command" ? null : "bash" }]]));
    Object.assign(f.tmux, { readAllPaneProcesses: batch });
    await f.poll.reconcileAll();
    expect(batch).toHaveBeenCalledTimes(3);
    expect(f.store.getForNode(f.node.id)?.verdict).not.toBe("verified");
    expect(f.startup()).toBe("attention_required");
  });

  it.each([null, "review-token"])("clears with positive occupancy then stays coherent on the next sweep (saved token: %s)", async token => {
    const f = fixture(token);
    const result = await f.post();
    expect(result.status).toBe(200);
    expect(result.body.evidence.kind).toBe("pane_identity_reverified");
    expect(f.startup()).toBe("ready");
    expect(f.listProcesses).toHaveBeenCalledTimes(2);
    await f.poll.reconcileAll();
    expect(f.store.getForNode(f.node.id)?.verdict).toBe("verified");
    expect(f.listProcesses).toHaveBeenCalledTimes(4);
    expect(f.sendVerify).not.toHaveBeenCalled();
  });

  it("periodic tokenless occupancy does not clear startup attention or invent a token", async () => {
    const f = fixture(); await f.poll.reconcileAll();
    expect(f.store.getForNode(f.node.id)?.verdict).toBe("verified");
    expect(f.startup()).toBe("attention_required");
    expect(f.db.prepare("SELECT resume_token FROM sessions WHERE id = ?").get(f.session.id)).toEqual({ resume_token: null });
    expect(f.sendVerify).not.toHaveBeenCalled();
  });

  it("never falls back from a wrong saved token to runtime-only proof", async () => {
    const f = fixture("different-token");
    expect((await f.post()).status).toBe(422);
    expect((await f.verify()).ok).toBe(false);
    await f.poll.reconcileAll();
    expect(f.store.getForNode(f.node.id)?.verdict).toBe("mismatch");
    expect(f.startup()).toBe("attention_required");
  });

  it.each([null, "different-token"])("strict restore cannot use runtime-only evidence (%s)", async token => {
    const f = fixture(token);
    expect((await f.verify(true)).ok).toBe(false);
    expect(await verifyClaudePaneProcess({ target: f.pane, tmux: f.tmux, listProcesses: f.listProcesses, expectedToken: token })).toBeNull();
    expect(f.startup()).toBe("attention_required");
  });

  it("retains the exact saved-token strict wrapper path", async () => {
    expect((await fixture("review-token").verify(true)).ok).toBe(true);
  });

  // #1091: strict restore rejects a shallower token only when a deeper verified Claude in the
  // same chain positively names another conversation; otherwise it keeps main's result.
  const real = (args: string) => ({ ...root, executableName: "claude", command: `claude ${args}` });
  const script = { ...root, executableName: "claude", command: "/bin/sh /shim/claude --resume review-token" };
  const kid = (pid: number, ppid: number, executableName: string, command: string) => ({ ...child, pid, ppid, executableName, command });
  it.each([
    ["the company-launcher model (opaque real Claude)", [real("--session-id review-token --name worker@review197"),
      kid(101, 100, "claude", "/shim/bin/claude --session-id review-token --name worker@review197"),
      kid(102, 101, "claude", "/shim/claude --settings /shim/settings.json --permission-mode auto")], true],
    ["a ripgrep helper whose argv mentions claude", [real("--resume review-token"), kid(101, 100, "rg", "rg -n claude src")], true],
    ["a claude mcp serve child", [real("--resume review-token"), kid(101, 100, "claude", "claude mcp serve")], true],
    ["a script launcher over a child on another conversation", [script, kid(101, 100, "claude", "claude --session-id different")], false],
    ["a child that names the token", [script, kid(101, 100, "claude", "claude --resume review-token")], true],
    ["a verified Claude that starts a child Claude on another conversation", [real("--resume review-token"), kid(101, 100, "claude", "claude --session-id different")], true],
    ["an intermediate opaque Claude whose own child is on another conversation",
      [script, kid(101, 100, "claude", "claude --settings /shim/settings.json"), kid(102, 101, "claude", "claude --session-id different")], true],
    ["a script and a helper on the token over a real Claude on another conversation",
      [script, kid(101, 100, "ugrep", "ugrep -n claude --session-id review-token file.ts"), kid(102, 100, "claude", "claude --session-id different")], false],
    ["a Node-run Claude on the token over a child Claude on another conversation",
      [{ ...root, executableName: "node", command: "node /usr/local/bin/claude --resume review-token" }, kid(101, 100, "claude", "claude --session-id different")], true],
  ] as const)("strict restore with %s", async (_name, rows, proved) => {
    const f = fixture("review-token");
    f.tmux.getPaneCommand.mockResolvedValue("claude");
    f.listProcesses.mockResolvedValue([...rows]);
    expect((await f.verify(true)).ok).toBe(proved);
  });

  // #1091 round 3: a pane-root Claude with an exact child keeps the pane root as its
  // observed pid, so the record resolver accepts the unchanged live pane, as on main.
  it("a pane-root Claude with an exact child stays resolvable", async () => {
    const id = "00000000-0000-4000-8000-000000001091";
    const f = fixture(id);
    f.tmux.getPaneCommand.mockResolvedValue("claude");
    const rows = [real(`--resume ${id} --name worker@review197`), kid(101, 100, "claude", `claude --session-id ${id}`)];
    f.listProcesses.mockResolvedValue(rows);
    expect((await f.verify(true)).ok).toBe(true);
    const identity = f.store.getForNode(f.node.id)!;
    expect(identity.evidence.observedPid).toBe(100);
    const selection = await resolveIdentityVerifiedClaudeRecord({
      sessionName: f.name, generation: "generation-current", occupantBootAt: "2000-01-01 00:00:00",
      binding: { tmuxSession: f.name, tmuxPane: f.pane }, identity,
      sidecar: { session_id: id, session_name: f.name, transcript_path: `/fixture/${id}.jsonl` },
    }, { getPanePid: async () => 100, listProcesses: async () => rows }, () => true);
    expect(selection).toMatchObject({ ok: true, id });
  });

  it("keeps full restore outcome reconciliation ahead of runtime occupancy", async () => {
    const f = fixture();
    f.bus.emit({ type: "restore.started", rigId: f.rig.id, snapshotId: "snapshot" } as never);
    f.bus.emit({ type: "restore.completed", rigId: f.rig.id, snapshotId: "snapshot", result: {
      snapshotId: "snapshot", preRestoreSnapshotId: "before", rigResult: "failed",
      nodes: [{ nodeId: f.node.id, logicalId: "worker", status: "failed" }], warnings: [],
    } } as never);
    const result = await f.post();
    expect(result.status).toBe(422);
    expect(result.body.detail).toContain("strict restore reconciler is unavailable");
    expect(f.listProcesses).not.toHaveBeenCalled();
    await f.poll.reconcileAll();
    expect(f.store.getForNode(f.node.id)?.verdict).toBe("verified");
    expect(f.startup()).toBe("attention_required");
    expect((await f.post()).status).toBe(422);
  });

  const invalid: [string, NativeProcessRow[]][] = [
    ["empty", []], ["bare shell", [root]], ["wrong runtime", [root, { ...child, command: "codex", executableName: "codex" }]],
    ["background", [root, { ...child, pgid: 200 }]], ["unrelated", [root, { ...child, ppid: 1 }]],
    ["duplicate candidates", [root, child, { ...child, pid: 102 }]], ["wrong OS executable", [root, { ...child, executableName: "python3" }]],
    ["missing start", [root, { ...child, startedAt: undefined }]], ["missing foreground", [{ ...root, tpgid: undefined }, child]],
  ];
  it.each(invalid)("does not clear or periodically verify %s", async (_name, rows) => {
    const f = fixture(); f.listProcesses.mockResolvedValue(rows);
    expect((await f.verify()).ok).toBe(false);
    await f.poll.reconcileAll();
    expect(f.store.getForNode(f.node.id)?.verdict).not.toBe("verified");
    expect(f.startup()).toBe("attention_required");
  });

  it("rejects process PID reuse between the two observations", async () => {
    const f = fixture(); f.listProcesses.mockResolvedValueOnce([root, child]).mockResolvedValue([root, { ...child, startedAt: "later" }]);
    expect((await f.verify()).ok).toBe(false);
  });
  it("keeps unavailable process evidence non-positive", async () => {
    const f = fixture(); f.listProcesses.mockRejectedValue(new Error("ps unavailable"));
    expect((await f.verify()).ok).toBe(false);
    await f.poll.reconcileAll(); expect(f.store.getForNode(f.node.id)?.verdict).not.toBe("verified");
  });
  it.each(["pane", "pid", "extra pane", "unavailable"])("rejects a final %s change after process proof", async mode => {
    const f = fixture();
    f.listProcesses.mockImplementation(async () => {
      if (f.listProcesses.mock.calls.length === 2) {
        if (mode === "pane") f.tmux.listPanes.mockResolvedValue([{ id: "%replacement" }] as never);
        if (mode === "pid") f.tmux.getPanePid.mockResolvedValue(999);
        if (mode === "extra pane") f.tmux.listPanes.mockResolvedValue([{ id: f.pane }, { id: "%extra" }] as never);
        if (mode === "unavailable") f.tmux.listPanes.mockRejectedValue(new Error("tmux unavailable"));
      }
      return [root, child];
    });
    expect((await f.verify()).ok).toBe(false);
  });

  it.each(["pane", "pid", "extra pane", "unavailable", "null command"])("periodic runtime proof also rejects a final %s change", async mode => {
    const f = fixture();
    f.listProcesses.mockImplementation(async () => {
      if (f.listProcesses.mock.calls.length === 2) {
        if (mode === "pane") f.tmux.listPanes.mockResolvedValue([{ id: "%replacement" }] as never);
        if (mode === "pid") f.tmux.getPanePid.mockResolvedValue(999);
        if (mode === "extra pane") f.tmux.listPanes.mockResolvedValue([{ id: f.pane }, { id: "%extra" }] as never);
        if (mode === "unavailable") f.tmux.listPanes.mockRejectedValue(new Error("tmux unavailable"));
        if (mode === "null command") f.tmux.getPaneCommand.mockResolvedValue(null);
      }
      return [root, child];
    });
    await f.poll.reconcileAll();
    expect(f.store.getForNode(f.node.id)?.verdict).not.toBe("verified");
    expect(f.startup()).toBe("attention_required");
  });
});
