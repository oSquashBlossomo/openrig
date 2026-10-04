// Files edit safety: the textarea editor replaces the WHOLE file with the
// draft, so it may only be seeded from a read that is the complete, exact,
// round-trippable text of the file. Truncated (>1 MiB) and binary reads are
// previews; saving them used to pass the full-file CAS and destroy the tail /
// re-encode bytes. These cases run the actual daemon Hono files routes and
// FileWriteService over disposable private temp files (no user files, no
// installed daemon, no listener).
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Hono } from "hono";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { transferableAbortController } from "node:util";
import { join } from "node:path";
import { FilesWorkspace, FileEditor, assessFileEditability } from "../src/components/files/FilesWorkspace.js";
import { readFilesFile } from "../src/lib/files-read.js";
import type { FilesReadResponse } from "../src/hooks/useFiles.js";
import { filesRoutes } from "../../daemon/src/routes/files.js";
import { FileWriteService } from "../../daemon/src/domain/files/file-write-service.js";
import { FILE_READ_TRUNCATION_BYTES } from "../../daemon/src/domain/files/file-read.js";

const owned: string[] = [];
const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((c) => c.clear());
  vi.unstubAllGlobals();
  owned.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true }));
});

function newClient() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  client.setQueryData(["hosts"], { ownName: "Private local test", selected: "local", hosts: [] });
  clients.push(client);
  return client;
}

async function mountWorkspace(name: string, bytes: Buffer) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "openrig-files-edit-safety-")));
  owned.push(root);
  const target = join(root, name);
  writeFileSync(target, bytes);
  const allowlist = [{ name: "private-fixture", canonicalPath: root }];
  const service = new FileWriteService({ allowlist, auditFilePath: join(root, "private-audit.jsonl") });
  const app = new Hono();
  app.use("*", async (c, next) => { c.set("filesAllowlist" as never, allowlist as never); c.set("fileWriteService" as never, service as never); await next(); });
  app.route("/api/files", filesRoutes());
  const reads: FilesReadResponse[] = [];
  const writes: Array<{ request: Record<string, unknown>; status: number }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, options: RequestInit = {}) => {
    // Hono's in-process Request uses Node's realm, while the UI owns a jsdom
    // signal. Bridge cancellation rather than discard it at the fixture edge.
    const controller = transferableAbortController();
    const abort = () => controller.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    let response: Response;
    try { response = await app.request(`http://private.test${url}`, { ...options, signal: controller.signal }); }
    finally { options.signal?.removeEventListener("abort", abort); }
    if (url.startsWith("/api/files/read")) reads.push(await response.clone().json());
    if (url === "/api/files/write") writes.push({ request: JSON.parse(options.body as string), status: response.status });
    return response;
  }));
  const client = newClient();
  render(<QueryClientProvider client={client}><FilesWorkspace /></QueryClientProvider>);
  fireEvent.click(await screen.findByTestId(`files-entry-${name}`));
  await waitFor(() => expect(screen.getByTestId("files-content-size")).toBeTruthy());
  return { target, bytes, reads, writes, client };
}

function expectNoEditorSurface() {
  expect(screen.queryByTestId("files-editor-textarea")).toBeNull();
  expect(screen.queryByTestId("files-editor-save")).toBeNull();
}

describe("FilesWorkspace edit safety against actual files routes", () => {
  it("still edits a complete UTF-8 text file with full-file CAS and keeps its tail", async () => {
    const f = await mountWorkspace("control.txt", Buffer.from("A prefix\nCONTROL_TAIL\n"));
    const toggle = screen.getByTestId("files-edit-toggle") as HTMLButtonElement;
    expect(toggle.disabled).toBe(false);
    fireEvent.click(toggle);
    const textarea = await screen.findByTestId("files-editor-textarea");
    fireEvent.change(textarea, { target: { value: "Z prefix\nCONTROL_TAIL\n" } });
    fireEvent.click(screen.getByTestId("files-editor-save"));
    await waitFor(() => expect(f.writes).toHaveLength(1));
    expect(f.writes[0]!.status).toBe(200);
    expect(f.writes[0]!.request).toMatchObject({ expectedMtime: f.reads[0]!.mtime, expectedContentHash: f.reads[0]!.contentHash });
    expect(readFileSync(f.target, "utf8")).toBe("Z prefix\nCONTROL_TAIL\n");
  });

  it("refuses to open a whole-file editor on a truncated read and leaves every byte on disk", async () => {
    const tail = Buffer.from("\nUNRETURNED_TAIL_SENTINEL\n");
    const f = await mountWorkspace("large.opaque", Buffer.concat([Buffer.alloc(FILE_READ_TRUNCATION_BYTES, 65), tail]));
    expect(f.reads[0]!.truncated).toBe(true);
    expect(screen.getByTestId("files-truncation-marker")).toBeTruthy();
    const toggle = screen.getByTestId("files-edit-toggle") as HTMLButtonElement;
    expect(toggle.disabled).toBe(true);
    fireEvent.click(toggle);
    expectNoEditorSurface();
    const notice = screen.getByTestId("files-edit-unavailable");
    expect(notice.getAttribute("data-reason")).toBe("truncated");
    expect(notice.textContent).toMatch(/truncated/i);
    expect(notice.textContent).toMatch(/external editor/i);
    expect(screen.getByTestId("files-text-fallback")).toBeTruthy();
    expect(f.writes).toHaveLength(0);
    expect(readFileSync(f.target).equals(f.bytes)).toBe(true);
  });

  it("refuses to open a whole-file editor on a binary read and does not re-encode it", async () => {
    const f = await mountWorkspace("blob.opaque", Buffer.from([0x41, 0xff, 0x00, 0x42]));
    expect((f.reads[0] as FilesReadResponse & { binary?: boolean }).binary).toBe(true);
    const toggle = screen.getByTestId("files-edit-toggle") as HTMLButtonElement;
    expect(toggle.disabled).toBe(true);
    fireEvent.click(toggle);
    expectNoEditorSurface();
    expect(screen.getByTestId("files-edit-unavailable").getAttribute("data-reason")).toBe("binary");
    expect(f.writes).toHaveLength(0);
    expect(readFileSync(f.target).toString("hex")).toBe("41ff0042");
  });

  it("refuses CR line endings the browser textarea would normalize on save", async () => {
    const f = await mountWorkspace("windows.txt", Buffer.from("one\r\ntwo\r\n"));
    expect((screen.getByTestId("files-edit-toggle") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("files-edit-unavailable").getAttribute("data-reason")).toBe("line-endings");
    expectNoEditorSurface();
    expect(readFileSync(f.target).equals(f.bytes)).toBe(true);
  });

  it.each(["binary", "truncated"] as const)("rechecks the actual hook cache before immediate Save after a late %s read", async change => {
    const f = await mountWorkspace(`late-${change}.opaque`, Buffer.from("safe complete text\n"));
    fireEvent.click(screen.getByTestId("files-edit-toggle"));
    fireEvent.change(await screen.findByTestId("files-editor-textarea"), { target: { value: "dirty draft\n" } });
    const save = screen.getByTestId("files-editor-save");
    const newBytes = change === "binary" ? Buffer.from([65, 0, 255]) : Buffer.alloc(FILE_READ_TRUNCATION_BYTES + 1, 66);
    writeFileSync(f.target, newBytes);
    const current = f.reads[0]!;
    const latest = await readFilesFile("local", current.root, current.path);
    const actualQuery = f.client.getQueryCache().getAll().find(q => q.queryKey[0] === "files" && q.queryKey[1] === "read" && q.queryKey[2] === current.root && q.queryKey[3] === current.path)!;
    await act(async () => {
      // Update the real reader's current key, then click before React receives
      // that new prop. The editor must consult that exact cache synchronously.
      f.client.setQueryData(actualQuery.queryKey, latest);
      fireEvent.click(save);
      await Promise.resolve();
    });
    expect(f.writes).toHaveLength(0);
    expect(vi.mocked(fetch).mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(0);
    expect(readFileSync(f.target).equals(newBytes)).toBe(true);
  });

  it("drops an open draft when a refetch shows the file is now truncated, without writing", async () => {
    const f = await mountWorkspace("growing.opaque", Buffer.from("small\n"));
    fireEvent.click(screen.getByTestId("files-edit-toggle"));
    fireEvent.change(await screen.findByTestId("files-editor-textarea"), { target: { value: "draft over small\n" } });
    const grown = Buffer.concat([Buffer.alloc(FILE_READ_TRUNCATION_BYTES, 66), Buffer.from("TAIL")]);
    writeFileSync(f.target, grown);
    await act(async () => { await f.client.invalidateQueries({ queryKey: ["files", "read"] }); });
    await waitFor(() => expect(screen.getByTestId("files-edit-unavailable").getAttribute("data-reason")).toBe("truncated"));
    expectNoEditorSurface();
    expect((screen.getByTestId("files-edit-toggle") as HTMLButtonElement).disabled).toBe(true);
    expect(f.writes).toHaveLength(0);
    expect(readFileSync(f.target).equals(grown)).toBe(true);
  });
});

const completeRead: FilesReadResponse = {
  root: "r", path: "a.txt", absolutePath: "/private/a.txt", content: "héllo\n",
  binary: false, mtime: "2026-01-01T00:00:00.000Z", contentHash: "a".repeat(64),
  size: 7, truncated: false, truncatedAtBytes: null, totalBytes: 7,
};

describe("FileEditor defends itself independent of the toolbar gate", () => {
  it.each([
    ["truncated", { truncated: true, truncatedAtBytes: 4, totalBytes: 9, size: 9 }],
    ["binary", { binary: true }],
    ["unverified", { binary: undefined }],
    ["unverified", { totalBytes: 99 }],
    ["unverified", { truncated: undefined }],
    ["line-endings", { content: "a\rb", totalBytes: 3, size: 3 }],
  ] as const)("direct render with a %s snapshot shows no draft surface (%j)", (reason, patch) => {
    const read = { ...completeRead, ...patch } as FilesReadResponse;
    render(<QueryClientProvider client={newClient()}><FileEditor root="r" path="a.txt" read={read} /></QueryClientProvider>);
    expectNoEditorSurface();
    expect(screen.getByTestId("files-edit-unavailable").getAttribute("data-reason")).toBe(reason);
  });

  it("swaps a dirty draft for the read-only notice when its snapshot becomes unsafe", () => {
    const fetchSpy = vi.fn(); vi.stubGlobal("fetch", fetchSpy);
    const client = newClient();
    const { rerender } = render(<QueryClientProvider client={client}><FileEditor root="r" path="a.txt" read={completeRead} /></QueryClientProvider>);
    fireEvent.change(screen.getByTestId("files-editor-textarea"), { target: { value: "dirty\n" } });
    expect((screen.getByTestId("files-editor-save") as HTMLButtonElement).disabled).toBe(false);
    rerender(<QueryClientProvider client={client}><FileEditor root="r" path="a.txt" read={{ ...completeRead, binary: true, mtime: "2026-01-02T00:00:00.000Z" }} /></QueryClientProvider>);
    expectNoEditorSurface();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("classifies the complete multi-byte UTF-8 snapshot as editable", () => {
    expect(assessFileEditability(completeRead)).toEqual({ editable: true });
  });
});
