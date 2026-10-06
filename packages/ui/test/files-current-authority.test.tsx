import type { PropsWithChildren } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useFilesList, useFilesRead, useFilesRoots, useFilesWrite } from "../src/hooks/useFiles.js";
import { readHosts } from "../src/lib/hosts-read.js";
import { FileEditor } from "../src/components/files/FileEditor.js";
import { useScopeMarkdown } from "../src/hooks/useScopeMarkdown.js";
import { FileViewer } from "../src/components/drawer-viewers/FileViewer.js";
import { EvidenceOpener } from "../src/components/review/EvidenceOpener.js";

const roots = { roots: [{ name: "ws", path: "/private/fixture" }] };
const listing = { root: "ws", path: "docs", entries: [] };
const read = { root: "ws", path: "docs/a.txt", absolutePath: "/private/fixture/docs/a.txt", content: "safe\n",
  mtime: "2026-10-04T00:00:00Z", contentHash: "a".repeat(64), size: 5, totalBytes: 5, binary: false, truncated: false };
const clients: QueryClient[] = [];
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.unstubAllGlobals(); });

async function fixture() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  let selected = "local";
  let hostsFailed = false;
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/hosts") {
      if (hostsFailed) throw new Error("fixture host refresh failed");
      return Response.json({ selected, ownName: "Fixture", hosts: [] });
    }
    if (init?.method === "POST") return Response.json({ root: read.root, path: read.path, absolutePath: read.absolutePath,
      newMtime: "2026-10-04T00:00:01Z", newContentHash: "b".repeat(64), byteCountDelta: 3 });
    return Response.json(url.includes("roots") ? roots : url.includes("list") ? listing : read);
  });
  vi.stubGlobal("fetch", fetch);
  const refreshHosts = () => client.fetchQuery({ queryKey: ["hosts"], queryFn: ({ signal }) => readHosts({ signal }), staleTime: 0 });
  await refreshHosts();
  const failRefresh = async () => {
    hostsFailed = true;
    await expect(refreshHosts()).rejects.toMatchObject({ code: "network" });
    // The actual failed-refetch lifecycle retains the successful local payload.
    expect(client.getQueryState(["hosts"])).toMatchObject({ status: "error", data: { selected: "local" } });
  };
  const recover = async (host = "local") => { selected = host; hostsFailed = false; await refreshHosts(); };
  return { client, fetch, refreshHosts, failRefresh, recover,
    switchExternally: (host: string) => { selected = host; },
    wrapper: ({ children }: PropsWithChildren) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
    fileCalls: () => fetch.mock.calls.filter(([url]) => url.startsWith("/api/files/")) };
}

const observe = (kind: string) => kind === "roots" ? useFilesRoots() : kind === "list" ? useFilesList("ws", "docs") : useFilesRead("ws", read.path);

it.each(["roots", "list", "read"])("failed hosts refresh hides cached %s and rejects retained/manual refetch until recovery", async kind => {
  const f = await fixture();
  const payload = kind === "roots" ? roots : kind === "list" ? listing : read;
  const { result } = renderHook(() => observe(kind), { wrapper: f.wrapper });
  await waitFor(() => expect(result.current.data).toEqual(payload));
  const retainedRefetch = result.current.refetch;
  const before = f.fileCalls().length;
  // CLI changes selection externally; refresh fails before the UI learns it.
  f.switchExternally("remote-fixture");
  await act(async () => { await f.failRefresh(); });
  await waitFor(() => expect(result.current).toMatchObject({ selectionKnown: false, readEnabled: false, data: undefined }));
  let outcome: unknown;
  await act(async () => { outcome = await retainedRefetch(); });
  expect(outcome).toMatchObject({ error: { code: "invalid_request" } });
  await act(async () => { outcome = await result.current.refetch(); });
  expect(outcome).toMatchObject({ error: { code: "invalid_request" } });
  expect(f.fileCalls()).toHaveLength(before);
  await act(async () => { await f.recover("remote-fixture"); });
  await waitFor(() => expect(result.current.scopeError).toMatchObject({ code: "unsupported_scope" }));
  expect(f.fileCalls()).toHaveLength(before);
  await act(async () => { await f.recover(); });
  await waitFor(() => expect(result.current).toMatchObject({ selectionKnown: true, readEnabled: true, data: payload }));
  await act(async () => { await result.current.refetch(); });
  expect(f.fileCalls().at(-1)?.[0]).toBe(kind === "roots" ? "/api/files/roots" : `/api/files/${kind}?root=ws&path=${encodeURIComponent(kind === "list" ? "docs" : read.path)}`);
});

it("scope markdown drops local content and resolution after a failed hosts refresh", async () => {
  const f = await fixture();
  const { result } = renderHook(() => useScopeMarkdown("/private/fixture/docs", "a.txt"), { wrapper: f.wrapper });
  await waitFor(() => expect(result.current.content).toBe(read.content));
  const before = f.fileCalls().length;
  await act(async () => { await f.failRefresh(); });
  await waitFor(() => expect(result.current).toMatchObject({ state: "idle", selectionKnown: false, content: null, file: null, resolved: null }));
  expect(f.fileCalls()).toHaveLength(before);
});

it.each(["roots", "list", "read"])("failed authority cancels an in-flight %s and never exposes its late bytes", async kind => {
  const f = await fixture();
  const originalFetch = f.fetch.getMockImplementation()!;
  let finish!: (response: Response) => void;
  f.fetch.mockImplementation((url, init) => url.startsWith("/api/files/")
    ? new Promise<Response>(resolve => { finish = resolve; }) : originalFetch(url, init));
  const { result } = renderHook(() => observe(kind), { wrapper: f.wrapper });
  await waitFor(() => expect(f.fileCalls()).toHaveLength(1));
  const signal = f.fileCalls()[0]?.[1]?.signal;
  await act(async () => { await f.failRefresh(); });
  await waitFor(() => expect(result.current.readEnabled).toBe(false));
  expect(signal?.aborted).toBe(true);
  const payload = kind === "roots" ? roots : kind === "list" ? listing : read;
  await act(async () => { finish(Response.json(payload)); });
  expect(result.current.data).toBeUndefined();
  expect(f.client.getQueryData(kind === "roots" ? ["files", "roots"] : ["files", kind, "ws", kind === "list" ? "docs" : read.path])).toBeUndefined();
});

it("failed hosts refresh blocks a retained editor write and preserves its exact draft for explicit recovery", async () => {
  const f = await fixture();
  f.client.setQueryData(["files", "read", read.root, read.path], read);
  render(<f.wrapper><FileEditor root={read.root} path={read.path} read={read} /></f.wrapper>);
  fireEvent.change(screen.getByTestId("files-editor-textarea"), { target: { value: "changed\n" } });
  f.switchExternally("remote-fixture");
  await act(async () => { await f.failRefresh(); });
  fireEvent.click(screen.getByTestId("files-editor-save"));
  await screen.findByTestId("files-editor-error");
  expect(f.fileCalls()).toHaveLength(0);
  expect((screen.getByTestId("files-editor-textarea") as HTMLTextAreaElement).value).toBe("changed\n");
  await act(async () => { await f.recover(); });
  expect(f.fileCalls()).toHaveLength(0);
  fireEvent.click(screen.getByTestId("files-editor-save"));
  await waitFor(() => expect(f.fileCalls()).toHaveLength(1));
  expect(JSON.parse(f.fileCalls()[0]?.[1]?.body as string)).toEqual({ root: read.root, path: read.path, content: "changed\n",
    expectedMtime: read.mtime, expectedContentHash: read.contentHash, actor: "ui-files-edit-mode" });
});

it("an actual current successful local hosts response admits one explicit edit", async () => {
  const f = await fixture();
  render(<f.wrapper><FileEditor root={read.root} path={read.path} read={read} /></f.wrapper>);
  expect(f.client.getQueryState(["hosts"])?.status).toBe("success");
  fireEvent.change(screen.getByTestId("files-editor-textarea"), { target: { value: "changed\n" } });
  fireEvent.click(screen.getByTestId("files-editor-save"));
  await waitFor(() => expect(f.fileCalls()).toHaveLength(1));
  expect(f.fileCalls()[0]?.[0]).toBe("/api/files/write");
});

it("a normal background hosts poll preserves confirmed local reads and explicit writes", async () => {
  const f = await fixture();
  const { result } = renderHook(() => ({ roots: useFilesRoots(), write: useFilesWrite() }), { wrapper: f.wrapper });
  await waitFor(() => expect(result.current.roots.data).toEqual(roots));
  const originalFetch = f.fetch.getMockImplementation()!;
  let finish!: (response: Response) => void;
  f.fetch.mockImplementation((url, init) => url === "/api/hosts"
    ? new Promise<Response>(resolve => { finish = resolve; }) : originalFetch(url, init));
  let pending!: ReturnType<typeof f.refreshHosts>;
  await act(async () => { pending = f.refreshHosts(); });
  expect(f.client.getQueryState(["hosts"])).toMatchObject({ status: "success", fetchStatus: "fetching" });
  expect(result.current.roots).toMatchObject({ readEnabled: true, data: roots });
  await act(async () => { await result.current.write.mutateAsync({ root: read.root, path: read.path, content: "changed\n",
    expectedMtime: read.mtime, expectedContentHash: read.contentHash, actor: "ui-files-edit-mode" }); });
  expect(f.fileCalls().filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  await act(async () => { finish(Response.json({ selected: "local", ownName: "Fixture", hosts: [] })); await pending; });
});

it.each(["image", "rootless-markdown", "relative-markdown"])("failed hosts authority withdraws %s inline assets and source links while retaining the excerpt", async kind => {
  const f = await fixture();
  const asset = "/api/files/asset?root=ws&path=docs%2Ffigure.svg";
  const content = `Inline fixture excerpt. ![figure](${kind === "relative-markdown" ? "figure.svg" : asset}) [Sibling](next.md)`;
  render(<f.wrapper><FileViewer path="docs/a.md" originInstance="local" kind={kind === "image" ? "image" : "markdown"}
    {...(kind === "image" ? { imageUrl: asset } : { content })} {...(kind === "relative-markdown" ? { root: "ws", readPath: read.path } : {})} /></f.wrapper>);
  await screen.findByRole("img");
  const before = f.fileCalls().length;
  await act(async () => { await f.failRefresh(); });
  await waitFor(() => expect(document.querySelector("img[src]")).toBeNull());
  expect(document.querySelector('[href^="/api/files/asset"]')).toBeNull();
  if (kind !== "image") {
    expect(screen.getByText(/Inline fixture excerpt/)).toBeTruthy();
    expect(screen.getByTestId("md-inline-link").getAttribute("href")).toBeNull();
  }
  expect(f.fileCalls()).toHaveLength(before);
  await act(async () => { await f.recover("remote-fixture"); });
  expect(document.querySelector("img[src]")).toBeNull();
  expect(f.fileCalls()).toHaveLength(before);
  await act(async () => { await f.recover(); });
  await waitFor(() => expect(document.querySelector("img[src]")).not.toBeNull());
  const restored = document.querySelector("img[src]")!;
  const source = new URL(restored.getAttribute("src")!, "http://fixture.test");
  expect(source.pathname).toBe("/api/files/asset");
  expect(source.searchParams.get("root")).toBe("ws");
  expect(source.searchParams.get("path")).toBe("docs/figure.svg");
});

it("bounded inherited evidence lightbox reproduction", async () => {
  const f = await fixture();
  function EvidenceFixture() {
    const scope = useScopeMarkdown("/private/fixture/docs", "a.txt");
    return <div data-testid="evidence-scope" data-root={scope.resolved?.rootName ?? ""}>
      <EvidenceOpener evidenceRef="shot.png" ctx={{ root: scope.resolved?.rootName ?? null,
        relPath: scope.resolved?.relPath ?? null, slicePath: "/private/fixture/docs" }} />
    </div>;
  }
  render(<f.wrapper><EvidenceFixture /></f.wrapper>);
  await waitFor(() => expect(screen.getByTestId("evidence-scope").getAttribute("data-root")).toBe("ws"));
  fireEvent.click(screen.getByTestId("evidence-opener-image"));
  const previousImage = screen.getByTestId("proof-lightbox-image");
  const before = f.fileCalls().length;
  expect(previousImage.getAttribute("src")).toBe("/api/files/asset?root=ws&path=docs%2Fshot.png");
  await act(async () => { await f.failRefresh(); });
  await waitFor(() => expect(screen.getByTestId("evidence-scope").getAttribute("data-root")).toBe(""));
  expect(screen.getByTestId("proof-lightbox-image")).toBe(previousImage);
  expect(previousImage.getAttribute("src")).toBe("/api/files/asset?root=ws&path=docs%2Fshot.png");
  expect(f.fileCalls()).toHaveLength(before);
  fireEvent.click(screen.getByTestId("evidence-opener-image"));
  expect(screen.queryByTestId("proof-lightbox-image")).toBeNull();
  expect(f.fileCalls()).toHaveLength(before);
});
