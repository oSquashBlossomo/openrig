// A Save that is still in flight belongs to the draft generation it was sent
// for. An explicit Discard ends that generation: the late response may not
// recreate the discarded draft or its conflict, and it may not overwrite a
// newer draft typed afterwards (even identical bytes). Ordinary typing during
// a pending Save is still the same generation and survives. Actual daemon
// filesRoutes + FileWriteService over private temp roots; the fetch seam only
// HOLDS the real write request, it never synthesizes a response.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { readFileSync, writeFileSync } from "node:fs";
import { FilesWorkspace } from "../src/components/files/FilesWorkspace.js";
import { disposeFilesFixtures, filesFixture } from "./files-fixture.js";

afterEach(() => { cleanup(); disposeFilesFixtures(); });

async function openHeldEditor(name: string, bytes: string) {
  const f = filesFixture({ ws: { files: { [name]: bytes } } });
  const realFetch = f.fetch;
  let release!: () => void;
  let held = false;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (url === "/api/files/write" && !held) { held = true; await gate; }
    return realFetch(url, init);
  });
  f.mount(<FilesWorkspace />);
  fireEvent.click(await screen.findByTestId(`files-entry-${name}`));
  await waitFor(() => expect((screen.getByTestId("files-edit-toggle") as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByTestId("files-edit-toggle"));
  const textarea = await screen.findByTestId("files-editor-textarea") as HTMLTextAreaElement;
  const reads = () => f.calls.filter((c) => c.url.startsWith("/api/files/read")).length;
  const settle = async (status: number) => {
    await act(async () => { release(); });
    await waitFor(() => expect(f.writes()).toHaveLength(1));
    expect(f.writes()[0]!.status).toBe(status);
    await waitFor(() => expect(screen.getByTestId("files-editor-save").textContent).toBe("save"));
  };
  return {
    f, textarea, reads, settle,
    held: () => held,
    disk: () => readFileSync(f.path("ws", name), "utf8"),
    external: (text: string) => writeFileSync(f.path("ws", name), text),
    value: () => (screen.getByTestId("files-editor-textarea") as HTMLTextAreaElement).value,
  };
}

const type = (el: HTMLTextAreaElement, value: string) => fireEvent.change(el, { target: { value } });

describe("a pending Save after an explicit Discard", () => {
  it("a delayed 409 does not recreate the discarded draft or its conflict", async () => {
    const e = await openHeldEditor("draft.txt", "original\n");
    type(e.textarea, "discard this draft\n");
    e.external("external update\n");
    fireEvent.click(screen.getByTestId("files-editor-save"));
    await waitFor(() => expect(e.held()).toBe(true));
    fireEvent.click(screen.getByTestId("files-editor-cancel"));
    expect(e.value()).toBe("original\n");
    await e.settle(409);
    expect(e.disk()).toBe("external update\n");
    expect(e.value()).toBe("original\n");
    expect(screen.queryByTestId("files-editor-conflict")).toBeNull();
    expect(screen.getByTestId("files-editor-status").textContent).toBe("no changes");
    expect(screen.queryByTestId("files-drafts-toggle")).toBeNull();
  });

  it("a delayed success shows the actual saved read without restoring the discarded draft", async () => {
    const e = await openHeldEditor("saved.txt", "original\n");
    type(e.textarea, "landed anyway\n");
    fireEvent.click(screen.getByTestId("files-editor-save"));
    await waitFor(() => expect(e.held()).toBe(true));
    fireEvent.click(screen.getByTestId("files-editor-cancel"));
    expect(e.value()).toBe("original\n");
    const before = e.reads();
    await e.settle(200);
    expect(e.disk()).toBe("landed anyway\n");
    // The write landed: the editor reconciles onto the re-read file, with no
    // draft, conflict or stale banner from the discarded generation.
    await waitFor(() => expect(e.reads()).toBeGreaterThan(before));
    await waitFor(() => expect(e.value()).toBe("landed anyway\n"));
    expect(screen.getByTestId("files-editor-status").textContent).toBe("no changes");
    expect(screen.queryByTestId("files-editor-conflict")).toBeNull();
    expect(screen.queryByTestId("files-editor-stale")).toBeNull();
    expect(screen.queryByTestId("files-drafts-toggle")).toBeNull();
  });

  it("identical bytes retyped as a new draft are kept when the old 409 lands", async () => {
    const e = await openHeldEditor("retype.txt", "original\n");
    type(e.textarea, "same bytes\n");
    e.external("external update\n");
    fireEvent.click(screen.getByTestId("files-editor-save"));
    await waitFor(() => expect(e.held()).toBe(true));
    fireEvent.click(screen.getByTestId("files-editor-cancel"));
    type(screen.getByTestId("files-editor-textarea") as HTMLTextAreaElement, "same bytes\n");
    await e.settle(409);
    expect(e.disk()).toBe("external update\n");
    expect(e.value()).toBe("same bytes\n");
    expect(screen.getByTestId("files-editor-status").textContent).toBe("draft (unsaved)");
    // The 409 answered the discarded generation's request, not this draft's.
    expect(screen.queryByTestId("files-editor-conflict")).toBeNull();
  });

  it("a newer draft typed after Discard is not overwritten when the old Save succeeds", async () => {
    const e = await openHeldEditor("newer.txt", "original\n");
    type(e.textarea, "first draft\n");
    fireEvent.click(screen.getByTestId("files-editor-save"));
    await waitFor(() => expect(e.held()).toBe(true));
    fireEvent.click(screen.getByTestId("files-editor-cancel"));
    type(screen.getByTestId("files-editor-textarea") as HTMLTextAreaElement, "second draft\n");
    const before = e.reads();
    await e.settle(200);
    expect(e.disk()).toBe("first draft\n");
    await waitFor(() => expect(e.reads()).toBeGreaterThan(before));
    // The newer draft keeps its text and its original base; the file changed
    // under it (by the earlier save), so Save is blocked with an explicit notice.
    await waitFor(() => expect(screen.getByTestId("files-editor-stale")).toBeTruthy());
    expect(e.value()).toBe("second draft\n");
    expect(screen.getByTestId("files-editor-status").textContent).toBe("draft (unsaved)");
    expect(e.disk()).toBe("first draft\n");
  });
});

describe("typing during a pending Save is the same draft", () => {
  it("typing back to the original text while the Save is pending is kept after it lands", async () => {
    const e = await openHeldEditor("undo.txt", "original\n");
    type(e.textarea, "changed\n");
    fireEvent.click(screen.getByTestId("files-editor-save"));
    await waitFor(() => expect(e.held()).toBe(true));
    // Not a Discard: the user edits the text back while the request is held.
    type(e.textarea, "original\n");
    const before = e.reads();
    await e.settle(200);
    expect(e.disk()).toBe("changed\n");
    await waitFor(() => expect(e.reads()).toBeGreaterThan(before));
    await waitFor(() => expect(screen.queryByTestId("files-editor-stale")).toBeNull());
    expect(e.value()).toBe("original\n");
    expect(screen.getByTestId("files-editor-status").textContent).toBe("draft (unsaved)");
    // The kept text is an ordinary draft on the saved file: saving it writes it.
    fireEvent.click(screen.getByTestId("files-editor-save"));
    await waitFor(() => expect(e.f.writes()).toHaveLength(2));
    expect(e.f.writes()[1]!.status).toBe(200);
    expect(e.disk()).toBe("original\n");
  });
});

describe("navigating away while a Save is pending", () => {
  async function openFile(name: string) {
    fireEvent.click(await screen.findByTestId(`files-entry-${name}`));
    await waitFor(() => expect((screen.getByTestId("files-edit-toggle") as HTMLButtonElement).disabled).toBe(false));
    if (screen.getByTestId("files-edit-toggle").getAttribute("aria-pressed") !== "true") fireEvent.click(screen.getByTestId("files-edit-toggle"));
    return await screen.findByTestId("files-editor-textarea") as HTMLTextAreaElement;
  }

  /** Real write; the response is held only AFTER the daemon committed it. */
  function holdCommittedWrite(f: ReturnType<typeof filesFixture>) {
    const real = f.fetch;
    let release!: () => void;
    let committed = false;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const response = await real(url, init);
      if (url === "/api/files/write" && !committed) { committed = true; await gate; }
      return response;
    });
    return { release: () => release(), committed: () => committed };
  }

  it("a successful Save that lands while another file is open is reconciled when the user returns", async () => {
    const f = filesFixture({ ws: { files: { "a.txt": "original\n", "b.txt": "other base\n" } } });
    const held = holdCommittedWrite(f);
    f.mount(<FilesWorkspace />);
    type(await openFile("a.txt"), "saved on a\n");
    fireEvent.click(screen.getByTestId("files-editor-save"));
    await waitFor(() => expect(held.committed()).toBe(true));
    const b = await openFile("b.txt");
    type(b, "unsaved on b\n");
    await act(async () => { held.release(); await new Promise((r) => setTimeout(r, 30)); });
    // B's own draft and disk are untouched, and B shows none of A's indicators.
    expect(b.value).toBe("unsaved on b\n");
    expect(screen.queryByTestId("files-editor-saved")).toBeNull();
    expect(screen.queryByTestId("files-editor-notice")).toBeNull();
    expect(readFileSync(f.path("ws", "a.txt"), "utf8")).toBe("saved on a\n");
    expect(readFileSync(f.path("ws", "b.txt"), "utf8")).toBe("other base\n");
    const back = await openFile("a.txt");
    await waitFor(() => expect(back.value).toBe("saved on a\n"));
    await waitFor(() => expect(screen.getByTestId("files-editor-status").textContent).toBe("no changes"));
    expect(screen.queryByTestId("files-editor-stale")).toBeNull();
    expect(screen.queryByTestId("files-editor-conflict")).toBeNull();
    expect(f.writes()).toHaveLength(1);
  });

  it("returning before the held Save settles keeps it pending: no second submit, then reconciles", async () => {
    const f = filesFixture({ ws: { files: { "a.txt": "original\n", "b.txt": "other base\n" } } });
    const held = holdCommittedWrite(f);
    f.mount(<FilesWorkspace />);
    type(await openFile("a.txt"), "saved on a\n");
    fireEvent.click(screen.getByTestId("files-editor-save"));
    await waitFor(() => expect(held.committed()).toBe(true));
    await openFile("b.txt");
    const back = await openFile("a.txt");
    expect(back.value).toBe("saved on a\n");
    expect((screen.getByTestId("files-editor-save") as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { held.release(); });
    await waitFor(() => expect(screen.getByTestId("files-editor-status").textContent).toBe("no changes"));
    expect(screen.queryByTestId("files-editor-stale")).toBeNull();
    expect(f.writes()).toHaveLength(1);
  });
});
