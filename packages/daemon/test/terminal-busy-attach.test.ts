import { afterEach, expect, it, vi } from "vitest";
import { appendFileSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { TerminalSessionBroker, type BrokerTmux, type TerminalSubscriber } from "../src/terminal/TerminalSessionBroker.js";
const { Terminal } = createRequire(import.meta.url)("@xterm/xterm") as typeof import("@xterm/xterm");

const brokers: TerminalSessionBroker[] = [];
afterEach(() => { brokers.splice(0).forEach(b => b.dispose()); });
function viewer() {
  const output: string[] = [], closed: unknown[] = [], geometry: unknown[] = [];
  const sub: TerminalSubscriber = { send: s => output.push(s), close: (code, reason) => closed.push({ code, reason }), geometry: (cols, rows) => geometry.push({ cols, rows }) };
  return { sub, output, closed, geometry };
}
function fixture(plain = false, cursor = { x: 7, y: 1, width: 90, height: 27 }) {
  let busy = false, frame = 0, observations = 0;
  let broker: TerminalSessionBroker;
  const stop = vi.fn(async () => ({ ok: true as const }));
  const capture = () => {
    observations++;
    if (busy) appendFileSync(broker.pipeOutputPath!, plain ? `FRAME-${++frame}\n` : `\x1b[2;1HFRAME-${++frame}`);
    return `HEADER\nFRAME-${frame}\n`;
  };
  const tmux: BrokerTmux = {
    hasSession: async () => true, startPipePane: async () => ({ ok: true }), stopPipePane: stop,
    sendKeys: vi.fn(async () => ({ ok: true })), sendText: vi.fn(async () => ({ ok: true })),
    getPaneCursorPosition: async () => cursor, capturePaneScreen: async () => capture(), capturePaneContent: async () => "OLDER\nHISTORY\n",
    capturePaneObservation: async () => ({ snapshot: capture(), cursor }),
  };
  broker = new TerminalSessionBroker("busy@fixture", tmux, { pollMs: 5, geometryMs: 50 });
  brokers.push(broker);
  return { broker, tmux, stop, setBusy: (value: boolean) => { busy = value; }, frames: () => frame, observations: () => observations };
}

it("admits a continuously busy first viewer with authoritative snapshots and no unfenced deltas", async () => {
  const f = fixture(), a = viewer(); f.setBusy(true);
  await f.broker.attach(a.sub);
  expect(a.closed).toEqual([]); expect(f.broker.subscriberCount).toBe(1);
  await vi.waitFor(() => expect(a.output.length).toBeGreaterThanOrEqual(4));
  expect(a.output.every(s => s.startsWith("\x1b[2J"))).toBe(true);
  const delivered = a.output.map(s => Number(s.match(/FRAME-(\d+)/)![1]));
  expect(delivered).toEqual(Array.from({ length: delivered.length }, (_, index) => index + 1));
  expect(f.tmux.sendKeys).not.toHaveBeenCalled(); expect(f.tmux.sendText).not.toHaveBeenCalled();
  expect(f.stop).not.toHaveBeenCalled();
});

it("keeps the existing raw viewer exact while a second busy viewer uses snapshots, then joins only at the fence", async () => {
  const f = fixture(), live = viewer(), joining = viewer();
  await f.broker.attach(live.sub); live.output.length = 0;
  f.setBusy(true); await f.broker.attach(joining.sub);
  expect(joining.closed).toEqual([]);
  await vi.waitFor(() => expect(f.frames()).toBeGreaterThanOrEqual(4));
  expect(joining.output.every(s => s.startsWith("\x1b[2J"))).toBe(true);
  const count = f.frames();
  f.setBusy(false);
  await vi.waitFor(() => {
    for (let n = 1; n <= count; n++) expect(live.output.join("").split(`FRAME-${n}`)).toHaveLength(2);
  });
  await vi.waitFor(() => expect(joining.output.filter(s => s.includes(`FRAME-${count}`)).length).toBeGreaterThan(1));
  appendFileSync(f.broker.pipeOutputPath!, "AFTER_FENCE");
  await vi.waitFor(() => expect(joining.output.filter(s => s === "AFTER_FENCE")).toHaveLength(1));
  expect(live.output.filter(s => s === "AFTER_FENCE")).toHaveLength(1);
  expect([live.closed, joining.closed]).toEqual([[], []]);
});

it("returns a history viewer to busy live snapshots without a quiet-screen refusal", async () => {
  const f = fixture(), a = viewer(); await f.broker.attach(a.sub);
  await f.broker.scroll(a.sub, 2); f.setBusy(true);
  a.output.length = 0; await f.broker.scroll(a.sub, 0);
  await vi.waitFor(() => expect(a.output.length).toBeGreaterThanOrEqual(4));
  expect(a.closed).toEqual([]); expect(a.output.every(s => s.startsWith("\x1b[2J"))).toBe(true);
  f.setBusy(false);
  // A snapshot already in flight is not evidence that the quiet fence completed.
  const state = f.broker as unknown as { snapshotOnly: Map<TerminalSubscriber, unknown> };
  await vi.waitFor(() => expect(state.snapshotOnly.has(a.sub)).toBe(false));
  appendFileSync(f.broker.pipeOutputPath!, "HISTORY_RETURN_RAW");
  await vi.waitFor(() => expect(a.output).toContain("HISTORY_RETURN_RAW"));
  expect(a.output.join("")).not.toContain("\x1b[3J");
});

it("stops busy snapshots, its pipe and all observation work after the last detach", async () => {
  const f = fixture(), a = viewer(); f.setBusy(true); await f.broker.attach(a.sub);
  expect(a.closed).toEqual([]); f.broker.detach(a.sub);
  await f.broker.waitForShutdown(); const before = f.observations();
  await new Promise(resolve => setTimeout(resolve, 120));
  expect(f.observations()).toBe(before); expect(f.stop).toHaveBeenCalledOnce(); expect(f.broker.pipeOutputPath).toBeNull();
});


it("retains the quiet-only fence when the atomic observation is unsupported (including configured hooks)", async () => {
  const f = fixture(), a = viewer(); f.tmux.capturePaneObservation = async () => null;
  await f.broker.attach(a.sub);
  expect(a.closed).toEqual([]); expect(a.output.at(-1)).toContain("HEADER");
});

it("does not admit a busy viewer without a proved atomic observation", async () => {
  const f = fixture(), a = viewer(); f.tmux.capturePaneObservation = async () => null; f.setBusy(true);
  await f.broker.attach(a.sub);
  expect(a.closed).toEqual([{ code: 1011, reason: "terminal screen remained busy; reopen to retry" }]);
  expect(a.output.some(s => s.startsWith("\x1b[2J"))).toBe(false);
});

it("pairs a busy snapshot with its captured cursor and geometry, never a later probe", async () => {
  const f = fixture(), a = viewer(); f.setBusy(true);
  f.tmux.getPaneCursorPosition = async () => ({ x: 17, y: 4, width: 110, height: 30 });
  await f.broker.attach(a.sub);
  expect(a.geometry).toEqual([{ cols: 90, rows: 27 }]);
  expect(a.output.at(-1)).toMatch(/\x1b\[2;8H$/);
});

it("does not overwrite a newer history selection with an older pending busy snapshot", async () => {
  const f = fixture(), a = viewer(); f.setBusy(true); await f.broker.attach(a.sub);
  await f.broker.scroll(a.sub, 2); a.output.length = 0;
  await new Promise(resolve => setTimeout(resolve, 120));
  expect(a.output).toEqual([]); expect(a.closed).toEqual([]);
});

it("bounds a lost atomic proof for a snapshot-only viewer without closing an existing raw viewer", async () => {
  const f = fixture(), live = viewer(), joining = viewer(); await f.broker.attach(live.sub);
  f.setBusy(true); await f.broker.attach(joining.sub);
  f.tmux.capturePaneObservation = async () => null;
  await vi.waitFor(() => expect(joining.closed).toEqual([{ code: 1011, reason: "terminal screen remained busy; reopen to retry" }]));
  expect(live.closed).toEqual([]); expect(f.broker.subscriberCount).toBe(1);
});


it("defers safe newcomer history replay until the quiet fence and sends it once", async () => {
  const f = fixture(true), live = viewer(), joining = viewer(); await f.broker.attach(live.sub);
  appendFileSync(f.broker.pipeOutputPath!, "EARLIER\n");
  await vi.waitFor(() => expect(live.output).toContain("EARLIER\n"));
  f.setBusy(true); await f.broker.attach(joining.sub);
  expect(joining.output.every(s => s.startsWith("\x1b[2J"))).toBe(true);
  f.setBusy(false);
  await vi.waitFor(() => expect(joining.output.filter(s => !s.startsWith("\x1b[2J") && s.includes("EARLIER"))).toHaveLength(1));
  await new Promise(resolve => setTimeout(resolve, 120));
  expect(joining.output.filter(s => s.includes("EARLIER"))).toHaveLength(1);
});

it("replays deferred history into a clean xterm buffer, without temporary snapshots entering scrollback", async () => {
  const f = fixture(true, { x: 7, y: 1, width: 24, height: 4 }), live = viewer(), joining = viewer();
  await f.broker.attach(live.sub);
  const earlier = Array.from({ length: 8 }, (_, n) => `EARLIER-${n}\r\n`).join("");
  appendFileSync(f.broker.pipeOutputPath!, earlier);
  await vi.waitFor(() => expect(live.output).toContain(earlier));
  const observe = f.tmux.capturePaneObservation!;
  f.tmux.capturePaneObservation = async name => {
    const screen = (await observe(name))!;
    return { ...screen, snapshot: `\x1b[31;44m${screen.snapshot}` };
  };
  f.setBusy(true); await f.broker.attach(joining.sub);
  await vi.waitFor(() => expect(joining.output.length).toBeGreaterThanOrEqual(3));
  f.setBusy(false);
  await vi.waitFor(() => expect(joining.output.filter(s => s.includes("EARLIER-0"))).toHaveLength(1));
  const retainedHistory = readFileSync(f.broker.pipeOutputPath!, "utf8");
  const finalSnapshot = joining.output.at(-1)!;
  expect(finalSnapshot).toMatch(/^\x1b\[2J/);
  appendFileSync(f.broker.pipeOutputPath!, "AFTER_FENCE\r\n");
  await vi.waitFor(() => expect(joining.output).toContain("AFTER_FENCE\r\n"));
  const actual = new Terminal({ cols: 24, rows: 4 }), fresh = new Terminal({ cols: 24, rows: 4 });
  const write = (term: typeof actual, data: string) => new Promise<void>(resolve => term.write(data, resolve));
  const buffer = (term: typeof actual) => ({
    rows: Array.from({ length: term.buffer.active.length }, (_, row) => {
      const line = term.buffer.active.getLine(row)!, cell = line.getCell(0)!;
      return { text: line.translateToString(true), fg: [cell.getFgColorMode(), cell.getFgColor()], bg: [cell.getBgColorMode(), cell.getBgColor()] };
    }),
    baseY: term.buffer.active.baseY, cursorX: term.buffer.active.cursorX, cursorY: term.buffer.active.cursorY,
  });
  try {
    for (const data of joining.output) await write(actual, data);
    await write(fresh, retainedHistory + finalSnapshot + "AFTER_FENCE\r\n");
    expect(buffer(actual)).toEqual(buffer(fresh));
    expect(joining.output.filter(s => s.includes("EARLIER-0"))).toHaveLength(1);
    expect(joining.output.filter(s => s === "AFTER_FENCE\r\n")).toHaveLength(1);
    expect(live.output.filter(s => s === "AFTER_FENCE\r\n")).toHaveLength(1);
    expect(live.output.join("")).not.toContain("\x1b[3J");
    expect([live.closed, joining.closed]).toEqual([[], []]);
  } finally { actual.dispose(); fresh.dispose(); }
});


it("rechecks the seed fence after draining bytes that arrive after the observation", async () => {
  const f = fixture(), a = viewer();
  f.tmux.capturePaneObservation = async () => ({ snapshot: `BASELINE${readFileSync(f.broker.pipeOutputPath!, "utf8")}\n`, cursor: { x: 7, y: 1, width: 90, height: 27 } });
  // Inject at the real boundary: the final pre-tail stat saw the old size,
  // but native output arrives before readTail consumes the file.
  const internal = f.broker as unknown as { pipeSize(): number };
  const pipeSize = internal.pipeSize.bind(f.broker);
  let reads = 0;
  internal.pipeSize = () => {
    const size = pipeSize();
    if (++reads === 3) appendFileSync(f.broker.pipeOutputPath!, "POST_SNAPSHOT");
    return size;
  };
  await f.broker.attach(a.sub);
  appendFileSync(f.broker.pipeOutputPath!, "NEXT");
  await vi.waitFor(() => expect(a.output.some(s => s.startsWith("\x1b[2J") && s.includes("POST_SNAPSHOTNEXT"))).toBe(true));
  expect(a.output).not.toContain("NEXT");
  expect(a.closed).toEqual([]);
});
