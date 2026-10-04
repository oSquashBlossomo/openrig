import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PropsWithChildren } from "react";
import { useFilesRoots, useFilesList, useFilesRead } from "../src/hooks/useFiles.js";
import { useScopeMarkdown } from "../src/hooks/useScopeMarkdown.js";
const roots = { roots: [{ name: "ws", path: "/private/workspace" }] };
const listing = { root: "ws", path: "scope", entries: [] };
const read = { root: "ws", path: "scope/README.md", absolutePath: "/private/workspace/scope/README.md", resolvedPath: "scope/README.md",
  content: "EXACT LOCAL FILE BYTES", mtime: "2026-10-04", contentHash: "full-file-hash", size: 22, binary: false, truncated: false, truncatedAtBytes: null, totalBytes: 22 };
const clients: QueryClient[] = [];
function harness(selected?: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0, placeholderData: p => p } } }); clients.push(client);
  if (selected) client.setQueryData(["hosts"], { selected, hosts: [] });
  return { client, wrapper: ({ children }: PropsWithChildren) => <QueryClientProvider client={client}>{children}</QueryClientProvider> };
}
const observe = (kind: string) => kind === "roots" ? useFilesRoots() : kind === "list" ? useFilesList("ws", "scope") : useFilesRead("ws", "scope/README.md");
afterEach(() => { clients.splice(0).forEach(c => c.clear()); vi.useRealTimers(); vi.unstubAllGlobals(); });
describe("Files local read authority and identity", () => {
  it.each(["roots", "list", "read"])("blocks unknown/remote %s even on manual refetch and hides warm local cache", async kind => {
    for (const selected of [undefined, "remote/exact"]) {
      const payload = kind === "roots" ? roots : kind === "list" ? listing : read;
      const fetch = vi.fn(async () => Response.json(payload)); vi.stubGlobal("fetch", fetch); const { client, wrapper } = harness(selected);
      const legacyKey = kind === "roots" ? ["files", "roots"] : ["files", kind, "ws", kind === "list" ? "scope" : read.path];
      client.setQueryData(legacyKey, payload); client.setQueryData([...legacyKey, "local"], payload);
      const { result, unmount } = renderHook(() => observe(kind), { wrapper });
      await act(async () => {}); expect(fetch).not.toHaveBeenCalled(); expect(result.current.data).toBeUndefined();
      let outcome: unknown; await act(async () => { outcome = await result.current.refetch(); });
      expect(fetch).not.toHaveBeenCalled(); expect(outcome).toMatchObject({ error: { code: selected ? "unsupported_scope" : "invalid_request" } }); unmount();
    }
  });
  it("does not resolve/read a caller-disabled scope from warm roots", async () => {
    const fetch = vi.fn(async () => Response.json(read)); vi.stubGlobal("fetch", fetch); const { client, wrapper } = harness("local");
    client.setQueryData(["files", "roots"], roots); client.setQueryData(["files", "roots", "local"], roots);
    const { result } = renderHook(() => useScopeMarkdown("/private/workspace/scope", "README.md", { enabled: false }), { wrapper });
    await act(async () => {}); expect(fetch).not.toHaveBeenCalled(); expect(result.current).toMatchObject({ state: "idle", content: null, resolved: null, isLoading: false });
  });
  it.each(["roots", "list", "read"])("strips cached %s bytes immediately on remote selection", async kind => {
    const payload = kind === "roots" ? roots : kind === "list" ? listing : read;
    const fetch = vi.fn(async () => Response.json(payload)); vi.stubGlobal("fetch", fetch); const { wrapper, client } = harness("local"); const { result } = renderHook(() => observe(kind), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual(payload)); act(() => client.setQueryData(["hosts"], { selected: "remote/exact", hosts: [] }));
    await waitFor(() => expect(result.current.data).toBeUndefined()); expect(fetch).toHaveBeenCalledOnce();
  });
  it.each(["roots", "list", "read"])("caller-disabled %s hides its warm local data and refuses manual refetch", async kind => {
    const payload = kind === "roots" ? roots : kind === "list" ? listing : read;
    const fetch = vi.fn(async () => Response.json(payload)); vi.stubGlobal("fetch", fetch); const { client, wrapper } = harness("local");
    client.setQueryData(kind === "roots" ? ["files", "roots"] : ["files", kind, "ws", kind === "list" ? listing.path : read.path], payload);
    const { result } = renderHook(() => kind === "roots" ? useFilesRoots({ enabled: false }) : kind === "list" ? useFilesList("ws", listing.path, { enabled: false }) : useFilesRead("ws", read.path, { enabled: false }), { wrapper });
    expect(result.current.data).toBeUndefined(); expect(result.current.readEnabled).toBe(false);
    let outcome: unknown; await act(async () => { outcome = await result.current.refetch(); });
    expect(outcome).toMatchObject({ error: { code: "invalid_request" } }); expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["list", "read"])("drops previous %s root when another root is pending", async kind => {
    const payload = kind === "list" ? listing : read;
    const fetch = vi.fn().mockResolvedValueOnce(Response.json(payload)).mockImplementation(() => new Promise(() => {})); vi.stubGlobal("fetch", fetch); const { wrapper } = harness("local");
    const { result, rerender } = renderHook(({ root }) => kind === "list" ? useFilesList(root, listing.path) : useFilesRead(root, read.path), { wrapper, initialProps: { root: "ws" } });
    await waitFor(() => expect(result.current.data).toEqual(payload)); rerender({ root: "another-root" }); expect(result.current.data).toBeUndefined();
  });
  it.each(["roots", "list", "read"])("forwards %s query cancellation and never caches late local bytes", async kind => {
    let resolve!: (v: unknown) => void; const cancel = vi.fn(async () => {}), json = vi.fn(async () => kind === "roots" ? roots : kind === "list" ? listing : read);
    const fetch = vi.fn((_url: string, _options?: RequestInit) => new Promise(done => { resolve = done; })); vi.stubGlobal("fetch", fetch); const { wrapper, client } = harness("local");
    renderHook(() => observe(kind), { wrapper }); await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    await act(async () => { await client.cancelQueries({ queryKey: ["files"] }); }); expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    await act(async () => { resolve({ body: { cancel }, json }); }); expect(cancel).toHaveBeenCalledOnce(); expect(json).not.toHaveBeenCalled();
    expect(client.getQueryData(kind === "roots" ? ["files", "roots"] : ["files", kind, "ws", kind === "list" ? listing.path : read.path])).toBeUndefined();
  });
  it("drops markdown content/metadata/resolution on a host switch despite warm local caches", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => Response.json(url.includes("roots") ? roots : read))); const { wrapper, client } = harness("local");
    const { result } = renderHook(() => useScopeMarkdown("/private/workspace/scope", "README.md"), { wrapper }); await waitFor(() => expect(result.current.state).toBe("content"));
    act(() => client.setQueryData(["hosts"], { selected: "remote/exact", hosts: [] }));
    await waitFor(() => expect(result.current).toMatchObject({ state: "idle", content: null, file: null, resolved: null, scopeSupported: false, scopeError: { code: "unsupported_scope" } }));
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });
  it.each(["list", "read"])("drops previous %s target despite global keepPreviousData", async kind => {
    const payload = kind === "list" ? listing : read;
    const fetch = vi.fn().mockResolvedValueOnce(Response.json(payload)).mockImplementation(() => new Promise(() => {})); vi.stubGlobal("fetch", fetch); const { wrapper } = harness("local");
    const { result, rerender } = renderHook(({ path }) => kind === "list" ? useFilesList("ws", path) : useFilesRead("ws", path), { wrapper, initialProps: { path: kind === "list" ? listing.path : read.path } });
    await waitFor(() => expect(result.current.data).toEqual(payload)); rerender({ path: "another-target" }); expect(result.current.data).toBeUndefined(); expect(result.current.isPlaceholderData).toBe(false);
  });
  it.each(["roots", "list", "read"])("bounds never-resolving %s body and cancels it", async kind => {
    vi.useFakeTimers(); const cancel = vi.fn(async () => {}); const fetch = vi.fn(async (_url: string, _options?: RequestInit) => ({ ok: true, json: () => new Promise(() => {}), body: { cancel } })); vi.stubGlobal("fetch", fetch);
    const { wrapper } = harness("local"); const { result } = renderHook(() => observe(kind), { wrapper });
    await act(async () => { await vi.advanceTimersByTimeAsync(5001); }); expect(result.current.error).toMatchObject({ code: "timeout" }); expect(cancel).toHaveBeenCalledOnce(); expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });
  it.each(["list", "read"])("refuses wrong root/path %s responses", async kind => {
    const payload = kind === "list" ? listing : read;
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ...payload, root: "other-root", path: "other-path" }))); const { wrapper } = harness("local"); const { result } = renderHook(() => observe(kind), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true)); expect(result.current.error).toMatchObject({ code: "invalid_contract" }); expect(result.current.data).toBeUndefined();
  });
  it("keeps empty text distinct from absence", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => Response.json(url.includes("roots") ? roots : { ...read, content: "", size: 0, totalBytes: 0 })));
    const { wrapper } = harness("local"); const { result } = renderHook(() => useScopeMarkdown("/private/workspace/scope", "README.md"), { wrapper });
    await waitFor(() => expect(result.current.state).toBe("content")); expect(result.current.content).toBe(""); expect(result.current.unavailable).toBe(false); expect(result.current.file).toMatchObject({ binary: false, truncated: false, resolvedPath: read.resolvedPath, contentHash: read.contentHash });
  });
});
