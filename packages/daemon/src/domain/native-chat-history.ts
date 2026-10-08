import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { basename, relative, isAbsolute } from "node:path";
import { redactTranscriptContent } from "./transcript-redaction.js";

export interface NativeChatMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  text: string;
  timestamp: string | null;
  tool?: { name: string; callId: string | null; kind: "call" | "result" };
  truncated: boolean;
}
export interface NativeChatHistoryInput {
  path: string; root: string; conversationId: string; runtime: "codex" | "claude-code"; before?: string;
}
const WINDOW = 512 * 1024;
const MAX_TEXT = 16 * 1024;
export const nativeChatTextHash = (text: string): string => createHash("sha256").update(text).digest("hex");
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.flatMap((item: unknown) => {
    const block = record(item);
    return block && ["text", "input_text", "output_text"].includes(String(block.type)) && typeof block.text === "string" ? [block.text] : [];
  }).join("\n");
}

/** Bounded native-file read. The caller must also prove the live owner; neither a
 * filename nor a working directory alone authorizes exposing a conversation. */
export function readNativeChatHistory(input: NativeChatHistoryInput) {
  const root = realpathSync(input.root), path = realpathSync(input.path);
  const rel = relative(root, path);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("Native history is outside its provider root");
  const fd = openSync(path, "r");
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error("Native history is not a regular file");
    const read = (start: number, size: number) => {
      const bytes = Buffer.alloc(size); const length = readSync(fd, bytes, 0, size, start);
      return bytes.subarray(0, length);
    };
    const head = read(0, Math.min(stat.size, 64 * 1024));
    const firstEnd = head.indexOf(10);
    if (firstEnd < 0) throw new Error("Native history header is unavailable");
    const headRows = head.subarray(0, head.lastIndexOf(10)).toString("utf8").split("\n").flatMap(line => {
      try { return [record(JSON.parse(line))]; } catch { return []; }
    });
    const first = headRows[0];
    const identity = input.runtime === "codex"
      ? first?.type === "session_meta" && record(first.payload)?.id === input.conversationId
      : basename(path) === `${input.conversationId}.jsonl` && headRows.some(row => row?.sessionId === input.conversationId);
    if (!identity) throw new Error("Native history identity does not match");
    const fileKey = nativeChatTextHash(`${stat.dev}:${stat.ino}:${input.conversationId}:${head.subarray(0, firstEnd).toString("utf8")}`);
    let end = stat.size;
    if (input.before) {
      let cursor: { key?: unknown; before?: unknown };
      try { cursor = JSON.parse(Buffer.from(input.before, "base64url").toString("utf8")); } catch { throw new Error("Invalid history cursor"); }
      if (cursor.key !== fileKey || !Number.isSafeInteger(cursor.before) || Number(cursor.before) < 0 || Number(cursor.before) > stat.size) throw new Error("History cursor no longer matches this file");
      end = Number(cursor.before);
    }
    let start = Math.max(0, end - WINDOW);
    const windowStart = start;
    const clippedWindow = start > 0;
    let bytes = read(start, end - start);
    if (start > 0) {
      const newline = bytes.indexOf(10);
      if (newline < 0) bytes = Buffer.alloc(0);
      else { start += newline + 1; bytes = bytes.subarray(newline + 1); }
    }
    // Native writers may leave a partial JSON record while streaming. Never parse it.
    const partialTail = bytes.length > 0 && bytes.at(-1) !== 10;
    bytes = bytes.subarray(0, Math.max(0, bytes.lastIndexOf(10) + 1));
    const parsed: Array<{ message: NativeChatMessage; offset: number; textHash: string }> = [];
    let offset = start, malformed = false;
    for (const line of bytes.toString("utf8").split("\n")) {
      const lineOffset = offset; offset += Buffer.byteLength(line) + 1;
      if (!line) continue;
      let row: Record<string, unknown> | null;
      try { row = record(JSON.parse(line)); } catch { malformed = true; continue; }
      if (!row) continue;
      const timestamp = typeof row.timestamp === "string" ? row.timestamp : null;
      let blockIndex = 0;
      const add = (role: NativeChatMessage["role"], text: string, tool?: NativeChatMessage["tool"]) => {
        if (!text && !tool) return;
        const raw = Buffer.from(text); const truncated = raw.length > MAX_TEXT;
        const bounded = truncated ? raw.subarray(0, MAX_TEXT).toString("utf8") + "\n[truncated]" : text;
        parsed.push({ offset: lineOffset, textHash: nativeChatTextHash(text), message: {
          id: `${fileKey}:${lineOffset}:${blockIndex++}`,
          role, text: redactTranscriptContent(bounded), timestamp, ...(tool ? { tool } : {}), truncated,
        } });
      };
      if (input.runtime === "codex") {
        if (row.type !== "response_item") continue; // event_msg echoes the same messages
        const p = record(row.payload); if (!p) continue;
        if (p.type === "message" && (p.role === "user" || p.role === "assistant")) add(p.role, contentText(p.content));
        else if (p.type === "function_call" || p.type === "custom_tool_call") add("tool", contentText(p.arguments ?? p.input), {
          name: typeof p.name === "string" ? p.name : "Tool", callId: typeof p.call_id === "string" ? p.call_id : null, kind: "call",
        });
        else if (p.type === "function_call_output" || p.type === "custom_tool_call_output") add("tool", contentText(p.output), {
          name: "Tool result", callId: typeof p.call_id === "string" ? p.call_id : null, kind: "result",
        });
      } else {
        if (row.sessionId !== input.conversationId || (row.type !== "user" && row.type !== "assistant")) continue;
        const p = record(row.message); if (!p) continue;
        add(row.type, contentText(p.content));
        for (const item of Array.isArray(p.content) ? p.content : []) {
          const block = record(item); if (!block) continue;
          if (block.type === "tool_use") add("tool", JSON.stringify(block.input ?? {}), {
            name: typeof block.name === "string" ? block.name : "Tool", callId: typeof block.id === "string" ? block.id : null, kind: "call",
          });
          if (block.type === "tool_result") add("tool", contentText(block.content), {
            name: "Tool result", callId: typeof block.tool_use_id === "string" ? block.tool_use_id : null, kind: "result",
          });
        }
      }
    }
    // Keep all blocks belonging to the first retained native row together.
    const boundary = parsed.length > 100 ? parsed[parsed.length - 100]!.offset : start;
    const selected = parsed.filter(item => item.offset >= boundary);
    // If one record fills the entire window, still make strict backward progress.
    // It will be skipped with a partial warning; never return a self-repeating cursor.
    const olderAt = parsed.length === 0 && clippedWindow ? windowStart : boundary > 0 ? boundary : null;
    return { messages: selected.map(item => item.message), records: selected, fileKey, endOffset: stat.size,
      olderCursor: olderAt === null ? null : Buffer.from(JSON.stringify({ key: fileKey, before: olderAt })).toString("base64url"),
      state: malformed || clippedWindow || partialTail ? "partial" as const : "available" as const,
      detail: "Saved native messages and tool records. Thinking and unsupported records are omitted. Reads are limited to 512 KiB; oversized or incomplete records may be skipped, and active output may not yet be saved.",
    };
  } finally { closeSync(fd); }
}
