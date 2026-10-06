import { expect, it, vi } from "vitest";
import { appendFileSync } from "node:fs";
import { TerminalBrokerRegistry, type BrokerTmux, type TerminalSubscriber } from "../src/terminal/TerminalSessionBroker.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function viewer() {
  const received: string[] = [], closed: unknown[] = [];
  const sub: TerminalSubscriber = { send: data => received.push(data), close: (code, reason) => closed.push({ code, reason }) };
  return { received, closed, sub };
}
function fixture() {
  const stop = deferred(), open = deferred();
  let active: string | null = null, fault = "", holdOpen = false, starts = 0, stops = 0;
  const tmux: BrokerTmux = {
    hasSession: async () => fault !== "death",
    startPipePane: async (_name, path) => { if (++starts === 1 && holdOpen) await open.promise; active = path; return { ok: true }; },
    stopPipePane: async () => { if (++stops === 1) await stop.promise; active = null; return { ok: true }; },
    getPaneCursorPosition: async () => fault === "geometry" ? null : { x: 0, y: 0, width: 90, height: 27 },
    capturePaneScreen: async () => fault === "capture" ? null : "CURRENT",
    sendKeys: async () => ({ ok: true }), sendText: async () => ({ ok: true }),
  };
  const registry = new TerminalBrokerRegistry(tmux, { pollMs: 5, geometryMs: 5, livenessMs: 10 });
  return { registry, tmux, stop, open, setFault: (value: string) => { fault = value; }, holdOpen: () => { holdOpen = true; },
    starts: () => starts, stops: () => stops, emit: () => { if (active) appendFileSync(active, "REOPEN_BYTES"); } };
}

it.each(["capture", "geometry", "dispose", "detach", "death"])("waits for a delayed old pipe stop before concurrent reopen after %s", async mode => {
  const f = fixture(), oldViewer = viewer(), a = viewer(), b = viewer();
  const old = await f.registry.attach("shutdown@fixture", oldViewer.sub);
  let reopen: Promise<unknown>[] = [];
  try {
    if (mode === "capture" || mode === "geometry") {
      f.setFault(mode); await old.scroll(oldViewer.sub, 0);
      await vi.waitFor(() => expect(oldViewer.closed).toHaveLength(1));
      f.setFault("");
    } else if (mode === "death") {
      f.setFault("death"); await vi.waitFor(() => expect(oldViewer.closed).toHaveLength(1)); f.setFault("");
    } else if (mode === "dispose") old.dispose();
    else old.detach(oldViewer.sub);
    await vi.waitFor(() => expect(f.stops()).toBe(1));
    reopen = [f.registry.attach("shutdown@fixture", a.sub), f.registry.attach("shutdown@fixture", b.sub)];
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(f.starts(), "replacement must not open while session-scoped old stop can still disable it").toBe(1);
    expect(a.closed).toEqual([]); expect(b.closed).toEqual([]);
    f.stop.resolve();
    const [first, second] = await Promise.all(reopen);
    expect(first).toBe(second); expect(first).not.toBe(old);
    expect(f.starts()).toBe(2); expect(f.registry.size).toBe(1);
    f.emit();
    await vi.waitFor(() => expect([a, b].every(v => v.received.includes("REOPEN_BYTES"))).toBe(true));
    expect(a.closed).toEqual([]); expect(b.closed).toEqual([]);
  } finally {
    f.stop.resolve(); f.open.resolve();
    await Promise.allSettled(reopen);
    f.registry.get("shutdown@fixture")?.dispose(); old.dispose();
  }
});

it("waits for an in-flight open to finish and stops it before replacement open", async () => {
  const f = fixture(); f.holdOpen();
  const a = viewer(), b = viewer();
  const firstAttach = f.registry.attach("opening@fixture", a.sub);
  await vi.waitFor(() => expect(f.starts()).toBe(1));
  const old = f.registry.get("opening@fixture")!;
  old.dispose();
  const replacement = f.registry.attach("opening@fixture", b.sub);
  try {
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(f.starts()).toBe(1);
    f.open.resolve();
    await vi.waitFor(() => expect(f.stops()).toBe(1));
    expect(f.starts()).toBe(1);
    f.stop.resolve();
    await firstAttach;
    expect(await replacement).not.toBe(old);
    expect(f.starts()).toBe(2);
    expect(a.closed).toHaveLength(1); expect(b.closed).toEqual([]);
    f.emit(); await vi.waitFor(() => expect(b.received).toContain("REOPEN_BYTES"));
  } finally {
    f.open.resolve(); f.stop.resolve(); await Promise.allSettled([firstAttach, replacement]);
    f.registry.get("opening@fixture")?.dispose(); old.dispose();
  }
});

it("releases the replacement barrier and cleans resources even when old stop rejects", async () => {
  const f = fixture(), a = viewer(), b = viewer();
  f.tmux.stopPipePane = async () => { await f.stop.promise; throw Error("fixture stop failed"); };
  const old = await f.registry.attach("stop-error@fixture", a.sub);
  old.dispose(); const replacement = f.registry.attach("stop-error@fixture", b.sub);
  try {
    await new Promise(resolve => setTimeout(resolve, 20)); expect(f.starts()).toBe(1);
    f.stop.resolve();
    const next = await replacement;
    expect(next).not.toBe(old); expect(old.pipeOutputPath).toBeNull();
    expect(f.starts()).toBe(2); expect(b.closed).toEqual([]);
    f.emit(); await vi.waitFor(() => expect(b.received).toContain("REOPEN_BYTES"));
  } finally { f.stop.resolve(); await replacement; f.registry.get("stop-error@fixture")?.dispose(); }
});

it("does not shut down a pipe while another viewer is still being seeded after last-viewer detach", async () => {
  const f = fixture(), a = viewer(), b = viewer(), seed = deferred();
  const old = await f.registry.attach("seed-detach@fixture", a.sub);
  f.tmux.capturePaneScreen = async () => { await seed.promise; return "CURRENT"; };
  const replacement = f.registry.attach("seed-detach@fixture", b.sub);
  await new Promise(resolve => setTimeout(resolve, 10));
  old.detach(a.sub);
  try {
    expect(f.stops()).toBe(0); expect(f.registry.get("seed-detach@fixture")).toBe(old);
    seed.resolve(); expect(await replacement).toBe(old);
    expect(b.closed).toEqual([]); expect(old.subscriberCount).toBe(1);
    expect(f.starts()).toBe(1); expect(f.stops()).toBe(0);
    f.emit(); await vi.waitFor(() => expect(b.received).toContain("REOPEN_BYTES"));
  } finally { seed.resolve(); f.stop.resolve(); await replacement; old.dispose(); }
});
