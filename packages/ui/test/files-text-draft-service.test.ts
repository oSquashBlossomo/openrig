import { afterEach, expect, it } from "vitest";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAllowedFile } from "../../daemon/src/domain/files/file-read.js";
import { FileWriteService, WriteConflictError } from "../../daemon/src/domain/files/file-write-service.js";
import { analyzeFileText, prepareFileTextWrite, type FileLineEnding } from "../src/lib/files-text-draft.js";
const owned: string[] = [];
afterEach(() => owned.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
function fixture(content: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "files-text-draft-"))); owned.push(root);
  const target = join(root, "fictional.txt"); writeFileSync(target, content);
  const allowlist = [{ name: "private", canonicalPath: root }];
  const service = new FileWriteService({ allowlist, auditFilePath: join(root, "private-audit.jsonl") });
  return { target, service, read: readAllowedFile(allowlist, "private", "fictional.txt") };
}
it.each(["\n", "\r\n", "\r"])("actual complete UTF8 file changed-line write preserves separator %j and original CAS", ending => {
  const raw = `\ufeff😀first${ending}second${ending}日本語 tail`;
  const { target, service, read } = fixture(raw); expect(read).toMatchObject({ binary: false, truncated: false });
  const base = { content: read.content, mtime: read.mtime, contentHash: read.contentHash };
  const prepared = prepareFileTextWrite(base.content, analyzeFileText(base.content).lfText.replace("second", "changed second"));
  if (prepared.kind !== "ready") throw new Error("Expected writable uniform fixture");
  const result = service.writeAtomic({ rootName: "private", path: "fictional.txt", content: prepared.content, expectedMtime: base.mtime, expectedContentHash: base.contentHash, actor: "private-test" });
  expect(readFileSync(target).equals(Buffer.from(raw.replace("second", "changed second")))).toBe(true);
  expect(base).toEqual({ content: raw, mtime: read.mtime, contentHash: read.contentHash }); expect(result.newContentHash).not.toBe(base.contentHash);
  expect(readFileSync(target).toString()).not.toMatch(/[\r\n]$/); // No independent terminal newline added.
});
it.each(["lf", "crlf", "cr"] as FileLineEnding[])("actual mixed edited file normalizes only with explicit %s choice", choice => {
  const { target, service, read } = fixture("A\r\nB\nC\r");
  expect(prepareFileTextWrite(read.content, "A\nchanged B\nC\n").kind).toBe("mixed-policy-required");
  expect(readFileSync(target).toString()).toBe("A\r\nB\nC\r");
  const prepared = prepareFileTextWrite(read.content, "A\nchanged B\nC\n", choice); if (prepared.kind !== "ready") throw new Error("Expected explicit mixed choice");
  service.writeAtomic({ rootName: "private", path: "fictional.txt", content: prepared.content, expectedMtime: read.mtime, expectedContentHash: read.contentHash, actor: "private-test" });
  const ending = { lf: "\n", crlf: "\r\n", cr: "\r" }[choice]; expect(readFileSync(target).equals(Buffer.from(`A${ending}changed B${ending}C${ending}`))).toBe(true);
});
it("external file change rejects the original tokens without erasing bytes or changing the prepared draft", () => {
  const { target, service, read } = fixture("one\r\ntwo\r\n"); const prepared = prepareFileTextWrite(read.content, "one\nchanged two\n");
  if (prepared.kind !== "ready") throw new Error("Expected uniform fixture"); writeFileSync(target, "external\r\nbytes\r\n");
  expect(() => service.writeAtomic({ rootName: "private", path: "fictional.txt", content: prepared.content, expectedMtime: read.mtime, expectedContentHash: read.contentHash, actor: "private-test" })).toThrow(WriteConflictError);
  expect(readFileSync(target).toString()).toBe("external\r\nbytes\r\n"); expect(prepared.content).toBe("one\r\nchanged two\r\n"); expect(read.content).toBe("one\r\ntwo\r\n");
});
