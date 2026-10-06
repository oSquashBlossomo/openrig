// useSpatialTopology — data truthfulness across hosts, bounded fetch work,
// cancellation and partial failure. Real fetch paths, mocked network.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider, keepPreviousData } from "@tanstack/react-query";
import { Component, type ReactNode } from "react";
import { useSpatialTopology } from "../src/hooks/useSpatialTopology.js";
import { useRigSummary } from "../src/hooks/useRigSummary.js";
import { useRigGraph } from "../src/hooks/useRigGraph.js";
import { MAX_SPATIAL_RIGS, type SpatialScope } from "../src/lib/spatial-topology.js";

function graphFor(prefix: string) {
  return {
    nodes: [
      { id: "pod-p", type: "podGroup", data: { podId: "p", podNamespace: "core" } },
      { id: `${prefix}-1`, type: "rigNode", parentId: "pod-p", data: { logicalId: `core.${prefix}1`, status: "running", terminalActive: true } },
      { id: `${prefix}-2`, type: "rigNode", parentId: "pod-p", data: { logicalId: `core.${prefix}2`, status: "running", terminalActive: false } },
    ],
    edges: [{ id: "e", source: `${prefix}-1`, target: `${prefix}-2`, label: "delegates_to" }],
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

let fetchMock: ReturnType<typeof vi.fn>;
let qc: QueryClient;

function setup(selected = "local", globalPlaceholder = false) {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity, ...(globalPlaceholder ? { placeholderData: keepPreviousData } : {}) } } });
  qc.setQueryData(["hosts"], { ownName: "me", selected, hosts: [] });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  return wrapper;
}

beforeEach(() => {
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => { qc?.clear(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe("useSpatialTopology", () => {
  it.each(["host", "rig"] as const)("uses the rig identity when the %s inventory name is unavailable", async kind => {
    fetchMock.mockImplementation(async (url: string) => json(url.includes("summary")
      ? [{ id: "ra", name: null }, { id: "rb", name: "bravo" }]
      : graphFor(url.includes("/ra/") ? "a" : "b")));
    const { result } = renderHook(() => useSpatialTopology(kind === "host" ? { kind: "host" } : { kind: "rig", rigId: "ra" }), { wrapper: setup() });
    await waitFor(() => expect(result.current.status).not.toBe("loading"));
    expect(result.current.status).toBe("ready");
    expect(result.current.model?.rigs.map(r => [r.rigId, r.rigName])).toEqual(kind === "host" ? [["ra", "ra"], ["rb", "bravo"]] : [["ra", "ra"]]);
    expect(result.current.rigErrors).toEqual([]);
    // The shared cache retains served null enrichment; only presentation falls back.
    await waitFor(() => expect(qc.getQueryData(["rigs", "summary", "local"])).toEqual([{ id: "ra", name: null }, { id: "rb", name: "bravo" }]));
  });

  it("updates the model when successful cache payloads change within one millisecond", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1791100000000);
    fetchMock.mockImplementation(async (url: string) => json(url.includes("summary") ? [{ id: "ra", name: "alpha" }] : graphFor("a")));
    const { result, rerender } = renderHook(() => useSpatialTopology({ kind: "rig", rigId: "ra" }), { wrapper: setup() });
    await waitFor(() => expect(result.current.model?.counts.agents).toBe(2));
    const key = ["rig", "ra", "graph", "local"];
    const firstTime = qc.getQueryState(key)!.dataUpdatedAt;
    act(() => { qc.setQueryData(key, graphFor("b")); });
    rerender();
    expect(qc.getQueryState(key)!.dataUpdatedAt).toBe(firstTime);
    expect([...result.current.model!.agentsByKey.values()].map(a => a.logicalId)).toEqual(["core.b1", "core.b2"]);
    const currentModel = result.current.model;
    rerender();
    // Unrelated renders must not allocate a fresh model and restart the scene.
    expect(result.current.model).toBe(currentModel);
  });

  it.each([{ error: "wrong contract" }, [null], [{ id: "ra", name: {} }], [{ id: "ra", nodeCount: "many" }]])("reports malformed summary %j as an error without a render crash", async payload => {
    let caught: Error | undefined;
    class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
      state = { failed: false };
      static getDerivedStateFromError() { return { failed: true }; }
      componentDidCatch(error: Error) { caught = error; }
      render() { return this.state.failed ? null : this.props.children; }
    }
    const inner = setup();
    const wrapper = ({ children }: { children: ReactNode }) => <Boundary>{inner({ children })}</Boundary>;
    vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.mockImplementation(async () => json(payload));
    const { result } = renderHook(() => useSpatialTopology({ kind: "host" }), { wrapper });
    await waitFor(() => expect(caught ?? result.current.status).not.toBe("loading"));
    expect(caught).toBeUndefined();
    expect(result.current.status).toBe("error");
    expect(result.current.errorMessage).toMatch(/invalid topology rig summary/i);
    expect(result.current.model).toBeNull();
  });

  it.each([null, { error: "wrong contract" }, { nodes: "wrong", edges: [] }, { nodes: [], edges: {} }, { nodes: [] }])("reports malformed graph %j as unavailable instead of an empty successful rig", async payload => {
    fetchMock.mockImplementation(async (url: string) => json(url.includes("summary") ? [{ id: "ra", name: "alpha" }] : payload));
    const { result } = renderHook(() => useSpatialTopology({ kind: "host" }), { wrapper: setup() });
    await waitFor(() => expect(result.current.status).not.toBe("loading"));
    expect(result.current.status).toBe("error");
    expect(result.current.model).toBeNull();
    expect(result.current.rigErrors).toEqual([{ rigId: "ra", rigName: "alpha", message: "Invalid topology graph payload." }]);
  });

  it.each(["summary", "graph"] as const)("guards malformed shared %s cache data before an in-flight refresh finishes", async endpoint => {
    const wrapper = setup();
    qc.setQueryData(["rigs", "summary", "local"], endpoint === "summary" ? { error: "old malformed cache" } : [{ id: "ra", name: "alpha" }]);
    if (endpoint === "graph") qc.setQueryData(["rig", "ra", "graph", "local"], { nodes: "old malformed cache" });
    fetchMock.mockImplementation(() => new Promise<Response>(() => {}));
    const { result } = renderHook(() => useSpatialTopology({ kind: "host" }), { wrapper });
    expect(result.current.status).toBe("error");
    expect(result.current.model).toBeNull();
    expect(result.current.errorMessage).toMatch(/invalid topology/i);
  });

  it.each(["summary", "graph"] as const)("bounds a shared %s read started by a 2D observer before the spatial observer mounts", async endpoint => {
    vi.useFakeTimers();
    let readSignal: AbortSignal | null | undefined;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (endpoint === "graph" && url.startsWith("/api/rigs/summary")) return Promise.resolve(json([{ id: "ra", name: "alpha" }]));
      readSignal = init?.signal;
      return new Promise<Response>(() => {});
    });
    const wrapper = setup("hostB");
    qc.setDefaultOptions({ queries: { retry: 1, gcTime: Infinity } });
    renderHook(() => endpoint === "summary" ? useRigSummary() : useRigGraph("ra"), { wrapper });
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    const { result } = renderHook(() => useSpatialTopology(endpoint === "summary" ? { kind: "host" } : { kind: "rig", rigId: "ra" }), { wrapper });
    await act(async () => { await vi.advanceTimersByTimeAsync(4_001); });
    expect(result.current.status).toBe("error");
    expect(result.current.errorMessage).toMatch(/timed out.*5 seconds/i);
    expect(readSignal?.aborted).toBe(true);
    const route = endpoint === "summary" ? "/api/rigs/summary?host=hostB" : "/api/rigs/ra/graph?host=hostB";
    expect(fetchMock.mock.calls.filter(([url]) => url === route)).toHaveLength(1);
  });

  it("omits a cached graph after failed refresh, reports that rig, and recovers on success", async () => {
    let failed = false;
    fetchMock.mockImplementation(async (url: string) => {
      if (url === "/api/rigs/summary") return json([{ id: "ra", name: "alpha" }, { id: "rb", name: "bravo" }]);
      if (url === "/api/rigs/ra/graph" && failed) return json({}, 503);
      return json(graphFor(url.includes("ra") ? "a" : "b"));
    });
    const { result } = renderHook(() => useSpatialTopology({ kind: "host" }), { wrapper: setup() });
    await waitFor(() => expect(result.current.model?.counts.rigs).toBe(2));
    failed = true;
    await act(async () => { await qc.invalidateQueries({ queryKey: ["rig", "ra", "graph", "local"] }); });
    await waitFor(() => expect(result.current.rigErrors).toEqual([{ rigId: "ra", rigName: "alpha", message: "HTTP 503" }]));
    expect(result.current.status).toBe("ready");
    expect(result.current.model?.rigs.map(r => r.rigId)).toEqual(["rb"]);
    // Keep the shared 2D cache contract: last success is retained by TanStack,
    // but the spatial current model must exclude it while this read is failed.
    expect(qc.getQueryData(["rig", "ra", "graph", "local"])).toEqual(graphFor("a"));
    failed = false;
    await act(async () => { await qc.invalidateQueries({ queryKey: ["rig", "ra", "graph", "local"] }); });
    await waitFor(() => expect(result.current.model?.counts.rigs).toBe(2));
    expect(result.current.rigErrors).toEqual([]);
  });

  it("does not present the previous inventory after a failed summary refresh", async () => {
    let failed = false;
    fetchMock.mockImplementation(async (url: string) => url === "/api/rigs/summary"
      ? json(failed ? {} : [{ id: "ra", name: "alpha" }], failed ? 502 : 200)
      : json(graphFor("a")));
    const { result } = renderHook(() => useSpatialTopology({ kind: "host" }), { wrapper: setup() });
    await waitFor(() => expect(result.current.model?.counts.rigs).toBe(1));
    failed = true;
    await act(async () => { await qc.invalidateQueries({ queryKey: ["rigs", "summary", "local"] }); });
    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.model).toBeNull();
    expect(result.current.errorMessage).toBe("HTTP 502");
  });

  it("defeats global graph placeholders when rig IDs are reused across hosts", async () => {
    let releaseRemote!: (r: Response) => void;
    const signals: AbortSignal[] = [];
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.startsWith("/api/rigs/summary")) return Promise.resolve(json([{ id: "ra", name: url.includes("host=") ? "remote" : "local" }]));
      if (url.includes("host=hostB")) {
        signals.push(init!.signal!);
        return new Promise<Response>(resolve => { releaseRemote = resolve; });
      }
      return Promise.resolve(json(graphFor("same")));
    });
    const { result } = renderHook(() => useSpatialTopology({ kind: "rig", rigId: "ra" }), { wrapper: setup("local", true) });
    await waitFor(() => expect(result.current.model?.counts.agents).toBe(2));
    const localKeys = [...result.current.model!.agentsByKey.keys()];
    // A global placeholder factory can return a shared entity payload even
    // when useQueries has no previous observer data. Override it explicitly.
    qc.setDefaultOptions({ queries: { retry: false, gcTime: Infinity, placeholderData: () => graphFor("same") } });
    act(() => { qc.setQueryData(["hosts"], { selected: "hostB", hosts: [] }); });
    await waitFor(() => expect(signals).toHaveLength(1));
    expect(result.current.hostId).toBe("hostB");
    expect(result.current.status).toBe("loading");
    expect(result.current.model).toBeNull();
    await act(async () => { releaseRemote(json(graphFor("same"))); });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const remoteKeys = [...result.current.model!.agentsByKey.keys()];
    expect(remoteKeys.every(k => k.startsWith("hostB/"))).toBe(true);
    expect(remoteKeys.some(k => localKeys.includes(k))).toBe(false);
  });

  it("aborts an old host read and ignores its late completion after selection changes", async () => {
    let releaseLocal!: (r: Response) => void;
    let localSignal!: AbortSignal;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.startsWith("/api/rigs/summary")) return Promise.resolve(json([{ id: "ra", name: "alpha" }]));
      if (url === "/api/rigs/ra/graph") {
        localSignal = init!.signal!;
        return new Promise<Response>(resolve => { releaseLocal = resolve; });
      }
      return Promise.resolve(json(graphFor("remote")));
    });
    const { result } = renderHook(() => useSpatialTopology({ kind: "rig", rigId: "ra" }), { wrapper: setup() });
    await waitFor(() => expect(localSignal).toBeDefined());
    act(() => { qc.setQueryData(["hosts"], { selected: "hostB", hosts: [] }); });
    await waitFor(() => expect(result.current.model?.counts.agents).toBe(2));
    expect(localSignal.aborted).toBe(true);
    await act(async () => { releaseLocal(json(graphFor("local"))); });
    expect([...result.current.model!.agentsByKey.values()].map(a => a.logicalId)).toEqual(["core.remote1", "core.remote2"]);
    expect(qc.getQueryData(["rig", "ra", "graph", "local"])).toBeUndefined();
  });

  it.each(["summary", "graph"] as const)("bounds %s response headers and body to one total five-second deadline", async endpoint => {
    vi.useFakeTimers();
    let readSignal!: AbortSignal;
    let release!: (r: Response) => void;
    const cancel = vi.fn(async () => {});
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (endpoint === "graph" && url.startsWith("/api/rigs/summary")) return Promise.resolve(json([{ id: "ra", name: "alpha" }]));
      readSignal = init!.signal!;
      return new Promise<Response>(resolve => { release = resolve; });
    });
    const { result } = renderHook(() => useSpatialTopology(endpoint === "summary" ? { kind: "host" } : { kind: "rig", rigId: "ra" }), { wrapper: setup("hostB") });
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(readSignal.aborted).toBe(false);
    await act(async () => { release({ ok: true, status: 200, json: () => new Promise(() => {}), body: { cancel } } as unknown as Response); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(result.current.status).toBe("error");
    expect(result.current.model).toBeNull();
    expect(result.current.errorMessage).toMatch(/timed out.*5 seconds/i);
    expect(readSignal.aborted).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("host scope: reads summary + one graph per rig, keyed and scoped by host", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === "/api/rigs/summary") return json([{ id: "ra", name: "alpha", nodeCount: 2 }, { id: "rb", name: "bravo", nodeCount: 5 }]);
      if (url === "/api/rigs/ra/graph") return json(graphFor("a"));
      if (url === "/api/rigs/rb/graph") return json(graphFor("b"));
      return json({}, 404);
    });
    const { result } = renderHook(() => useSpatialTopology({ kind: "host" }), { wrapper: setup() });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await waitFor(() => expect(result.current.model?.counts.rigs).toBe(2));
    expect(result.current.model?.counts).toEqual({ rigs: 2, pods: 2, agents: 4, edges: 2 });
    expect(result.current.model?.rigs.map((r) => [r.rigName, r.summaryNodeCount])).toEqual([["alpha", 2], ["bravo", 5]]);
    expect([...result.current.model!.agentsByKey.keys()].every((k) => k.startsWith("local/"))).toBe(true);
  });

  it("never renders the previous host's rigs while the newly selected host loads", async () => {
    let releaseRemote: (r: Response) => void = () => {};
    fetchMock.mockImplementation(async (url: string) => {
      if (url === "/api/rigs/summary") return json([{ id: "ra", name: "alpha", nodeCount: 2 }]);
      if (url === "/api/rigs/ra/graph") return json(graphFor("a"));
      if (url === "/api/rigs/summary?host=hostB") return new Promise<Response>((resolve) => { releaseRemote = resolve; });
      if (url === "/api/rigs/rz/graph?host=hostB") return json(graphFor("z"));
      return json({}, 404);
    });
    const { result } = renderHook(() => useSpatialTopology({ kind: "host" }), { wrapper: setup("local") });
    await waitFor(() => expect(result.current.model?.counts.rigs).toBe(1));

    act(() => {
      qc.setQueryData(["hosts"], { ownName: "me", selected: "hostB", hosts: [] });
    });
    await waitFor(() => expect(result.current.hostId).toBe("hostB"));
    // keepPreviousData would hand back alpha here; the 3D view must not.
    expect(result.current.status).toBe("loading");
    expect(result.current.model).toBeNull();
    // ...and host A's rig ids are never queried against host B.
    expect(fetchMock.mock.calls.some(([u]) => String(u) === "/api/rigs/ra/graph?host=hostB")).toBe(false);

    await act(async () => {
      releaseRemote(json([{ id: "rz", name: "zulu", nodeCount: 2 }]));
    });
    await waitFor(() => expect(result.current.model?.rigs.map((r) => r.rigName)).toEqual(["zulu"]));
    expect([...result.current.model!.agentsByKey.keys()].every((k) => k.startsWith("hostB/"))).toBe(true);
  });

  it("bounds host-scope fetches and reports the truncated remainder", async () => {
    const total = MAX_SPATIAL_RIGS + 6;
    fetchMock.mockImplementation(async (url: string) => {
      if (url === "/api/rigs/summary") return json(Array.from({ length: total }, (_, i) => ({ id: `r${i}`, name: `r${i}`, nodeCount: 0 })));
      return json({ nodes: [], edges: [] });
    });
    const { result } = renderHook(() => useSpatialTopology({ kind: "host" }), { wrapper: setup() });
    await waitFor(() => expect(result.current.model?.counts.rigs).toBe(MAX_SPATIAL_RIGS));
    expect(result.current.truncatedRigCount).toBe(6);
    const graphCalls = fetchMock.mock.calls.filter(([u]) => String(u).endsWith("/graph"));
    expect(graphCalls).toHaveLength(MAX_SPATIAL_RIGS);
  });

  it("forwards an AbortSignal and cancels in-flight graph reads on unmount", async () => {
    const signals: AbortSignal[] = [];
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === "/api/rigs/summary") return Promise.resolve(json([{ id: "ra", name: "alpha", nodeCount: 2 }]));
      if (init?.signal) signals.push(init.signal);
      return new Promise<Response>(() => {});
    });
    const { result, unmount } = renderHook(() => useSpatialTopology({ kind: "host" }), { wrapper: setup() });
    await waitFor(() => expect(signals.length).toBe(1));
    expect(result.current.status).toBe("loading");
    unmount();
    await waitFor(() => expect(signals[0]!.aborted).toBe(true));
  });

  it("partial failure: readable rigs render, failed rigs are reported", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === "/api/rigs/summary") return json([{ id: "ra", name: "alpha" }, { id: "rb", name: "bravo" }]);
      if (url === "/api/rigs/ra/graph") return json(graphFor("a"));
      return json({ error: "boom" }, 500);
    });
    const { result } = renderHook(() => useSpatialTopology({ kind: "host" }), { wrapper: setup() });
    await waitFor(() => expect(result.current.rigErrors).toHaveLength(1));
    expect(result.current.status).toBe("ready");
    expect(result.current.model?.counts.rigs).toBe(1);
    expect(result.current.rigErrors[0]).toMatchObject({ rigId: "rb", rigName: "bravo", message: "HTTP 500" });
  });

  it("all graphs failing is an error, not an empty topology", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === "/api/rigs/summary") return json([{ id: "ra", name: "alpha" }]);
      return json({}, 503);
    });
    const { result } = renderHook(() => useSpatialTopology({ kind: "host" }), { wrapper: setup() });
    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.model).toBeNull();
    expect(result.current.errorMessage).toBe("HTTP 503");
  });

  it("rig scope fetches only that rig; pod scope narrows and reports a missing pod", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === "/api/rigs/summary") return json([{ id: "ra", name: "alpha" }, { id: "rb", name: "bravo" }]);
      if (url === "/api/rigs/ra/graph") return json(graphFor("a"));
      return json({}, 404);
    });
    const wrapper = setup();
    const rig = renderHook(() => useSpatialTopology({ kind: "rig", rigId: "ra" }), { wrapper });
    await waitFor(() => expect(rig.result.current.model?.counts.agents).toBe(2));
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/rb/"))).toBe(false);

    let scope: SpatialScope = { kind: "pod", rigId: "ra", podName: "core" };
    const pod = renderHook(() => useSpatialTopology(scope), { wrapper });
    await waitFor(() => expect(pod.result.current.model?.counts.pods).toBe(1));
    scope = { kind: "pod", rigId: "ra", podName: "missing" };
    pod.rerender();
    await waitFor(() => expect(pod.result.current.podMissing).toBe(true));
    expect(pod.result.current.model?.counts.agents).toBe(0);
  });
});
