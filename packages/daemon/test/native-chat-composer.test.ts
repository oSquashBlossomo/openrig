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

it("matches the native Codex 0.161 paragraph at the 77-cell textarea word boundary", () => {
  const text = "CHAT_REVIEW_CODEX: Read only acceptance.txt and report its marker. Also repeat café λ 日本語 🙂. Use no other tools.";
  const lines = Array.from({ length: 24 }, () => "");
  lines[19] = "› CHAT_REVIEW_CODEX: Read only acceptance.txt and report its marker. Also       ";
  lines[20] = "  repeat café λ 日本語 🙂. Use no other tools.                                  ";
  lines[22] = "  GPT-6.1-Sol high · /tmp/chat-proof/work-codex                        ";
  expect(matches(lines.join("\n"), "codex", cursor(46, 20), text)).toBe(true);
  expect(matches(lines.join("\n"), "codex", cursor(45, 20), text)).toBe(false);
  expect(matches(lines.join("\n"), "codex", cursor(46, 20), text.replace("Also repeat", "Alsorepeat"))).toBe(false);
});
it.each([5, 6, 7])("uses native width−3 and preserves the insertion row for boundary word length %i", length => {
  const text = "a".repeat(70) + " " + "é".repeat(length);
  const body = length === 5 ? [`› ${text}`] : length === 6 ? [`› ${text}`, ""] : ["› " + "a".repeat(70), "  " + "é".repeat(length)];
  const pane = [...body, "", "  GPT-6.1-Sol high · /tmp/proof", ""].join("\n");
  const pos = length === 5 ? cursor(78) : length === 6 ? cursor(2, 1) : cursor(9, 1);
  expect(matches(pane, "codex", pos, text)).toBe(true);
  expect(matches(pane, "codex", { ...pos, x: pos.x + 1 }, text)).toBe(false);
});
it("counts wide Unicode cells and rejects loss of a literal trailing space at the exact Codex boundary", () => {
  const text = "a".repeat(68) + " 日本語🙂";
  expect(stringWidth(text)).toBe(77);
  const pane = [`› ${text} `, "", "", "  GPT-6.1-Sol high · /tmp/proof", ""].join("\n");
  expect(matches(pane, "codex", cursor(2, 1), text)).toBe(true);
  expect(matches(pane, "codex", cursor(2, 1), text + " ")).toBe(false);
  const withSpace = [`› ${text} `, "   ", "", "  GPT-6.1-Sol high · /tmp/proof", ""].join("\n");
  expect(matches(withSpace, "codex", cursor(3, 1), text + " ")).toBe(true);
  expect(matches(pane, "codex", cursor(79), text)).toBe(false);
});

// Captured native Claude idle footer, with unrelated conversation rows omitted.
it("recognizes the exact remote-control hint below the observed empty Claude frame", () => {
  const lines = Array.from({ length: 24 }, () => "");
  lines[15] = "● Completed response.";
  lines[17] = "───────────────────────────────────────────────── proof-claude@native-chat-lab ─";
  lines[18] = "❯\u00a0                  ";
  lines[19] = "─".repeat(80);
  lines[20] = "  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents                           ";
  lines[21] = "                        control this session from your phone · /remote-control  ";
  const pane = lines.join("\n");
  expect(matches(pane, "claude-code", cursor(2, 18), "")).toBe(true);
  expect(matches(pane, "claude-code", cursor(3, 18), "")).toBe(false);
  expect(matches(pane.replace(lines[18]!, "❯\u00a0draft"), "claude-code", cursor(7, 18), "")).toBe(false);
  expect(matches(pane.replace(lines[18]!, "❯\u00a0hello  "), "claude-code", cursor(7, 18), "hello")).toBe(true);
  expect(matches(pane.replace(lines[18]!, "❯\u00a0hello  "), "claude-code", cursor(7, 18), "hello ")).toBe(false);
  for (const suffix of ["Proceed?", "control this session from your phone · /remote-control now",
    "control this session from your phone · /remote-control\nUnexpected footer"]) {
    expect(matches(pane.replace(lines[21]!, suffix), "claude-code", cursor(2, 18), "")).toBe(false);
  }
  expect(matches(pane.replace(lines[20]!, "Unknown mode (shift+tab to cycle)"), "claude-code", cursor(2, 18), "")).toBe(false);
});
