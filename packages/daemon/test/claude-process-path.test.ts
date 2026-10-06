import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listNativeProcesses, verifyClaudePaneProcess } from "../src/domain/native-process-lineage.js";

let dir: string | undefined;
afterEach(() => { vi.unstubAllEnvs(); if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });
const binary = "/fixture/.local/share/claude/versions/2.1.288";
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
function install(lsof: string) {
  dir = mkdtempSync(join(tmpdir(), "claude-executable-path-"));
  const ps = ["PID PPID PGID TPGID UCOMM LSTART COMMAND",
    "20 1 20 21 zsh Sat Jan  1 12:00:00 2000 -zsh",
    "21 20 21 21 2.1.288 Sat Jan  1 12:00:00 2000 claude --session-id fixture-token --name worker@fixture",
    "22 1 22 22 codex Sat Jan  1 12:00:00 2000 codex resume other-token",
  ];
  writeFileSync(join(dir, "ps"), `#!/bin/sh\nprintf '%s\n' ${ps.map(quote).join(" ")}\n`, { mode: 0o755 });
  writeFileSync(join(dir, "lsof"), `#!/bin/sh\nprintf '%s\n' "$@" > ${quote(join(dir, "args"))}\n${lsof}\n`, { mode: 0o755 });
  vi.stubEnv("PATH", dir);
}
const output = (lines: string[]) => `printf '%s\n' ${lines.map(quote).join(" ")}`;
describe.skipIf(process.platform !== "darwin")("Darwin Claude executable-path census", () => {
  it("batches renamed candidates and joins only their own OS executable mapping", async () => {
    install(output(["p21", `n${binary}`, "n/usr/lib/libSystem.B.dylib"]));
    const rows = await listNativeProcesses();
    expect(rows.find(row => row.pid === 21)).toMatchObject({ executablePath: binary });
    expect(rows.find(row => row.pid === 22)).not.toHaveProperty("executablePath");
    expect(readFileSync(join(dir!, "args"), "utf8")).toContain("-p\n21\n");
    expect((await verifyClaudePaneProcess({ target: "%fixture", tmux: { getPanePid: async () => 20 }, listProcesses: listNativeProcesses, expectedToken: "fixture-token" }))?.process.pid).toBe(21);
  });
  it.each([
    ["unavailable", "exit 1"],
    ["timeout", "exec /bin/sleep 5"],
    ["missing", output(["p21"])],
    ["wrong PID", output(["p99", `n${binary}`])],
    ["wrong executable", output(["p21", "n/tmp/2.1.288", `n${binary}`])],
    ["ambiguous", output(["p21", `n${binary}`, "n/other/.local/share/claude/versions/2.1.288"])],
  ])("keeps %s executable evidence non-positive", async (_name, script) => {
    install(script);
    const rows = await listNativeProcesses();
    expect(rows).toHaveLength(3);
    expect(rows.find(row => row.pid === 21)).not.toHaveProperty("executablePath");
    expect(await verifyClaudePaneProcess({ target: "%fixture", tmux: { getPanePid: async () => 20 }, listProcesses: listNativeProcesses, expectedToken: "fixture-token" })).toBeNull();
  });
});
