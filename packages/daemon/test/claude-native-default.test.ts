import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { claudePostureFlag, codexPostureArg } from "../src/adapters/yolo-mode.js";
import { ClaudeCodeAdapter, type ClaudeAdapterFsOps } from "../src/adapters/claude-code-adapter.js";
import { ClaudeResumeAdapter } from "../src/adapters/claude-resume.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "openrig-native-default-"));
  vi.stubEnv("CLAUDE_CONFIG_DIR", dir);
  vi.stubEnv("OPENRIG_YOLO", "0");
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });
const settings = (defaultMode: string) => writeFileSync(join(dir, "settings.json"), JSON.stringify({ permissions: { defaultMode, deny: ["Read(.env)"] } }));

describe("Claude native auto default", () => {
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
  it("keeps the floor for absent or other defaults and reports unreadable settings", () => {
    expect(claudePostureFlag(process.env, "floor")).toBe("--permission-mode acceptEdits");
    settings("manual");
    expect(claudePostureFlag(process.env, "floor")).toBe("--permission-mode acceptEdits");
    writeFileSync(join(dir, "settings.json"), "invalid JSON");
    expect(() => claudePostureFlag(process.env, "floor")).toThrow();
  });
  it.each(["fresh", "resume", "fork", "restore"])("honors the native default on %s launches", async kind => {
    settings("auto");
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
