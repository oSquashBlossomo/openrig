import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PropsWithChildren } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAgentImageLibrary, useAgentImagePreview } from "../src/hooks/useAgentImageLibrary.js";

const clients: QueryClient[] = [];
function harness(keepPrevious = false) {
  const client = new QueryClient({ defaultOptions: { queries: {
    retry: false, gcTime: 0, ...(keepPrevious ? { placeholderData: (previous: unknown) => previous } : {}),
  } } });
  clients.push(client);
  return { client, wrapper: ({ children }: PropsWithChildren) => <QueryClientProvider client={client}>{children}</QueryClientProvider> };
}
function entry(id = "agent-image:worker%2F雪:01") {
  return {
    id, kind: "agent-image", name: "worker%2F雪", version: "01", runtime: "codex",
    sourceSeat: "private-seat", sourceSessionId: "private-session", sourceResumeToken: "(redacted)",
    sourceCwd: null, notes: null, createdAt: "2026-10-04T00:00:00Z", sourceType: "user_file",
    sourcePath: "/private/fictional/image.yaml", relativePath: "worker/image.yaml", updatedAt: "2026-10-04T00:00:00Z",
    manifestEstimatedTokens: null, derivedEstimatedTokens: 0, pinned: false, lineage: [],
    stats: { forkCount: 0, lastUsedAt: null, estimatedSizeBytes: 0, lineage: [] },
    files: [{ path: "empty.md", role: "notes", summary: null, absolutePath: null, bytes: null, estimatedTokens: null }],
    additiveFact: { retained: true },
  };
}
function preview(id = "agent-image:worker%2F雪:01") {
  const { kind, sourceSessionId, sourceResumeToken, sourceCwd, createdAt, sourceType, sourcePath, relativePath, updatedAt, ...rest } = entry(id);
  return { ...rest, starterSnippet: "" };
}
const cases = [
  { kind: "library", useRead: () => useAgentImageLibrary(), value: () => [entry()] },
  { kind: "preview", useRead: () => useAgentImagePreview("agent-image:worker%2F雪:01"), value: () => preview() },
] as const;

afterEach(() => { clients.splice(0).forEach(client => client.clear()); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe.each(cases)("agent image $kind reads", ({ kind, useRead, value }) => {
  it.each(["headers", "body"])("bounds hung %s in one five-second budget", async phase => {
    vi.useFakeTimers();
    let deliver!: (response: unknown) => void;
    const fetch = vi.fn((_url: RequestInfo | URL, _options?: RequestInit) => new Promise(resolve => { deliver = resolve; }));
    vi.stubGlobal("fetch", fetch);
    const { wrapper } = harness();
    const { result } = renderHook(() => ({ ...useRead() }), { wrapper });
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

  it("cancels an abandoned read and disposes late headers without decoding", async () => {
    let deliver!: (response: unknown) => void;
    const fetch = vi.fn((_url: RequestInfo | URL, _options?: RequestInit) => new Promise(resolve => { deliver = resolve; }));
    vi.stubGlobal("fetch", fetch);
    const { wrapper } = harness();
    const { unmount } = renderHook(() => ({ ...useRead() }), { wrapper });
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    unmount();
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    const cancel = vi.fn(async () => {}), json = vi.fn();
    await act(async () => { deliver({ body: { cancel }, json }); });
    expect(cancel).toHaveBeenCalledOnce(); expect(json).not.toHaveBeenCalled();
  });

  it.each([503, 401, 404])("reports HTTP %s as unavailable rather than successful empty data", async status => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("unavailable", { status })));
    const { wrapper } = harness(); const { result } = renderHook(() => ({ ...useRead() }), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toBe(`HTTP ${status}`);
    expect(result.current.data).toBeUndefined();
  });

  it("reports malformed JSON as a read failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{broken")));
    const { wrapper } = harness(); const { result } = renderHook(() => ({ ...useRead() }), { wrapper });
    await waitFor(() => expect(result.current.error).toMatchObject({ code: "invalid_json" }));
    expect(result.current.data).toBeUndefined();
  });

  it.each([null, {}, [null]])("rejects an invalid successful payload %j", async invalid => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(invalid)));
    const { wrapper } = harness(); const { result } = renderHook(() => ({ ...useRead() }), { wrapper });
    await waitFor(() => expect(result.current.error).toMatchObject({ code: "invalid_contract" }));
    expect(result.current.data).toBeUndefined();
  });

  it("retains served null, zero, empty and additive facts without inventing defaults", async () => {
    const data = value();
    const fetch = vi.fn(async (_url: RequestInfo | URL, _options?: RequestInit) => Response.json(data));
    vi.stubGlobal("fetch", fetch);
    const { wrapper, client } = harness(); const { result } = renderHook(() => ({ ...useRead() }), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual(data));
    expect(fetch.mock.calls[0]?.[0]).toBe(kind === "library" ? "/api/agent-images/library"
      : "/api/agent-images/library/agent-image%3Aworker%252F%E9%9B%AA%3A01/preview");
    expect(client.getQueryData(kind === "library" ? ["agent-images", "library"]
      : ["agent-images", "preview", "agent-image:worker%2F雪:01"])).toEqual(data);
  });

  it("keeps the original dated cache beside a failed refresh without retrying", async () => {
    const data = value();
    const fetch = vi.fn().mockResolvedValueOnce(Response.json(data)).mockResolvedValue(new Response("down", { status: 503 }));
    vi.stubGlobal("fetch", fetch);
    const { wrapper } = harness(); const { result } = renderHook(() => ({ ...useRead() }), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual(data));
    const observedAt = result.current.dataUpdatedAt;
    await act(async () => { await result.current.refetch(); });
    await waitFor(() => expect(result.current.isRefetchError).toBe(true));
    expect(result.current.data).toEqual(data); expect(result.current.dataUpdatedAt).toBe(observedAt);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

it("an actually empty library remains a successful empty library", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json([])));
  const { wrapper } = harness(); const { result } = renderHook(useAgentImageLibrary, { wrapper });
  await waitFor(() => expect(result.current.isSuccess).toBe(true)); expect(result.current.data).toEqual([]);
});

it("a preview for another exact image cannot satisfy this request", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(preview("agent-image:worker/雪:01"))));
  const { wrapper } = harness(); const { result } = renderHook(() => useAgentImagePreview("agent-image:worker%2F雪:01"), { wrapper });
  await waitFor(() => expect(result.current.error).toMatchObject({ code: "invalid_contract" }));
  expect(result.current.data).toBeUndefined();
});

it.each([null, ""])("manual refetch of an absent preview ID %j does not make a request", async id => {
  const fetch = vi.fn(async () => Response.json(preview())); vi.stubGlobal("fetch", fetch);
  const { wrapper } = harness(); const { result } = renderHook(() => ({ ...useAgentImagePreview(id) }), { wrapper });
  await act(async () => { await result.current.refetch(); });
  expect(fetch).not.toHaveBeenCalled();
  await waitFor(() => expect(result.current.error).toMatchObject({ code: "invalid_request" }));
});

it("does not borrow another image preview under a global keep-previous-data default", async () => {
  const first = preview();
  const fetch = vi.fn().mockResolvedValueOnce(Response.json(first)).mockImplementation(() => new Promise(() => {}));
  vi.stubGlobal("fetch", fetch);
  const { wrapper } = harness(true);
  const { result, rerender } = renderHook(({ id }) => ({ ...useAgentImagePreview(id) }), {
    wrapper, initialProps: { id: first.id },
  });
  await waitFor(() => expect(result.current.data).toEqual(first));
  rerender({ id: "agent-image:another:1" });
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  expect(result.current.data).toBeUndefined(); expect(result.current.isPlaceholderData).toBe(false);
});

it.each(["id", "stats", "files", "lineage"])("rejects unusable library %s rather than handing a crashing row to consumers", async field => {
  const invalid = { ...entry(), [field]: field === "id" ? "" : null };
  vi.stubGlobal("fetch", vi.fn(async () => Response.json([invalid])));
  const { wrapper } = harness(); const { result } = renderHook(() => ({ ...useAgentImageLibrary() }), { wrapper });
  await waitFor(() => expect(result.current.error).toMatchObject({ code: "invalid_contract" }));
  expect(result.current.data).toBeUndefined();
});

it("retains a legacy omitted cwd as unknown and an empty version exactly", async () => {
  const { sourceCwd, ...older } = entry("agent-image:worker:");
  const value = { ...older, version: "" };
  vi.stubGlobal("fetch", vi.fn(async () => Response.json([value])));
  const { wrapper } = harness(); const { result } = renderHook(() => ({ ...useAgentImageLibrary() }), { wrapper });
  await waitFor(() => expect(result.current.data).toEqual([value]));
  expect(result.current.data?.[0]?.sourceCwd).toBeUndefined();
});
