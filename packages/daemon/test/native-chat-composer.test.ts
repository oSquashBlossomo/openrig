import { expect, it } from "vitest";
import stringWidth from "string-width";
import { nativeChatComposerMatches as matches } from "../src/domain/native-chat.js";
const cursor = (x: number, y = 0, width = 80) => ({ x, y, width, height: 24 });
const claude = (body: string[]) => [...body, "────────────────────", "⏵⏵ auto mode on (shift+tab to cycle)"].join("\n");
it("distinguishes native paint padding from typed trailing spaces using the insertion cursor", () => {
  const pane = claude(["❯\u00a0hello      "]);
  expect(matches(pane, "claude-code", cursor(7), "hello")).toBe(true);
  expect(matches(pane, "claude-code", cursor(9), "hello  ")).toBe(true);
  expect(matches(pane, "claude-code", cursor(7), "hello  ")).toBe(false);
  expect(matches(pane, "claude-code", cursor(9), "hello")).toBe(false);
  expect(matches(claude(["❯\u00a0      "]), "claude-code", cursor(2), "")).toBe(true);
  expect(matches(claude(["❯\u00a0      "]), "claude-code", cursor(4), "")).toBe(false);
});
it.each(["I’m here — café 👩🏽‍💻", "你好，世界 👋", "e\u0301 and 👨‍👩‍👧‍👦"])("compares exact Unicode text and rendered cells for %j", text => {
  const pane = claude(["❯\u00a0" + text + "  "]);
  expect(matches(pane, "claude-code", cursor(2 + stringWidth(text)), text)).toBe(true);
  expect(matches(pane, "claude-code", cursor(3 + stringWidth(text)), text)).toBe(false);
  expect(matches(pane, "claude-code", cursor(2 + stringWidth(text)), text + " ")).toBe(false);
});
it("accepts known word-wrap boundaries without joining arbitrary rows or erasing exact spaces", () => {
  const text = "I’m testing café text 👋 with a friend.";
  const pane = claude(["❯\u00a0I’m testing café    ", "  text 👋 with a      ", "  friend.     "]);
  expect(matches(pane, "claude-code", cursor(9, 2, 22), text)).toBe(true);
  expect(matches(pane, "claude-code", cursor(9, 2, 22), text.replace("café text", "cafétext"))).toBe(false);
  expect(matches(pane, "claude-code", cursor(9, 2, 22), text.replace("café text", "café  text"))).toBe(false);
  expect(matches(pane, "claude-code", cursor(9, 2, 22), text.replace("café text", "café\ntext"))).toBe(false);
});
it("refuses false Codex footer and metadata rows in a draft", () => {
  expect(matches("› \n? for shortcuts\nHUMAN DRAFT\n\n? for shortcuts", "codex", cursor(2), "")).toBe(false);
  expect(matches("› \n  GPT-6.1-Sol high · /tmp/draft\n? for shortcuts", "codex", cursor(2), "")).toBe(false);
  expect(matches("› \n\n  GPT-6.1-Sol high · /tmp/draft\n? for shortcuts", "codex", cursor(10, 2), "")).toBe(false);
  expect(matches("› Ask Codex to do anything    \n\n? for shortcuts", "codex", cursor(25), "")).toBe(false);
});
it("keeps incomplete, collapsed, extra-row and moved-cursor forms out of the supported projection", () => {
  expect(matches(claude(["❯ [Pasted text #1 +2 lines]"]), "claude-code", cursor(28), "hello")).toBe(false);
  expect(matches(claude(["❯ hello", "  HUMAN DRAFT"]), "claude-code", cursor(7), "hello")).toBe(false);
  expect(matches(claude(["❯ hello"]), "claude-code", cursor(2), "hello")).toBe(false);
  expect(matches("❯ \n────────────────────\n? for shortcuts\nHUMAN DRAFT\n────────────────────\n⏵⏵ auto mode on (shift+tab to cycle)", "claude-code", cursor(2), "")).toBe(false);
  expect(matches("❯ hello", "claude-code", cursor(7), "hello")).toBe(false);
  expect(matches("› 1. Yes\n? for shortcuts", "codex", cursor(2), "")).toBe(false);
});
