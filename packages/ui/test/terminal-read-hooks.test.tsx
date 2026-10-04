import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PropsWithChildren } from "react";
import { useTerminalViews } from "../src/hooks/useTerminalViews.js";
import { useTerminalPreview } from "../src/hooks/useTerminalPreview.js";
const catalog = { saved: [{ id: "same", name: "Saved", members: [{ seat: "exact@rig", readOnly: true }] }], rigs: ["same"] };
const pane = { seat: "exact@rig", label: "Exact", readOnly: false, paneCommand: "tmux attach -t exact@rig" };
const preview = { provider: "herdr", view: "saved:same", planId: "plan/exact", status: { available: true }, composed: { id: "same", opened: [pane], pages: [[pane]], absent: [], degraded: [] }, grids: [{ columns: 1, rows: 1, blanks: 0 }] };
const clients: QueryClient[] = [];
function harness(selected?: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } }); clients.push(client);
  if (selected) client.setQueryData(["hosts"], { selected, ownName: "Self", hosts: [] });
  return { client, wrapper: ({ children }: PropsWithChildren) => <QueryClientProvider client={client}>{children}</QueryClientProvider> };
}
afterEach(() => { clients.splice(0).forEach(c => c.clear()); vi.useRealTimers(); vi.unstubAllGlobals(); });
const hook = (kind: string) => kind === "catalog" ? useTerminalViews() : useTerminalPreview("local", "saved:same", "herdr", true);

describe("bounded scoped terminal reads", () => {
  it("does not read a presumed local catalog before selected host is known", async () => {
    const fetch = vi.fn(async () => Response.json(catalog)); vi.stubGlobal("fetch", fetch);
    const { wrapper } = harness(); const { result } = renderHook(() => useTerminalViews(), { wrapper });
    await act(async () => {});
    expect(fetch).not.toHaveBeenCalled(); expect(result.current.data).toBeUndefined();
    let readback: unknown;
    await act(async () => { readback = await result.current.refetch(); });
    expect(fetch).not.toHaveBeenCalled(); expect(readback).toMatchObject({ error: { code: "invalid_request" } });
    expect(result.current.scopeError).toMatchObject({ code: "invalid_request" });
  });
  it.each(["catalog", "preview"])("refuses unsupported remote %s even on manual refetch", async kind => {
    const fetch = vi.fn(async () => Response.json(kind === "catalog" ? catalog : preview)); vi.stubGlobal("fetch", fetch);
    const { wrapper } = harness("remote/exact");
    const { result } = renderHook(() => kind === "catalog" ? useTerminalViews() : useTerminalPreview("remote/exact", "saved:same", "herdr", true), { wrapper });
    await act(async () => {}); expect(fetch).not.toHaveBeenCalled();
    let readback: unknown;
    await act(async () => { readback = await result.current.refetch(); });
    expect(fetch).not.toHaveBeenCalled(); expect(readback).toMatchObject({ error: { code: "unsupported_scope" } });
    expect(result.current.scopeError).toMatchObject({ code: "unsupported_scope" });
  });
  it.each(["catalog", "preview"])("preserves local %s payload and query identity", async kind => {
    const payload = { ...(kind === "catalog" ? catalog : preview), additive: "retained" };
    const fetch = vi.fn(async () => Response.json(payload)); vi.stubGlobal("fetch", fetch);
    const { wrapper, client } = harness("local"); const { result } = renderHook(() => hook(kind), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual(payload));
    expect(client.getQueryCache().getAll().map(q => q.queryKey)).toContainEqual(kind === "catalog" ? ["terminal", "views", "local"] : ["terminal", "preview", "local", "saved:same", "herdr"]);
    expect(fetch.mock.calls[0]?.[0]).toBe(kind === "catalog" ? "/api/terminal/views" : "/api/terminal/preview?view=saved%3Asame&provider=herdr");
  });
  it.each(["catalog", "preview"])("bounds never-resolving %s body including failed HTTP body", async kind => {
    vi.useFakeTimers(); const cancel = vi.fn(async () => {});
    const fetch = vi.fn(async () => ({ ok: kind === "preview", status: kind === "preview" ? 200 : 503, json: () => new Promise(() => {}), body: { cancel } })); vi.stubGlobal("fetch", fetch);
    const { wrapper } = harness("local"); const { result } = renderHook(() => hook(kind), { wrapper });
    await act(async () => { await vi.advanceTimersByTimeAsync(5001); });
    expect(result.current.error).toMatchObject({ code: "timeout" }); expect(cancel).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[1]?.signal.aborted).toBe(true);
  });
  it.each(["catalog", "preview"])("cancels %s and disposes a late header/body without JSON decoding", async kind => {
    let resolve!: (value: unknown) => void; const cancel = vi.fn(async () => {}), json = vi.fn();
    const fetch = vi.fn(() => new Promise(done => { resolve = done; })); vi.stubGlobal("fetch", fetch);
    const { wrapper, client } = harness("local"); renderHook(() => hook(kind), { wrapper });
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    await act(async () => { await client.cancelQueries({ queryKey: ["terminal"], exact: false }); });
    expect(fetch.mock.calls[0]?.[1]?.signal.aborted).toBe(true);
    await act(async () => { resolve({ body: { cancel }, json }); });
    expect(cancel).toHaveBeenCalledOnce(); expect(json).not.toHaveBeenCalled();
  });
  it("rejects malformed listing instead of exposing arbitrary JSON", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ saved: [{ id: "same", name: "Saved", members: [{ seat: 123 }] }], rigs: ["same"] })));
    const { wrapper } = harness("local"); const { result } = renderHook(() => useTerminalViews(), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true)); expect(result.current.error).toMatchObject({ code: "invalid_contract" }); expect(result.current.data).toBeUndefined();
  });
  it.each([{ ...preview, provider: "cmux" }, { ...preview, view: "rig:same" }, { ...preview, planId: "" }])("rejects mismatched provider/token or empty plan %j", async payload => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(payload)));
    const { wrapper } = harness("local"); const { result } = renderHook(() => useTerminalPreview("local", "saved:same", "herdr", true), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true)); expect(result.current.error).toMatchObject({ code: "invalid_contract" });
  });
  it("isolates bare-ID collisions and drops old plan while another exact token is pending", async () => {
    const fetch = vi.fn(async (url: string) => url.includes("view=saved%3A") ? Response.json(preview) : new Promise<Response>(() => {})); vi.stubGlobal("fetch", fetch);
    const { wrapper, client } = harness("local"); client.setDefaultOptions({ queries: { retry: false, placeholderData: previous => previous } });
    const { result, rerender } = renderHook(({ view }) => useTerminalPreview("local", view, "herdr", true), { wrapper, initialProps: { view: "saved:same" } });
    await waitFor(() => expect(result.current.data?.planId).toBe("plan/exact")); rerender({ view: "rig:same" });
    expect(result.current.data).toBeUndefined(); expect(client.getQueryCache().getAll().map(q => q.queryKey)).toContainEqual(["terminal", "preview", "local", "rig:same", "herdr"]);
    expect(fetch.mock.calls[0]?.[0]).toContain("view=saved%3Asame");
  });
  it("retargets known selection without displaying local membership under a remote label", async () => {
    const fetch = vi.fn(async () => Response.json(catalog)); vi.stubGlobal("fetch", fetch);
    const { wrapper, client } = harness(); const { result } = renderHook(() => useTerminalViews(), { wrapper });
    expect(fetch).not.toHaveBeenCalled();
    act(() => client.setQueryData(["hosts"], { selected: "local", hosts: [] }));
    await waitFor(() => expect(result.current.data).toEqual(catalog));
    act(() => client.setQueryData(["hosts"], { selected: "remote/exact", hosts: [] }));
    await waitFor(() => expect(result.current.scopeSupported).toBe(false));
    expect(result.current.data).toBeUndefined(); expect(fetch).toHaveBeenCalledOnce();
    expect(client.getQueryCache().getAll().map(q => q.queryKey)).toContainEqual(["terminal", "views", "remote/exact"]);
  });
});
