import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("preserves native terminal UTF-8 output split across pipe polls for live and late viewers", () => {
  const home = mkdtempSync(join(tmpdir(), "openrig-terminal-utf8-"));
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx",
      fileURLToPath(new URL("./fixtures/terminal-pipe-utf8.mjs", import.meta.url)), home, resolve(import.meta.dirname, "../../.."),
    ], { env: { ...process.env, HOME: home, TMUX: "" }, encoding: "utf8", timeout: 15000 });
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({ nativeTmux: true, splitFourByteCharacter: true, liveAndLateSubscribers: true });
  } finally { rmSync(home, { recursive: true, force: true }); }
}, 20000);
