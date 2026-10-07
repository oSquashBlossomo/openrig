import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { NativePermissionStore } from "../src/domain/native-permission-store.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { StartupOrchestrator } from "../src/domain/startup-orchestrator.js";
import { RestoreOrchestrator } from "../src/domain/restore-orchestrator.js";
import { ClaudeCodeAdapter, type ClaudeAdapterFsOps } from "../src/adapters/claude-code-adapter.js";
import { ClaudeResumeAdapter } from "../src/adapters/claude-resume.js";
import type { ClaudeManagedLaunch } from "../src/domain/claude-managed-launch.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

let dir: string;
const dbs: ReturnType<typeof createFullTestDb>[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "claude-authored-floor-"));
  vi.stubEnv("CLAUDE_CONFIG_DIR", dir);
  vi.stubEnv("OPENRIG_YOLO", "1");
});
afterEach(() => { dbs.splice(0).forEach(db => db.close()); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });

function fixture(scope = "user", nativeMode = "auto") {
  const cwd = join(dir, "project");
  mkdirSync(join(cwd, ".claude"), { recursive: true });
  const settingsPath = scope === "user" ? join(dir, "settings.json")
    : join(cwd, ".claude", scope === "project" ? "settings.json" : "settings.local.json");
  const settings = JSON.stringify({ permissions: { defaultMode: nativeMode, deny: ["Read(.env)"] } });
  writeFileSync(settingsPath, settings);
  const db = createFullTestDb(); dbs.push(db);
  const repo = new RigRepository(db), rig = repo.createRig("floor-fixture");
  const node = repo.addNode(rig.id, "worker", { runtime: "claude-code", cwd });
  const registry = new SessionRegistry(db), session = registry.registerSession(node.id, "worker@floor-fixture");
  const store = new NativePermissionStore(db);
  const binding = { id: "binding", nodeId: node.id, cwd, tmuxSession: session.sessionName, launchPosture: "floor" } as NodeBinding;
  const send = vi.fn(async (_target: string, _command: string) => ({ ok: false as const, message: "inert command boundary; no native process" }));
  const tmux = { sendText: send, sendShellCommand: send } as unknown as TmuxAdapter;
  const prepare = vi.fn(async (_target: unknown, mode: string) => ({ configDir: dir, assertCurrent: () => {},
    command: (args: string[]) => `claude ${args.join(" ")}` }));
  const managed = { prepare, configPaths: () => ({ configDir: dir, statePath: join(dir, ".claude.json") }),
    selectedStatePath: () => join(dir, ".claude.json") } as unknown as ClaudeManagedLaunch;
  function policy(target: "member" | "rig", ref: string, posture: "floor" | "auto" | "full_bypass" = "floor") {
    const origin = ref === "none" ? "deliberate_none" : ref.startsWith("builtin:") ? "builtin" : "custom";
    const provenance = { origin, launchPosture: posture, resolvedTarget: null, declaringDir: null } as const;
    if (target === "member") {
      db.prepare("UPDATE nodes SET permission_policy=? WHERE id=?").run(ref, node.id);
      repo.setNodePolicyProvenance(node.id, provenance);
    } else { repo.setRigPermissionPolicy(rig.id, ref); repo.setRigPolicyProvenance(rig.id, provenance); }
  }
  async function launch(kind: string, posture: NodeBinding["launchPosture"] = "floor") {
    if (kind === "legacy restore") {
      const ctx = { db, rigRepo: repo, sessionRegistry: registry,
        claudeResume: new ClaudeResumeAdapter(tmux, { claudeManagedLaunch: managed }),
        codexResume: { canResume: () => false } };
      await (RestoreOrchestrator.prototype as any).attemptResume.call(ctx, node.id, session.sessionName,
        "claude_id", "saved-native-id", cwd, null, null, posture);
    } else {
      const adapter = new ClaudeCodeAdapter({ tmux, claudeManagedLaunch: managed, fsOps: {
        homedir: dir, exists: () => false, readFile: () => "", writeFile: () => {},
        mkdirp: () => {}, copyFile: () => {}, listFiles: () => [],
      } as ClaudeAdapterFsOps });
      await new StartupOrchestrator({ db, sessionRegistry: registry, eventBus: new EventBus(db), tmuxAdapter: tmux }).startNode({
        rigId: rig.id, nodeId: node.id, sessionId: session.id, binding: { ...binding, launchPosture: posture }, adapter,
        plan: { entries: [] } as never, resolvedStartupFiles: [], startupActions: [], isRestore: kind === "resume",
        ...(kind === "resume" ? { resumeToken: "saved-native-id", resumeType: "claude_id" } : {}),
        ...(kind === "fork" ? { forkSource: { kind: "native_id" as const, value: "parent-native-id" } } : {}) });
    }
    expect(send).toHaveBeenCalledTimes(1);
    expect(readFileSync(settingsPath, "utf8")).toBe(settings);
    return send.mock.calls[0]![1] as string;
  }
  return { db, repo, rig, node, store, binding, prepare, policy, launch };
}

describe("authored Claude floor versus native inheritance", () => {
  const paths = ["fresh", "resume", "fork", "legacy restore"];
  it.each(["user", "project", "local"].flatMap(scope => paths.map(kind => ({ scope, kind }))))(
    "a member locked floor overrides $scope native mode on $kind", async ({ scope, kind }) => {
      const f = fixture(scope, "bypassPermissions"); f.policy("member", "builtin:locked");
      expect(await f.launch(kind)).toContain("--permission-mode acceptEdits");
      expect(f.prepare).not.toHaveBeenCalled();
    });
  it.each(paths)("an unselected synthetic floor preserves native auto on %s", async kind => {
    const f = fixture();
    expect(await f.launch(kind)).not.toMatch(/--permission-mode|--dangerously-skip-permissions/);
    expect(f.prepare).not.toHaveBeenCalled();
  });
  it.each(["builtin:standard", "builtin:open", "policies/custom-floor.md"])("a rig-authored %s floor reaches organic seats", async ref => {
    const f = fixture(); f.policy("rig", ref);
    expect(await f.launch("fresh")).toContain("--permission-mode acceptEdits");
  });
  it.each(paths)("an explicit stored floor overrides native auto on %s", async kind => {
    const f = fixture(); f.store.write(f.node.id, { runtime: "claude-code", mode: "floor" }, "operator", "selected floor");
    expect(await f.launch(kind)).toContain("--permission-mode acceptEdits");
  });
  it.each(["auto", "plan", "full_bypass"])("an explicit stored %s wins over the authored floor", async mode => {
    const f = fixture(); f.policy("member", "builtin:locked");
    f.store.write(f.node.id, { runtime: "claude-code", mode }, "operator", "selected mode");
    expect(await f.launch("fresh")).toContain(mode === "full_bypass" ? "--dangerously-skip-permissions" : `--permission-mode ${mode}`);
  });
  it.each(["builtin:yolo", "builtin:locked"])("member none masks rig %s and inherits native auto", async ref => {
    const f = fixture(); f.policy("rig", ref, ref === "builtin:yolo" ? "full_bypass" : "floor"); f.policy("member", "none");
    expect(await f.launch("fresh")).not.toMatch(/--permission-mode|--dangerously-skip-permissions/);
  });
  it.each(["auto", "full_bypass"] as const)("a re-derived custom %s posture is not replaced by its stored floor", async posture => {
    const f = fixture(); f.policy("member", "policies/custom.md");
    expect(await f.launch("legacy restore", posture)).toContain(posture === "auto" ? "--permission-mode auto" : "--dangerously-skip-permissions");
  });
  it("a custom policy re-derived as floor overrides its old bypass posture", async () => {
    const f = fixture(); f.policy("member", "policies/custom.md", "full_bypass");
    expect(await f.launch("legacy restore", "floor")).toContain("--permission-mode acceptEdits");
  });
  it.each([["floor", "full_bypass"], ["full_bypass", "floor"]] as const)(
    "restore reopens custom policy %s→%s before selecting the native flag", async (prior, current) => {
      const f = fixture(); f.policy("member", "custom.md", prior);
      const policyPath = join(dir, "custom.md");
      writeFileSync(policyPath, `---\npolicy_schema_version: 1\nname: custom-floor\nsource: custom\ndescription: fixture policy\nsurface: flag\nlaunch_posture: ${current}\n---\n`);
      f.repo.setNodePolicyProvenance(f.node.id, { origin: "custom", launchPosture: prior,
        declaringDir: dir, resolvedTarget: policyPath });
      const resolved = (RestoreOrchestrator.prototype as any).resolveRestorePosture.call({ rigRepo: f.repo }, f.node.id, f.rig.id);
      expect(resolved).toBe(current);
      const command = await f.launch("legacy restore", resolved);
      expect(command).toContain(current === "floor" ? "--permission-mode acceptEdits" : "--dangerously-skip-permissions");
      if (current === "full_bypass") expect(command).not.toContain("--permission-mode");
    });
  it("a rig's deliberate none keeps the native default", async () => {
    const f = fixture(); f.policy("rig", "none");
    expect(await f.launch("legacy restore")).not.toMatch(/--permission-mode|--dangerously-skip-permissions/);
  });
  it("an unavailable authored-policy lookup refuses instead of silently inheriting", () => {
    const f = fixture(); f.policy("member", "builtin:locked");
    const prepare = f.db.prepare.bind(f.db);
    vi.spyOn(f.db, "prepare").mockImplementation((sql: string) => {
      if (sql.includes("AS origin")) throw new Error("policy provenance unavailable");
      return prepare(sql);
    });
    expect(() => f.store.apply(f.binding, "claude-code")).toThrow("policy provenance unavailable");
  });
  it.each(["member", "rig"] as const)("legacy %s raw ref without provenance still selects its resolved floor", async scope => {
    const f = fixture();
    if (scope === "member") f.db.prepare("UPDATE nodes SET permission_policy='builtin:locked' WHERE id=?").run(f.node.id);
    else f.repo.setRigPermissionPolicy(f.rig.id, "policies/floor.md");
    expect(await f.launch("legacy restore")).toContain("--permission-mode acceptEdits");
  });
  it("legacy member none without provenance masks a rig authored floor", async () => {
    const f = fixture(); f.policy("rig", "builtin:locked");
    f.db.prepare("UPDATE nodes SET permission_policy='none' WHERE id=?").run(f.node.id);
    expect(await f.launch("fresh")).not.toMatch(/--permission-mode|--dangerously-skip-permissions/);
  });
  it.each([["floor", "full_bypass"], ["full_bypass", "floor"]] as const)(
    "legacy member custom %s→%s uses the caller's current posture over the rig policy", async (prior, current) => {
      const f = fixture(); f.policy("rig", "builtin:locked");
      f.db.prepare("UPDATE nodes SET permission_policy='policies/member.md', policy_launch_posture=? WHERE id=?").run(prior, f.node.id);
      const command = await f.launch("legacy restore", current);
      expect(command).toContain(current === "floor" ? "--permission-mode acceptEdits" : "--dangerously-skip-permissions");
      if (current === "full_bypass") expect(command).not.toContain("--permission-mode");
    });
  it("an invalid legacy ref is refused without resolving a relative policy file", () => {
    const f = fixture();
    f.db.prepare("UPDATE nodes SET permission_policy='../outside.md' WHERE id=?").run(f.node.id);
    expect(() => f.store.apply(f.binding, "claude-code")).toThrow(/Stored permission policy/);
  });
});
