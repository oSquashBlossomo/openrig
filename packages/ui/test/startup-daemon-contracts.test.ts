// @vitest-environment node
// Actual Hono routes / private SQLite. Tmux/runtime services are injected; no
// listener, native process, installed daemon, home database or fleet writes.
import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createFullTestDb, createTestApp } from "../../daemon/test/helpers/test-app.js";
import { SeatLifecycleService } from "../../daemon/src/domain/seat-lifecycle-service.js";
import { crashCartRoutes, __resetFleetAttempts } from "../../daemon/src/routes/crash-cart.js";
import { readStartupRig, selectStartupSeat, performStartupAction, reconcileStartupAttempt, kickoffFleetRestore, cancelFleetRestore, readFleetRestoreStatus } from "../src/lib/startup-operations.js";
vi.mock("../../daemon/src/domain/kernel-boot.js", async original => ({ ...await original<typeof import("../../daemon/src/domain/kernel-boot.js")>(), defaultProbeRuntimes: vi.fn(async () => ({ codex: "ok", claudeCode: "ok" })) }));
const local = { kind: "local-instance" } as const;
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); __resetFleetAttempts(); });

describe("new startup/fleet clients against isolated daemon route contracts", () => {
  it("accepts actual startup read shape and preserves exact stale-revision refusal without launch", async () => {
    const db = createFullTestDb();
    try {
      const setup = createTestApp(db); const rig = setup.rigRepo.createRig("private-contract");
      const node = setup.rigRepo.addNode(rig.id, "operator.agent", { runtime: "codex", model: "configured-model" });
      const session = setup.sessionRegistry.registerSession(node.id, "operator-agent@private-contract");
      setup.sessionRegistry.updateBinding(node.id, { tmuxSession: session.sessionName, tmuxPane: "%1" });
      setup.tmuxAdapter.probeSession = vi.fn(async () => ({ state: "absent" as const }));
      const fetch = vi.fn((route: string, options?: RequestInit) => setup.app.request(route, options)); vi.stubGlobal("fetch", fetch);
      const observed = await readStartupRig(local, rig.id); const selection = selectStartupSeat(observed, node.id);
      expect(observed.seats[0]).toMatchObject({ nodeId: node.id, hasHistory: true, runtime: "codex", model: "configured-model", observed: { state: "stopped", sessionName: session.sessionName } });
      db.prepare("UPDATE nodes SET model = ? WHERE id = ?").run("changed while selected", node.id);
      const launch = vi.spyOn(SeatLifecycleService.prototype, "launchFresh");
      const error = await performStartupAction(local, { selection, action: "resume" }).catch(e => e);
      expect(error).toMatchObject({ code: "rejected", status: 409, serverCode: "selection_changed", attempt: { selection } });
      const readback = await reconcileStartupAttempt(local, error.attempt);
      expect(readback).toMatchObject({ selectionChanged: true, seat: { nodeId: node.id, model: "changed while selected" } });
      db.prepare("UPDATE nodes SET runtime = NULL WHERE id = ?").run(node.id);
      expect(await reconcileStartupAttempt(local, error.attempt)).toMatchObject({ selectionChanged: true, seat: { nodeId: node.id, runtime: null } });
      expect(launch).not.toHaveBeenCalled(); expect(setup.tmuxAdapter.createSession).not.toHaveBeenCalled();
      expect(fetch.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(1);
      expect(setup.sessionRegistry.getSessionsForRig(rig.id).map(s => s.id)).toEqual([session.id]);
    } finally { db.close(); }
  });
  it("retains nullable runtime inventory beside a healthy sibling without choosing an invented runtime", async () => {
    const db = createFullTestDb();
    try {
      const setup = createTestApp(db); const rig = setup.rigRepo.createRig("private-nullable");
      const configured = setup.rigRepo.addNode(rig.id, "configured.agent", { runtime: "codex" });
      const unconfigured = setup.rigRepo.addNode(rig.id, "unconfigured.agent");
      setup.tmuxAdapter.probeSession = vi.fn(async () => ({ state: "absent" as const }));
      vi.stubGlobal("fetch", vi.fn((route: string, options?: RequestInit) => setup.app.request(route, options)));
      const observed = await readStartupRig(local, rig.id);
      expect(observed.seats.find(s => s.nodeId === unconfigured.id)).toMatchObject({ runtime: null, model: null });
      expect(selectStartupSeat(observed, configured.id)).toMatchObject({ runtime: "codex", nodeId: configured.id });
      expect(() => selectStartupSeat(observed, unconfigured.id)).toThrow("runtime");
      expect(setup.tmuxAdapter.createSession).not.toHaveBeenCalled();
    } finally { db.close(); }
  });
  it("keeps actual continuation attention response distinct from a safe rejection or fresh retry", async () => {
    const db = createFullTestDb();
    try {
      const setup = createTestApp(db); const rig = setup.rigRepo.createRig("private-context");
      const node = setup.rigRepo.addNode(rig.id, "operator.agent", { runtime: "codex" });
      setup.tmuxAdapter.probeSession = vi.fn(async () => ({ state: "absent" as const }));
      const continuation = vi.spyOn(SeatLifecycleService.prototype, "continueFreshStartup").mockResolvedValue({ ok: false, code: "attention_required", message: "Resolve native prerequisite first." } as never);
      vi.stubGlobal("fetch", vi.fn((route: string, options?: RequestInit) => setup.app.request(route, options)));
      const observed = await readStartupRig(local, rig.id); const selection = selectStartupSeat(observed, node.id);
      const error = await performStartupAction(local, { selection, action: "continue" }).catch(e => e);
      expect(error).toMatchObject({ code: "outcome_unknown", status: 409, serverCode: "attention_required", details: { ok: false, message: "Resolve native prerequisite first." } });
      expect(continuation).toHaveBeenCalledTimes(1); expect(continuation).toHaveBeenCalledWith(selection.sessionName);
      expect(setup.tmuxAdapter.createSession).not.toHaveBeenCalled();
    } finally { db.close(); }
  });
  it("uses accepted actual fleet handle, cancels at the next-rig boundary and never kicks again", async () => {
    let release!: () => void; const blocked = new Promise<void>(resolve => { release = resolve; });
    const restored: string[] = [];
    const app = new Hono();
    const deps = {
      rigRepo: { listRigs: () => [{ id: "next-private", name: "next" }, { id: "kernel-private", name: "kernel" }] },
      snapshotRepo: { findLatestRestoreUsable: (id: string) => ({ id: `snapshot-${id}` }) },
      restoreOrchestrator: { restore: vi.fn(async (id: string) => { restored.push(id); await blocked; return { ok: true, result: { rigResult: "partially_restored", nodes: [{ logicalId: "checker.agent", status: "attention_required", attentionEvidence: "private native prompt" }] } }; }) },
    };
    app.use("*", async (c, next) => { for (const [key, value] of Object.entries(deps)) c.set(key as never, value as never); await next(); });
    app.route("/api/crash-cart", crashCartRoutes);
    const fetch = vi.fn((route: string, options?: RequestInit) => app.request(route, options)); vi.stubGlobal("fetch", fetch);
    try {
      const receipt = await kickoffFleetRestore(local, "private connected instance");
      const running = await readFleetRestoreStatus(local, receipt.handle.connectionKey, receipt.handle);
      expect(running.done).toBe(false); expect(running.rollup.sequence).toEqual([]);
      await cancelFleetRestore(local, receipt.handle.connectionKey, receipt.handle);
      expect(await readFleetRestoreStatus(local, receipt.handle.connectionKey, receipt.handle)).toMatchObject({ done: false, cancelled: true });
      release();
      let observed = await readFleetRestoreStatus(local, receipt.handle.connectionKey, receipt.handle);
      for (let i = 0; !observed.done && i < 10; i++) observed = await readFleetRestoreStatus(local, receipt.handle.connectionKey, receipt.handle);
      expect(observed).toMatchObject({ done: true, cancelled: true, verdict: "mixed", rollup: { counts: { partially_restored: 1, not_attempted: 1 },
        attention_required: [{ rigId: "kernel-private", seat: "checker.agent", need: "live runtime prompt — private native prompt" }] } });
      expect(restored).toEqual(["snapshot-kernel-private"]);
      expect(fetch.mock.calls.filter(([route]) => route === "/api/crash-cart/restore-fleet")).toHaveLength(1);
      __resetFleetAttempts(); // model daemon restart losing its process-local store
      await expect(readFleetRestoreStatus(local, receipt.handle.connectionKey, receipt.handle)).rejects.toMatchObject({ status: 404 });
    } finally { release(); }
  });
});
