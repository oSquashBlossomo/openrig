import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PropsWithChildren } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { usePluginFilesList, usePluginFilesRead } from "../src/hooks/usePluginFiles.js";
import { useSkillFilesList, useSkillFilesRead } from "../src/hooks/useSkillFiles.js";

const cases = [
  { family: "plugin", operation: "list", useRead: usePluginFilesList },
  { family: "plugin", operation: "read", useRead: usePluginFilesRead },
  { family: "skill", operation: "list", useRead: useSkillFilesList },
  { family: "skill", operation: "read", useRead: useSkillFilesRead },
] as const;
const clients: QueryClient[] = [];
function harness(keepPrevious = false) {
  const client = new QueryClient({ defaultOptions: { queries: {
    retry: false, gcTime: 0, ...(keepPrevious ? { placeholderData: (previous: unknown) => previous } : {}),
  } } });
  clients.push(client);
  return { client, wrapper: ({ children }: PropsWithChildren) => <QueryClientProvider client={client}>{children}</QueryClientProvider> };
}
function payload(family: string, operation: string, id = "opaque/id:%", path = "docs/a?#.md") {
  const target = { [`${family}Id`]: id, path };
  return operation === "list"
    ? { ...target, entries: [{ name: "a?#.md", type: "file", size: 0, mtime: null }, { name: "link", type: "other", size: null, mtime: null }] }
    : { ...target, absolutePath: "/private/fictional/a?#.md", content: "", mtime: "2026-10-04T00:00:00.000Z", contentHash: "original", size: 0,
      truncated: false, truncatedAtBytes: null, totalBytes: 0, additiveFact: "retained" };
}
afterEach(() => { clients.splice(0).forEach(client => client.clear()); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe.each(cases)("$family file $operation read boundary", ({ family, operation, useRead }) => {
  it.each(["headers", "body"])("bounds hung %s within one five-second request", async phase => {
    vi.useFakeTimers();
    let deliver!: (response: unknown) => void;
    const fetch = vi.fn((_url: RequestInfo | URL, _options?: RequestInit) => new Promise(resolve => { deliver = resolve; }));
    vi.stubGlobal("fetch", fetch);
    const { wrapper } = harness();
    const { result } = renderHook(() => ({ ...useRead("opaque/id:%", "docs/a?#.md") }), { wrapper });
    await act(async () => {
      if (phase === "body") {
        await vi.advanceTimersByTimeAsync(4_000);
        deliver({ ok: true, json: () => new Promise(() => {}) });
        await vi.advanceTimersByTimeAsync(1_001);
      } else await vi.advanceTimersByTimeAsync(5_001);
    });
    expect(result.current.error).toMatchObject({ code: "timeout" });
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("cancels when its last observer leaves, disposing late headers without decoding", async () => {
    let deliver!: (response: unknown) => void;
    const fetch = vi.fn((_url: RequestInfo | URL, _options?: RequestInit) => new Promise(resolve => { deliver = resolve; }));
    vi.stubGlobal("fetch", fetch);
    const { wrapper } = harness();
    const { unmount } = renderHook(() => ({ ...useRead("opaque/id:%", "docs/a?#.md") }), { wrapper });
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    unmount();
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    const cancel = vi.fn(async () => {}), json = vi.fn();
    await act(async () => { deliver({ body: { cancel }, json }); });
    expect(cancel).toHaveBeenCalledOnce(); expect(json).not.toHaveBeenCalled();
  });

  it.each(["owner", "path", "shape"])("rejects a successful response with wrong %s", async fault => {
    const value = payload(family, operation);
    const invalid = fault === "owner" ? { ...value, [`${family}Id`]: "another-owner" }
      : fault === "path" ? { ...value, path: "another.md" }
        : operation === "list" ? { ...value, entries: [null] } : { ...value, content: null };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(invalid)));
    const { wrapper } = harness();
    const { result } = renderHook(() => ({ ...useRead("opaque/id:%", "docs/a?#.md") }), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toMatchObject({ code: "invalid_contract" });
    expect(result.current.data).toBeUndefined();
  });

  it("does not manufacture a target during manual refetch of a disabled owner", async () => {
    const fetch = vi.fn(async () => Response.json(payload(family, operation)));
    vi.stubGlobal("fetch", fetch);
    const { wrapper } = harness(); const { result } = renderHook(() => ({ ...useRead(null, "docs/a?#.md") }), { wrapper });
    await act(async () => { await result.current.refetch(); });
    expect(fetch).not.toHaveBeenCalled();
    await waitFor(() => expect(result.current.error).toMatchObject({ code: "invalid_request" }));
  });

  it.each(["owner", "path"])("never borrows previous identity after %s changes, including a caller placeholder default", async change => {
    const first = payload(family, operation);
    const fetch = vi.fn().mockResolvedValueOnce(Response.json(first)).mockImplementation(() => new Promise(() => {}));
    vi.stubGlobal("fetch", fetch);
    const { wrapper } = harness(true);
    const { result, rerender } = renderHook(({ id, path }) => ({ ...useRead(id, path) }), {
      wrapper, initialProps: { id: "opaque/id:%", path: "docs/a?#.md" },
    });
    await waitFor(() => expect(result.current.data).toEqual(first));
    rerender({ id: change === "owner" ? "other-owner" : "opaque/id:%", path: change === "path" ? "other.md" : "docs/a?#.md" });
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(result.current.data).toBeUndefined(); expect(result.current.isPlaceholderData).toBe(false);
  });

  it("retains exact URLs, query keys, empty content, nullable entries and additive metadata", async () => {
    const value = payload(family, operation);
    const fetch = vi.fn(async (_url: RequestInfo | URL, _options?: RequestInit) => Response.json(value));
    vi.stubGlobal("fetch", fetch);
    const { wrapper, client } = harness();
    const { result } = renderHook(() => ({ ...useRead("opaque/id:%", "docs/a?#.md") }), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual(value));
    expect(fetch.mock.calls[0]?.[0]).toBe(`/api/${family}s/opaque%2Fid%3A%25/files/${operation}?path=docs%2Fa%3F%23.md`);
    expect(client.getQueryData([`${family}-files`, operation, "opaque/id:%", "docs/a?#.md"])).toEqual(value);
  });

  it("retains dated same-target data beside a failed refresh without retrying", async () => {
    const value = payload(family, operation);
    const fetch = vi.fn().mockResolvedValueOnce(Response.json(value)).mockResolvedValue(new Response("unavailable", { status: 503 }));
    vi.stubGlobal("fetch", fetch);
    const { wrapper } = harness(); const { result } = renderHook(() => ({ ...useRead("opaque/id:%", "docs/a?#.md") }), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual(value));
    const observedAt = result.current.dataUpdatedAt;
    await act(async () => { await result.current.refetch(); });
    await waitFor(() => expect(result.current.isRefetchError).toBe(true));
    expect(result.current.data).toEqual(value); expect(result.current.dataUpdatedAt).toBe(observedAt);
    expect(result.current.error?.message).toBe("HTTP 503"); expect(fetch).toHaveBeenCalledTimes(2);
  });
});

it.each([usePluginFilesList, useSkillFilesList])("a null list path retains its root-list meaning", async useRead => {
  const family = useRead === usePluginFilesList ? "plugin" : "skill";
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(payload(family, "list", "owner", ""))));
  const { wrapper } = harness(); const { result } = renderHook(() => ({ ...useRead("owner", null) }), { wrapper });
  await waitFor(() => expect(result.current.data?.path).toBe(""));
});
