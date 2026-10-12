import { afterEach, describe, expect, it, vi } from "vitest";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { NativePermissionStore } from "../src/domain/native-permission-store.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { StartupOrchestrator } from "../src/domain/startup-orchestrator.js";
import { RestoreOrchestrator } from "../src/domain/restore-orchestrator.js";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code-adapter.js";
import { CodexRuntimeAdapter } from "../src/adapters/codex-runtime-adapter.js";
import { ClaudeResumeAdapter } from "../src/adapters/claude-resume.js";
import { CodexResumeAdapter } from "../src/adapters/codex-resume.js";
import { operationalLaunchArgs } from "../src/adapters/kernel-authority.js";
import type { NodeBinding, RuntimeAdapter } from "../src/domain/runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

const dbs: ReturnType<typeof createFullTestDb>[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); vi.unstubAllEnvs(); });
function fixture(runtime: string, name = "workshop") {
  vi.stubEnv("OPENRIG_YOLO", "0");
  const db = createFullTestDb(); dbs.push(db);
  const rigRepo = new RigRepository(db), rig = rigRepo.createRig(name);
  const node = rigRepo.addNode(rig.id, "dev.builder", { runtime, cwd: "/inert/project" });
  const store = new NativePermissionStore(db), registry = new SessionRegistry(db);
  const session = registry.registerSession(node.id, `dev-builder@${name}`);
  const binding = { id: "binding", nodeId: node.id, cwd: "/inert/project", tmuxSession: session.sessionName,
    launchPosture: "floor" } as NodeBinding;
  return { db, rigRepo, rig, node, store, registry, session, binding };
}
function transport() {
  const send = vi.fn(async () => ({ ok: false as const, message: "inert boundary" }));
  const tmux = { sendShellCommand: send, sendText: send } as unknown as TmuxAdapter;
  const fsOps = { readFile: () => { throw new Error("missing"); }, exists: () => false,
    writeFile: vi.fn(() => { throw new Error("unexpected permission file write"); }), mkdirp: vi.fn(), copyFile: vi.fn() };
  const prepareTeamWorkspace = vi.fn(() => ["/configured/work space", "/configured/shared/rigs/workshop/state/dev"]);
  return { send, tmux, fsOps, prepareTeamWorkspace };
}
// This fork does not adopt upstream's no-policy team launch default (#893) or its rig-name kernel
// default: a seat with no explicit policy or seat choice keeps native settings and profile
// inheritance. These tests pin that policy on the same launch paths upstream's tests cover.
function assertInherited(cmd: string, runtime: string) {
  expect(cmd).not.toContain("claude-team-permissions.cjs");
  expect(cmd, "the team workspace must not reach the native command").not.toContain("/configured/");
  if (runtime === "claude-code") {
    expect(cmd, "no team settings may reach the native command").not.toContain("--settings");
    expect(cmd).not.toContain("--dangerously-skip-permissions");
  } else {
    expect(cmd).not.toContain("danger-full-access");
    expect(cmd).not.toContain("-a never");
  }
}
describe("fork: no team launch permission default", () => {
  for (const runtime of ["claude-code", "codex"]) for (const mode of ["fresh", "resume", "fork"] as const) {
    it(`${runtime} ${mode}: a seat with no policy launches with native inheritance`, async () => {
      const f = fixture(runtime), t = transport(), b = f.store.apply(f.binding, runtime);
      expect(b.teamPermissionDefault).toBe(false);
      const adapter = runtime === "claude-code" ? new ClaudeCodeAdapter(t) : new CodexRuntimeAdapter(t);
      await adapter.launchHarness(b, { name: f.session.sessionName,
        ...(mode === "resume" ? { resumeToken: "original" } : {}),
        ...(mode === "fork" ? { forkSource: { kind: "native_id" as const, value: "original" } } : {}) });
      assertInherited(t.send.mock.calls[0]![1], runtime);
      expect(t.fsOps.writeFile).not.toHaveBeenCalled();
      expect(t.prepareTeamWorkspace).not.toHaveBeenCalled();
    });
  }
  for (const runtime of ["claude-code", "codex"]) {
    it(`${runtime}: no authored rig/member choice turns the team default on`, () => {
      const f = fixture(runtime);
      for (const policy of ["none", "builtin:locked", "builtin:standard", "builtin:yolo"]) {
        for (const table of ["rigs", "nodes"]) {
          f.db.prepare(`UPDATE ${table} SET permission_policy=? WHERE id=?`).run(policy, table === "rigs" ? f.rig.id : f.node.id);
          expect(f.store.apply(f.binding, runtime)).toMatchObject({ teamPermissionDefault: false });
          f.db.prepare(`UPDATE ${table} SET permission_policy=NULL WHERE id=?`).run(table === "rigs" ? f.rig.id : f.node.id);
        }
      }
      expect(f.store.apply(f.binding, runtime)).toMatchObject({ teamPermissionDefault: false });
    });
    it(`${runtime}: a stale team marker is cleared with or without a seat choice`, () => {
      const f = fixture(runtime);
      const stale = { ...f.binding, teamPermissionDefault: true } as NodeBinding;
      expect(f.store.apply(stale, runtime)).toMatchObject({ teamPermissionDefault: false });
      f.store.write(f.node.id, { runtime: runtime as "codex" | "claude-code", mode: runtime === "codex" ? "floor" : "plan" }, "person", "selected");
      expect(f.store.apply(stale, runtime)).toMatchObject({ teamPermissionDefault: false });
    });
    it(`${runtime}: startup launches without the team or kernel default`, async () => {
      const f = fixture(runtime);
      const launchHarness = vi.fn(async (_binding: NodeBinding) => ({ ok: false as const, error: "inert boundary" }));
      const adapter = { runtime, project: async () => ({ projected: [], skipped: [], failed: [] }),
        deliverStartup: async () => ({ delivered: [], failed: [] }), launchHarness } as unknown as RuntimeAdapter;
      const orchestrator = new StartupOrchestrator({ db: f.db, sessionRegistry: f.registry, eventBus: new EventBus(f.db), tmuxAdapter: {} as TmuxAdapter });
      await orchestrator.startNode({ rigId: f.rig.id, nodeId: f.node.id, sessionId: f.session.id, binding: f.binding,
        adapter, plan: { entries: [] } as never, resolvedStartupFiles: [], startupActions: [] });
      const launched = launchHarness.mock.calls[0]![0];
      expect(launched.teamPermissionDefault ?? false).toBe(false);
      expect(launched.kernelAuthority ?? false).toBe(false);
    });
    it(`${runtime}: legacy restore keeps native inheritance`, async () => {
      const f = fixture(runtime), t = transport();
      const actual = runtime === "codex" ? new CodexResumeAdapter(t.tmux, t) : new ClaudeResumeAdapter(t.tmux);
      const resume = (...args: unknown[]) => (actual.resume as (...args: unknown[]) => unknown)(...args);
      const ctx = { db: f.db, rigRepo: f.rigRepo, sessionRegistry: f.registry,
        claudeResume: { canResume: () => runtime === "claude-code", resume }, codexResume: { canResume: () => runtime === "codex", resume } };
      await (RestoreOrchestrator.prototype as any).attemptResume.call(ctx, f.node.id, f.session.sessionName,
        runtime === "codex" ? "codex_id" : "claude_id", "original", "/inert", null, "model", "floor");
      assertInherited(t.send.mock.calls[0]![1], runtime);
    });
  }
  it("a rig named kernel gets no kernel authority by name", () => {
    for (const runtime of ["claude-code", "codex"]) {
      const kernel = fixture(runtime, "kernel");
      expect(kernel.store.apply(kernel.binding, runtime)).toMatchObject({ teamPermissionDefault: false, kernelAuthority: false });
    }
  });
  it("explicit native mode and non-interruptive flags are preserved", () => {
    expect(operationalLaunchArgs("claude-code", { teamPermissionDefault: true, permissionMode: "plan" } as any)).toEqual([]);
    const choice = { teamPermissionDefault: true, launchPosture: "full_bypass", nonInterruptive: true } as any;
    expect(operationalLaunchArgs("claude-code", choice)).toEqual(["--settings", '{"skipDangerousModePermissionPrompt":true}']);
  });
});
