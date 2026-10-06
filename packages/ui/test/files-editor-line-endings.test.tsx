// FileEditor + files-text-draft serializer against the actual daemon files
// routes and FileWriteService over private temp roots (fictional contents).
// Every case inspects the exact bytes on disk. fireEvent.change/composition
// prove component wiring only; native typing/paste/IME/undo are browser
// acceptance for root (see docs/plans/gui-files-markdown-ui.md).
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { readFileSync, writeFileSync } from "node:fs";
import { FilesWorkspace } from "../src/components/files/FilesWorkspace.js";
import { readFilesFile } from "../src/lib/files-read.js";
import { disposeFilesFixtures, filesFixture } from "./files-fixture.js";

afterEach(() => { cleanup(); disposeFilesFixtures(); });

async function openEditor(name: string, bytes: string | Buffer) {
  const f = filesFixture({ ws: { files: { [name]: bytes } } });
  f.mount(<FilesWorkspace />);
  fireEvent.click(await screen.findByTestId(`files-entry-${name}`));
  await waitFor(() => expect((screen.getByTestId("files-edit-toggle") as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByTestId("files-edit-toggle"));
  const textarea = await screen.findByTestId("files-editor-textarea") as HTMLTextAreaElement;
  return { f, textarea, disk: () => readFileSync(f.path("ws", name), "latin1"), target: f.path("ws", name) };
}

const type = (el: HTMLTextAreaElement, value: string) => fireEvent.change(el, { target: { value } });

describe("uniform line endings are preserved", () => {
  it.each([
    ["LF final", "one\ntwo\nthree\n", "one\ntWo\nthree\n"],
    ["LF no final", "one\ntwo\nthree", "one\ntWo\nthree"],
    ["CRLF final", "one\r\ntwo\r\nthree\r\n", "one\r\ntWo\r\nthree\r\n"],
    ["CRLF no final", "one\r\ntwo\r\nthree", "one\r\ntWo\r\nthree"],
    ["CR final", "one\rtwo\rthree\r", "one\rtWo\rthree\r"],
    ["CR no final", "one\rtwo\rthree", "one\rtWo\rthree"],
  ])("%s: one middle character changes, every other byte stays", async (_label, raw, expected) => {
    const { f, textarea, disk } = await openEditor("doc.txt", raw);
    const lf = raw.replace(/\r\n|\r/g, "\n");
    expect(textarea.value).toBe(lf);
    type(textarea, lf.replace("two", "tWo"));
    fireEvent.click(screen.getByTestId("files-editor-save"));
    await waitFor(() => expect(f.writes()).toHaveLength(1));
    expect(f.writes()[0]!.status).toBe(200);
    expect(disk()).toBe(expected);
  });

  it.each([
    ["adds a final CRLF", "a\r\nb", "a\nb\n", "a\r\nb\r\n"],
    ["removes the final CRLF", "a\r\nb\r\n", "a\nb", "a\r\nb"],
    ["adds a final CR", "a\rb", "a\nb\n", "a\rb\r"],
    ["first lines of an empty file use LF", "", "x\ny\n", "x\ny\n"],
  ])("terminal newline: %s exactly as typed", async (_label, raw, next, expected) => {
    const { f, textarea, disk } = await openEditor("tail.txt", raw);
    type(textarea, next);
    fireEvent.click(screen.getByTestId("files-editor-save"));
    await waitFor(() => expect(f.writes()).toHaveLength(1));
    expect(disk()).toBe(expected);
  });
});

describe("mixed line endings need a deliberate per-base choice", () => {
  const mixed = "a\r\nb\nc\rd\n";

  it("unchanged mixed text never writes, even after edit-then-undo with a choice selected", async () => {
    const { f, textarea, disk } = await openEditor("mixed.txt", mixed);
    expect(screen.getByTestId("files-editor-line-endings").textContent).toMatch(/2 LF · 1 CRLF · 1 CR/);
    type(textarea, "A\nb\nc\nd\n");
    fireEvent.click(screen.getByTestId("files-editor-mixed-choice-crlf"));
    type(textarea, "a\nb\nc\nd\n");
    expect(screen.getByTestId("files-editor-status").textContent).toBe("no changes");
    expect((screen.getByTestId("files-editor-save") as HTMLButtonElement).disabled).toBe(true);
    expect(f.writes()).toHaveLength(0);
    expect(disk()).toBe(mixed);
  });

  it("changed mixed text without a choice is retained and not POSTed; an explicit choice writes exactly", async () => {
    const { f, textarea, disk } = await openEditor("mixed.txt", mixed);
    type(textarea, "A\nb\nc\nd\n");
    const fieldset = screen.getByTestId("files-editor-mixed-choice");
    expect(fieldset.getAttribute("data-choice")).toBe("");
    fireEvent.click(screen.getByTestId("files-editor-save"));
    expect(screen.getByTestId("files-editor-error").textContent).toMatch(/mixes line endings/);
    expect(f.writes()).toHaveLength(0);
    expect(textarea.value).toBe("A\nb\nc\nd\n");
    fireEvent.click(screen.getByTestId("files-editor-mixed-choice-crlf"));
    fireEvent.click(screen.getByTestId("files-editor-save"));
    await waitFor(() => expect(f.writes()).toHaveLength(1));
    expect(disk()).toBe("A\r\nb\r\nc\r\nd\r\n");
  });

  it.each([
    ["first", "same\n"],
    ["second", "same\n"],
  ])("repeated lines: deleting the %s identical line makes no separator claim; the chosen ending decides", async (_which, after) => {
    const { f, textarea, disk } = await openEditor("repeat.txt", "same\r\nsame\n");
    type(textarea, after);
    fireEvent.click(screen.getByTestId("files-editor-save"));
    expect(f.writes()).toHaveLength(0);
    fireEvent.click(screen.getByTestId("files-editor-mixed-choice-lf"));
    fireEvent.click(screen.getByTestId("files-editor-save"));
    await waitFor(() => expect(f.writes()).toHaveLength(1));
    expect(disk()).toBe("same\n");
  });
});

describe("CAS, cache and draft lifecycle", () => {
  it("external edit → 409 conflict keeps the draft and disk bytes; Refresh is the explicit discard", async () => {
    const { f, textarea, target, disk } = await openEditor("cas.txt", "base\r\n");
    type(textarea, "mine\n");
    writeFileSync(target, "theirs\r\n");
    fireEvent.click(screen.getByTestId("files-editor-save"));
    await screen.findByTestId("files-editor-conflict");
    expect(f.writes()[0]!.status).toBe(409);
    expect(textarea.value).toBe("mine\n");
    expect(disk()).toBe("theirs\r\n");
    fireEvent.click(screen.getByTestId("files-editor-refresh"));
    await waitFor(() => expect((screen.getByTestId("files-editor-textarea") as HTMLTextAreaElement).value).toBe("theirs\n"));
    expect(screen.getByTestId("files-editor-line-endings").getAttribute("data-ending")).toBe("crlf");
    expect(f.writes()).toHaveLength(1);
  });

  it.each(["binary", "truncated"] as const)("a newer cached %s read of a CRLF file blocks an immediate Save", async (change) => {
    const { f, textarea, target } = await openEditor("late.txt", "safe\r\n");
    type(textarea, "dirty\n");
    const save = screen.getByTestId("files-editor-save");
    const newBytes = change === "binary" ? Buffer.from([65, 0, 255]) : Buffer.alloc(1024 * 1024 + 1, 66);
    writeFileSync(target, newBytes);
    const latest = await readFilesFile("local", "ws", "late.txt");
    await act(async () => { f.client.setQueryData(["files", "read", "ws", "late.txt"], latest); fireEvent.click(save); await Promise.resolve(); });
    expect(f.writes()).toHaveLength(0);
    expect(readFileSync(target).equals(newBytes)).toBe(true);
  });

  it("Save captures the live textarea value at click time", async () => {
    const { f, textarea, disk } = await openEditor("live.txt", "x\r\n");
    type(textarea, "xy\n");
    // A keystroke the browser applied but React has not delivered yet.
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "xyz\n");
    fireEvent.click(screen.getByTestId("files-editor-save"));
    await waitFor(() => expect(f.writes()).toHaveLength(1));
    expect(disk()).toBe("xyz\r\n");
  });

  it("Save is disabled during composition and uses the committed text afterwards", async () => {
    const { f, textarea, disk } = await openEditor("ime.txt", "a\r\n");
    fireEvent.compositionStart(textarea);
    type(textarea, "aか\n");
    expect((screen.getByTestId("files-editor-save") as HTMLButtonElement).disabled).toBe(true);
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "a漢\n");
    fireEvent.compositionEnd(textarea);
    expect(textarea.value).toBe("a漢\n");
    fireEvent.click(screen.getByTestId("files-editor-save"));
    await waitFor(() => expect(f.writes()).toHaveLength(1));
    expect(readFileSync(f.path("ws", "ime.txt"), "utf8")).toBe("a漢\r\n");
    expect(disk()).not.toContain("か");
  });

  it("typing during a pending write survives the rebase onto the saved file", async () => {
    const { f, textarea, disk } = await openEditor("pending.txt", "1\r\n");
    type(textarea, "12\n");
    fireEvent.click(screen.getByTestId("files-editor-save"));
    type(textarea, "123\n");
    await waitFor(() => expect(f.writes()).toHaveLength(1));
    expect(disk()).toBe("12\r\n");
    await waitFor(() => expect(f.calls.filter((c) => c.url.startsWith("/api/files/read")).length).toBeGreaterThanOrEqual(2));
    await waitFor(() => expect(screen.queryByTestId("files-editor-stale")).toBeNull());
    expect((screen.getByTestId("files-editor-textarea") as HTMLTextAreaElement).value).toBe("123\n");
    expect(screen.getByTestId("files-editor-status").textContent).toBe("draft (unsaved)");
    fireEvent.click(screen.getByTestId("files-editor-save"));
    await waitFor(() => expect(f.writes()).toHaveLength(2));
    expect(f.writes()[1]!.status).toBe(200);
    expect(disk()).toBe("123\r\n");
  });

  it("a changed file on disk leaves the draft on its original base with an explicit discard", async () => {
    const { f, textarea, target } = await openEditor("drift.txt", "v1\n");
    type(textarea, "draft\n");
    writeFileSync(target, "v2 external\n");
    await act(async () => { await f.client.invalidateQueries({ queryKey: ["files", "read"] }); });
    expect(await screen.findByTestId("files-editor-stale")).toBeTruthy();
    expect(textarea.value).toBe("draft\n");
    fireEvent.click(screen.getByTestId("files-editor-save"));
    expect(screen.getByTestId("files-editor-error").textContent).toMatch(/re-read after this draft/);
    expect(f.writes()).toHaveLength(0);
    fireEvent.click(screen.getByTestId("files-editor-discard-stale"));
    await waitFor(() => expect((screen.getByTestId("files-editor-textarea") as HTMLTextAreaElement).value).toBe("v2 external\n"));
  });
});
