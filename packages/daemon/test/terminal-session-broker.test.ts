import { describe, it, expect, vi, afterEach } from "vitest";
import * as fs from "node:fs";
import {
  TerminalSessionBroker,
  TerminalBrokerRegistry,
  screenSnapshotEscape,
  cursorPositionEscape,
  type BrokerTmux,
  type TerminalSubscriber,
} from "../src/terminal/TerminalSessionBroker.js";

// ---- test doubles -----------------------------------------------------------

interface FakeSub extends TerminalSubscriber {
  received: string[];
  closed: { code: number; reason: string }[];
}

function makeSub(): FakeSub {
  const received: string[] = [];
  const closed: { code: number; reason: string }[] = [];
  return {
    received,
    closed,
    send: (d: string) => { received.push(d); },
    close: (code: number, reason: string) => { closed.push({ code, reason }); },
  };
}

function makeTmux(overrides: Partial<BrokerTmux> = {}): BrokerTmux {
  return {
    hasSession: async () => true,
    setWindowOption: async () => ({ ok: true }),
    resizeWindow: async () => ({ ok: true }),
    startPipePane: async () => ({ ok: true }),
    stopPipePane: async () => ({ ok: true }),
    sendKeys: async () => ({ ok: true }),
    sendText: async () => ({ ok: true }),
    capturePaneScreen: async () => "",
    getPaneCursorPosition: async () => ({ x: 0, y: 0, width: 90, height: 27 }),
    capturePaneContent: async () => null,
    ...overrides,
  };
}

// Track brokers created so we always tear down (clears intervals + temp files).
const liveBrokers: TerminalSessionBroker[] = [];
function track(b: TerminalSessionBroker): TerminalSessionBroker {
  liveBrokers.push(b);
  return b;
}
afterEach(() => {
  for (const b of liveBrokers.splice(0)) b.dispose();
});

// ---- pure cursor-safe seed helpers (test #9 row-drift discriminator) --------

describe("cursor-safe seed helpers", () => {
  it("cursorPositionEscape emits a 1-based absolute cursor move", () => {
    expect(cursorPositionEscape(0, 0)).toBe("\x1b[1;1H");
    expect(cursorPositionEscape(4, 7)).toBe("\x1b[8;5H");
  });

  it("screenSnapshotEscape paints each row with an ABSOLUTE move (no row drift)", () => {
    const out = screenSnapshotEscape("alpha\nbeta\ngamma", { x: 2, y: 1, height: 24 });
    expect(out.startsWith("\x1b[2J")).toBe(true);
    expect(out).toContain("\x1b[1;1Halpha");
    expect(out).toContain("\x1b[2;1Hbeta");
    expect(out).toContain("\x1b[3;1Hgamma");
    expect(out.endsWith(cursorPositionEscape(2, 1))).toBe(true);
  });

  it("keeps only the last `height` rows when rows exceed height (scroll-safe)", () => {
    const out = screenSnapshotEscape(["r1", "r2", "r3", "r4", "r5"].join("\n"), { x: 0, y: 0, height: 2 });
    expect(out).not.toContain("r1");
    expect(out).not.toContain("r3");
    expect(out).toContain("\x1b[1;1Hr4");
    expect(out).toContain("\x1b[2;1Hr5");
  });

  it("normalizes CRLF and drops exactly one trailing newline; null cursor homes", () => {
    expect(screenSnapshotEscape("a\r\nb\r\n", null)).toBe("\x1b[2J\x1b[1;1Ha\x1b[2;1Hb\x1b[H");
  });
});

// ---- broker behavior --------------------------------------------------------

describe("TerminalSessionBroker", () => {
  it("test 1: fans output bytes out to ALL subscribers", async () => {
    const broker = track(new TerminalSessionBroker("dev@rig", makeTmux(), { pollMs: 10 }));
    const a = makeSub();
    const b = makeSub();
    await broker.attach(a);
    await broker.attach(b);

    const path = broker.pipeOutputPath!;
    expect(path).toBeTruthy();
    fs.appendFileSync(path, "hello-world");

    await vi.waitFor(() => {
      expect(a.received.join("")).toContain("hello-world");
      expect(b.received.join("")).toContain("hello-world");
    }, { timeout: 1000 });
  });

  it("test 2: a 2nd subscriber does NOT start a second pipe-pane", async () => {
    const startPipePane = vi.fn(async () => ({ ok: true as const }));
    const broker = track(new TerminalSessionBroker("dev@rig", makeTmux({ startPipePane }), { pollMs: 10 }));
    await broker.attach(makeSub());
    await broker.attach(makeSub());
    expect(startPipePane).toHaveBeenCalledOnce();
    expect(broker.subscriberCount).toBe(2);
  });

  it("test 3: input from a subscriber forwards to tmux sendText / sendKeys", async () => {
    const sendText = vi.fn(async () => ({ ok: true as const }));
    const sendKeys = vi.fn(async () => ({ ok: true as const }));
    const broker = track(new TerminalSessionBroker("dev@rig", makeTmux({ sendText, sendKeys }), { pollMs: 10 }));
    await broker.attach(makeSub());

    await broker.input({ type: "text", text: "echo hi" });
    await broker.input({ type: "keys", keys: ["Enter"] });

    expect(sendText).toHaveBeenCalledWith("dev@rig", "echo hi");
    expect(sendKeys).toHaveBeenCalledWith("dev@rig", ["Enter"]);
  });

  it("test 3b: serializes rapid input before calling tmux (ordering preserved)", async () => {
    const order: string[] = [];
    const sendText = vi.fn(async (_n: string, t: string) => {
      await new Promise((r) => setTimeout(r, t === "e" ? 20 : 0));
      order.push(t);
      return { ok: true as const };
    });
    const broker = track(new TerminalSessionBroker("dev@rig", makeTmux({ sendText }), { pollMs: 10 }));
    await broker.attach(makeSub());

    void broker.input({ type: "text", text: "e" });
    void broker.input({ type: "text", text: "c" });
    void broker.input({ type: "text", text: "h" });
    await broker.input({ type: "text", text: "o" });

    expect(order.join("")).toBe("echo");
  });

  it("test 4: disconnecting one subscriber keeps the broker alive for the rest", async () => {
    const stopPipePane = vi.fn(async () => ({ ok: true as const }));
    const broker = track(new TerminalSessionBroker("dev@rig", makeTmux({ stopPipePane }), { pollMs: 10 }));
    const a = makeSub();
    const b = makeSub();
    await broker.attach(a);
    await broker.attach(b);

    broker.detach(a);
    expect(broker.subscriberCount).toBe(1);
    expect(stopPipePane).not.toHaveBeenCalled();

    fs.appendFileSync(broker.pipeOutputPath!, "still-live");
    await vi.waitFor(() => {
      expect(b.received.join("")).toContain("still-live");
    }, { timeout: 1000 });
    expect(a.received.join("")).not.toContain("still-live");
  });

  it("test 5: the FINAL disconnect stops pipe-pane and deletes the temp file", async () => {
    const stopPipePane = vi.fn(async () => ({ ok: true as const }));
    const broker = new TerminalSessionBroker("dev@rig", makeTmux({ stopPipePane }), { pollMs: 10 });
    const a = makeSub();
    await broker.attach(a);
    const path = broker.pipeOutputPath!;
    expect(fs.existsSync(path)).toBe(true);

    broker.detach(a);
    await vi.waitFor(() => {
      expect(stopPipePane).toHaveBeenCalledWith("dev@rig");
      expect(fs.existsSync(path)).toBe(false);
    }, { timeout: 1000 });
    expect(broker.subscriberCount).toBe(0);
  });

  it("test 6: session death closes ALL subscribers honestly (1001), no silent stale-live", async () => {
    let alive = true;
    const broker = track(new TerminalSessionBroker("dev@rig", makeTmux({ hasSession: async () => alive }), {
      pollMs: 10,
      livenessMs: 20,
    }));
    const a = makeSub();
    const b = makeSub();
    await broker.attach(a);
    await broker.attach(b);

    alive = false;
    await vi.waitFor(() => {
      expect(a.closed[0]?.code).toBe(1001);
      expect(b.closed[0]?.code).toBe(1001);
    }, { timeout: 1000 });
    expect(a.closed[0]?.reason).toContain("terminated");
  });

  it("test 7 (broker side): input has no resize path — a resize never reaches tmux.resizeWindow via input", async () => {
    const resizeWindow = vi.fn(async () => ({ ok: true as const }));
    const broker = track(new TerminalSessionBroker("dev@rig", makeTmux({ resizeWindow }), { pollMs: 10 }));
    await broker.attach(makeSub());
    // The broker input API only accepts keys/text; there is no client-driven resize.
    await broker.input({ type: "text", text: "x" });
    expect(resizeWindow).not.toHaveBeenCalled();
  });

  it("viewing never sets window-size, resizes the pane or sends redraw keys", async () => {
    const setWindowOption = vi.fn(async () => ({ ok: true as const }));
    const resizeWindow = vi.fn(async () => ({ ok: true as const }));
    const sendKeys = vi.fn(async () => ({ ok: true as const }));
    const broker = track(new TerminalSessionBroker("dev@rig", makeTmux({ setWindowOption, resizeWindow, sendKeys }), { pollMs: 10 }));
    await broker.attach(makeSub());
    await broker.attach(makeSub());
    expect(resizeWindow).not.toHaveBeenCalled();
    expect(setWindowOption).not.toHaveBeenCalled();
    expect(sendKeys).not.toHaveBeenCalled();
  });

  it("test 8: seeds on FIRST attach with NO resize message, as the first bytes the subscriber sees", async () => {
    const tmux = makeTmux({
      capturePaneScreen: async () => "line one\nline two",
      getPaneCursorPosition: async () => ({ x: 3, y: 1, width: 120, height: 40 }),
    });
    const broker = track(new TerminalSessionBroker("dev@rig", tmux, { pollMs: 10 }));
    const a = makeSub();
    await broker.attach(a);

    expect(a.received[0]).toBe(screenSnapshotEscape("line one\nline two", { x: 3, y: 1, height: 40 }));
    expect(a.received[0]!.startsWith("\x1b[2J")).toBe(true);
  });

  it("test 8b: EACH subscriber gets its own seed (2nd subscriber seeded too, no shared pipe)", async () => {
    const tmux = makeTmux({ capturePaneScreen: async () => "screen" });
    const broker = track(new TerminalSessionBroker("dev@rig", tmux, { pollMs: 10 }));
    const a = makeSub();
    const b = makeSub();
    await broker.attach(a);
    await broker.attach(b);
    expect(a.received[0]).toContain("screen");
    expect(b.received[0]).toContain("screen");
  });

  it("test 9: the seed uses the VISIBLE-screen capture + cursor (absolute paint), never scrollback", async () => {
    const capturePaneScreen = vi.fn(async () => "r1\nr2\nr3");
    const getPaneCursorPosition = vi.fn(async () => ({ x: 1, y: 2, width: 80, height: 24 }));
    const broker = track(new TerminalSessionBroker("dev@rig", makeTmux({ capturePaneScreen, getPaneCursorPosition }), {
      pollMs: 10,
    }));
    const a = makeSub();
    await broker.attach(a);

    expect(capturePaneScreen).toHaveBeenCalledWith("dev@rig", true);
    const seed = a.received[0]!;
    expect(seed).toContain("\x1b[1;1Hr1");
    expect(seed).toContain("\x1b[3;1Hr3");
    expect(seed.endsWith(cursorPositionEscape(1, 2))).toBe(true);
  });

  it("test 11: a pipe-pane failure leaks no temp file, closes the subscriber, and evicts the broker", async () => {
    let evicted: string | null = null;
    const broker = new TerminalSessionBroker("dev@rig", makeTmux({
      startPipePane: async () => ({ ok: false, code: "session_not_found", message: "gone" }),
    }), { pollMs: 10, onEmpty: (n) => { evicted = n; } });
    const a = makeSub();
    await broker.attach(a);

    const path = broker.pipeOutputPath;
    expect(a.closed[0]?.code).toBe(1011);
    expect(evicted).toBe("dev@rig");
    expect(broker.subscriberCount).toBe(0);
    if (path) expect(fs.existsSync(path)).toBe(false);
  });

  it("test 11b: a dead session at open closes the subscriber (1008, honest) and never starts a pipe", async () => {
    const startPipePane = vi.fn(async () => ({ ok: true as const }));
    const broker = new TerminalSessionBroker("dev@rig", makeTmux({ hasSession: async () => false, startPipePane }), {
      pollMs: 10,
    });
    const a = makeSub();
    await broker.attach(a);
    // 1008 (policy / session genuinely absent) mirrors the pre-broker route, distinct
    // from 1011 (server-side pipe failure) below.
    expect(a.closed[0]?.code).toBe(1008);
    expect(a.closed[0]?.reason).toContain("session not found");
    expect(startPipePane).not.toHaveBeenCalled();
  });
});

// ---- registry: create-if-absent + eviction ---------------------------------

describe("TerminalBrokerRegistry", () => {
  it("create-if-absent: two subscribers on one session share ONE broker / ONE pipe", async () => {
    const startPipePane = vi.fn(async () => ({ ok: true as const }));
    const reg = new TerminalBrokerRegistry(makeTmux({ startPipePane }), { pollMs: 10 });
    const b1 = await reg.attach("dev@rig", makeSub());
    const b2 = await reg.attach("dev@rig", makeSub());
    expect(b1).toBe(b2);
    expect(reg.size).toBe(1);
    expect(startPipePane).toHaveBeenCalledOnce();
    b1.dispose();
  });

  it("distinct sessions get distinct brokers", async () => {
    const reg = new TerminalBrokerRegistry(makeTmux(), { pollMs: 10 });
    const b1 = await reg.attach("a@rig", makeSub());
    const b2 = await reg.attach("b@rig", makeSub());
    expect(b1).not.toBe(b2);
    expect(reg.size).toBe(2);
    b1.dispose();
    b2.dispose();
  });

  it("evicts a broker from the registry once its last subscriber detaches", async () => {
    const reg = new TerminalBrokerRegistry(makeTmux(), { pollMs: 10 });
    const sub = makeSub();
    const broker = await reg.attach("dev@rig", sub);
    expect(reg.size).toBe(1);
    broker.detach(sub);
    await vi.waitFor(() => {
      expect(reg.size).toBe(0);
    }, { timeout: 1000 });
  });
});

// ---- lifecycle hardening (dev1-guard watchpoints) ---------------------------

describe("TerminalSessionBroker - lifecycle hardening", () => {
  it("singleflight: CONCURRENT first attaches do not race into two pipes", async () => {
    // A delayed startPipePane widens the race window so all three attaches are
    // in flight together; the synchronous started-guard must still yield one pipe.
    const startPipePane = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return { ok: true as const };
    });
    const broker = track(new TerminalSessionBroker("dev@rig", makeTmux({ startPipePane }), { pollMs: 10 }));
    await Promise.all([broker.attach(makeSub()), broker.attach(makeSub()), broker.attach(makeSub())]);
    expect(startPipePane).toHaveBeenCalledOnce();
    expect(broker.subscriberCount).toBe(3);
  });

  it("fanout isolation: a throwing subscriber does not break others and is detached", async () => {
    const broker = track(new TerminalSessionBroker("dev@rig", makeTmux(), { pollMs: 10 }));
    const good = makeSub();
    const bad: FakeSub = {
      received: [],
      closed: [],
      send: () => { throw new Error("dead socket"); },
      close: () => {},
    };
    await broker.attach(good);
    await broker.attach(bad);
    expect(broker.subscriberCount).toBe(2);

    fs.appendFileSync(broker.pipeOutputPath!, "ISOLATION-DATA");
    await vi.waitFor(() => {
      expect(good.received.join("")).toContain("ISOLATION-DATA");
      expect(broker.subscriberCount).toBe(1); // the throwing subscriber was detached
    }, { timeout: 1000 });
  });

  it("last-detach unlinks even a NON-EMPTY pipe file (AC-7 no temp leak)", async () => {
    const broker = new TerminalSessionBroker("dev@rig", makeTmux(), { pollMs: 10 });
    const a = makeSub();
    await broker.attach(a);
    const path = broker.pipeOutputPath!;
    fs.appendFileSync(path, "real accumulated terminal output bytes");
    expect(fs.statSync(path).size).toBeGreaterThan(0);

    broker.detach(a);
    await vi.waitFor(() => {
      expect(fs.existsSync(path)).toBe(false);
    }, { timeout: 1000 });
  });

  it("registry: CONCURRENT attaches to one session share ONE broker / ONE pipe", async () => {
    const startPipePane = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return { ok: true as const };
    });
    const reg = new TerminalBrokerRegistry(makeTmux({ startPipePane }), { pollMs: 10 });
    const [b1, b2] = await Promise.all([
      reg.attach("dev@rig", makeSub()),
      reg.attach("dev@rig", makeSub()),
    ]);
    expect(b1).toBe(b2);
    expect(reg.size).toBe(1);
    expect(startPipePane).toHaveBeenCalledOnce();
    b1.dispose();
  });

  it("registry: attach AFTER final-close creates a FRESH broker (no stale reuse)", async () => {
    const reg = new TerminalBrokerRegistry(makeTmux(), { pollMs: 10 });
    const sub1 = makeSub();
    const first = await reg.attach("dev@rig", sub1);
    first.detach(sub1);
    await vi.waitFor(() => { expect(reg.size).toBe(0); }, { timeout: 1000 });

    const sub2 = makeSub();
    const second = await reg.attach("dev@rig", sub2);
    expect(second).not.toBe(first);
    expect(reg.size).toBe(1);
    second.dispose();
  });
});

// ---- AC-5 / FR-4 broker-owned shared history ring ---------------------------
// dev1-guard code-review BLOCKING: late subscribers must get the broker-owned
// shared recent-output history (the bytes that scrolled off the first
// subscriber), not only their own visible-screen capture + future fanout.
describe("TerminalSessionBroker - shared history ring (AC-5)", () => {
  it("a LATE subscriber receives the broker-owned history that scrolled off the first subscriber", async () => {
    const startPipePane = vi.fn(async () => ({ ok: true as const }));
    // capturePaneScreen returns null so the ONLY path for B to see the
    // scrolled-off output is the broker-owned ring (not its own visible seed).
    const broker = track(new TerminalSessionBroker("dev@rig", makeTmux({ startPipePane }), { pollMs: 10 }));
    const a = makeSub();
    await broker.attach(a);

    fs.appendFileSync(broker.pipeOutputPath!, "HISTORY-A-SAW-THEN-SCROLLED-OFF");
    await vi.waitFor(() => {
      expect(a.received.join("")).toContain("HISTORY-A-SAW-THEN-SCROLLED-OFF");
    }, { timeout: 1000 });

    const b = makeSub();
    await broker.attach(b);

    // B must receive the broker-owned history even though its capturePaneScreen is null.
    expect(b.received.join("")).toContain("HISTORY-A-SAW-THEN-SCROLLED-OFF");
    // ...and still no second pipe (FR-1 preserved).
    expect(startPipePane).toHaveBeenCalledOnce();
  });

  it("a LATE subscriber skips unsafe TUI repaint history and receives the current screen snapshot", async () => {
    const broker = track(new TerminalSessionBroker("dev@rig", makeTmux({
      capturePaneScreen: async () => "CURRENT SCREEN",
      getPaneCursorPosition: async () => ({ x: 0, y: 0, width: 120, height: 40 }),
    }), { pollMs: 10 }));
    const a = makeSub();
    await broker.attach(a);

    fs.appendFileSync(
      broker.pipeOutputPath!,
      "\x1b[2J\x1b[12;1HSTALE TUI PROMPT\x1b[13;1Hoverpainted status",
    );
    await vi.waitFor(() => {
      expect(a.received.join("")).toContain("STALE TUI PROMPT");
    }, { timeout: 1000 });

    const b = makeSub();
    await broker.attach(b);
    const bSeed = b.received.join("");

    expect(bSeed).not.toContain("STALE TUI PROMPT");
    expect(bSeed).not.toContain("overpainted status");
    expect(bSeed).toContain("CURRENT SCREEN");
  });

  it("the history ring is bounded under sustained output", async () => {
    const broker = track(new TerminalSessionBroker("dev@rig", makeTmux(), { pollMs: 5, maxHistoryBytes: 2048 }));
    await broker.attach(makeSub());
    const path = broker.pipeOutputPath!;
    for (let i = 0; i < 20; i++) {
      fs.appendFileSync(path, "Y".repeat(300)); // 300-byte chunks, each < the 2048 cap
      await new Promise((r) => setTimeout(r, 8));
    }
    expect(broker.historyByteLength).toBeGreaterThan(0);
    expect(broker.historyByteLength).toBeLessThanOrEqual(2048);
  });

  it("the history ring is cleared on final detach (no carry-over / leak)", async () => {
    const broker = new TerminalSessionBroker("dev@rig", makeTmux(), { pollMs: 10 });
    const a = makeSub();
    await broker.attach(a);
    fs.appendFileSync(broker.pipeOutputPath!, "transient history");
    await vi.waitFor(() => { expect(broker.historyByteLength).toBeGreaterThan(0); }, { timeout: 1000 });

    broker.detach(a);
    await vi.waitFor(() => { expect(broker.historyByteLength).toBe(0); }, { timeout: 1000 });
  });
});

// ---- concurrent attach FAILURE (dev1-guard re-review watchpoint) ------------
// A concurrent later attach must not be left live on a torn-down broker when
// the shared open fails. All concurrent attaches await the same open result and
// every subscriber closes honestly (no-live-terminal-lies).
describe("TerminalSessionBroker - concurrent attach failure (honest close)", () => {
  it("concurrent first attaches with a DEAD session close ALL subscribers honestly (1008), none left live", async () => {
    let evicted = 0;
    const broker = new TerminalSessionBroker("dead@rig", makeTmux({
      hasSession: async () => { await new Promise((r) => setTimeout(r, 20)); return false; },
    }), { pollMs: 10, onEmpty: () => { evicted += 1; } });
    const a = makeSub();
    const b = makeSub();

    await Promise.all([broker.attach(a), broker.attach(b)]);

    expect(a.closed[0]?.code).toBe(1008);
    expect(b.closed[0]?.code).toBe(1008); // the co-waiter is NOT left live
    expect(broker.subscriberCount).toBe(0);
    expect(evicted).toBe(1); // evicted exactly once
  });

  it("concurrent first attaches with a PIPE-START failure close ALL subscribers (1011), no temp leak", async () => {
    let capturedPath: string | null = null;
    const broker = new TerminalSessionBroker("dev@rig", makeTmux({
      startPipePane: async (_n: string, p: string) => {
        capturedPath = p;
        await new Promise((r) => setTimeout(r, 20));
        return { ok: false as const, code: "pipe_fail", message: "pipe boom" };
      },
    }), { pollMs: 10 });
    const a = makeSub();
    const b = makeSub();

    await Promise.all([broker.attach(a), broker.attach(b)]);

    expect(a.closed[0]?.code).toBe(1011);
    expect(b.closed[0]?.code).toBe(1011);
    expect(broker.subscriberCount).toBe(0);
    if (capturedPath) expect(fs.existsSync(capturedPath)).toBe(false);
  });

  it("registry: concurrent attaches to a dead session close all and evict the broker (size 0)", async () => {
    const reg = new TerminalBrokerRegistry(makeTmux({
      hasSession: async () => { await new Promise((r) => setTimeout(r, 20)); return false; },
    }), { pollMs: 10 });
    const a = makeSub();
    const b = makeSub();

    await Promise.all([reg.attach("dead@rig", a), reg.attach("dead@rig", b)]);

    expect(a.closed[0]?.code).toBe(1008);
    expect(b.closed[0]?.code).toBe(1008);
    await vi.waitFor(() => { expect(reg.size).toBe(0); }, { timeout: 1000 });
  });
});

// ---- teardown-during-seed race (dev1-guard round-3 watchpoint) --------------
// A late attach blocked in its async seed must NOT be added to a broker that
// got torn down (session death / dispose) while the seed was pending - it must
// close honestly with the remembered teardown reason, never go live silently.
describe("TerminalSessionBroker - teardown during seed (honest close)", () => {
  it("a late attach blocked in seed while the session dies closes honestly (1001) and is NOT added", async () => {
    let releaseCapture!: () => void;
    const blocked = new Promise<string | null>((res) => { releaseCapture = () => res("late-screen"); });
    let captureCalls = 0;
    let alive = true;
    let evicted = 0;
    const broker = new TerminalSessionBroker("dev@rig", makeTmux({
      hasSession: async () => alive,
      capturePaneScreen: async () => {
        captureCalls += 1;
        // The FIRST subscriber's seed resolves immediately; the late
        // subscriber's seed blocks until we release it.
        return captureCalls === 1 ? "first-screen" : blocked;
      },
    }), { pollMs: 10, livenessMs: 15, onEmpty: () => { evicted += 1; } });

    const a = makeSub();
    await broker.attach(a); // first subscriber attached, broker live + liveness running

    const b = makeSub();
    const bAttach = broker.attach(b); // blocks inside seed (capturePaneScreen)

    // Session dies while B is mid-seed; liveness fires and tears the broker down.
    alive = false;
    await vi.waitFor(() => { expect(a.closed[0]?.code).toBe(1001); }, { timeout: 1000 });

    releaseCapture(); // B's seed now resolves
    await bAttach;

    expect(b.closed[0]?.code).toBe(1001); // honest close with the remembered death reason
    expect(broker.subscriberCount).toBe(0); // B was NOT added to the dead broker
    expect(evicted).toBe(1);
  });
});

// ---- OPR.0.4.0.39 per-subscriber scroll-back (tmux capture-pane window) ------
// The live xterm screen is only the current `rows`; scrolling UP must show tmux
// SCROLLBACK. Because the broker fans ONE pipe out to many viewers, scroll-back is
// per-subscriber and READ-ONLY on the pane (capture-pane history window), not a
// pane-global copy-mode (which would freeze every viewer). A scrolled subscriber is
// painted a static history window and SKIPPED by the live fanout until it returns to
// the bottom (offset 0), where it repaints the live screen and rejoins the fanout.
describe("TerminalSessionBroker - per-subscriber scroll-back (OPR.0.4.0.39)", () => {
  it("scroll(offset>0) paints a BOTTOM-anchored tmux history window (offset lines up) to ONLY that subscriber", async () => {
    // Model REAL tmux: `capture-pane -p -S -N` returns a buffer that ENDS at the live
    // bottom and contains ~N lines of history ABOVE the visible screen PLUS the screen
    // (so ~N + rows lines). L1..L200 with L200 = the live bottom row.
    const BUF = Array.from({ length: 200 }, (_, i) => `L${i + 1}`);
    const ROWS = 3;
    const capturePaneContent = vi.fn(async (_n: string, n: number) => {
      const count = Math.min(BUF.length, n + ROWS); // -S -N => ~N + rows lines, bottom-anchored
      return BUF.slice(BUF.length - count).join("\n");
    });
    const broker = track(new TerminalSessionBroker("dev@rig", makeTmux({ capturePaneContent, getPaneCursorPosition: async () => ({ x: 0, y: 0, width: 90, height: ROWS }) }), { pollMs: 10 }));
    const a = makeSub();
    const b = makeSub();
    await broker.attach(a);
    await broker.attach(b);
    const aBefore = a.received.length;
    const bBefore = b.received.length;

    await broker.scroll(a, 3); // wheel up 3 lines from the live bottom (L200)

    // Captures (offset + rows) = 3 + 3 = 6 lines back; the painted window is `rows` (3)
    // lines ending `offset` (3) ABOVE the live bottom: bottom row = L200 - 3 = L197,
    // so the window is L195..L197 (NOT the older top of the capture, NOT the live tail).
    expect(capturePaneContent).toHaveBeenCalledWith("dev@rig", 6);
    expect(a.received.length).toBe(aBefore + 1);
    const painted = a.received[a.received.length - 1]!;
    expect(painted.startsWith("\x1b[2J")).toBe(true);
    expect(painted).toContain("\x1b[1;1HL195");
    expect(painted).toContain("\x1b[2;1HL196");
    expect(painted).toContain("\x1b[3;1HL197");
    expect(painted).not.toContain("L198"); // L198..L200 are within the offset (toward live)
    expect(painted).not.toContain("L194"); // above the rows-tall window
    // b (live, never scrolled) is untouched by a's scroll - per-subscriber.
    expect(b.received.length).toBe(bBefore);
  });

  it("a scrolled-back subscriber is SKIPPED by the live fanout; the live viewer still streams", async () => {
    const broker = track(new TerminalSessionBroker("dev@rig", makeTmux({
      capturePaneContent: async () => "x1\nx2\nx3\nx4",
      getPaneCursorPosition: async () => ({ x: 0, y: 0, width: 90, height: 3 }),
    }), { pollMs: 10 }));
    const a = makeSub();
    const b = makeSub();
    await broker.attach(a);
    await broker.attach(b);

    await broker.scroll(a, 2); // a is now viewing a static history window
    const aAfterScroll = a.received.length;

    fs.appendFileSync(broker.pipeOutputPath!, "LIVE-AFTER-SCROLL");
    await vi.waitFor(() => {
      expect(b.received.join("")).toContain("LIVE-AFTER-SCROLL");
    }, { timeout: 1000 });
    // a was scrolled back: the live byte must NOT overwrite its history view.
    expect(a.received.length).toBe(aAfterScroll);
    expect(a.received.join("")).not.toContain("LIVE-AFTER-SCROLL");
  });

  it("scroll(offset 0) repaints the live screen and the subscriber REJOINS the fanout", async () => {
    const capturePaneScreen = vi.fn(async () => "LIVE SCREEN");
    const broker = track(new TerminalSessionBroker("dev@rig", makeTmux({
      capturePaneContent: async () => "g1\ng2\ng3\ng4",
      capturePaneScreen,
      getPaneCursorPosition: async () => ({ x: 0, y: 0, width: 90, height: 3 }),
    }), { pollMs: 10 }));
    const a = makeSub();
    await broker.attach(a);

    await broker.scroll(a, 2); // into history (skipped by fanout)
    capturePaneScreen.mockClear();
    const beforeReturn = a.received.length;

    await broker.scroll(a, 0); // back to the live bottom

    expect(capturePaneScreen).toHaveBeenCalledWith("dev@rig", true);
    expect(a.received.length).toBe(beforeReturn + 1);
    expect(a.received[a.received.length - 1]!).toContain("LIVE SCREEN");

    // ...and it rejoins the live fanout (no longer skipped).
    fs.appendFileSync(broker.pipeOutputPath!, "BACK-TO-LIVE-STREAM");
    await vi.waitFor(() => {
      expect(a.received.join("")).toContain("BACK-TO-LIVE-STREAM");
    }, { timeout: 1000 });
  });

  it("scroll on an UNKNOWN subscriber is a no-op (never throws, sends nothing)", async () => {
    const broker = track(new TerminalSessionBroker("dev@rig", makeTmux(), { pollMs: 10 }));
    await broker.attach(makeSub());
    const ghost = makeSub(); // never attached
    await broker.scroll(ghost, 5);
    expect(ghost.received.length).toBe(0);
    expect(ghost.closed.length).toBe(0);
  });
});

describe("native geometry mirroring", () => {
  it("sends actual geometry before the first seed and closes honestly for unavailable/bounded geometry", async () => {
    const events: string[] = [];
    const broker = track(new TerminalSessionBroker("dev@rig", makeTmux({
      capturePaneScreen: async () => "native screen",
      getPaneCursorPosition: async () => ({ x: 5, y: 2, width: 137, height: 43 }),
    })));
    await broker.attach({ geometry: (cols, rows) => events.push(`geometry:${cols}:${rows}`), send: data => events.push(data), close: () => {} });
    expect(events[0]).toBe("geometry:137:43");
    expect(events[1]).toContain("native screen");
    for (const cursor of [null, { x: 0, y: 0, width: 501, height: 43 }, { x: 0, y: 0, width: 500, height: 300 }]) {
      const bad = track(new TerminalSessionBroker("bad@rig", makeTmux({ getPaneCursorPosition: async () => cursor })));
      const sub = makeSub(); await bad.attach(sub);
      const reason = cursor
        ? `terminal geometry exceeds browser display limits (${cursor.width}x${cursor.height}; max 500x300, 100000 cells)`
        : "terminal geometry unavailable or outside supported bounds";
      expect(sub.closed[0]).toEqual({ code: 1011, reason });
      expect(bad.subscriberCount).toBe(0);
      expect(bad.pipeOutputPath).toBeNull();
    }
  });

  it("repaints resized geometry while keeping each viewer's independent scroll offset", async () => {
    let rows = 3;
    const content = Array.from({ length: 100 }, (_, index) => `L${index + 1}`).join("\n");
    const broker = track(new TerminalSessionBroker("dev@rig", makeTmux({
      capturePaneScreen: async () => "LIVE",
      capturePaneContent: async () => content,
      getPaneCursorPosition: async () => ({ x: 0, y: 0, width: 137, height: rows }),
    }), { pollMs: 5, geometryMs: 5 }));
    const a = makeSub(), b = makeSub();
    const aGeometry: number[] = [], bGeometry: number[] = [];
    a.geometry = (_cols, height) => aGeometry.push(height);
    b.geometry = (_cols, height) => bGeometry.push(height);
    await broker.attach(a); await broker.attach(b);
    await broker.scroll(a, 3);
    rows = 5;
    await vi.waitFor(() => { expect(aGeometry).toEqual([3, 5]); expect(bGeometry).toEqual([3, 5]); });
    expect(a.received.at(-1)).toContain("\x1b[1;1HL93");
    expect(a.received.at(-1)).toContain("\x1b[5;1HL97");
    expect(b.received.at(-1)).toContain("LIVE");
    fs.appendFileSync(broker.pipeOutputPath!, "NEXT-LIVE");
    await vi.waitFor(() => expect(b.received.join("")).toContain("NEXT-LIVE"));
    expect(a.received.join("")).not.toContain("NEXT-LIVE");
  });
});

describe("resize capture/output boundary", () => {
  it("delivers bytes appended after resize capture exactly once before a later authoritative repaint", async () => {
    let cols = 90, appendAfterCapture = false, appended = false;
    const events: string[] = [];
    let broker: TerminalSessionBroker;
    broker = track(new TerminalSessionBroker("boundary@fixture", makeTmux({
      capturePaneScreen: async () => {
        if (cols === 100 && !appended) appendAfterCapture = true;
        return appended ? "CURRENT SCREEN AFTER LATE OUTPUT" : "SNAPSHOT BEFORE LATE OUTPUT";
      },
      getPaneCursorPosition: async () => {
        if (appendAfterCapture) {
          appendAfterCapture = false; appended = true;
          fs.appendFileSync(broker.pipeOutputPath!, "LATE_AFTER_SNAPSHOT");
        }
        return { x: 0, y: 0, width: cols, height: 27 };
      },
    }), { pollMs: 5, geometryMs: 5 }));
    await broker.attach({ send: data => events.push(data), geometry: (width, rows) => events.push(`geometry:${width}:${rows}`), close: () => {} });
    cols = 100;
    await vi.waitFor(() => expect(events).toContain("LATE_AFTER_SNAPSHOT"));
    await vi.waitFor(() => expect(events.at(-1)).toContain("CURRENT SCREEN AFTER LATE OUTPUT"));
    expect(events.filter(event => event === "LATE_AFTER_SNAPSHOT")).toHaveLength(1);
    expect(events.indexOf("geometry:100:27")).toBeLessThan(events.indexOf("LATE_AFTER_SNAPSHOT"));
    expect(events.slice(events.indexOf("LATE_AFTER_SNAPSHOT") + 1).every(event => event.startsWith("\x1b[2J"))).toBe(true);
  });

  it("keeps output live under continuous capture-time writes instead of retrying indefinitely or repainting stale snapshots", async () => {
    let cols = 90, captureCount = 0, appendAfterCapture = false;
    const events: string[] = [];
    let broker: TerminalSessionBroker;
    broker = track(new TerminalSessionBroker("busy@fixture", makeTmux({
      capturePaneScreen: async () => {
        if (cols === 100) { captureCount++; appendAfterCapture = true; }
        return "STALE RESIZE SNAPSHOT";
      },
      getPaneCursorPosition: async () => {
        if (appendAfterCapture) {
          appendAfterCapture = false;
          fs.appendFileSync(broker.pipeOutputPath!, `LIVE-${captureCount};`);
        }
        return { x: 0, y: 0, width: cols, height: 27 };
      },
    }), { pollMs: 5, geometryMs: 5 }));
    await broker.attach({ send: data => events.push(data), geometry: (width, rows) => events.push(`geometry:${width}:${rows}`), close: () => {} });
    events.length = 0;
    cols = 100;
    await vi.waitFor(() => expect(events.filter(event => event.startsWith("LIVE-")).length).toBeGreaterThanOrEqual(3));
    expect(events[0]).toBe("geometry:100:27");
    expect(events.some(event => event.includes("STALE RESIZE SNAPSHOT"))).toBe(false);
    expect(captureCount).toBeLessThan(30); // one bounded capture per pending poll, not a retry spin
    expect(new Set(events.filter(event => event.startsWith("LIVE-"))).size).toBe(events.filter(event => event.startsWith("LIVE-")).length);
    broker.dispose();
    const afterDispose = captureCount;
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(captureCount).toBe(afterDispose);
  });
});

it("retains a partially decoded UTF-8 character across a native resize boundary", async () => {
  let cols = 90, appendAfterCapture = false, completed = false;
  const bytes = Buffer.from("🚀");
  const events: string[] = [];
  let broker: TerminalSessionBroker;
  broker = track(new TerminalSessionBroker("unicode-resize@fixture", makeTmux({
    capturePaneScreen: async () => {
      if (cols === 100 && !completed) appendAfterCapture = true;
      return completed ? "COMPLETE SCREEN" : "CURRENT SCREEN";
    },
    getPaneCursorPosition: async () => {
      if (appendAfterCapture) {
        appendAfterCapture = false; completed = true;
        fs.appendFileSync(broker.pipeOutputPath!, bytes.subarray(2));
      }
      return { x: 0, y: 0, width: cols, height: 27 };
    },
  }), { pollMs: 5, geometryMs: 5 }));
  await broker.attach({ send: data => events.push(data), close: () => {} });
  fs.appendFileSync(broker.pipeOutputPath!, bytes.subarray(0, 2));
  await new Promise(resolve => setTimeout(resolve, 25));
  cols = 100;
  await vi.waitFor(() => expect(events).toContain("🚀"));
  expect(events.filter(event => event === "🚀")).toHaveLength(1);
  expect(events.join("")).not.toContain("\ufffd");
});

it("serializes concurrent late attaches and resize capture without duplicate tail delivery", async () => {
  let cols = 90, appendAfterCapture = false, appended = false;
  const frames = [[], [], []] as string[][];
  let broker: TerminalSessionBroker;
  broker = track(new TerminalSessionBroker("concurrent-resize@fixture", makeTmux({
    capturePaneScreen: async () => {
      if (cols === 100 && !appended) appendAfterCapture = true;
      return "CURRENT";
    },
    getPaneCursorPosition: async () => {
      if (appendAfterCapture) {
        appendAfterCapture = false; appended = true;
        fs.appendFileSync(broker.pipeOutputPath!, "CONCURRENT-LATE");
      }
      return { x: 0, y: 0, width: cols, height: 27 };
    },
  }), { pollMs: 5, geometryMs: 5 }));
  const sub = (index: number): TerminalSubscriber => ({
    geometry: (width, rows) => frames[index]!.push(`geometry:${width}:${rows}`),
    send: data => frames[index]!.push(data), close: () => {},
  });
  await broker.attach(sub(0));
  cols = 100;
  await Promise.all([broker.attach(sub(1)), broker.attach(sub(2))]);
  await vi.waitFor(() => expect(frames.every(viewer => viewer.includes("CONCURRENT-LATE"))).toBe(true));
  for (const viewer of frames) {
    expect(viewer.filter(frame => frame === "CONCURRENT-LATE")).toHaveLength(1);
    expect(viewer.filter(frame => frame === "geometry:100:27")).toHaveLength(1);
    expect(viewer.indexOf("geometry:100:27")).toBeLessThan(viewer.indexOf("CONCURRENT-LATE"));
  }
});

// Review regressions: read-only sampling faults must not replace or terminate
// an otherwise healthy native session or its shared pipe.
describe("bounded display recovery", () => {
  it.each(["unavailable", "throw"])("recovers a transient %s geometry sample without dropping either viewer or pipe bytes", async failure => {
    let fault = false;
    const stopPipePane = vi.fn(async () => ({ ok: true }));
    const broker = track(new TerminalSessionBroker("recover@fixture", makeTmux({
      capturePaneScreen: async () => "CURRENT",
      stopPipePane,
      getPaneCursorPosition: async () => {
        if (fault) {
          fault = false;
          if (failure === "throw") throw Error("temporary tmux read failure");
          return null;
        }
        return { x: 0, y: 0, width: 90, height: 27 };
      },
    }), { pollMs: 5, geometryMs: 5 }));
    const a = makeSub(), b = makeSub();
    await broker.attach(a); await broker.attach(b);
    const pipe = broker.pipeOutputPath!;
    fault = true;
    fs.appendFileSync(pipe, "OUTPUT_DURING_READ_FAILURE");
    await vi.waitFor(() => expect(fault).toBe(false));
    await vi.waitFor(() => expect(a.received.join("")).toContain("OUTPUT_DURING_READ_FAILURE"));
    expect(b.received.join("")).toContain("OUTPUT_DURING_READ_FAILURE");
    expect(a.closed).toEqual([]); expect(b.closed).toEqual([]);
    expect(broker.pipeOutputPath).toBe(pipe);
    expect(stopPipePane).not.toHaveBeenCalled();
  });

  it.each(["geometry", "capture"])("isolates an unsuccessful late %s seed from a connected viewer", async failure => {
    let broken = false;
    const stopPipePane = vi.fn(async () => ({ ok: true }));
    const broker = track(new TerminalSessionBroker("late-fault@fixture", makeTmux({
      stopPipePane,
      capturePaneScreen: async () => {
        if (broken && failure === "capture") throw Error("temporary capture failure");
        return "CURRENT";
      },
      getPaneCursorPosition: async () => broken && failure === "geometry" ? null : ({ x: 0, y: 0, width: 90, height: 27 }),
    }), { pollMs: 1000, geometryMs: 1000 }));
    const a = makeSub(), b = makeSub();
    await broker.attach(a);
    const pipe = broker.pipeOutputPath!;
    broken = true;
    await broker.attach(b);
    broken = false;
    expect(b.closed[0]?.code).toBe(1011);
    expect(a.closed).toEqual([]);
    expect(broker.subscriberCount).toBe(1);
    expect(broker.pipeOutputPath).toBe(pipe);
    expect(stopPipePane).not.toHaveBeenCalled();
    fs.appendFileSync(pipe, "STILL_LIVE");
    await vi.waitFor(() => expect(a.received.join("")).toContain("STILL_LIVE"), { timeout: 2000 });
  });

  it("bounds a fresh viewer's continuously busy seed and preserves the already seeded viewer", async () => {
    let busy = false, count = 0;
    const stopPipePane = vi.fn(async () => ({ ok: true }));
    let broker: TerminalSessionBroker;
    broker = track(new TerminalSessionBroker("busy-seed@fixture", makeTmux({
      stopPipePane,
      capturePaneScreen: async () => {
        if (busy) fs.appendFileSync(broker.pipeOutputPath!, `\x1b[2;1HLIVE-${++count}`);
        return busy ? "UNSAFE_STALE_SNAPSHOT" : "BASELINE";
      },
    }), { pollMs: 5, geometryMs: 5 }));
    const a = makeSub(), b = makeSub();
    await broker.attach(a);
    const pipe = broker.pipeOutputPath!;
    busy = true;
    await broker.attach(b);
    await vi.waitFor(() => expect(b.closed[0]).toEqual({ code: 1011, reason: "terminal screen remained busy; reopen to retry" }), { timeout: 500 });
    expect(b.received.join("")).not.toContain("UNSAFE_STALE_SNAPSHOT");
    expect(a.closed).toEqual([]);
    expect(broker.subscriberCount).toBe(1);
    expect(broker.pipeOutputPath).toBe(pipe);
    expect(stopPipePane).not.toHaveBeenCalled();
    expect(count).toBeLessThan(10);
    busy = false;
    fs.appendFileSync(pipe, "AFTER_BUSY_SEED");
    await vi.waitFor(() => expect(a.received.join("")).toContain("AFTER_BUSY_SEED"));
  });
});

it("retries a transient busy seed to an authoritative current screen without losing or duplicating pipe bytes", async () => {
  let transientBusy = false, appended = false;
  let broker: TerminalSessionBroker;
  broker = track(new TerminalSessionBroker("briefly-busy@fixture", makeTmux({
    capturePaneScreen: async () => {
      if (transientBusy && !appended) {
        appended = true;
        fs.appendFileSync(broker.pipeOutputPath!, "\x1b[2;1HNEW_ROW");
        return "STALE_BEFORE_NEW_ROW";
      }
      return appended ? "CURRENT_WITH_NEW_ROW" : "BASELINE";
    },
  }), { pollMs: 5, geometryMs: 5 }));
  const a = makeSub(), b = makeSub();
  const geometry: string[] = [];
  b.geometry = (cols, rows) => geometry.push(`${cols}:${rows}`);
  await broker.attach(a);
  transientBusy = true;
  await broker.attach(b);
  expect(b.closed).toEqual([]);
  expect(b.received.at(-1)).toContain("CURRENT_WITH_NEW_ROW");
  expect(b.received.join("")).not.toContain("STALE_BEFORE_NEW_ROW");
  expect(geometry).toEqual(["90:27"]);
  for (const viewer of [a, b]) expect(viewer.received.filter(frame => frame === "\x1b[2;1HNEW_ROW")).toHaveLength(1);
});

it("cleans up a continuously busy first seed and permits a fresh quiet attachment to the same native session", async () => {
  let busy = true, outputPath = "";
  const startPipePane = vi.fn(async (_name: string, file: string) => { outputPath = file; return { ok: true }; });
  const stopPipePane = vi.fn(async () => ({ ok: true }));
  const tmux = makeTmux({
    startPipePane, stopPipePane,
    capturePaneScreen: async () => {
      if (busy) fs.appendFileSync(outputPath, "\x1b[2;1HCONTINUOUS");
      return busy ? "UNSAFE_SNAPSHOT" : "QUIET_CURRENT_SCREEN";
    },
  });
  const registry = new TerminalBrokerRegistry(tmux, { pollMs: 5 });
  const a = makeSub();
  const failed = track(await registry.attach("first-busy@fixture", a));
  expect(a.closed).toEqual([{ code: 1011, reason: "terminal screen remained busy; reopen to retry" }]);
  expect(failed.subscriberCount).toBe(0);
  expect(failed.pipeOutputPath).toBeNull();
  expect(registry.size).toBe(0);
  expect(fs.existsSync(outputPath)).toBe(false);
  expect(stopPipePane).toHaveBeenCalledTimes(1);
  busy = false;
  const b = makeSub();
  const admitted = track(await registry.attach("first-busy@fixture", b));
  expect(admitted).not.toBe(failed);
  expect(b.closed).toEqual([]);
  expect(b.received.at(-1)).toContain("QUIET_CURRENT_SCREEN");
  expect(admitted.subscriberCount).toBe(1);
  expect(startPipePane).toHaveBeenCalledTimes(2); // one pipe per broker, first was stopped
});

it("closes every viewer honestly after persistent geometry failure instead of keeping stale geometry live indefinitely", async () => {
  let unavailable = false;
  const broker = track(new TerminalSessionBroker("persistent-fault@fixture", makeTmux({
    capturePaneScreen: async () => "BASELINE",
    getPaneCursorPosition: async () => unavailable ? null : ({ x: 0, y: 0, width: 90, height: 27 }),
  }), { pollMs: 5, geometryMs: 5 }));
  const a = makeSub(), b = makeSub();
  await broker.attach(a); await broker.attach(b);
  unavailable = true;
  await vi.waitFor(() => expect(a.closed).toEqual([{ code: 1011, reason: "terminal geometry unavailable or outside supported bounds" }]));
  expect(b.closed).toEqual(a.closed);
  expect(broker.pipeOutputPath).toBeNull();
  expect(broker.subscriberCount).toBe(0);
});

it.each(["unavailable", "throw"])("bounds persistent %s display faults with the default slower geometry cadence", async failure => {
  let broken = false, failedReads = 0;
  const broker = track(new TerminalSessionBroker("slow-cadence@fixture", makeTmux({
    capturePaneScreen: async () => "BASELINE",
    getPaneCursorPosition: async () => {
      if (broken) {
        failedReads++;
        if (failure === "throw") throw Error("temporary cursor probe failure");
        return null;
      }
      return { x: 0, y: 0, width: 90, height: 27 };
    },
  }), { pollMs: 5 })); // geometryMs deliberately omitted: native reads default to 250ms
  const a = makeSub(), b = makeSub();
  await broker.attach(a); await broker.attach(b);
  broken = true;
  await vi.waitFor(() => expect(a.closed[0]?.code).toBe(1011), { timeout: 1500 });
  expect(b.closed).toEqual(a.closed);
  expect(failedReads).toBe(3); // pending repaint revalidates even on intervening tail ticks
  expect(broker.subscriberCount).toBe(0);
  expect(broker.pipeOutputPath).toBeNull();
});

it("resets the display failure budget after successful recovery between separated faults", async () => {
  let unavailableReads = 0, captures = 0;
  const broker = track(new TerminalSessionBroker("separated-faults@fixture", makeTmux({
    capturePaneScreen: async () => `CURRENT-${++captures}`,
    getPaneCursorPosition: async () => {
      if (unavailableReads > 0) { unavailableReads--; return null; }
      return { x: 0, y: 0, width: 90, height: 27 };
    },
  }), { pollMs: 5 })); // exercise the default 250ms geometry cadence
  const a = makeSub(), b = makeSub();
  await broker.attach(a); await broker.attach(b);
  const pipe = broker.pipeOutputPath!;
  for (let cycle = 0; cycle < 3; cycle++) {
    unavailableReads = 2; // two consecutive faults, then valid native geometry
    fs.appendFileSync(pipe, `RECOVERED_OUTPUT-${cycle}`);
    await vi.waitFor(() => expect(unavailableReads).toBe(0), { timeout: 1500 });
    await vi.waitFor(() => expect([a, b].every(sub => sub.received.at(-1)?.includes(`CURRENT-${captures}`))).toBe(true));
    expect(a.closed).toEqual([]); expect(b.closed).toEqual([]);
    for (const sub of [a, b]) expect(sub.received.filter(frame => frame === `RECOVERED_OUTPUT-${cycle}`)).toHaveLength(1);
  }
  expect(broker.pipeOutputPath).toBe(pipe);
  expect(broker.subscriberCount).toBe(2);
});

describe("browser geometry limit reporting", () => {
  it.each([[500, 200], [333, 300], [400, 250]])("admits native %ix%i at the supported column, row or cell boundary without resizing", async (width, height) => {
    const resizeWindow = vi.fn(async () => ({ ok: true }));
    const setWindowOption = vi.fn(async () => ({ ok: true }));
    const geometry = vi.fn();
    const cursor = { x: width - 1, y: height - 1, width, height };
    const broker = track(new TerminalSessionBroker("boundary-size@fixture", makeTmux({
      resizeWindow, setWindowOption,
      getPaneCursorPosition: async () => cursor,
      capturePaneScreen: async () => "NATIVE_CURRENT_SCREEN",
    }), { pollMs: 5 }));
    const sub = makeSub(); sub.geometry = geometry;
    await broker.attach(sub);
    expect(sub.closed).toEqual([]);
    expect(geometry).toHaveBeenCalledExactlyOnceWith(width, height);
    expect(sub.received.at(-1)).toContain("NATIVE_CURRENT_SCREEN");
    expect(sub.received.at(-1)).toContain(cursorPositionEscape(cursor.x, cursor.y));
    expect(resizeWindow).not.toHaveBeenCalled(); expect(setWindowOption).not.toHaveBeenCalled();
  });

  it.each([[501, 60], [300, 301], [500, 201], [520, 60], [400, 260], [500, 300]])("closes unsupported native %ix%i with an explicit static limit error instead of clipping or resizing", async (width, height) => {
    const resizeWindow = vi.fn(async () => ({ ok: true }));
    const setWindowOption = vi.fn(async () => ({ ok: true }));
    const broker = track(new TerminalSessionBroker("oversized@fixture", makeTmux({
      resizeWindow, setWindowOption,
      getPaneCursorPosition: async () => ({ x: 0, y: 0, width, height }),
    }), { pollMs: 5 }));
    const sub = makeSub(); sub.geometry = vi.fn();
    await broker.attach(sub);
    expect(sub.closed).toEqual([{ code: 1011, reason: `terminal geometry exceeds browser display limits (${width}x${height}; max 500x300, 100000 cells)` }]);
    expect(sub.geometry).not.toHaveBeenCalled();
    expect(sub.received).toEqual([]);
    expect(broker.subscriberCount).toBe(0); expect(broker.pipeOutputPath).toBeNull();
    expect(resizeWindow).not.toHaveBeenCalled(); expect(setWindowOption).not.toHaveBeenCalled();
  });

  it("preserves bounded shared-viewer recovery and reports the actual unsupported native resize", async () => {
    let width = 90, height = 27;
    const resizeWindow = vi.fn(async () => ({ ok: true }));
    const broker = track(new TerminalSessionBroker("oversized-resize@fixture", makeTmux({
      resizeWindow,
      capturePaneScreen: async () => "BASELINE",
      getPaneCursorPosition: async () => ({ x: 0, y: 0, width, height }),
    }), { pollMs: 5, geometryMs: 5 }));
    const a = makeSub(), b = makeSub();
    await broker.attach(a); await broker.attach(b);
    width = 520; height = 60;
    await vi.waitFor(() => expect(a.closed).toEqual([{ code: 1011, reason: "terminal geometry exceeds browser display limits (520x60; max 500x300, 100000 cells)" }]));
    expect(b.closed).toEqual(a.closed);
    expect(broker.pipeOutputPath).toBeNull();
    expect(resizeWindow).not.toHaveBeenCalled();
  });
});

it.each([null, { x: 501, y: 0, width: 500, height: 200 }, { x: 0, y: 0, width: Number.NaN, height: 27 }])("keeps unavailable or malformed cursor information distinct from browser size limits", async cursor => {
  const broker = track(new TerminalSessionBroker("unavailable-size@fixture", makeTmux({
    getPaneCursorPosition: async () => cursor,
  }), { pollMs: 5 }));
  const sub = makeSub();
  await broker.attach(sub);
  expect(sub.closed).toEqual([{ code: 1011, reason: "terminal geometry unavailable or outside supported bounds" }]);
});

it("reports bounds without inventing an exact size for unsafe integer geometry and keeps the WebSocket close reason bounded", async () => {
  const broker = track(new TerminalSessionBroker("unsafe-size@fixture", makeTmux({
    getPaneCursorPosition: async () => ({ x: 0, y: 0, width: Number.MAX_SAFE_INTEGER + 1, height: 60 }),
  }), { pollMs: 5 }));
  const sub = makeSub();
  await broker.attach(sub);
  expect(sub.closed).toEqual([{ code: 1011, reason: "terminal geometry exceeds browser display limits (max 500x300, 100000 cells)" }]);
  expect(Buffer.byteLength(sub.closed[0]!.reason)).toBeLessThanOrEqual(123);
});

it("rejects a failed screen capture for only the fresh viewer and admits a later successful seed", async () => {
  let failed = false;
  const broker = track(new TerminalSessionBroker("capture@fixture", makeTmux({
    capturePaneScreen: async () => failed ? null : "AUTHORITATIVE",
  }), { pollMs: 1000 }));
  const healthy = makeSub(); await broker.attach(healthy);
  failed = true;
  const rejected = makeSub(); await broker.attach(rejected);
  expect(rejected.closed).toEqual([{ code: 1011, reason: "terminal screen capture unavailable; reopen to retry" }]);
  expect(rejected.received).toEqual([]);
  expect(healthy.closed).toEqual([]);
  failed = false;
  const later = makeSub(); await broker.attach(later);
  expect(later.closed).toEqual([]);
  expect(later.received.some(frame => frame.includes("AUTHORITATIVE"))).toBe(true);
});

it("keeps a geometry repaint pending after null capture and paints only a recovered authoritative screen", async () => {
  let width = 90, failed = false;
  let captures = 0;
  const broker = track(new TerminalSessionBroker("capture@fixture", makeTmux({
    getPaneCursorPosition: async () => ({ x: 0, y: 0, width, height: 27 }),
    capturePaneScreen: async () => { captures++; return failed ? null : "AUTHORITATIVE"; },
  }), { pollMs: 100, geometryMs: 100 }));
  const sub = makeSub(); await broker.attach(sub); sub.received.length = 0;
  failed = true; width = 100;
  await vi.waitFor(() => expect(captures).toBeGreaterThan(1), { interval: 5 });
  expect(sub.received).toEqual([]);
  failed = false;
  await vi.waitFor(() => expect(sub.received.some(frame => frame.includes("AUTHORITATIVE"))).toBe(true));
  expect(sub.closed).toEqual([]);
});

it("does not replace a scroll-back screen with empty content when scroll-to-live capture fails", async () => {
  let failed = false;
  const broker = track(new TerminalSessionBroker("capture@fixture", makeTmux({
    capturePaneScreen: async () => failed ? null : "LIVE_AUTHORITATIVE",
    capturePaneContent: async () => "OLD\nHISTORY\n",
  }), { pollMs: 1000 }));
  const sub = makeSub(); await broker.attach(sub); await broker.scroll(sub, 1);
  sub.received.length = 0; failed = true;
  await broker.scroll(sub, 0);
  expect(sub.received).toEqual([]);
  failed = false;
  await vi.waitFor(() => expect(sub.received.some(frame => frame.includes("LIVE_AUTHORITATIVE"))).toBe(true), { timeout: 3000 });
  expect(sub.closed).toEqual([]);
});

it("recovers a transient null capture during fresh seed without an empty-screen acknowledgement", async () => {
  let calls = 0;
  const broker = track(new TerminalSessionBroker("capture@fixture", makeTmux({
    capturePaneScreen: async () => ++calls === 1 ? null : "RECOVERED",
  }), { pollMs: 5 }));
  const sub = makeSub(); await broker.attach(sub);
  expect(calls).toBe(2);
  expect(sub.closed).toEqual([]);
  expect(sub.received).toEqual([screenSnapshotEscape("RECOVERED", { x: 0, y: 0, width: 90, height: 27 })]);
});

it("holds a failed scroll-to-live viewer out of raw delta fanout until its authoritative repaint", async () => {
  let failed = false;
  const broker = track(new TerminalSessionBroker("capture@fixture", makeTmux({
    capturePaneScreen: async () => failed ? null : "LIVE_AFTER_DELTA",
    capturePaneContent: async () => "OLD\nHISTORY\n",
  }), { pollMs: 1000 }));
  const healthy = makeSub(), scrolled = makeSub();
  await broker.attach(healthy); await broker.attach(scrolled);
  await broker.scroll(scrolled, 1); scrolled.received.length = 0; healthy.received.length = 0;
  failed = true; await broker.scroll(scrolled, 0);
  fs.appendFileSync(broker.pipeOutputPath!, "LIVE_DELTA");
  failed = false;
  await vi.waitFor(() => expect(scrolled.received.some(frame => frame.includes("LIVE_AFTER_DELTA"))).toBe(true), { timeout: 4000 });
  expect(healthy.received).toContain("LIVE_DELTA");
  expect(scrolled.received).not.toContain("LIVE_DELTA");
  expect(scrolled.closed).toEqual([]);
});

it("bounds persistent null captures without ever emitting an empty authoritative repaint", async () => {
  let failed = false, captures = 0;
  const broker = track(new TerminalSessionBroker("capture@fixture", makeTmux({
    capturePaneScreen: async () => { captures++; return failed ? null : "AUTHORITATIVE"; },
  }), { pollMs: 5 }));
  const sub = makeSub(); await broker.attach(sub); sub.received.length = 0;
  failed = true;
  await broker.scroll(sub, 0);
  await vi.waitFor(() => expect(sub.closed).toEqual([{ code: 1011, reason: "terminal screen capture unavailable; reopen to retry" }]));
  expect(captures).toBe(4); // initial success, then exactly three failed display samples
  expect(sub.received).toEqual([]);
});

it("bounds a continuously busy return from history for only that viewer while draining every pipe byte", async () => {
  let busy = false, count = 0;
  const stopPipePane = vi.fn(async () => ({ ok: true }));
  let broker: TerminalSessionBroker;
  broker = track(new TerminalSessionBroker("busy-return@fixture", makeTmux({
    stopPipePane,
    getPaneCursorPosition: async () => ({ x: count % 90, y: 0, width: 90, height: 27 }),
    capturePaneScreen: async () => {
      if (busy) fs.appendFileSync(broker.pipeOutputPath!, `\x1b[2;1HBUSY_RETURN_${++count}`);
      return busy ? "UNSAFE_RETURN_SNAPSHOT" : "CURRENT_LIVE";
    },
    capturePaneContent: async () => "HISTORICAL_SCREEN\n",
  }), { pollMs: 5, geometryMs: 5 }));
  const healthy = makeSub(), returning = makeSub();
  await broker.attach(healthy); await broker.attach(returning);
  await broker.scroll(returning, 1);
  healthy.received.length = 0; returning.received.length = 0;
  const pipe = broker.pipeOutputPath!;
  busy = true; await broker.scroll(returning, 0);
  await vi.waitFor(() => expect(returning.closed).toEqual([{ code: 1011, reason: "terminal screen remained busy; reopen to retry" }]), { timeout: 500 });
  expect(count).toBe(3);
  expect(returning.received).toEqual([]);
  expect(healthy.closed).toEqual([]);
  expect(broker.subscriberCount).toBe(1);
  expect(broker.pipeOutputPath).toBe(pipe);
  expect(stopPipePane).not.toHaveBeenCalled();
  busy = false;
  fs.appendFileSync(pipe, "AFTER_BUSY_RETURN");
  await vi.waitFor(() => expect(healthy.received.join("")).toContain("AFTER_BUSY_RETURN"));
  for (let index = 1; index <= count; index++) {
    expect(healthy.received.join("").split(`BUSY_RETURN_${index}`)).toHaveLength(2);
  }
  expect(healthy.received.join("")).not.toContain("UNSAFE_RETURN_SNAPSHOT");
});

it("admits a briefly busy history return after a stable repaint and resumes that viewer's delta fanout", async () => {
  let busyCaptures = 0, count = 0;
  let broker: TerminalSessionBroker;
  broker = track(new TerminalSessionBroker("brief-return@fixture", makeTmux({
    getPaneCursorPosition: async () => ({ x: count, y: 0, width: 90, height: 27 }),
    capturePaneScreen: async () => {
      if (busyCaptures > 0) {
        busyCaptures--; count++;
        fs.appendFileSync(broker.pipeOutputPath!, "\x1b[2;1HDURING_RETURN");
        return "UNSAFE_TRANSIENT_RETURN";
      }
      return "CURRENT_LIVE";
    },
    capturePaneContent: async () => "HISTORICAL_SCREEN\n",
  }), { pollMs: 5 }));
  const healthy = makeSub(), returning = makeSub();
  await broker.attach(healthy); await broker.attach(returning); await broker.scroll(returning, 1);
  returning.received.length = 0; healthy.received.length = 0;
  busyCaptures = 1; await broker.scroll(returning, 0);
  expect(returning.received).toEqual([]);
  await vi.waitFor(() => expect(returning.received.some(frame => frame.includes("CURRENT_LIVE"))).toBe(true));
  expect(returning.closed).toEqual([]);
  expect(returning.received.join("")).not.toContain("UNSAFE_TRANSIENT_RETURN");
  expect(returning.received).not.toContain("\x1b[2;1HDURING_RETURN");
  expect(healthy.received.filter(frame => frame === "\x1b[2;1HDURING_RETURN")).toHaveLength(1);
  fs.appendFileSync(broker.pipeOutputPath!, "AFTER_RETURN");
  await vi.waitFor(() => expect(returning.received).toContain("AFTER_RETURN"));
});

it("keeps ordinary busy geometry repaints streaming without applying the history-return budget", async () => {
  let busy = false, count = 0, width = 90;
  let broker: TerminalSessionBroker;
  broker = track(new TerminalSessionBroker("busy-live@fixture", makeTmux({
    getPaneCursorPosition: async () => ({ x: count % width, y: 0, width, height: 27 }),
    capturePaneScreen: async () => {
      if (busy) fs.appendFileSync(broker.pipeOutputPath!, `\x1b[2;1HBUSY_LIVE_${++count}`);
      return busy ? "UNSAFE_GEOMETRY_SNAPSHOT" : "CURRENT_LIVE";
    },
  }), { pollMs: 5, geometryMs: 5 }));
  const live = makeSub(); await broker.attach(live);
  busy = true; width = 100;
  // A redundant request for the already-live bottom also must not create a
  // history-return budget for a viewer that still receives live output.
  await broker.scroll(live, 0);
  await vi.waitFor(() => expect(count).toBeGreaterThanOrEqual(4));
  expect(live.closed).toEqual([]);
  expect(live.received.join("")).toContain("BUSY_LIVE_1");
  expect(live.received.join("")).not.toContain("UNSAFE_GEOMETRY_SNAPSHOT");
  busy = false;
  await vi.waitFor(() => expect(live.received.at(-1)).toContain("CURRENT_LIVE"));
  expect(live.closed).toEqual([]);
});

it("does not restart a busy history-return budget on repeated live-bottom requests", async () => {
  let busy = false, count = 0;
  let broker: TerminalSessionBroker;
  broker = track(new TerminalSessionBroker("repeated-return@fixture", makeTmux({
    capturePaneScreen: async () => {
      if (busy) fs.appendFileSync(broker.pipeOutputPath!, `BUSY_${++count}`);
      return busy ? "UNSAFE_RETURN" : "LIVE";
    },
    capturePaneContent: async () => "HISTORY\n",
  }), { pollMs: 1000 }));
  const sub = makeSub(); await broker.attach(sub); await broker.scroll(sub, 1);
  busy = true;
  await broker.scroll(sub, 0); await broker.scroll(sub, 0); await broker.scroll(sub, 0);
  expect(count).toBe(3);
  expect(sub.closed).toEqual([{ code: 1011, reason: "terminal screen remained busy; reopen to retry" }]);
  expect(broker.subscriberCount).toBe(0);
  expect(broker.pipeOutputPath).toBeNull();
});

it("cancels the busy return budget when the viewer explicitly stays in history", async () => {
  let busy = false, count = 0;
  let broker: TerminalSessionBroker;
  broker = track(new TerminalSessionBroker("cancel-return@fixture", makeTmux({
    capturePaneScreen: async () => {
      if (busy) fs.appendFileSync(broker.pipeOutputPath!, `BUSY_${++count}`);
      return busy ? "UNSAFE_RETURN" : "LIVE";
    },
    capturePaneContent: async () => "HISTORY\n",
  }), { pollMs: 5 }));
  const sub = makeSub(); await broker.attach(sub); await broker.scroll(sub, 1);
  busy = true; await broker.scroll(sub, 0);
  await broker.scroll(sub, 2);
  await vi.waitFor(() => expect(count).toBeGreaterThanOrEqual(4));
  expect(sub.closed).toEqual([]);
  expect(sub.received.join("")).not.toContain("UNSAFE_RETURN");
  busy = false; await broker.scroll(sub, 0);
  await vi.waitFor(() => expect(sub.received.at(-1)).toContain("LIVE"));
  expect(sub.closed).toEqual([]);
});

it("bounds a fresh seed during valid geometry changes without painting an old-size snapshot or disposing healthy viewers", async () => {
  let changing = false, reads = 0;
  const broker = track(new TerminalSessionBroker("changing-seed@fixture", makeTmux({
    getPaneCursorPosition: async () => ({ x: 0, y: 0, width: changing && ++reads % 2 === 0 ? 91 : 90, height: 27 }),
    capturePaneScreen: async () => changing ? "OLD_SIZE_SNAPSHOT" : "BASELINE",
  }), { pollMs: 1000 }));
  const healthy = makeSub(), fresh = makeSub(); await broker.attach(healthy);
  changing = true; await broker.attach(fresh);
  expect(fresh.closed).toEqual([{ code: 1011, reason: "terminal screen remained busy; reopen to retry" }]);
  expect(fresh.received.join("")).not.toContain("OLD_SIZE_SNAPSHOT");
  expect(reads).toBe(18); // three bounded readScreen attempts, each with three before/after samples
  expect(healthy.closed).toEqual([]);
  expect(broker.subscriberCount).toBe(1);
});

it.each([
  ["null", null, "terminal geometry unavailable or outside supported bounds"],
  ["invalid", { x: 92, y: 0, width: 91, height: 27 }, "terminal geometry unavailable or outside supported bounds"],
  ["oversized", { x: 0, y: 0, width: 520, height: 60 }, "terminal geometry exceeds browser display limits (520x60; max 500x300, 100000 cells)"],
] as const)("does not mask a final %s cursor with an earlier valid changing-geometry sample", async (_label, bad, reason) => {
  let changing = false, reads = 0;
  const broker = track(new TerminalSessionBroker("mixed-changing@fixture", makeTmux({
    getPaneCursorPosition: async () => {
      if (!changing) return { x: 0, y: 0, width: 90, height: 27 };
      if (++reads % 6 === 0) return bad;
      return { x: 0, y: 0, width: reads % 2 === 0 ? 91 : 90, height: 27 };
    },
    capturePaneScreen: async () => "BASELINE",
  }), { pollMs: 1000 }));
  const healthy = makeSub(), fresh = makeSub(); await broker.attach(healthy);
  changing = true; await broker.attach(fresh);
  expect(fresh.closed).toEqual([{ code: 1011, reason }]);
  expect(fresh.received).toEqual([]);
  expect(reads).toBe(18);
  expect(healthy.closed).toEqual([]);
});

it("does not mask a failed capture following valid changing-geometry samples", async () => {
  let changing = false, reads = 0, captures = 0;
  const broker = track(new TerminalSessionBroker("mixed-capture@fixture", makeTmux({
    getPaneCursorPosition: async () => ({ x: 0, y: 0, width: changing && ++reads % 2 === 0 ? 91 : 90, height: 27 }),
    capturePaneScreen: async () => changing && ++captures % 3 === 0 ? null : "BASELINE",
  }), { pollMs: 1000 }));
  const healthy = makeSub(), fresh = makeSub(); await broker.attach(healthy);
  changing = true; await broker.attach(fresh);
  expect(fresh.closed).toEqual([{ code: 1011, reason: "terminal screen capture unavailable; reopen to retry" }]);
  expect(fresh.received).toEqual([]);
  expect(captures).toBe(9);
  expect(healthy.closed).toEqual([]);
});

it.each(["null", "oversized", "capture"] as const)("keeps the shared hard-failure bound after changing geometry ends in persistent %s failure", async failure => {
  let changing = false, failed = false, width = 90, captures = 0;
  const broker = track(new TerminalSessionBroker("changing-failure@fixture", makeTmux({
    getPaneCursorPosition: async () => failed && failure !== "capture"
      ? failure === "null" ? null : { x: 0, y: 0, width: 520, height: 60 }
      : { x: 0, y: 0, width, height: 27 },
    capturePaneScreen: async () => {
      if (changing && ++captures <= 3) {
        if (captures < 3) width++;
        else failed = true;
      }
      return failed && failure === "capture" ? null : "BASELINE";
    },
  }), { pollMs: 5, geometryMs: 5 }));
  const a = makeSub(), b = makeSub(); await broker.attach(a); await broker.attach(b);
  changing = true; width = 91;
  const reason = failure === "oversized"
    ? "terminal geometry exceeds browser display limits (520x60; max 500x300, 100000 cells)"
    : failure === "capture" ? "terminal screen capture unavailable; reopen to retry" : "terminal geometry unavailable or outside supported bounds";
  await vi.waitFor(() => expect(a.closed).toEqual([{ code: 1011, reason }]));
  expect(b.closed).toEqual(a.closed);
  expect(captures).toBe(failure === "capture" ? 5 : 3);
  expect(broker.subscriberCount).toBe(0);
});

it("bounds only a history-return viewer while geometry keeps changing and healthy output continues", async () => {
  let changing = false, reads = 0, captures = 0, capturesAtClose = 0;
  let broker: TerminalSessionBroker;
  broker = track(new TerminalSessionBroker("changing-history@fixture", makeTmux({
    getPaneCursorPosition: async () => ({ x: 0, y: 0, width: changing && ++reads % 2 === 0 ? 91 : 90, height: 27 }),
    capturePaneScreen: async () => {
      if (changing) fs.appendFileSync(broker.pipeOutputPath!, `CHANGE_${++captures};`);
      return changing ? "OLD_SIZE_SNAPSHOT" : "BASELINE";
    },
    capturePaneContent: async () => "HISTORY\n",
  }), { pollMs: 5, geometryMs: 5 }));
  const healthy = makeSub(), history = makeSub();
  const close = history.close;
  history.close = (code, reason) => { capturesAtClose = captures; close(code, reason); };
  await broker.attach(healthy); await broker.attach(history);
  await broker.scroll(history, 1); history.received.length = 0; healthy.received.length = 0;
  changing = true; await broker.scroll(history, 0);
  await vi.waitFor(() => expect(history.closed).toEqual([{ code: 1011, reason: "terminal screen remained busy; reopen to retry" }]));
  expect(healthy.closed).toEqual([]);
  expect(history.received).toEqual([]);
  expect(broker.subscriberCount).toBe(1);
  expect(capturesAtClose).toBe(9);
  changing = false; fs.appendFileSync(broker.pipeOutputPath!, "AFTER_CHANGE");
  await vi.waitFor(() => expect(healthy.received.join("")).toContain("AFTER_CHANGE"));
  for (let index = 1; index <= captures; index++) expect(healthy.received.join("").split(`CHANGE_${index};`)).toHaveLength(2);
  expect(healthy.received.join("")).not.toContain("OLD_SIZE_SNAPSHOT");
});
