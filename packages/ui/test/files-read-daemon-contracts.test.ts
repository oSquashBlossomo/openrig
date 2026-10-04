// @vitest-environment node
// Real Hono + disposable allowlisted files only; no installed daemon/listener.
import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { filesRoutes } from "../../daemon/src/routes/files.js";
import { FILE_READ_TRUNCATION_BYTES } from "../../daemon/src/domain/files/file-read.js";
import { readFilesFile, readFilesList, readFilesRoots } from "../src/lib/files-read.js";
const dirs: string[] = [];
afterEach(() => { dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); vi.unstubAllGlobals(); });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gui-files-read-contract-"))); dirs.push(root); mkdirSync(join(root, "scope"));
  const app = new Hono(); app.use("*", async (c, next) => { c.set("filesAllowlist" as never, [{ name: "exact-root", canonicalPath: root }] as never); await next(); }); app.route("/api/files", filesRoutes());
  const fetch = vi.fn((url: string, options?: RequestInit) => app.request(url, options)); vi.stubGlobal("fetch", fetch); return { root, fetch };
}
describe("Files readers against actual normalized-path contracts", () => {
  it("preserves authored echoes separately from canonical symlink/normalized paths", async () => {
    const { root } = fixture(); writeFileSync(join(root, "scope", "exact.md"), "# EXACT\n"); symlinkSync("exact.md", join(root, "scope", "alias.md"));
    expect(await readFilesRoots("local")).toEqual({ roots: [{ name: "exact-root", path: root }] });
    const path = "./scope//alias.md"; const observed = await readFilesFile("local", "exact-root", path);
    expect(observed).toMatchObject({ root: "exact-root", path, content: "# EXACT\n", resolvedPath: "scope/exact.md", absolutePath: join(root, "scope", "exact.md"), binary: false, truncated: false });
    expect(await readFilesList("local", "exact-root", "./scope//")).toMatchObject({ root: "exact-root", path: "./scope//", entries: expect.arrayContaining([{ name: "exact.md", type: "file", size: 8, mtime: observed.mtime }]) });
    expect(await readFilesList("local", "exact-root", "")).toMatchObject({ path: "", entries: expect.arrayContaining([{ name: "scope", type: "dir", size: null, mtime: expect.any(String) }]) });
  });
  it("preserves full-byte hashes/binary/truncation facts and actual empty text", async () => {
    const { root } = fixture(); const bytes = Buffer.concat([Buffer.alloc(FILE_READ_TRUNCATION_BYTES, 65), Buffer.from([0xff, 0x00])]);
    writeFileSync(join(root, "large.bin"), bytes); writeFileSync(join(root, "empty.md"), "");
    const read = await readFilesFile("local", "exact-root", "large.bin");
    expect(read).toMatchObject({ binary: true, truncated: true, truncatedAtBytes: FILE_READ_TRUNCATION_BYTES, size: bytes.length, totalBytes: bytes.length,
      contentHash: createHash("sha256").update(bytes).digest("hex") }); expect(read.content.length).toBe(FILE_READ_TRUNCATION_BYTES);
    expect(await readFilesFile("local", "exact-root", "empty.md")).toMatchObject({ content: "", size: 0, totalBytes: 0, binary: false, truncated: false, truncatedAtBytes: null,
      contentHash: createHash("sha256").update("").digest("hex") });
  });
  it("retains actual absent/bad-path/unknown-root outcomes and does not send remote local-file reads", async () => {
    const { fetch } = fixture();
    await expect(readFilesFile("local", "exact-root", "missing.md")).rejects.toMatchObject({ code: "absent", status: 404, message: "HTTP 404", name: "Error" });
    await expect(readFilesFile("local", "exact-root", "../escape.md")).rejects.toMatchObject({ code: "bad_path", status: 400 });
    await expect(readFilesList("local", "missing-root", "")).rejects.toMatchObject({ code: "bad_path", status: 400 });
    await expect(readFilesFile("remote/exact", "exact-root", "missing.md")).rejects.toMatchObject({ code: "unsupported_scope" }); expect(fetch).toHaveBeenCalledTimes(3);
  });
});
