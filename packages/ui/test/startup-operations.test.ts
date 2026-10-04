import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOCAL_OPERATOR_INSTANCE as local } from "../src/lib/operator-read.js";
import { consentToFreshStartup, performStartupAction, selectStartupSeat, readStartupRig, readStartupPrerequisites, reconcileStartupAttempt,
  kickoffFleetRestore, cancelFleetRestore, readFleetRestoreStatus } from "../src/lib/startup-operations.js";
import { fleetRestoreFrame, isFleetRestoreStatus } from "../src/lib/startup-contracts.js";

const remote = { kind: "remote-instance", hostId: "elsewhere" } as const;
const seat = { nodeId: "node/exact", logicalId: "operator.agent", runtime: "codex", model: "configured-model", revision: "rev/exact", hasHistory: true,
  intendedAction: "resume-original", freshRequired: false, tokenState: "present", occupantSessionId: "occupant/exact", contextPending: true, freshAllowed: false,
  observed: { state: "attention_required", detail: "native gate", sessionName: "served@rig" }, provenance: "operator", lastVerified: null, extra: { native: true } };
const rig = { rigId: "rig/exact", rigName: "rig", seats: [seat] };
const status = { done: false, cancelled: true, verdict: "mixed", rollup: { counts: { fully_restored: 1, partially_restored: 1, failed: 0, not_attempted: 1 }, sequence: [
  { rigId: "kernel", outcome: "fully_restored", receiptRef: 42 },
  { rigId: "partial", outcome: "partially_restored", attention: [{ rigId: "partial", seat: "checker.agent", need: "exact native prompt" }] },
  { rigId: "not-yet", outcome: "not_attempted", reason: "cancelled before next rig", remediation: "explicit next decision" },
], attention_required: [{ rigId: "partial", seat: "checker.agent", need: "exact native prompt" }] } };
const handle = { connectionKey: "connected/exact", fleetAttemptId: "fleet/exact" };
const json = (v: unknown, code = 200) => Response.json(v, { status: code });
beforeEach(() => localStorage.setItem("openrig.terminalBearerToken", "test-token"));
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); localStorage.removeItem("openrig.terminalBearerToken"); });

describe("startup exact read/consent/mutation identity", () => {
  it("reads full daemon facts with terminal authorization and exact encoded rig identity", async () => {
    const fetch = vi.fn(async () => json(rig)); vi.stubGlobal("fetch", fetch);
    expect(await readStartupRig(local, rig.rigId)).toEqual(rig);
    expect(fetch.mock.calls[0][0]).toBe("/api/startup/rig%2Fexact");
    expect(fetch.mock.calls[0][1].headers.Authorization).toBe("Bearer test-token");
    vi.stubGlobal("fetch", vi.fn(async () => json({ ...rig, rigId: "other" })));
    await expect(readStartupRig(local, rig.rigId)).rejects.toMatchObject({ code: "invalid_contract" });
  });
  it("cancels reads and bounds stalled startup bodies without losing original scope", async () => {
    vi.useFakeTimers(); vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: () => new Promise(() => {}) })));
    const request = readStartupRig(local, rig.rigId).catch(e => e);
    await vi.advanceTimersByTimeAsync(5000); expect(await request).toMatchObject({ code: "timeout" });
    const abort = new AbortController(); const cancelled = readStartupPrerequisites(local, { signal: abort.signal }).catch(e => e);
    abort.abort(); expect(await cancelled).toMatchObject({ code: "cancelled" }); expect(vi.getTimerCount()).toBe(0);
  });
  it("refuses remote reads and every write before transport", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch); const selection = selectStartupSeat(rig as never, seat.nodeId);
    for (const request of [readStartupRig(remote, rig.rigId), performStartupAction(remote, { selection, action: "resume" }), kickoffFleetRestore(remote, handle.connectionKey), cancelFleetRestore(remote, handle.connectionKey, handle)])
      await expect(request).rejects.toMatchObject({ code: "unsupported_scope" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("sends only exact action/revision and keeps consent bound to selected seat", async () => {
    const fetch = vi.fn(async () => json({ ok: true, seat: { ...seat, rigId: rig.rigId } })); vi.stubGlobal("fetch", fetch);
    const selection = selectStartupSeat(rig as never, seat.nodeId); const consent = consentToFreshStartup(selection);
    const receipt = await performStartupAction(local, { selection, action: "fresh", consent });
    expect(fetch.mock.calls[0][0]).toBe("/api/startup/rig%2Fexact/operator.agent");
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ action: "fresh", revision: seat.revision });
    expect(receipt.attempt.selection).toEqual(selection); expect(receipt.attempt.consent).toEqual(consent);
    await expect(performStartupAction(local, { selection: { ...selection, nodeId: "other" }, action: "fresh", consent })).rejects.toMatchObject({ code: "invalid_request" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("preserves configured custom runtime adapters and leaves availability to the daemon", async () => {
    const customRig = { ...rig, seats: [{ ...seat, runtime: "custom-native-adapter" }] };
    const selection = selectStartupSeat(customRig as never, seat.nodeId);
    expect(selection.runtime).toBe("custom-native-adapter");
    const fetch = vi.fn(async () => json({ ok: true, code: "running" })); vi.stubGlobal("fetch", fetch);
    expect(await performStartupAction(local, { selection, action: "resume" })).toMatchObject({ attempt: { selection }, result: { code: "running" } });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("preserves a stale revision rejection instead of rebasing and submitting again", async () => {
    const details = { ok: false, code: "selection_changed", message: "seat changed" };
    const fetch = vi.fn(async () => json(details, 409)); vi.stubGlobal("fetch", fetch);
    await expect(performStartupAction(local, { selection: selectStartupSeat(rig as never, seat.nodeId), action: "resume" })).rejects.toMatchObject({ code: "rejected", status: 409, serverCode: details.code, details, attempt: { payload: { revision: seat.revision } } });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each(["lost", "wrong-seat", "attention", "internal"])("retains immutable exact attempt with %s outcome and performs no replay", async (mode) => {
    const fetch = vi.fn(async () => {
      if (mode === "lost") throw new Error("response lost after send");
      return mode === "wrong-seat" ? json({ ok: true, seat: { rigId: rig.rigId, nodeId: "other", logicalId: seat.logicalId } })
        : json({ ok: false, code: mode === "attention" ? "attention_required" : "internal_error", sessionName: seat.observed.sessionName }, mode === "attention" ? 409 : 500);
    }); vi.stubGlobal("fetch", fetch);
    const mutable = { ...selectStartupSeat(rig as never, seat.nodeId) };
    const error = await performStartupAction(local, { selection: mutable, action: "continue" }).catch(e => e);
    mutable.revision = "later revision";
    expect(error).toMatchObject({ code: "outcome_unknown", attempt: { selection: { nodeId: seat.nodeId, revision: seat.revision }, payload: { action: "continue", revision: seat.revision } } });
    expect(Object.isFrozen(error.attempt.selection)).toBe(true); expect(Object.isFrozen(error.attempt.payload)).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    vi.stubGlobal("fetch", vi.fn(async () => json({ ...rig, seats: [{ ...seat, revision: "changed after effect" }] })));
    expect(await reconcileStartupAttempt(local, error.attempt)).toMatchObject({ selectionChanged: true, seat: { nodeId: seat.nodeId } });
  });
  it("bounds a lost post body and distinguishes cancellation before and after submission", async () => {
    vi.useFakeTimers(); const fetch = vi.fn(async () => ({ ok: true, status: 200, json: () => new Promise(() => {}) })); vi.stubGlobal("fetch", fetch);
    const selection = selectStartupSeat(rig as never, seat.nodeId);
    const pending = performStartupAction(local, { selection, action: "resume" }).catch(e => e);
    await vi.advanceTimersByTimeAsync(120_000); expect(await pending).toMatchObject({ code: "outcome_unknown" });
    const signal = new AbortController(); signal.abort();
    await expect(performStartupAction(local, { selection, action: "resume" }, { signal: signal.signal })).rejects.toMatchObject({ code: "cancelled" });
    expect(fetch).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });
});

describe("connected fleet handle/progress/cancel contract", () => {
  it("retains the kickoff handle, polls existing attempt and keeps partial/cancelled states honest", async () => {
    const fetch = vi.fn(async (_, options) => options?.method === "POST" ? json({ fleetAttemptId: handle.fleetAttemptId, status: "started" }, 202) : json(status)); vi.stubGlobal("fetch", fetch);
    const kickoff = await kickoffFleetRestore(local, handle.connectionKey);
    expect(kickoff.handle).toEqual(handle); expect(Object.isFrozen(kickoff.handle)).toBe(true);
    const observation = await readFleetRestoreStatus(local, handle.connectionKey, kickoff.handle);
    expect(observation).toEqual(status); expect(fleetRestoreFrame(handle, observation)).toMatchObject({ phase: "running", observation: { done: false, cancelled: true } });
    expect(fleetRestoreFrame(handle, observation, true)).toMatchObject({ phase: "detached", observation: status });
    expect(fetch.mock.calls.map(([, options]) => options.method)).toEqual(["POST", "GET"]);
  });
  it("cancels only exact retained ID, then reads actual status without kickoff", async () => {
    const fetch = vi.fn(async (_, options) => options?.method === "POST" ? json({ ok: true, cancelled: true }) : json(status)); vi.stubGlobal("fetch", fetch);
    const receipt = await cancelFleetRestore(local, handle.connectionKey, handle);
    expect(receipt.attempt.handle).toEqual(handle);
    expect(await readFleetRestoreStatus(local, handle.connectionKey, handle)).toEqual(status);
    expect(fetch.mock.calls.map(([path]) => path)).toEqual(["/api/crash-cart/restore-fleet/fleet%2Fexact/cancel", "/api/crash-cart/restore-fleet/fleet%2Fexact"]);
    await expect(cancelFleetRestore(local, "different instance", handle)).rejects.toMatchObject({ code: "invalid_request" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("keeps unknown handle explicit and never restarts an attempt to repair a 404", async () => {
    const fetch = vi.fn(async () => json({ error: "unknown fleet restore attempt" }, 404)); vi.stubGlobal("fetch", fetch);
    await expect(readFleetRestoreStatus(local, handle.connectionKey, handle)).rejects.toMatchObject({ status: 404 });
    await expect(cancelFleetRestore(local, handle.connectionKey, handle)).rejects.toMatchObject({ code: "rejected", status: 404, attempt: { handle } });
    expect(fetch.mock.calls.every(([path]) => path.includes("fleet%2Fexact"))).toBe(true);
  });
  it("losing kickoff response does not mint or assume an attempt handle", async () => {
    const fetch = vi.fn(async () => { throw new Error("response lost"); }); vi.stubGlobal("fetch", fetch);
    const error = await kickoffFleetRestore(local, handle.connectionKey).catch(e => e);
    expect(error).toMatchObject({ code: "outcome_unknown", attempt: { kind: "fleet-kickoff", connectionKey: handle.connectionKey, payload: {} } });
    expect(error.attempt.handle).toBeUndefined(); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("bounds a stalled fleet cancel response and retains exact handle for explicit readback", async () => {
    vi.useFakeTimers(); const fetch = vi.fn(async () => ({ ok: true, status: 200, json: () => new Promise(() => {}) })); vi.stubGlobal("fetch", fetch);
    const request = cancelFleetRestore(local, handle.connectionKey, handle).catch(e => e);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await request).toMatchObject({ code: "outcome_unknown", attempt: { kind: "fleet-cancel", handle, payload: {} } });
    expect(fetch).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });
  it("rejects corrupt progress without fabricating success or a percentage", () => {
    expect(isFleetRestoreStatus(status)).toBe(true);
    expect(isFleetRestoreStatus({ ...status, verdict: "all_fully_restored" })).toBe(false);
    expect(isFleetRestoreStatus({ ...status, rollup: { ...status.rollup, counts: { ...status.rollup.counts, failed: 9 } } })).toBe(false);
    expect(fleetRestoreFrame(handle)).toMatchObject({ phase: "observing", observation: undefined });
  });
});
