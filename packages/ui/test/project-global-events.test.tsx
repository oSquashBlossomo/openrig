import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { useGlobalEvents } from "../src/hooks/useGlobalEvents.js";
import { useProjectCatalog } from "../src/hooks/useProjectCatalog.js";
import { useCanonicalScopes } from "../src/hooks/useCanonicalScopes.js";
import { useExecutionView } from "../src/hooks/useExecutionView.js";
import { projectKey } from "../src/lib/project-read.js";
import { LOCAL_OPERATOR_INSTANCE } from "../src/lib/operator-read.js";
import { at, catalog, execution, scopes } from "./project-contract-fixtures.js";

const selection = { id: "a", root: "/books/a" };
const catalogKey = ["operator", "local-instance", "projects", "catalog"];
const scopesKey = [...projectKey(LOCAL_OPERATOR_INSTANCE, selection), "scopes", "detail"];
const executionKey = [...projectKey(LOCAL_OPERATOR_INSTANCE, selection), "execution", "trial"];
interface Read { url: string; signal: AbortSignal; completed: boolean; body?: (value: unknown) => void }
let client: QueryClient;
let reads: Read[];
let emit: (name: string, data?: string) => void;
let connections: number;

function setup(delay = 200, hung = false) {
  vi.useFakeTimers(); vi.setSystemTime(new Date(at)); reads = []; connections = 0;
  vi.stubGlobal("EventSource", class {
    listeners = new Map<string, Array<(event: { data?: string }) => void>>();
    constructor() { connections++; emit = (name, data) => { for (const listener of this.listeners.get(name) ?? []) listener({ data }); }; }
    addEventListener(name: string, listener: (event: { data?: string }) => void) { this.listeners.set(name, [...this.listeners.get(name) ?? [], listener]); }
    close() {}
  });
  vi.stubGlobal("fetch", vi.fn((url: string, options: RequestInit) => {
    const read: Read = { url, signal: options.signal as AbortSignal, completed: false }; reads.push(read);
    const stamp = new Date(Date.now()).toISOString();
    const payload = url === "/api/scopes/projects" ? { ...catalog, projects: catalog.projects.map(p => ({ ...p, name: `Read ${stamp}` })) }
      : url.startsWith("/api/scopes?") ? { ...scopes(), sourceObservation: { state: "watching", revision: stamp } }
      : { ...execution(), generatedAt: stamp };
    if (hung) {
      const response = Response.json(payload);
      response.json = () => new Promise(resolve => { read.body = value => { read.completed = true; resolve(value); }; });
      return Promise.resolve(response);
    }
    return new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => { read.completed = true; resolve(Response.json(payload)); }, delay);
      read.signal.addEventListener("abort", () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); }, { once: true });
    });
  }));
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  client.setQueryData(catalogKey, catalog); client.setQueryData(scopesKey, scopes()); client.setQueryData(executionKey, execution());
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
  const events = renderHook(() => useGlobalEvents(), { wrapper });
  const reader = renderHook(() => ({ catalog: useProjectCatalog(LOCAL_OPERATOR_INSTANCE), scopes: useCanonicalScopes(LOCAL_OPERATOR_INSTANCE, selection), execution: useExecutionView(LOCAL_OPERATOR_INSTANCE, selection, "trial") }), { wrapper });
  return { wrapper, events, reader };
}
function event(type = "queue.updated") { act(() => emit("message", JSON.stringify({ type, rigId: "rig-one", qitemId: "q-a", instanceId: "workflow-a" }))); }
async function tick(ms: number) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
afterEach(() => { cleanup(); client?.clear(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("canonical project activity refresh", () => {
  it.each(["queue.updated", "proof.judged", "workflow.resumed"])("refreshes mounted catalog/scopes/execution on %s without waiting for polling", async type => {
    const { reader } = setup();
    expect(reads).toHaveLength(0); event(type); await tick(1_201);
    expect(reads).toHaveLength(3); expect(connections).toBe(1);
    expect(reader.result.current.catalog.data?.projects[0]?.name).toContain("Read ");
    expect(reader.result.current.scopes.data?.sourceObservation.revision).not.toBe("unverified");
    expect(reader.result.current.execution.data?.generatedAt).not.toBe(at);
    expect(reader.result.current.catalog.error).toBeNull(); expect(reader.result.current.scopes.error).toBeNull(); expect(reader.result.current.execution.error).toBeNull();
    const urls = reads.map(r => new URL(r.url, "http://fixture"));
    for (const url of urls.filter(u => u.pathname !== "/api/scopes/projects")) { expect(url.searchParams.get("project")).toBe("a"); expect(url.searchParams.get("projectRoot")).toBe("/books/a"); }
  });

  it("allows slow project reads to finish throughout sustained activity and coalesces follow-ups", async () => {
    const { reader } = setup(1_500);
    for (let window = 0; window < 6; window++) { event(window % 2 ? "workflow.resumed" : "queue.claimed"); await tick(1_000); }
    expect(reads.filter(r => r.completed).length).toBeGreaterThanOrEqual(9);
    expect(reads.every(r => !r.signal.aborted)).toBe(true); expect(reader.result.current.execution.data?.generatedAt).not.toBe(at);
    await tick(4_000); expect(reads.every(r => r.completed)).toBe(true); expect(reader.result.current.execution.isFetching).toBe(false);
  });

  it("marks disabled/inactive local projects stale without reads and leaves remote/unrelated families alone", async () => {
    const { wrapper } = setup();
    const inactive = [...projectKey(LOCAL_OPERATOR_INSTANCE, { id: "b", root: "/books/b" }), "scopes", "detail"];
    const disabled = [...projectKey(LOCAL_OPERATOR_INSTANCE, { id: "b", root: "/books/b" }), "execution", "trial"];
    const remote = ["operator", "remote-instance", "other", "projects", "catalog"];
    const unrelated = ["operator", "local-instance", "configuration", "list"];
    client.setQueryData(inactive, scopes("b")); client.setQueryData(disabled, execution("b")); client.setQueryData(remote, catalog); client.setQueryData(unrelated, { retained: true });
    renderHook(() => useExecutionView(LOCAL_OPERATOR_INSTANCE, { id: "b", root: "/books/b" }, "trial", { enabled: false }), { wrapper });
    renderHook(() => useProjectCatalog({ kind: "remote-instance", hostId: "other" }), { wrapper });
    event("proof.sources_changed"); await tick(1_201);
    expect(client.getQueryState(inactive)?.isInvalidated).toBe(true); expect(client.getQueryState(disabled)?.isInvalidated).toBe(true);
    expect(client.getQueryState(remote)?.isInvalidated).toBe(false); expect(client.getQueryState(unrelated)?.isInvalidated).toBe(false);
    expect(reads).toHaveLength(3); expect(reads.every(r => !r.url.includes("project=b"))).toBe(true);
  });

  it("deduplicates project family and reconnect-all overlap while preserving one follow-up per query", async () => {
    setup(2_500); act(() => emit("open")); event(); await tick(1_000);
    expect(reads).toHaveLength(3);
    for (let i = 0; i < 30; i++) { event("proof.judged"); event("workflow.resumed"); }
    act(() => { emit("error"); emit("open"); }); await tick(1_000); await tick(1_501);
    expect(reads).toHaveLength(6); expect(reads.every(r => !r.signal.aborted)).toBe(true);
    await tick(2_501); expect(reads.every(r => r.completed)).toBe(true); expect(reads).toHaveLength(6); expect(connections).toBe(1);
  });

  it("keeps the project body deadline during events and recovers through the queued follow-up", async () => {
    const { reader } = setup(200, true); event(); await tick(1_000);
    for (let window = 0; window < 5; window++) { event(); await tick(1_000); }
    await tick(1); expect(reader.result.current.execution.error?.code).toBe("timeout"); expect(reader.result.current.execution.data?.generatedAt).toBe(at);
    expect(reads).toHaveLength(6); expect(reads.slice(0, 3).every(r => r.signal.aborted)).toBe(true);
    await act(async () => { reads[3]!.body!({ ...catalog }); reads[4]!.body!(scopes()); reads[5]!.body!({ ...execution(), generatedAt: "2026-10-04T12:00:06Z" }); });
    await tick(1); expect(reader.result.current.execution.error).toBeNull(); expect(reader.result.current.execution.data?.generatedAt).toBe("2026-10-04T12:00:06Z");
  });

  it("removes queued project refresh when the shared event owner unmounts", async () => {
    const { events } = setup(1_500); event(); await tick(1_000); event(); await tick(1_000); events.unmount(); await tick(3_000);
    expect(reads).toHaveLength(3); expect(reads.every(r => r.completed && !r.signal.aborted)).toBe(true);
  });
});
