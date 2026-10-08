// Native agent chat client; see docs/reference/native-chat.md.
//
// History is the daemon's bounded read of the selected seat's OWN native
// conversation; a send is one guarded literal paste into the same tmux
// harness, recorded under a browser-made request id whose receipt the daemon
// keeps. Repeating a request id reads that receipt and never sends again, so
// the only safe retry is the SAME id: this module never makes a new id for a
// retry and never resends on its own.
//
// Drafts and in-flight receipts live in memory for this page load, keyed by
// source host / rig / raw node id / native conversation id, so navigation and
// reconnect keep them, a replaced conversation (/clear, restart) never
// inherits them, and private prompts are not written to localStorage.

import { useSyncExternalStore } from "react";
import { terminalAuthHeaders } from "../components/mission-control/missionControlAuth.js";
import { boundedJsonRead } from "./bounded-json-read.js";
import { isObject, isText, OperatorReadError } from "./operator-read.js";

export type NativeChatRole = "user" | "assistant" | "tool";
export interface NativeChatMessage {
  id: string;
  role: NativeChatRole;
  text: string;
  timestamp: string | null;
  tool?: { name: string; callId: string | null; kind: "call" | "result" };
  truncated: boolean;
}
export type NativeChatRequestState = "sending" | "submitted" | "observed" | "failed" | "indeterminate";
export interface NativeChatRequest {
  requestId: string;
  kind: "message" | "interrupt";
  text: string;
  state: NativeChatRequestState;
  detail: string;
  createdAt: string;
  updatedAt: string;
}
export interface NativeChatResponse {
  identity: {
    nodeId: string;
    sessionId: string;
    sessionName: string;
    runtime: "codex" | "claude-code";
    conversationId: string;
    ownerKey: string;
  };
  availability: {
    state: "ready" | "busy" | "needs_terminal" | "unavailable";
    detail: string;
    canSend: boolean;
    canInterrupt: boolean;
  };
  history: { state: "available" | "partial" | "unavailable"; detail: string; olderCursor: string | null };
  messages: NativeChatMessage[];
  requests: NativeChatRequest[];
}
/** 404/409: no current identity for this node; the Terminal is the fallback. */
export interface NativeChatRefusal {
  refused: true;
  status: number;
  code: string | null;
  error: string;
}

export const NATIVE_CHAT_MAX_BYTES = 32 * 1024;
const REQUEST_STATES = new Set(["sending", "submitted", "observed", "failed", "indeterminate"]);

const isNullableText = (v: unknown): v is string | null => v === null || isText(v);
const oneOf = <T extends string>(...values: T[]) => (v: unknown): v is T => values.includes(v as T);

function isMessage(v: unknown): v is NativeChatMessage {
  if (!isObject(v) || !isText(v.id) || !v.id || !oneOf("user", "assistant", "tool")(v.role) || !isText(v.text)
    || !isNullableText(v.timestamp) || typeof v.truncated !== "boolean") return false;
  if (v.tool === undefined) return true;
  const t = v.tool;
  return isObject(t) && isText(t.name) && isNullableText(t.callId) && oneOf("call", "result")(t.kind);
}
export function isNativeChatRequest(v: unknown): v is NativeChatRequest {
  return isObject(v) && isText(v.requestId) && !!v.requestId && oneOf("message", "interrupt")(v.kind)
    && isText(v.text) && REQUEST_STATES.has(v.state as string) && isText(v.detail)
    && isText(v.createdAt) && isText(v.updatedAt);
}
function isResponse(v: unknown, nodeId: string): v is NativeChatResponse {
  if (!isObject(v) || !isObject(v.identity) || !isObject(v.availability) || !isObject(v.history)) return false;
  const { identity: id, availability: a, history: h } = v;
  const nonEmpty = (x: unknown) => isText(x) && x.length > 0;
  return id.nodeId === nodeId && nonEmpty(id.sessionId) && nonEmpty(id.sessionName) && oneOf("codex", "claude-code")(id.runtime)
    && nonEmpty(id.conversationId) && nonEmpty(id.ownerKey)
    && oneOf("ready", "busy", "needs_terminal", "unavailable")(a.state) && isText(a.detail)
    && typeof a.canSend === "boolean" && typeof a.canInterrupt === "boolean"
    && oneOf("available", "partial", "unavailable")(h.state) && isText(h.detail) && isNullableText(h.olderCursor)
    && Array.isArray(v.messages) && v.messages.every(isMessage)
    && Array.isArray(v.requests) && v.requests.every(isNativeChatRequest);
}

const route = (nodeId: string) => `/api/native-chat/${encodeURIComponent(nodeId)}`;

/** One bounded page (latest, or older than `before`) for this exact node. A
 *  response naming another node is a contract failure, never shown. */
export async function readNativeChat(nodeId: string, options: { before?: string; signal?: AbortSignal; cache?: RequestCache } = {}): Promise<NativeChatResponse | NativeChatRefusal> {
  const url = options.before ? `${route(nodeId)}?before=${encodeURIComponent(options.before)}` : route(nodeId);
  return boundedJsonRead(url, { signal: options.signal, cache: options.cache, headers: terminalAuthHeaders(), readResponse: async (response) => {
    if (response.status === 404 || response.status === 409) {
      const body: unknown = await response.json().catch(() => null);
      return {
        refused: true as const,
        status: response.status,
        code: isObject(body) && isText(body.code) ? body.code : null,
        error: isObject(body) && isText(body.error) ? body.error
          : response.status === 404 ? "This seat (or native chat on this daemon) was not found." : "The seat's current native conversation could not be established.",
      };
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const value: unknown = await response.json();
    if (!isResponse(value, nodeId)) throw new OperatorReadError("invalid_contract", "Native chat response could not be verified for this seat.");
    return value;
  } });
}

/** A mutation's outcome. `unknown` means the request may have reached the
 *  daemon: keep its id and reconcile by reading, never by a new id. */
export type NativeChatPostOutcome =
  | { kind: "receipt"; request: NativeChatRequest }
  | { kind: "rejected"; status: number; code: string | null; error: string }
  | { kind: "unknown"; reason: string };

async function post(url: string, body: { requestId: string }): Promise<NativeChatPostOutcome> {
  // One deadline for headers AND body: a stalled reply is an unknown outcome.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  const lost = (err: unknown): NativeChatPostOutcome => ({
    kind: "unknown",
    reason: controller.signal.aborted ? "no complete response within 30 seconds" : err instanceof Error ? err.message : "network error",
  });
  try {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", ...terminalAuthHeaders() },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      return lost(err);
    }
    let json: unknown = null;
    try {
      json = await response.json();
    } catch (err) {
      if (controller.signal.aborted) return lost(err);
    }
    if (response.ok) {
      const request = isObject(json) ? json.request : null;
      return isNativeChatRequest(request) && request.requestId === body.requestId
        ? { kind: "receipt", request }
        : { kind: "unknown", reason: "the daemon's reply could not be read" };
    }
    // A 4xx is the daemon refusing before any effect; anything else may not be.
    if (response.status >= 400 && response.status < 500) {
      return {
        kind: "rejected",
        status: response.status,
        code: isObject(json) && isText(json.code) ? json.code : null,
        error: isObject(json) && isText(json.error) ? json.error : `HTTP ${response.status}`,
      };
    }
    return { kind: "unknown", reason: `HTTP ${response.status}` };
  } finally {
    clearTimeout(timer);
  }
}

export function postNativeChatMessage(nodeId: string, body: { requestId: string; ownerKey: string; text: string }) {
  return post(`${route(nodeId)}/messages`, body);
}
export function postNativeChatInterrupt(nodeId: string, body: { requestId: string; ownerKey: string }) {
  return post(`${route(nodeId)}/interrupt`, body);
}

/** Why this text must go through the Terminal instead (null: chat can send). */
export function composeRefusal(text: string): string | null {
  if (text.trimStart().startsWith("/")) return "Slash commands run in the native terminal, where their prompts and pickers are visible.";
  // Same set the daemon refuses: C0 (tab included) except LF, DEL and C1.
  // CR is checked after the CRLF→LF normalization a send applies.
  if (/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/.test(text.replace(/\r\n?/g, "\n"))) return "Tabs and other control characters are terminal keys; use the Terminal for them.";
  // v1 sends one paragraph: the terminal view cannot tell a typed line break
  // from wrapping, so any CR/LF (after the same normalization) stays in the
  // draft, unchanged, for the Terminal.
  if (/[\r\n]/.test(text)) return "Multi-line input goes through the Terminal. Your draft stays here; send one paragraph in Chat or open Terminal for multiple lines.";
  if (new TextEncoder().encode(text).length > NATIVE_CHAT_MAX_BYTES) return "Messages are limited to 32 KiB; paste longer input in the Terminal.";
  return null;
}

/** Most messages one panel keeps; past it the view says what it dropped. */
export const NATIVE_CHAT_VIEW_LIMIT = 1000;

/** Merge a page into the accumulated timeline: same id replaces in place,
 *  new ids join at the page's end (older pages: at the front). Unbounded;
 *  callers apply NATIVE_CHAT_VIEW_LIMIT so nothing is dropped silently. */
export function mergeMessages(prev: readonly NativeChatMessage[], page: readonly NativeChatMessage[], where: "newer" | "older"): NativeChatMessage[] {
  const incoming = new Map(page.map((m) => [m.id, m]));
  const known = new Set(prev.map((m) => m.id));
  const updated = prev.map((m) => incoming.get(m.id) ?? m);
  const added = page.filter((m) => !known.has(m.id));
  return where === "older" ? [...added, ...updated] : [...updated, ...added];
}

// ---------------------------------------------------------------------------
// Per-conversation draft and receipt store (memory only)
// ---------------------------------------------------------------------------

/** "posting": no answer yet; "unknown": the answer was lost. Others are the
 *  daemon's receipt states. */
export type PendingPhase = "posting" | "unknown" | NativeChatRequestState;
export interface PendingSend {
  requestId: string;
  text: string;
  ownerKey: string;
  phase: PendingPhase;
  detail: string;
}
export interface ChatSlot {
  draft: string;
  /** The latest message request still being resolved. */
  pending: PendingSend | null;
  /** The latest interrupt request (text is empty); kept after it settles so
   *  its outcome stays visible. */
  interrupt: PendingSend | null;
  /** Last refusal, shown beside the kept draft. */
  notice: string | null;
}

const EMPTY_SLOT: ChatSlot = { draft: "", pending: null, interrupt: null, notice: null };
const slots = new Map<string, ChatSlot>();
const listeners = new Set<() => void>();
const dismissed = new Set<string>();

export function chatSlotKey(hostId: string, rigId: string, nodeId: string, conversationId: string): string {
  return [hostId, rigId, nodeId, conversationId].join("\u0000");
}
export function readChatSlot(key: string): ChatSlot {
  return slots.get(key) ?? EMPTY_SLOT;
}
export function updateChatSlot(key: string, fn: (slot: ChatSlot) => ChatSlot): void {
  const prev = readChatSlot(key);
  const next = fn(prev);
  if (next === prev) return;
  if (!next.draft && !next.pending && !next.interrupt && !next.notice) slots.delete(key); else slots.set(key, next);
  for (const l of listeners) l();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function useChatSlot(key: string | null): ChatSlot {
  return useSyncExternalStore(subscribe, () => (key ? readChatSlot(key) : EMPTY_SLOT));
}
/** The operator acknowledged an unresolved receipt; it stays in the daemon. */
export function dismissReceipt(requestId: string): void {
  dismissed.add(requestId);
  for (const l of listeners) l();
}
export function isReceiptDismissed(requestId: string): boolean {
  return dismissed.has(requestId);
}
/** Tests only. */
export function resetNativeChatStore(): void {
  slots.clear();
  dismissed.clear();
}

/** Apply a mutation outcome (or a receipt seen in a later read) to the slot
 *  that issued it — never to whatever seat is selected now. */
export function settlePending(key: string, requestId: string, outcome: NativeChatPostOutcome): void {
  updateChatSlot(key, (slot) => {
    if (slot.pending?.requestId !== requestId) return slot;
    const pending = slot.pending;
    if (outcome.kind === "unknown") {
      return { ...slot, pending: { ...pending, phase: "unknown", detail: outcome.reason } };
    }
    if (outcome.kind === "rejected") {
      return { ...slot, pending: null, notice: `Not sent: ${outcome.error}` };
    }
    const r = outcome.request;
    if (r.state === "failed") return { ...slot, pending: null, notice: `Not sent: ${r.detail || "the daemon refused this message"}` };
    if (r.state === "observed") return { ...slot, draft: slot.draft === pending.text ? "" : slot.draft, pending: null, notice: null };
    if (r.state === "submitted") {
      return { ...slot, draft: slot.draft === pending.text ? "" : slot.draft, pending: { ...pending, phase: "submitted", detail: r.detail }, notice: null };
    }
    return { ...slot, pending: { ...pending, phase: r.state, detail: r.detail } };
  });
}

/** Same rules for an interrupt: only its own request id settles it, and a
 *  lost answer stays `unknown` under that id. */
export function settleInterrupt(key: string, requestId: string, outcome: NativeChatPostOutcome): void {
  updateChatSlot(key, (slot) => {
    const current = slot.interrupt;
    if (current?.requestId !== requestId) return slot;
    const next: PendingSend = outcome.kind === "unknown" ? { ...current, phase: "unknown", detail: outcome.reason }
      : outcome.kind === "rejected" ? { ...current, phase: "failed", detail: outcome.error }
      : { ...current, phase: outcome.request.state, detail: outcome.request.detail };
    return next.phase === current.phase && next.detail === current.detail ? slot : { ...slot, interrupt: next };
  });
}

/** No new interrupt while one may still be in flight or its outcome is
 *  indeterminate (until the operator acknowledges inspecting the Terminal). */
export function interruptPhaseBlocks(phase: PendingPhase | undefined): boolean {
  return phase === "posting" || phase === "sending" || phase === "unknown" || phase === "indeterminate";
}
export function interruptUnresolved(slot: ChatSlot): boolean {
  return interruptPhaseBlocks(slot.interrupt?.phase);
}
