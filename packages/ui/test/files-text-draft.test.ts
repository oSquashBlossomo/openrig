import { expect, it } from "vitest";
import { analyzeFileText, FileTextSourceError, prepareFileTextWrite } from "../src/lib/files-text-draft.js";

it.each([
  ["", "", "none", { lf: 0, crlf: 0, cr: 0 }],
  ["plain", "plain", "none", { lf: 0, crlf: 0, cr: 0 }],
  ["a\nb\n", "a\nb\n", "lf", { lf: 2, crlf: 0, cr: 0 }],
  ["a\r\nb\r\n", "a\nb\n", "crlf", { lf: 0, crlf: 2, cr: 0 }],
  ["a\rb\r", "a\nb\n", "cr", { lf: 0, crlf: 0, cr: 2 }],
  ["a\r\nb\nC\r", "a\nb\nC\n", "mixed", { lf: 1, crlf: 1, cr: 1 }],
  ["\r\n\r\n\n\r", "\n\n\n\n", "mixed", { lf: 1, crlf: 2, cr: 1 }],
])("analyzes actual separator boundaries case %#", (raw, lfText, ending, counts) => {
  expect(analyzeFileText(raw as string)).toEqual({ lfText, ending, counts });
});
it("preserves BOM, astral and combining Unicode, tabs and Unicode separators", () => {
  const raw = "\ufeff😀cafe\u0301\t\u2028line\u2029\r\n日本語";
  expect(analyzeFileText(raw)).toEqual({ lfText: raw.replace("\r\n", "\n"), ending: "crlf", counts: { lf: 0, crlf: 1, cr: 0 } });
  expect(prepareFileTextWrite(raw, analyzeFileText(raw).lfText)).toMatchObject({ kind: "ready", content: raw, dirty: false });
});
it.each([null, undefined, 4, {}, ["text"], "\ud800", "\udc00", "a\ud800b"])("invalid source case %# is explicit and never write-ready", raw => {
  expect(() => analyzeFileText(raw as string)).toThrow(FileTextSourceError);
  const result = prepareFileTextWrite(raw as string, "safe"); expect(result).toEqual({ kind: "invalid-draft", reason: "invalid-source" }); expect(result).not.toHaveProperty("content");
});
it.each(["", "no newline", "a\n", "a\r\n", "a\r", "same\r\nsame\n", "a\r\nb\nC\r"])("unchanged projection is byte-exact case %# even with a retained mixed choice", raw => {
  for (const choice of [undefined, "lf", "crlf", "cr"] as const) {
    expect(prepareFileTextWrite(raw, analyzeFileText(raw).lfText, choice)).toEqual({ kind: "ready", content: raw, dirty: false, handling: "unchanged" });
  }
});
it.each([
  ["one\ntwo\n", "one\nchanged two\n", "one\nchanged two\n"],
  ["one\r\ntwo\r\n", "one\nchanged two\n", "one\r\nchanged two\r\n"],
  ["one\rtwo\r", "one\nchanged two\n", "one\rchanged two\r"],
  ["one\r\ntwo", "insert\none\ntwo", "insert\r\none\r\ntwo"],
  ["one\rtwo", "onetwo", "onetwo"],
  ["one\r\ntwo\r\n", "one\n", "one\r\n"],
  ["one\r\n", "one", "one"],
  ["one\r\ntwo", "one\ntwo\n", "one\r\ntwo\r\n"],
  ["one\r", "", ""],
])("edits uniform files and obeys draft terminal-newline state case %#", (raw, next, content) => {
  expect(prepareFileTextWrite(raw, next, "lf")).toEqual({ kind: "ready", content, dirty: true, handling: "uniform" });
});
it.each(["", "one"])("source with no separators uses LF for new lines: %s", raw => {
  expect(prepareFileTextWrite(raw, "changed\n\n", "crlf")).toEqual({ kind: "ready", content: "changed\n\n", dirty: true, handling: "new-lines-lf" });
});
it("changed mixed draft refuses to guess even when only one word changed", () => {
  const result = prepareFileTextWrite("A\r\nB\nC\r", "A\nchanged B\nC\n");
  expect(result).toEqual({ kind: "mixed-policy-required", counts: { lf: 1, crlf: 1, cr: 1 } }); expect(result).not.toHaveProperty("content");
});
it("repeated-line deletion ambiguity requires deliberate mixed policy", () => {
  expect(prepareFileTextWrite("same\r\nsame\n", "same\n").kind).toBe("mixed-policy-required");
});
it.each([["lf", "A\nchanged B\nC\n"], ["crlf", "A\r\nchanged B\r\nC\r\n"], ["cr", "A\rchanged B\rC\r"]] as const)("explicit mixed choice %s truthfully normalizes the whole edited draft", (choice, content) => {
  expect(prepareFileTextWrite("A\r\nB\nC\r", "A\nchanged B\nC\n", choice)).toEqual({ kind: "ready", content, dirty: true, handling: "mixed-normalized" });
});
it("mixed choice survives no false dirty after native undo returns original view", () => {
  const base = "same\r\nsame\n";
  expect(prepareFileTextWrite(base, "edited\n", "cr")).toMatchObject({ kind: "ready", dirty: true });
  expect(prepareFileTextWrite(base, analyzeFileText(base).lfText, "cr")).toEqual({ kind: "ready", content: base, dirty: false, handling: "unchanged" });
});
it.each([null, undefined, 0, {}, "a\rb", "a\r\nb"])("invalid LF editor projection case %# never supplies writable content", next => {
  const result = prepareFileTextWrite("base\r\n", next as string); expect(result).toEqual({ kind: "invalid-draft", reason: "not-lf-projection" }); expect(result).not.toHaveProperty("content");
});
it.each(["\ud800", "\udc00", "valid😀\ud800"])("invalid draft Unicode case %# is not silently replaced during UTF8 encoding", next => {
  expect(prepareFileTextWrite("base", next)).toEqual({ kind: "invalid-draft", reason: "invalid-unicode" });
});
it("invalid explicit policy cannot become an undefined replacement", () => {
  const result = prepareFileTextWrite("a\r\nb\n", "changed\n", "os-default" as never);
  expect(result).toEqual({ kind: "invalid-draft", reason: "invalid-choice" }); expect(result).not.toHaveProperty("content");
});
