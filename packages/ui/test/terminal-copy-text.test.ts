// Copy's no-selection fallback over a real xterm buffer (no renderer, no
// socket): the visible rows as logical lines. Soft-wrapped rows (isWrapped)
// continue the previous line; hard newlines stay; written spaces at a wrap
// boundary stay; unwritten padding does not (as xterm's own selection).

import { afterEach, expect, it } from "vitest";
import { Terminal } from "@xterm/xterm";
import { terminalCopyText } from "../src/components/terminal/FocusedTerminal.js";

let term: Terminal | null = null;
afterEach(() => { term?.dispose(); term = null; });

async function screen(data: string, cols = 10, rows = 6) {
  term = new Terminal({ cols, rows, allowProposedApi: true });
  await new Promise<void>((resolve) => term!.write(data, resolve));
  return terminalCopyText(term as unknown as Parameters<typeof terminalCopyText>[0]);
}

it("joins soft-wrapped rows into one line and keeps hard newlines", async () => {
  expect(await screen("abcdefghijklmnopqrstuvwx\r\nsecond")).toEqual({ text: "abcdefghijklmnopqrstuvwx\nsecond", what: "the visible screen" });
});

it("keeps a written space at the wrap boundary and adds none before a wrapped wide character", async () => {
  expect((await screen("abcdefghi jkl\r\n123456789中z")).text).toBe("abcdefghi jkl\n123456789中z");
});

it("copies only the visible rows: a line wrapped in from above starts at the top row", async () => {
  // 3 rows tall: the first wrapped row of the long line scrolls out of view.
  expect((await screen("abcdefghijklmnopqrstuvwxyz0123\r\nX", 10, 3)).text).toBe("klmnopqrstuvwxyz0123\nX");
});

it("keeps blank hard lines between text and trims trailing blank rows", async () => {
  expect((await screen("one\r\n\r\nthree\r\n")).text).toBe("one\n\nthree");
});
