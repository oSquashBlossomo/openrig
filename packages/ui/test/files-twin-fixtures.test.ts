// The twin Files fixtures must satisfy the real read guards and editor
// admission, so the browser twin exercises the same paths as the daemon.
import { describe, expect, it } from "vitest";
import { filesTwinBody, filesTwinRoots } from "../twin/files-fixtures.js";
import { isFilesList, isFilesRead } from "../src/lib/files-read.js";
import { assessFileEditability } from "../src/components/files/FileEditor.js";
import type { FilesReadResponse } from "../src/hooks/useFiles.js";

const read = (root: string, path: string) => filesTwinBody("/api/files/read", new URLSearchParams({ root, path }));

describe("twin Files fixtures", () => {
  it("serves guard-valid DTOs with exact echoed identity and canonical alias facts", () => {
    expect(filesTwinRoots.map((r) => r.name)).toEqual(["demo-notes", "demo-mirror"]);
    const alias = read("demo-notes", "guides/alias.md")!;
    expect(isFilesRead(alias.body)).toBe(true);
    expect(alias.body).toMatchObject({ path: "guides/alias.md", resolvedPath: "guides/setup.md" });
    const list = filesTwinBody("/api/files/list", new URLSearchParams({ root: "demo-notes", path: "" }))!;
    expect(isFilesList(list.body)).toBe(true);
    expect(read("demo-mirror", "README.md")!.body).toMatchObject({ content: expect.stringContaining("Mirror") });
    expect(read("demo-notes", "missing.md")!.status).toBe(404);
    expect(filesTwinBody("/api/files/read", new URLSearchParams({ root: "workspace", path: "x" }))).toBeNull();
  });

  it.each([
    ["windows.txt", true], ["classic-mac.txt", true], ["mixed.txt", true], ["empty.md", true],
    ["blob.bin", false], ["huge.log", false],
  ] as const)("%s editability is %s", (path, editable) => {
    expect(assessFileEditability(read("demo-notes", path)!.body as FilesReadResponse).editable).toBe(editable);
  });

  it("writes use CAS and reject a stale token with 409", () => {
    const current = read("demo-mirror", "README.md")!.body as FilesReadResponse;
    const stale = filesTwinBody("/api/files/write", new URLSearchParams(), "POST", { root: "demo-mirror", path: "README.md", content: "x", expectedMtime: current.mtime, expectedContentHash: "0".repeat(64) });
    expect(stale!.status).toBe(409);
    const ok = filesTwinBody("/api/files/write", new URLSearchParams(), "POST", { root: "demo-mirror", path: "README.md", content: "# Mirror readme\r\n", expectedMtime: current.mtime, expectedContentHash: current.contentHash });
    expect(ok!.status).toBe(200);
    expect((read("demo-mirror", "README.md")!.body as FilesReadResponse).content).toBe("# Mirror readme\r\n");
  });
});
