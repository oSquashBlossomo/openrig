import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { claudePostureFlag, codexPostureArg } from "../src/adapters/yolo-mode.js";
import { ClaudeCodeAdapter, type ClaudeAdapterFsOps } from "../src/adapters/claude-code-adapter.js";
import { ClaudeResumeAdapter } from "../src/adapters/claude-resume.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { NativePermissionStore } from "../src/domain/native-permission-store.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "openrig-native-default-"));
  vi.stubEnv("CLAUDE_CONFIG_DIR", dir);
  vi.stubEnv("OPENRIG_YOLO", "0");
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });
const settings = (defaultMode: string) => writeFileSync(join(dir, "settings.json"), JSON.stringify({ permissions: { defaultMode, deny: ["Read(.env)"] } }));

describe("Claude native auto default", () => {
  it("kernel inherits the native auto default without adding operational permissions", async () => {
    settings("auto");
    const before = readFileSync(join(dir, "settings.json"), "utf8");
    const db = createFullTestDb();
    try {
      const repo = new RigRepository(db), rig = repo.createRig("kernel");
      const node = repo.addNode(rig.id, "advisor", { runtime: "claude-code", cwd: dir });
      const binding = new NativePermissionStore(db).apply({ nodeId: node.id, cwd: dir,
        tmuxSession: "advisor@kernel", launchPosture: "floor" } as NodeBinding, "claude-code");
      const sendText = vi.fn(async () => ({ ok: false as const, message: "inert launch boundary" }));
      await new ClaudeCodeAdapter({ tmux: { sendText } as unknown as TmuxAdapter }).launchHarness(binding, { name: "advisor@kernel" });
      expect(sendText.mock.calls[0]![1]).not.toMatch(/--permission-mode|--dangerously-skip-permissions|--settings/);
      expect(readFileSync(join(dir, "settings.json"), "utf8")).toBe(before);
    } finally { db.close(); }
  });
  it("omits the mode override so native project and managed precedence remain authoritative", () => {
    settings("auto");
    expect(claudePostureFlag(process.env, "floor")).toBe("");
    expect(claudePostureFlag(process.env)).toBe("");
    expect(codexPostureArg("", process.env, "floor")).toBe(" -s workspace-write");
  });
  it("retains explicit mode and bypass selections over the native default", () => {
    settings("auto");
    expect(claudePostureFlag(process.env, "floor", "acceptEdits")).toBe("--permission-mode acceptEdits");
    expect(claudePostureFlag(process.env, "full_bypass")).toBe("--dangerously-skip-permissions");
    expect(claudePostureFlag(process.env, "full_bypass", "plan")).toBe("--permission-mode plan");
  });
  it("keeps the floor only when no native mode was selected", () => {
    expect(claudePostureFlag(process.env, "floor")).toBe("--permission-mode acceptEdits");
    settings("plan");
    expect(claudePostureFlag(process.env, "floor")).toBe("");
  });
  it.each(["settings.json", "settings.local.json"])("leaves project %s precedence to Claude", file => {
    settings("acceptEdits");
    const cwd = join(dir, "project");
    mkdirSync(join(cwd, ".claude"), { recursive: true });
    writeFileSync(join(cwd, ".claude", file), JSON.stringify({ permissions: { defaultMode: "auto" } }));
    expect(claudePostureFlag(process.env, undefined, undefined, cwd)).toBe("");
  });
  it.each(["config", ""])("resolves the native config selection %j at the seat cwd", configDir => {
    const cwd = join(dir, "project"), selected = join(cwd, configDir);
    mkdirSync(selected, { recursive: true });
    writeFileSync(join(selected, "settings.json"), JSON.stringify({ permissions: { defaultMode: "auto" } }));
    expect(claudePostureFlag({ ...process.env, CLAUDE_CONFIG_DIR: configDir }, undefined, undefined, cwd)).toBe("");
  });
  it("defers malformed native settings without throwing or changing explicit selections", () => {
    writeFileSync(join(dir, "settings.json"), "invalid JSON");
    expect(claudePostureFlag(process.env, "floor")).toBe("");
    expect(claudePostureFlag(process.env, "floor", "acceptEdits")).toBe("--permission-mode acceptEdits");
  });
  it("defers unreadable native settings to Claude", () => {
    settings("auto");
    chmodSync(join(dir, "settings.json"), 0);
    expect(() => readFileSync(join(dir, "settings.json"), "utf8")).toThrow();
    expect(claudePostureFlag(process.env, "floor")).toBe("");
  });
  it("a malformed settings file does not escape the resume result boundary", async () => {
    writeFileSync(join(dir, "settings.json"), "invalid JSON");
    const tmux = { sendText: vi.fn(async () => ({ ok: false, message: "inert launch boundary" })) } as unknown as TmuxAdapter;
    await expect(new ClaudeResumeAdapter(tmux).resume("worker@fixture", "claude_id", "native-token", dir, "floor"))
      .resolves.toMatchObject({ ok: false, code: "resume_failed" });
  });
  it.each(["user", "project", "local"].flatMap(scope => ["fresh", "resume", "fork", "restore"].map(kind => ({ scope, kind }))))("honors the $scope native default on $kind launches", async ({ scope, kind }) => {
    if (scope === "user") settings("auto");
    else {
      mkdirSync(join(dir, ".claude"));
      writeFileSync(join(dir, ".claude", scope === "local" ? "settings.local.json" : "settings.json"),
        JSON.stringify({ permissions: { defaultMode: "auto" } }));
    }
    const commands: string[] = [];
    const tmux = { sendText: vi.fn(async (_target: string, command: string) => { commands.push(command); return { ok: true }; }),
      hasSession: vi.fn(async () => true), getPaneCommand: vi.fn(async () => "claude"),
      capturePaneContent: vi.fn(async () => ""), sendKeys: vi.fn(async () => ({ ok: true })),
    } as unknown as TmuxAdapter;
    if (kind === "restore") {
      await new ClaudeResumeAdapter(tmux, { maxWaitMs: 0 }).resume("worker@fixture", "claude_id", "native-token", dir);
    } else {
      await new ClaudeCodeAdapter({ tmux, fsOps: {
        homedir: dir, readFile: () => JSON.stringify({ name: "worker@fixture", sessionId: "fork-token" }),
        writeFile: () => {}, exists: (path: string) => path.endsWith("sessions"), mkdirp: () => {},
        copyFile: () => {}, listFiles: () => [], readdir: () => ["fixture.json"],
      } as ClaudeAdapterFsOps, sessionIdFactory: () => "11111111-1111-4111-8111-111111111111" }).launchHarness({
        id: "binding", nodeId: "node", tmuxSession: "worker@fixture", tmuxWindow: null, tmuxPane: null,
        cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", cwd: dir,
      }, { name: "worker@fixture", ...(kind === "resume" ? { resumeToken: "native-token" } : {}),
        ...(kind === "fork" ? { forkSource: { kind: "native_id" as const, value: "parent-token" } } : {}) });
    }
    expect(commands).toHaveLength(1);
    expect(commands[0]).not.toContain("--permission-mode");
    expect(commands[0]).not.toContain("--dangerously-skip-permissions");
  });
});
