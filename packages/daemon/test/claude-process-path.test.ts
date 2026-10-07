import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile: Object.assign(vi.fn(), {
  [Symbol.for("nodejs.util.promisify.custom")]: execute,
}) }));
import { listNativeProcesses, verifyClaudePaneProcess } from "../src/domain/native-process-lineage.js";

const platform = process.platform;
const binary = "/fixture/.local/share/claude/versions/2.1.288";
const rows = ["PID PPID PGID TPGID UCOMM LSTART COMMAND",
  "20 1 20 21 zsh Sat Jan  1 12:00:00 2000 -zsh",
  "21 20 21 21 2.1.288 Sat Jan  1 12:00:00 2000 claude --session-id fixture-token --name worker@fixture",
  "22 1 22 22 codex Sat Jan  1 12:00:00 2000 codex resume other-token",
];
beforeEach(() => {
  vi.resetAllMocks();
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
});
afterEach(() => { Object.defineProperty(process, "platform", { value: platform, configurable: true }); });

function census(paths: unknown, ps = rows) {
  execute.mockImplementation(async (file: string) => {
    if (file === "ps") return { stdout: ps.join("\n") };
    if (file !== "/usr/bin/osascript") throw new Error(`Unexpected executable: ${file}`);
    if (paths instanceof Error) throw paths;
    return { stdout: JSON.stringify(paths) };
  });
}
const verify = () => verifyClaudePaneProcess({ target: "%fixture", tmux: { getPanePid: async () => 20 },
  listProcesses: listNativeProcesses, expectedToken: "fixture-token" });

describe("Darwin Claude executable-path census", () => {
  it("batches renamed candidates and joins only their own OS executable mapping", async () => {
    census([[21, binary]]);
    const processes = await listNativeProcesses();
    expect(processes.find(row => row.pid === 21)).toMatchObject({ executablePath: binary });
    expect(processes.find(row => row.pid === 22)?.executablePath).toBeUndefined();
    const lookup = execute.mock.calls.find(([file]) => file === "/usr/bin/osascript")!;
    expect(lookup[1].slice(4)).toEqual(["21"]);
    expect(lookup[2]).toMatchObject({ timeout: 2000, maxBuffer: 1048576 });
    expect((await verify())?.process.pid).toBe(21);
  });

  it.each([
    ["unavailable", new Error("ENOENT")],
    ["timeout", Object.assign(new Error("timed out"), { killed: true, signal: "SIGTERM" })],
    ["missing", [[21, null]]],
    ["wrong PID", [[99, binary]]],
  ])("keeps %s executable evidence non-positive", async (_name, paths) => {
    census(paths);
    const processes = await listNativeProcesses();
    expect(processes).toHaveLength(3);
    expect(processes.find(row => row.pid === 21)?.executablePath).toBeUndefined();
    expect(await verify()).toBeNull();
  });

  it("refuses a version-named process whose OS executable is unrelated", async () => {
    census([[21, "/tmp/2.1.288"]]);
    expect((await listNativeProcesses()).find(row => row.pid === 21)?.executablePath).toBe("/tmp/2.1.288");
    expect(await verify()).toBeNull();
  });

  it("refuses multiple verified Claude processes in the pane foreground", async () => {
    census([[21, binary], [23, binary]], [...rows,
      "23 20 21 21 2.1.288 Sat Jan  1 12:00:00 2000 claude --session-id fixture-token --name worker@fixture",
    ]);
    expect(await verify()).toBeNull();
  });
});
