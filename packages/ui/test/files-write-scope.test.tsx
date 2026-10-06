import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { FileEditor } from "../src/components/files/FilesWorkspace.js";

const read = { root: "ws", path: "a.txt", absolutePath: "/private/a.txt", content: "safe\n", mtime: "2026-10-04T00:00:00Z",
  contentHash: "a".repeat(64), size: 5, totalBytes: 5, truncatedAtBytes: null, binary: false, truncated: false };
const clients: QueryClient[] = [];
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.unstubAllGlobals(); });
function mount(selected?: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  if (selected) client.setQueryData(["hosts"], { selected, ownName: "Private fixture", hosts: [] });
  client.setQueryData(["files", "read", read.root, read.path], read);
  const fetch = vi.fn(async () => Response.json({ root: read.root, path: read.path, absolutePath: read.absolutePath,
    newMtime: "2026-10-04T00:00:01Z", newContentHash: "b".repeat(64), byteCountDelta: 3 }));
  vi.stubGlobal("fetch", fetch);
  render(<QueryClientProvider client={client}><FileEditor root={read.root} path={read.path} read={read} /></QueryClientProvider>);
  fireEvent.change(screen.getByTestId("files-editor-textarea"), { target: { value: "changed\n" } });
  return { client, fetch };
}

it.each([undefined, "remote-fixture"])("a retained editor cannot submit a local write under host %s", async selected => {
  const f = mount(selected);
  fireEvent.click(screen.getByTestId("files-editor-save"));
  await screen.findByTestId("files-editor-error");
  expect(f.fetch).not.toHaveBeenCalled();
  expect((screen.getByTestId("files-editor-textarea") as HTMLTextAreaElement).value).toBe("changed\n");
});

it("checks the selected host at mutation time even when a local editor was already mounted", async () => {
  const f = mount("local");
  // Keep the editor's original read props; this models a retained caller or
  // a host-cache update before its parent has delivered a new render.
  act(() => f.client.setQueryData(["hosts"], { selected: "remote-fixture", ownName: "Private fixture", hosts: [] }));
  fireEvent.click(screen.getByTestId("files-editor-save"));
  await screen.findByTestId("files-editor-error");
  expect(f.fetch).not.toHaveBeenCalled();
});

it("still submits one explicit known-local edit with its original CAS tokens", async () => {
  const f = mount("local");
  fireEvent.click(screen.getByTestId("files-editor-save"));
  await waitFor(() => expect(f.fetch).toHaveBeenCalledOnce());
  expect(f.fetch.mock.calls[0]?.[0]).toBe("/api/files/write");
  expect(JSON.parse(f.fetch.mock.calls[0]?.[1]?.body)).toEqual({ root: "ws", path: "a.txt", content: "changed\n",
    expectedMtime: read.mtime, expectedContentHash: read.contentHash, actor: "ui-files-edit-mode" });
});
