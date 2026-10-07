import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { listNativeProcesses, type NativeProcessRow } from "../src/domain/native-process-lineage.js";
import { startupRevision } from "../src/routes/startup.js";

vi.mock("../src/domain/kernel-boot.js", async (original) => ({
  ...await original<typeof import("../src/domain/kernel-boot.js")>(),
  defaultProbeRuntimes: vi.fn(async () => ({ codex: "ok", claudeCode: "ok" })),
}));
vi.mock("../src/domain/native-process-lineage.js", async (original) => ({
  ...await original<typeof import("../src/domain/native-process-lineage.js")>(),
  listNativeProcesses: vi.fn(),
}));

const token = "11111111-1111-4111-8111-111111111111";
const rotatedToken = "22222222-2222-4222-8222-222222222222";
const sessionName = "proof-claude@selected";
const autoScreen = "A native reply\n❯\u00a0\n  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents\n";

describe("startup view observes Claude's exact current native identity", () => {
  let db: ReturnType<typeof createFullTestDb>;
  let setup: ReturnType<typeof createTestApp>;
  let dir: string;
  let rows: NativeProcessRow[];
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "startup-claude-identity-"));
    vi.stubEnv("CLAUDE_CONFIG_DIR", dir);
    db = createFullTestDb();
    setup = createTestApp(db);
    rows = [
      { pid: 20, ppid: 1, pgid: 20, tpgid: 21, executableName: "sh", command: "/bin/sh", startedAt: "2000-01-01T12:00:00Z" },
      { pid: 21, ppid: 20, pgid: 21, tpgid: 21, executableName: "2.1.292",
        executablePath: "/fixture/.local/share/claude/versions/2.1.292",
        command: `claude --session-id ${token} --name ${sessionName}`, startedAt: "2000-01-01T12:00:01Z" },
    ];
    vi.mocked(listNativeProcesses).mockReset().mockImplementation(async () => rows);
    setup.tmuxAdapter.probeSession = vi.fn(async () => ({ state: "present" as const }));
    setup.tmuxAdapter.listPanes = vi.fn(async () => [{ id: "%1", index: 0 }]);
    setup.tmuxAdapter.getPanePid = vi.fn(async () => 20);
    setup.tmuxAdapter.getPaneCommand = vi.fn(async () => "2.1.292");
    setup.tmuxAdapter.capturePaneScreen = vi.fn(async () => autoScreen);
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); db.close(); rmSync(dir, { recursive: true, force: true }); });

  function seat() {
    const rig = setup.rigRepo.createRig("selected");
    const node = setup.rigRepo.addNode(rig.id, "proof.claude", { runtime: "claude-code", cwd: dir, model: "claude-opus-5-5" });
    const session = setup.sessionRegistry.registerSession(node.id, sessionName);
    setup.sessionRegistry.updateStatus(session.id, "running");
    setup.sessionRegistry.updateBinding(node.id, { tmuxSession: sessionName, tmuxPane: "%1" });
    setup.sessionRegistry.updateResumeToken(session.id, "claude_id", token, "hook");
    return { rig, node, session };
  }
  async function observed(rigId: string) {
    const response = await setup.app.request(`/api/startup/${rigId}`);
    expect(response.status).toBe(200);
    return (await response.json()).seats[0].observed;
  }

  it.each(["--session-id", "--resume"])("reports a verified %s auto session running without changing history or sending input", async (flag) => {
    const { rig, node, session } = seat();
    rows[1]!.command = `claude ${flag} ${token} --name ${sessionName}`;
    const before = setup.sessionRegistry.getSessionsForRig(rig.id);
    expect(await observed(rig.id)).toMatchObject({ state: "running", sessionName });
    const response = await setup.app.request(`/api/startup/${rig.id}/${node.logicalId}`, { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "start", revision: startupRevision(db, node) }) });
    expect(await response.json()).toMatchObject({ ok: true, code: "running" });
    expect(setup.sessionRegistry.getSessionsForRig(rig.id)).toEqual(before);
    expect(setup.sessionRegistry.resumeTokenMatches(session.id, "claude_id", token)).toBe(true);
    expect(setup.tmuxAdapter.createSession).not.toHaveBeenCalled();
    expect(setup.tmuxAdapter.sendText).not.toHaveBeenCalled();
    expect(setup.tmuxAdapter.sendKeys).not.toHaveBeenCalled();
  });

  it("recognizes a verified composer with placeholder text", async () => {
    const { rig } = seat();
    vi.mocked(setup.tmuxAdapter.capturePaneScreen).mockResolvedValue(autoScreen.replace("❯\u00a0", "❯ Try a question"));
    expect(await observed(rig.id)).toMatchObject({ state: "running" });
  });

  it("uses the exact current PID record after a hook-provenance token rotation", async () => {
    const { rig, session } = seat();
    setup.sessionRegistry.updateResumeToken(session.id, "claude_id", rotatedToken, "hook");
    mkdirSync(join(dir, "sessions"));
    writeFileSync(join(dir, "sessions", "21.json"), JSON.stringify({ name: sessionName, sessionId: rotatedToken }));
    expect(await observed(rig.id)).toMatchObject({ state: "running" });
  });

  it("ignores a later historical row when one running occupant has exact identity", async () => {
    const { rig, node } = seat();
    const old = setup.sessionRegistry.registerSession(node.id, sessionName);
    setup.sessionRegistry.updateResumeToken(old.id, "claude_id", rotatedToken, "hook");
    setup.sessionRegistry.markSuperseded(old.id);
    expect(await observed(rig.id)).toMatchObject({ state: "running" });
  });

  it.each(["missing token", "wrong token", "wrong runtime token", "historical only", "ambiguous occupants", "wrong executable", "background process", "changing process"])("does not promote %s", async (kind) => {
    const { rig, node, session } = seat();
    if (kind === "missing token") setup.sessionRegistry.clearResumeToken(session.id);
    if (kind === "wrong token") setup.sessionRegistry.updateResumeToken(session.id, "claude_id", rotatedToken, "hook");
    if (kind === "wrong runtime token") setup.sessionRegistry.updateResumeToken(session.id, "codex_id", token, "hook");
    if (kind === "historical only") setup.sessionRegistry.markSuperseded(session.id);
    if (kind === "ambiguous occupants") setup.sessionRegistry.updateStatus(setup.sessionRegistry.registerSession(node.id, sessionName).id, "running");
    if (kind === "wrong executable") rows[1]!.executablePath = "/tmp/2.1.292";
    if (kind === "background process") rows[1]!.pgid = 99;
    if (kind === "changing process") vi.mocked(listNativeProcesses).mockResolvedValueOnce(rows.map(row => ({ ...row })))
      .mockImplementation(async () => rows.map(row => ({ ...row, startedAt: "2001-01-01T12:00:00Z" })));
    expect(await observed(rig.id)).toMatchObject({ state: "attention_required" });
  });

  it.each([
    ["Accessing workspace:\nYes, I trust this folder", "workspace trust"],
    ["Not logged in · Run /login", "logs in"],
    ["new MCP servers found in .mcp.json\nSelect any you wish to enable\nEnter to confirm", "MCP server approval"],
    ["How would you like to resume?\n❯ Resume from summary\n  Resume full session as-is", "resume-selection"],
    ["Running in Bypass Permissions mode.\n❯ No, exit\nYes, I accept\nEnter to confirm · Esc to cancel", "bypass-permissions warning"],
  ])("keeps the genuine native gate: %s", async (gate, detail) => {
    const { rig } = seat();
    vi.mocked(setup.tmuxAdapter.capturePaneScreen).mockResolvedValue(`${autoScreen}\n${gate}`);
    expect(await observed(rig.id)).toMatchObject({ state: "attention_required", detail: expect.stringContaining(detail) });
    expect(listNativeProcesses).not.toHaveBeenCalled();
  });

  it("does not reuse an earlier ready screen when a native gate appears during identity verification", async () => {
    const { rig } = seat();
    vi.mocked(setup.tmuxAdapter.capturePaneScreen).mockResolvedValueOnce(autoScreen)
      .mockResolvedValue("Accessing workspace:\nYes, I trust this folder");
    expect(await observed(rig.id)).toMatchObject({ state: "attention_required", detail: expect.stringContaining("workspace trust") });
  });

  it("refuses a different sole pane after the process proof", async () => {
    const { rig } = seat();
    vi.mocked(setup.tmuxAdapter.listPanes).mockResolvedValueOnce([{ id: "%1", index: 0 }])
      .mockResolvedValue([{ id: "%2", index: 0 }]);
    expect((await observed(rig.id)).state).not.toBe("running");
  });

  it("keeps unavailable native process evidence non-positive", async () => {
    const { rig } = seat();
    vi.mocked(listNativeProcesses).mockRejectedValue(new Error("native process census unavailable"));
    expect(await observed(rig.id)).toMatchObject({ state: "attention_required" });
  });

  it("does not promote a token replaced during the native census", async () => {
    const { rig, session } = seat();
    vi.mocked(listNativeProcesses).mockImplementation(async () => {
      setup.sessionRegistry.updateResumeToken(session.id, "claude_id", rotatedToken, "hook");
      return rows;
    });
    expect(await observed(rig.id)).toMatchObject({ state: "attention_required" });
  });

  it.each(["retired occupant", "second running occupant", "changed binding"])("does not promote a %s introduced during the native census", async (change) => {
    const { rig, node, session } = seat();
    vi.mocked(listNativeProcesses).mockImplementation(async () => {
      if (change === "retired occupant") setup.sessionRegistry.markSuperseded(session.id);
      if (change === "second running occupant") setup.sessionRegistry.updateStatus(setup.sessionRegistry.registerSession(node.id, sessionName).id, "running");
      if (change === "changed binding") setup.sessionRegistry.updateBinding(node.id, { tmuxSession: "other-claude@selected", tmuxPane: "%2" });
      return rows;
    });
    expect((await observed(rig.id)).state).not.toBe("running");
  });
});
