import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PropsWithChildren } from "react";
import { useStartupActions, useStartupRig, consentToFreshStartup } from "../src/hooks/useStartup.js";
import { useFleetRestoreAttempt, useFleetRestoreStatus, useFleetRestoreCancel, useFleetRestoreKickoff } from "../src/hooks/useFleetRestore.js";
const local = { kind: "local-instance" } as const;
const remote = { kind: "remote-instance", hostId: "elsewhere" } as const;
const handle = { connectionKey: "connection/exact", fleetAttemptId: "fleet/exact" };
const selection = { rigId: "rig/exact", nodeId: "node/exact", logicalId: "operator.agent", runtime: "codex", revision: "rev/exact", sessionName: "exact@rig" };
const empty = { done: false, cancelled: false, verdict: "none_attempted", rollup: { counts: { fully_restored: 0, partially_restored: 0, failed: 0, not_attempted: 0 }, sequence: [], attention_required: [] } };
const clients: QueryClient[] = [];
function harness() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } }); clients.push(client);
  return { client, wrapper: ({ children }: PropsWithChildren) => <QueryClientProvider client={client}>{children}</QueryClientProvider> };
}
afterEach(() => { clients.splice(0).forEach(c => c.clear()); vi.restoreAllMocks(); vi.unstubAllGlobals(); sessionStorage.clear(); });

describe("startup and connected restore hooks", () => {
  it("keeps remote/missing selections disabled and keys distinct without local fallback", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch); const { wrapper, client } = harness();
    const rig = renderHook(({ scope, id }) => useStartupRig(id, scope), { wrapper, initialProps: { scope: remote as typeof remote | typeof local, id: "rig/exact" as string | null } });
    expect(rig.result.current.scopeSupported).toBe(false); expect(fetch).not.toHaveBeenCalled();
    rig.rerender({ scope: local, id: null }); expect(fetch).not.toHaveBeenCalled();
    expect(client.getQueryCache().getAll().map(q => q.queryKey)).toEqual([
      ["startup", "operator", "remote-instance", "elsewhere", "rig", "rig/exact"],
      ["startup", "operator", "local-instance", "rig", null],
    ]);
  });
  it("serializes repeated startup actions while preserving the first effect's pending state", async () => {
    let resolve!: (r: Response) => void;
    const fetch = vi.fn(() => new Promise<Response>(done => { resolve = done; })); vi.stubGlobal("fetch", fetch);
    const { wrapper } = harness(); const { result } = renderHook(() => useStartupActions(local), { wrapper });
    let first!: Promise<unknown>;
    await act(async () => { first = result.current.mutateAsync({ kind: "seat", input: { selection, action: "fresh", consent: consentToFreshStartup(selection) } }); });
    await waitFor(() => expect(result.current.operationPending).toBe(true));
    await act(async () => { await expect(result.current.mutateAsync({ kind: "seat", input: { selection, action: "resume" } })).rejects.toMatchObject({ code: "operation_in_progress" }); });
    expect(result.current.operationPending).toBe(true); expect(fetch).toHaveBeenCalledTimes(1);
    await act(async () => { resolve(Response.json({ ok: true, sessionName: selection.sessionName })); await first; });
    await waitFor(() => expect(result.current.operationPending).toBe(false));
  });
  it("keeps the first accepted startup receipt after duplicate mutate input", async () => {
    let resolve!: (r: Response) => void;
    const fetch = vi.fn(() => new Promise<Response>(done => { resolve = done; })); vi.stubGlobal("fetch", fetch);
    const { wrapper } = harness(); const { result } = renderHook(() => useStartupActions(local), { wrapper });
    const request = { kind: "seat" as const, input: { selection, action: "resume" as const } };
    act(() => { result.current.mutate(request); result.current.mutate(request); });
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(result.current.operationPending).toBe(true);
    await act(async () => { resolve(Response.json({ ok: true, sessionName: selection.sessionName, code: "running" })); });
    await waitFor(() => expect(result.current.operationPending).toBe(false));
    expect(result.current.data).toMatchObject({ result: { ok: true, code: "running" }, attempt: { selection } });
    expect(result.current.isSuccess).toBe(true);
  });
  it("keeps an accepted fleet handle after duplicate mutate rather than losing recoverability", async () => {
    let resolve!: (r: Response) => void;
    const fetch = vi.fn(() => new Promise<Response>(done => { resolve = done; })); vi.stubGlobal("fetch", fetch);
    const { wrapper } = harness(); const { result } = renderHook(() => useFleetRestoreKickoff(handle.connectionKey, local), { wrapper });
    act(() => { result.current.mutate(); result.current.mutate(); });
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    await act(async () => { resolve(Response.json({ fleetAttemptId: handle.fleetAttemptId, status: "started" }, { status: 202 })); });
    await waitFor(() => expect(result.current.operationPending).toBe(false));
    expect(result.current.data?.handle).toEqual(handle); expect(result.current.isSuccess).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("retains an accepted fleet handle even when its requesting view detaches before the response", async () => {
    let resolve!: (r: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(done => { resolve = done; })));
    const { wrapper } = harness(); const kickoff = renderHook(() => useFleetRestoreKickoff(handle.connectionKey, local), { wrapper });
    act(() => kickoff.result.current.mutate());
    await waitFor(() => expect(kickoff.result.current.operationPending).toBe(true));
    kickoff.unmount();
    await act(async () => { resolve(Response.json({ fleetAttemptId: handle.fleetAttemptId, status: "started" }, { status: 202 })); });
    const recovered = renderHook(() => useFleetRestoreAttempt(handle.connectionKey));
    await waitFor(() => expect(recovered.result.current.handle).toEqual(handle));
  });
  it("keeps storage failure separate from accepted restore outcome", async () => {
    const storage = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ fleetAttemptId: handle.fleetAttemptId, status: "started" }, { status: 202 })));
    const { wrapper } = harness(); const { result } = renderHook(() => useFleetRestoreKickoff(handle.connectionKey, local), { wrapper });
    await act(async () => { await result.current.mutateAsync(); });
    expect(result.current.data?.handle).toEqual(handle); expect(result.current.data?.retentionError).toBeInstanceOf(Error);
    expect(result.current.isSuccess).toBe(true); storage.mockRestore();
  });
  it("retains exact connection-bound attempt across reload without interpreting restart as successful restore", async () => {
    const first = renderHook(() => useFleetRestoreAttempt(handle.connectionKey));
    act(() => first.result.current.retain(handle)); expect(first.result.current.handle).toEqual(handle);
    first.unmount();
    const second = renderHook(({ key }) => useFleetRestoreAttempt(key), { initialProps: { key: handle.connectionKey } });
    expect(second.result.current.handle).toEqual(handle);
    second.rerender({ key: "other daemon" }); expect(second.result.current.handle).toBeNull();
    expect(() => second.result.current.retain(handle)).toThrow("another instance");
    second.rerender({ key: handle.connectionKey }); await waitFor(() => expect(second.result.current.handle).toEqual(handle));
    act(() => second.result.current.clear()); expect(second.result.current.handle).toBeNull();
  });
  it("tolerates poll blips, resets error streak on observation, detaches and reattaches the exact GET", async () => {
    let fail = true;
    const fetch = vi.fn(async () => { if (fail) throw new Error("temporary read failure"); return Response.json(empty); }); vi.stubGlobal("fetch", fetch);
    const { wrapper } = harness(); const { result } = renderHook(() => useFleetRestoreStatus(handle.connectionKey, handle, local, { pollIntervalMs: 60_000, maxConsecutiveErrors: 2 }), { wrapper });
    await waitFor(() => expect(result.current.polls).toBe(1)); expect(result.current.detached).toBe(false);
    fail = false;
    await act(async () => { await result.current.refetch(); });
    expect(result.current.frame?.phase).toBe("running");
    fail = true;
    await act(async () => { await result.current.refetch(); }); expect(result.current.detached).toBe(false);
    await act(async () => { await result.current.refetch(); }); expect(result.current.detached).toBe(true);
    expect(result.current.frame).toMatchObject({ phase: "detached", observation: { done: false, cancelled: false } });
    fail = false;
    await act(async () => { await result.current.reattach(); }); await waitFor(() => expect(result.current.detached).toBe(false));
    expect(fetch.mock.calls.every(([route, options]) => route === "/api/crash-cart/restore-fleet/fleet%2Fexact" && options.method === "GET")).toBe(true);
  });
  it("reads back cancel acceptance and keeps the current rig running until observed done", async () => {
    let cancelled = false;
    const fetch = vi.fn(async (path, options) => {
      if (options.method === "POST") { cancelled = true; return Response.json({ ok: true, cancelled: true }); }
      return Response.json({ ...empty, cancelled });
    }); vi.stubGlobal("fetch", fetch);
    const { wrapper } = harness(); const { result } = renderHook(() => ({ status: useFleetRestoreStatus(handle.connectionKey, handle, local, { pollIntervalMs: 60_000 }), cancel: useFleetRestoreCancel(handle.connectionKey, local) }), { wrapper });
    await waitFor(() => expect(result.current.status.data).toEqual(empty));
    await act(async () => { await result.current.cancel.mutateAsync(handle); });
    await waitFor(() => expect(result.current.status.data?.cancelled).toBe(true));
    expect(result.current.status.frame?.phase).toBe("running"); expect(fetch.mock.calls.filter(([, options]) => options.method === "POST")).toHaveLength(1);
  });
  it("detaches at the poll ceiling and reports missing handles without kicking off", async () => {
    const fetch = vi.fn(async () => Response.json(empty)); vi.stubGlobal("fetch", fetch); const { wrapper } = harness();
    const { result } = renderHook(() => useFleetRestoreStatus(handle.connectionKey, handle, local, { maxPolls: 1, pollIntervalMs: 60_000 }), { wrapper });
    await waitFor(() => expect(result.current.frame?.phase).toBe("detached"));
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "unknown fleet restore attempt" }, { status: 404 })));
    await act(async () => { await result.current.reattach(); });
    await waitFor(() => expect(result.current.frame?.phase).toBe("unavailable"));
  });
});
