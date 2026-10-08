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

it("recognizes the actual Codex nonempty composer when shortcuts disappear but the model footer remains framed", () => {
  const text = "Reply exactly CHAT_CODEX_366815_OK.";
  const lines = Array.from({ length: 24 }, () => "");
  lines[1] = "  >_ OpenAI Codex (v0.161.0)";
  lines[20] = `› ${text}   `;
  lines[22] = "  GPT-6.1-Sol high · /tmp/chat-proof/work-codex                        ";
  lines[23] = "                    ";
  const pane = lines.join("\n");
  expect(matches(pane, "codex", cursor(37, 20), text)).toBe(true);
  expect(matches(pane, "codex", cursor(36, 20), text)).toBe(false);
  expect(matches(pane, "codex", cursor(38, 20), text)).toBe(false);
  expect(matches(pane, "codex", cursor(2, 20), "")).toBe(false);
  expect(matches(pane, "codex", cursor(37, 22), text)).toBe(false);
});
it.each([
  "› hello\n  GPT-6.1-Sol high · /tmp/proof\n",
  "› hello\nHUMAN DRAFT\n  GPT-6.1-Sol high · /tmp/proof\n",
  "› hello\n\n  GPT-6.1-Sol high · /tmp/proof\nHUMAN DRAFT",
  "› hello\n\n  GPT-6.1-Sol high · relative/path\n",
  "› hello\n\n  not a native footer\n",
  "› 1. Yes\n\n  GPT-6.1-Sol high · /tmp/proof\n",
])("does not promote an unframed or false metadata footer into composer proof (%j)", pane => {
  expect(matches(pane, "codex", cursor(7), "hello")).toBe(false);
});
