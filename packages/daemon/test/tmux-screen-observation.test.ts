import { describe, expect, it } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";

function response(argv: string[]) {
  const format = argv.find(arg => arg.includes("#{pane_id}|#{cursor_x}"))!;
  return "after-show-options\nafter-display-message\nafter-capture-pane\n" + format
    .replace("#{pane_id}", "%7").replace("#{cursor_x}", "4").replace("#{cursor_y}", "1")
    .replace("#{pane_width}", "4").replace("#{pane_height}", "2") + "\nabc \n    \n";
}
function adapter(transform: (value: string) => string = value => value) {
  const calls: string[][] = [];
  const tmux = new TmuxAdapter(async () => { throw Error("shell path unused"); }, undefined, async argv => { calls.push(argv); return transform(response(argv)); });
  return { tmux, calls };
}

describe("one-command screen observations", () => {
  it("captures exact same-pane metadata and written spaces without writing pane input, size or options", async () => {
    const { tmux, calls } = adapter();
    expect(await tmux.capturePaneObservation("%7")).toEqual({ cursor: { x: 4, y: 1, width: 4, height: 2 }, snapshot: "abc \n    \n" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.filter(x => x === "%7")).toHaveLength(5);
    expect(calls[0]!.filter(x => x === "show-options")).toHaveLength(4);
    expect(calls[0]).not.toContain("-e"); expect(calls[0]).toContain("-N");
    expect(calls[0]!.join(" ")).not.toMatch(/set-option|resize|send-keys|pipe-pane/);
  });
  it("uses exact dotted session targets on the shell path too", async () => {
    let command = "";
    const tmux = new TmuxAdapter(async cmd => {
      command = cmd;
      // The generated format is a single safe-quoted argument; take it directly.
      const format = cmd.match(/'(__openrig_screen_[a-f0-9]+__\|[^']+)'/)![1]!;
      return response([format]);
    });
    expect((await tmux.capturePaneObservation("proof.codex"))?.snapshot).toBe("abc \n    \n");
    expect(command.match(/-t =proof\.codex:/g)).toHaveLength(5);
    expect(command).toContain("';'");
  });
  it.each(["after-show-options", "after-display-message", "after-capture-pane"])("refuses a nonempty inherited %s hook without returning its body", async hook => {
    const { tmux } = adapter(output => output.replace(`${hook}\n`, `${hook}[9] run-shell 'private-hook-content'\n`));
    expect(await tmux.capturePaneObservation("%7")).toBeNull();
  });
  it.each(["show-options", "display-message", "capture-pane"])("refuses a %s command alias, including the alias reader itself", async command => {
    const { tmux } = adapter(output => `${command}=run-shell 'private-alias-content'; ${command}\n${output}`);
    expect(await tmux.capturePaneObservation("%7")).toBeNull();
  });
  it("allows unrelated aliases, including bodies which mention an observation command", async () => {
    const { tmux, calls } = adapter(output => `splitp=split-window\ncustom=capture-pane -p\n${output}`);
    expect((await tmux.capturePaneObservation("%7"))?.snapshot).toBe("abc \n    \n");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.slice(0, 6)).toEqual(["tmux", "show-options", "-sv", "command-alias", ";", "show-options"]);
  });
  it("refuses malformed alias output rather than claiming an atomic observation", async () => {
    const { tmux } = adapter(output => `unparsed alias output\n${output}`);
    expect(await tmux.capturePaneObservation("%7")).toBeNull();
  });
  it.each([
    (s: string) => s.replace("|%7|", "|%8|"),
    (s: string) => s.replace("|4|1|4|2", "|4x|1|4|2"),
    (s: string) => s.replace("|4|1|4|2", "|4|2|4|2"),
    (s: string) => s.replace("|4|1|4|2", "|5|1|4|2"),
    (s: string) => s.slice(0, -1),
    (s: string) => s + "unexpected output\n",
    (s: string) => s.replace("__openrig_screen_", "__wrong_screen_"),
  ])("refuses mismatched, malformed or incomplete combined observations", async transform => {
    expect(await adapter(transform).tmux.capturePaneObservation("%7")).toBeNull();
  });
  it("contains a failed chain rather than accepting partial stdout", async () => {
    const tmux = new TmuxAdapter(async () => { throw Error("capture failed"); });
    expect(await tmux.capturePaneObservation("proof.codex")).toBeNull();
  });
});
