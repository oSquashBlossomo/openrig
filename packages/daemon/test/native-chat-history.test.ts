import { afterEach, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, appendFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readNativeChatHistory } from "../src/domain/native-chat-history.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
function fixture(runtime: "codex" | "claude-code" = "codex") {
  const root = mkdtempSync(join(tmpdir(), "native-chat-history-")); roots.push(root);
  const id = "11111111-1111-4111-8111-111111111111", path = join(root, `${id}.jsonl`);
  const records = runtime === "codex" ? [{ type: "session_meta", payload: { id } }] : [{ type: "user", sessionId: id, message: { role: "user", content: "hello" } }];
  writeFileSync(path, records.map(row => JSON.stringify(row)).join("\n") + "\n");
  return { root, path, conversationId: id, runtime };
}
it("reads native messages/tools without duplicate event echoes or thinking", () => {
  const f = fixture();
  appendFileSync(f.path, [
    { type: "event_msg", payload: { type: "user_message", message: "hello" } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] } },
    { type: "response_item", payload: { type: "reasoning", summary: [{ text: "not public" }] } },
    { type: "response_item", payload: { type: "function_call", name: "read", call_id: "c1", arguments: '{"file":"test.ts"}' } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "c1", output: "result" } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] } },
  ].map(x => JSON.stringify(x)).join("\n") + "\n");
  const page = readNativeChatHistory(f);
  expect(page.messages.map(m => [m.role, m.text])).toEqual([["user", "hello"], ["tool", '{"file":"test.ts"}'], ["tool", "result"], ["assistant", "done"]]);
  expect(JSON.stringify(page.messages)).not.toContain("not public");
});
it("bounds pages, tolerates an incomplete last line and gives stable older cursors", () => {
  const f = fixture("claude-code");
  for (let i = 0; i < 150; i++) appendFileSync(f.path, JSON.stringify({ type: "assistant", sessionId: f.conversationId, message: { role: "assistant", content: [{ type: "text", text: `reply-${i}` }] } }) + "\n");
  appendFileSync(f.path, '{"type":');
  const newest = readNativeChatHistory(f);
  expect(newest.messages).toHaveLength(100); expect(newest.messages.at(-1)!.text).toBe("reply-149");
  const older = readNativeChatHistory({ ...f, before: newest.olderCursor! });
  expect(older.messages.at(-1)!.text).toBe("reply-49");
  expect(new Set([...older.messages, ...newest.messages].map(m => m.id)).size).toBe(151);
});
it("refuses a wrong conversation, escaped symlink and replaced-file cursor", () => {
  const f = fixture();
  expect(() => readNativeChatHistory({ ...f, conversationId: "wrong" })).toThrow();
  const outside = fixture(); mkdirSync(join(f.root, "sub")); symlinkSync(outside.path, join(f.root, "sub", "link"));
  expect(() => readNativeChatHistory({ ...f, path: join(f.root, "sub", "link") })).toThrow();
  expect(() => readNativeChatHistory({ ...f, before: Buffer.from(JSON.stringify({ key: "wrong", before: 0 })).toString("base64url") })).toThrow();
});
it("qualifies skipped oversized native records and an incomplete tail", () => {
  const f = fixture();
  appendFileSync(f.path, JSON.stringify({ type: "response_item", payload: { type: "function_call_output", call_id: "big", output: "x".repeat(600 * 1024) } }) + "\n" + '{"type":');
  const page = readNativeChatHistory(f);
  expect(page.state).toBe("partial"); expect(page.messages).toEqual([]);
  expect(page.detail).toContain("oversized");
});
it("makes backward progress when one whole record is larger than a window", () => {
  const f = fixture();
  appendFileSync(f.path, JSON.stringify({ type: "response_item", payload: { type: "function_call_output", call_id: "big", output: "x".repeat(1200 * 1024) } }) + "\n");
  let before: string | undefined, last = Infinity;
  for (let i = 0; i < 5; i++) {
    const page = readNativeChatHistory({ ...f, before });
    if (!page.olderCursor) return;
    const offset = JSON.parse(Buffer.from(page.olderCursor, "base64url").toString()).before;
    expect(offset).toBeLessThan(last); last = offset; before = page.olderCursor;
  }
  throw new Error("pagination did not terminate");
});
