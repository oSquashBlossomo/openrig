import { describe, expect, it, vi } from "vitest";
import { findExactNativeResumeProcess, observeClaudeDelivery, observeClaudePaneStartedAt, verifyClaudePaneProcess, verifyCodexPaneProcess, type NativeProcessRow } from "../src/domain/native-process-lineage.js";

const token = "00000000-0000-7000-8000-000000000001";
const startedAt = "Sat Jan  1 12:00:00 2000";
function rows(): NativeProcessRow[] {
  return [
    { pid: 10, ppid: 1, pgid: 10, tpgid: 11, executableName: "zsh", command: "-zsh", startedAt },
    { pid: 11, ppid: 10, pgid: 11, tpgid: 11, executableName: "bash", command: "/bin/sh /tmp/openrig-tmux-send.txt", startedAt },
    { pid: 12, ppid: 11, pgid: 11, tpgid: 11, executableName: "node", command: `node /opt/bin/codex resume ${token}`, startedAt },
    { pid: 13, ppid: 12, pgid: 11, tpgid: 11, executableName: "codex", command: `/opt/native/codex -p resume resume --add-dir /tmp/state ${token}`, startedAt },
  ];
}
const check = (listProcesses: () => NativeProcessRow[] | Promise<NativeProcessRow[]>, overrides = {}) => verifyCodexPaneProcess({
  target: "%1", tmux: { getPanePid: async () => 10 }, listProcesses, expectedToken: token, requireResume: true, ...overrides,
});

describe("joined native Codex identity", () => {
  it("selects the unique native process, not its Node wrapper", async () => {
    expect((await check(rows))?.process.pid).toBe(13);
    expect(findExactNativeResumeProcess(rows(), 10, "codex", token)?.pid).toBe(13);
  });
  it("proves direct-native resume", async () => {
    expect((await check(() => [{ ...rows()[3]!, pid: 10, ppid: 1 }]))?.process.pid).toBe(10);
  });
  it("distinguishes fresh/non-strict runtime proof from exact resume", async () => {
    const fresh = () => rows().map(r => r.pid === 13 ? { ...r, command: "/opt/native/codex -m model" } : r);
    expect(await check(fresh)).toBeNull();
    expect(await check(fresh, { requireResume: false })).not.toBeNull();
    expect(await check(rows, { requireResume: false, expectedToken: "different" })).toBeNull();
    expect(await check(rows, { requireResume: true, expectedToken: null })).toBeNull();
    expect(await check(rows, { requireResume: false, expectedToken: null })).toBeNull();
    expect(await check(() => rows().map(r => r.pid === 13 ? { ...r, command: "/opt/native/codex resume --last" } : r), { requireResume: false, expectedToken: null })).toBeNull();
  });
  const controls: [string, (r: NativeProcessRow[]) => NativeProcessRow[]][] = [
    ["wrong UUID", r => r.map(x => x.pid === 13 ? { ...x, command: "/opt/native/codex resume other" } : x)],
    ["missing UUID", r => r.map(x => x.pid === 13 ? { ...x, command: "/opt/native/codex resume" } : x)],
    ["token only in prompt", r => r.map(x => x.pid === 13 ? { ...x, command: `/opt/native/codex resume other ${token}` } : x)],
    ["wrong OS executable", r => r.map(x => x.pid === 13 ? { ...x, executableName: "printf" } : x)],
    ["argv-only executable", r => r.map(x => x.pid === 13 ? { ...x, command: `/bin/echo codex resume ${token}` } : x)],
    ["unrelated descendant", r => r.map(x => x.pid === 13 ? { ...x, ppid: 999 } : x)],
    ["background native", r => r.map(x => x.pid === 13 ? { ...x, pgid: 99 } : x)],
    ["conflicting foreground", r => r.map(x => x.pid === 13 ? { ...x, tpgid: 99 } : x)],
    ["missing root", r => r.slice(1)],
    ["missing ancestry", r => r.filter(x => x.pid !== 11)],
    ["cyclic ancestry", r => r.map(x => x.pid === 11 ? { ...x, ppid: 13 } : x)],
    ["multiple native candidates", r => [...r, { ...r[3]!, pid: 14 }]],
    ["duplicate PID", r => [...r, r[3]!]],
    ["missing start time", r => r.map(x => ({ ...x, startedAt: undefined }))],
    ["missing group", r => r.map(x => ({ ...x, tpgid: undefined }))],
    ["exited native", r => r.filter(x => x.pid !== 13)],
  ];
  it.each(controls)("refuses %s", async (_name, mutate) => {
    expect(await check(() => mutate(rows()))).toBeNull();
  });
  it.each(["startedAt", "command", "ppid", "pgid"] as const)("refuses a changed native %s between observations", async (field) => {
    const changed = rows().map(r => r.pid === 13 ? { ...r, [field]: field === "startedAt" ? "Sat Jan  1 12:00:01 2000" : field === "command" ? r.command + " --verbose" : 99 } : r);
    expect(await check(vi.fn().mockResolvedValueOnce(rows()).mockResolvedValueOnce(changed))).toBeNull();
  });
  it("refuses a reused pane PID even when the native PID is unchanged", async () => {
    const changed = rows().map(r => r.pid === 10 ? { ...r, startedAt: "Sat Jan  1 12:00:01 2000" } : r);
    expect(await check(vi.fn().mockResolvedValueOnce(rows()).mockResolvedValueOnce(changed))).toBeNull();
  });
  it("refuses a changed or missing pane and process observation failures", async () => {
    expect(await check(rows, { tmux: { getPanePid: vi.fn().mockResolvedValueOnce(10).mockResolvedValueOnce(11) } })).toBeNull();
    expect(await check(rows, { tmux: { getPanePid: async () => null } })).toBeNull();
    expect(await check(async () => { throw new Error("ps failed"); })).toBeNull();
  });
  it("retains the existing Claude exact-token contract", () => {
    expect(findExactNativeResumeProcess([{ pid: 10, ppid: 1, command: `claude --resume ${token}` }], 10, "claude-code", token)?.pid).toBe(10);
    expect(findExactNativeResumeProcess([{ pid: 10, ppid: 1, command: "claude --resume wrong" }], 10, "claude-code", token)).toBeNull();
  });
});

describe("observeClaudePaneStartedAt", () => {
  const claudeStart = "Fri Oct  2 11:00:00 2026";
  const claudeRows = (extra: NativeProcessRow[] = []): NativeProcessRow[] => [
    { pid: 20, ppid: 1, pgid: 20, tpgid: 21, executableName: "zsh", command: "-zsh", startedAt },
    { pid: 21, ppid: 20, pgid: 21, tpgid: 21, executableName: "claude", command: "claude --name seat@rig", startedAt: claudeStart },
    ...extra,
  ];
  const observe = (list: NativeProcessRow[], panePid: number | null = 20) =>
    observeClaudePaneStartedAt({ target: "seat@rig", tmux: { getPanePid: async () => panePid }, listProcesses: () => list });

  it("returns the start time of the one Claude process in the pane's foreground, without a token", async () => {
    expect(await observe(claudeRows())).toBe(claudeStart);
  });

  it("is unknown when the pane, the process or a single candidate cannot be established", async () => {
    expect(await observe(claudeRows(), null)).toBeNull();
    expect(await observe(claudeRows().slice(0, 1))).toBeNull();
    expect(await observe(claudeRows([{ pid: 22, ppid: 20, pgid: 21, tpgid: 21, executableName: "claude", command: "claude", startedAt: claudeStart }]))).toBeNull();
  });
});


describe("Claude rewritten process titles", () => {
  const binary = "/fixture/.local/share/claude/versions/2.1.288";
  const processRows = (path: string | undefined = binary): NativeProcessRow[] => [
    { pid: 20, ppid: 1, pgid: 20, tpgid: 21, executableName: "zsh", command: "-zsh", startedAt },
    { pid: 21, ppid: 20, pgid: 21, tpgid: 21, executableName: "2.1.288", command: `claude --resume ${token} --name worker@fixture`, startedAt, ...(path ? { executablePath: path } : {}) },
  ];
  const verify = (listProcesses: () => NativeProcessRow[], selectedExecutable?: string) => verifyClaudePaneProcess({
    target: "%fixture", tmux: { getPanePid: async () => 20 }, listProcesses, expectedToken: token, selectedExecutable,
  });
  it("joins the renamed title to its versioned OS executable and exact conversation", async () => {
    expect((await verify(processRows))?.process.pid).toBe(21);
    expect((await verify(processRows, binary))?.process.pid).toBe(21);
  });
  it.each([undefined, "/tmp/2.1.288", "/fixture/.local/share/claude/versions/2.1.284", "/fixture/.local/share/claude/versions/../2.1.288"])("requires a matching native installed executable path (%s)", async path => {
    expect(await verify(() => processRows(path === undefined ? "" : path))).toBeNull();
  });
  it("does not replace the frozen launch binary with a later installation", async () => {
    expect(await verify(processRows, "/fixture/.local/share/claude/versions/2.1.284")).toBeNull();
  });
  it("rejects executable path changes between the two observations", async () => {
    const changed = processRows("/other/.local/share/claude/versions/2.1.288");
    expect(await verify(vi.fn().mockReturnValueOnce(processRows()).mockReturnValueOnce(changed))).toBeNull();
  });
});

describe("Claude advisor launch identity", () => {
  const native = (options: string): NativeProcessRow[] => [{ pid: 10, ppid: 1, pgid: 10, tpgid: 10, executableName: "claude", startedAt, command: `claude --effort xhigh ${options} --resume ${token}` }];
  const proof = (options: string) => verifyClaudePaneProcess({ target: "%1", tmux: { getPanePid: async () => 10 }, listProcesses: () => native(options), expectedToken: token });
  it("accepts the advisor override alone or merged into launch-only operational settings", async () => {
    expect((await proof(`--settings '{"advisorModel":"claude-fable-5-1"}'`))?.process.pid).toBe(10);
    expect((await proof(`--settings '{"advisorModel":""}'`))?.process.pid).toBe(10);
    expect((await proof(`--settings '{"permissions":{"allow":["Bash(rig:*)"]},"advisorModel":"claude-fable-5-1"}'`))?.process.pid).toBe(10);
    expect((await proof(`--settings '{"skipDangerousModePermissionPrompt":true,"advisorModel":"claude-fable-5-1"}'`))?.process.pid).toBe(10);
  });
  it.each([`--settings '{"permissions":{"defaultMode":"auto"}}'`, `--settings broken`, `--settings /inert/settings.json`, `--settings '{"advisorModel":true}'`, `--settings '{"advisorModel":"x","extra":1}'`, `--settings '{"skipDangerousModePermissionPrompt":false}'`, `--settings '{"permissions":{"allow":[true]}}'`, `--settings '{"advisorModel":"x"}' --settings '{"advisorModel":"y"}'`, `--effort invalid`, `--effort high --effort xhigh`, `--fork-session`, `--settings`])("rejects indeterminate or conflicting native options: %s", async options => {
    expect(await proof(options)).toBeNull();
  });
  it.each(["ultracode", "High"])("does not validate a single effort level (%s) while proving or observing identity", async effort => {
    const rows: NativeProcessRow[] = [{ pid: 10, ppid: 1, pgid: 10, tpgid: 10, executableName: "claude", startedAt, command: `claude --effort ${effort} --resume ${token}` }];
    const input = { target: "%1", tmux: { getPanePid: async () => 10 }, listProcesses: () => rows, expectedToken: token };
    expect((await verifyClaudePaneProcess(input))?.process.pid).toBe(10);
    expect((await observeClaudeDelivery(input)).state).toBe("verified");
  });
});
