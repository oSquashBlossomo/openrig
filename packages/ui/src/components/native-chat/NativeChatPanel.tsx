// Chat / Terminal for ONE exact selected seat: a readable view of the seat's
// own native conversation and a composer that submits plain text once through
// the daemon's guarded transport to the same tmux harness. The Terminal stays
// one click away and is the only path for native approvals, questions,
// pickers and slash commands — chat never draws approval cards from screen
// text. See docs/reference/native-chat.md; client rules in
// lib/native-chat.ts.
//
// Identity: the panel is keyed by host/rig/node, reads only that node, and
// keys drafts by the native conversation the daemon reports. A latest read
// that failed, a session other than the selected seat's, a remote source or
// a host-supplied refusal (terminal admission) disables send. Nothing is sent
// on mount, switch, reconnect or refresh; an uncertain send keeps its draft
// and request id, and is only ever retried with that same id.

import { useEffect, useLayoutEffect, useReducer, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, CornerDownLeft, Square, SquareTerminal } from "lucide-react";
import { DisplayTime } from "../time/DisplayTime.js";
import { cn } from "../../lib/utils.js";
import {
  NATIVE_CHAT_VIEW_LIMIT,
  chatSlotKey,
  composeRefusal,
  dismissReceipt,
  interruptPhaseBlocks,
  interruptUnresolved,
  isReceiptDismissed,
  mergeMessages,
  postNativeChatInterrupt,
  postNativeChatMessage,
  readChatSlot,
  readNativeChat,
  settleInterrupt,
  settlePending,
  updateChatSlot,
  useChatSlot,
  type NativeChatMessage,
  type NativeChatResponse,
  type PendingPhase,
} from "../../lib/native-chat.js";

export interface SeatChatTarget {
  hostId: string;
  rigId: string;
  /** The served graph node id; null when the source did not report one. */
  nodeId: string | null;
  isRemote: boolean;
  /** The seat's canonical session as the host verified it, when known. */
  expectedSession: string | null;
  displayName: string;
  /** A host-side reason this seat cannot be written to now (e.g. terminal
   *  admission refused or still verifying). Reading continues. */
  blockedReason?: string | null;
}

/** side/stacked: 3D workspace, graph dock and phone (host-sized frames);
 *  page: the seat page. */
export type SeatChatLayout = "side" | "stacked" | "page";
type SeatView = "chat" | "terminal";

// The last view chosen this page load; every seat opens in it.
let preferredView: SeatView = "chat";
/** Tests that exercise the terminal directly start there. */
export function setPreferredSeatView(view: SeatView): void {
  preferredView = view;
}

export function SeatChatTerminal({ target, layout, terminal }: { target: SeatChatTarget; layout: SeatChatLayout; terminal: ReactNode }) {
  const [view, setViewState] = useState<SeatView>(preferredView);
  const setView = (next: SeatView) => { preferredView = next; setViewState(next); };
  return (
    <div data-testid="seat-chat-terminal" data-view={view}>
      <div role="group" aria-label="Seat view" className={cn("mt-2 flex", layout !== "page" && "mx-4")}>
        {(["chat", "terminal"] as const).map((v) => (
          <button
            key={v}
            type="button"
            data-testid={`seat-view-${v}`}
            aria-pressed={view === v}
            onClick={() => setView(v)}
            className="min-h-9 flex-1 border border-outline-variant px-3 font-mono text-[10px] uppercase tracking-[0.12em] text-on-surface-variant hover:text-on-surface aria-pressed:border-on-surface aria-pressed:bg-on-surface aria-pressed:text-background focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-on-surface [&+&]:border-l-0"
          >
            {v === "chat" ? "Chat" : "Terminal"}
          </button>
        ))}
      </div>
      {view === "chat" ? (
        <NativeChatPanel
          key={`${target.hostId}|${target.rigId}|${target.nodeId ?? ""}`}
          target={target}
          layout={layout}
          onOpenTerminal={() => setView("terminal")}
        />
      ) : terminal}
    </div>
  );
}

function Frame({ layout, children }: { layout: SeatChatLayout; children: ReactNode }) {
  return (
    <section
      data-testid="native-chat"
      aria-label="Agent chat"
      className={cn("spatial-terminal-surface mt-2 flex flex-col border border-outline-variant bg-background text-on-surface", layout !== "page" && "mx-4")}
    >
      {children}
    </section>
  );
}

function TerminalButton({ onClick, label = "Open Terminal" }: { onClick: () => void; label?: string }) {
  return (
    <button type="button" data-testid="native-chat-open-terminal" onClick={onClick}
      className="inline-flex min-h-9 shrink-0 items-center gap-1.5 border border-outline-variant px-3 font-mono text-[10px] uppercase tracking-[0.08em] text-on-surface hover:bg-surface-low focus-visible:outline focus-visible:outline-2 focus-visible:outline-on-surface">
      <SquareTerminal aria-hidden="true" className="h-3.5 w-3.5" /> {label}
    </button>
  );
}

export function NativeChatPanel({ target, layout, onOpenTerminal }: { target: SeatChatTarget; layout: SeatChatLayout; onOpenTerminal: () => void }) {
  const refusal = target.isRemote
    ? `${target.hostId} is a remote source: native chat is only read and written on this host's own seats.`
    : !target.nodeId ? "This seat's node id was not reported, so its native conversation cannot be addressed." : null;
  if (refusal) {
    return (
      <Frame layout={layout}>
        <div data-testid="native-chat-state" data-state="refused" role="status" className="space-y-2 px-3 py-4 font-mono text-[11px] text-on-surface-variant">
          <p>Chat unavailable.</p>
          <p className="text-on-surface">{refusal}</p>
        </div>
      </Frame>
    );
  }
  return <ChatBody target={target} nodeId={target.nodeId!} layout={layout} onOpenTerminal={onOpenTerminal} />;
}

const HISTORY_HEIGHT: Record<SeatChatLayout, string> = {
  // The spatial classes take each host's terminal sizing (dock, phone, 3D).
  side: "spatial-terminal-frame--side min-h-[16rem]",
  stacked: "spatial-terminal-frame--stacked",
  page: "h-[min(500px,70svh)]",
};

/** `trimmed`: the oldest messages left this view at the limit, so the older
 *  cursor no longer meets it and earlier pages stop here. `jumped`: a latest
 *  page shared no message with the view (more arrived than one page while
 *  reads were paused), so the view restarted at that page and its cursor. */
interface Timeline { conv: string | null; messages: NativeChatMessage[]; olderCursor: string | null; trimmed: boolean; jumped: boolean }

function ChatBody({ target, nodeId, layout, onOpenTerminal }: { target: SeatChatTarget; nodeId: string; layout: SeatChatLayout; onOpenTerminal: () => void }) {
  const { hostId, rigId } = target;
  const queryClient = useQueryClient();
  const queryKey = ["native-chat", hostId, rigId, nodeId] as const;
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => readNativeChat(nodeId, { signal }),
    // Persisted native records, re-read while visible (no provider call).
    refetchInterval: 2_000,
    staleTime: 0,
    retry: false,
  });
  const refused = query.data && "refused" in query.data ? query.data : null;
  const data: NativeChatResponse | null = query.data && !("refused" in query.data) ? query.data : null;
  const conv = data?.identity.conversationId ?? null;
  const slotKey = conv ? chatSlotKey(hostId, rigId, nodeId, conv) : null;
  const slot = useChatSlot(slotKey);
  const [, rerender] = useReducer((n: number) => n + 1, 0);

  // Accumulated timeline for the current conversation only.
  const [timeline, setTimeline] = useState<Timeline>({ conv: null, messages: [], olderCursor: null, trimmed: false, jumped: false });
  useEffect(() => {
    if (!data) return;
    setTimeline((t) => {
      // A new conversation, or an empty view (e.g. its first record just
      // arrived): adopt the page and its cursor; there is no gap to report.
      if (t.conv !== data.identity.conversationId || t.messages.length === 0) {
        return { conv: data.identity.conversationId, messages: data.messages, olderCursor: data.history.olderCursor, trimmed: false, jumped: false };
      }
      const known = new Set(t.messages.map((m) => m.id));
      if (known.size > 0 && data.messages.length > 0 && !data.messages.some((m) => known.has(m.id))) {
        // Not continuous with the view: never stitch the two together.
        followRef.current = true;
        return { ...t, messages: data.messages, olderCursor: data.history.olderCursor, trimmed: false, jumped: true };
      }
      const merged = mergeMessages(t.messages, data.messages, "newer");
      return merged.length > NATIVE_CHAT_VIEW_LIMIT
        ? { ...t, messages: merged.slice(-NATIVE_CHAT_VIEW_LIMIT), olderCursor: null, trimmed: true }
        : { ...t, messages: merged };
    });
  }, [data]);
  const current = timeline.conv === conv;
  const messages = current ? timeline.messages : data?.messages ?? [];
  const trimmed = current && timeline.trimmed;
  const jumped = current && timeline.jumped;
  const atLimit = messages.length >= NATIVE_CHAT_VIEW_LIMIT;
  const olderCursor = atLimit ? null : current ? timeline.olderCursor : data?.history.olderCursor ?? null;

  // A receipt seen in a read settles this conversation's own pending send.
  useEffect(() => {
    if (!data || !slotKey) return;
    const { pending, interrupt } = readChatSlot(slotKey);
    const receipt = pending && data.requests.find((r) => r.requestId === pending.requestId && r.kind === "message");
    if (receipt && receipt.state !== pending.phase) settlePending(slotKey, pending.requestId, { kind: "receipt", request: receipt });
    const stop = interrupt && data.requests.find((r) => r.requestId === interrupt.requestId && r.kind === "interrupt");
    if (stop && stop.state !== interrupt.phase) settleInterrupt(slotKey, interrupt.requestId, { kind: "receipt", request: stop });
  }, [data, slotKey]);

  // The conversation was replaced under an open panel (/clear, restart):
  // the old draft stays with the old conversation, never sent here.
  const prevKeyRef = useRef<string | null>(null);
  const [carried, setCarried] = useState<string | null>(null);
  useEffect(() => {
    const prev = prevKeyRef.current;
    prevKeyRef.current = slotKey;
    if (prev && slotKey && prev !== slotKey && readChatSlot(prev).draft) setCarried(prev);
  }, [slotKey]);

  // Earlier pages: explicit, bound to the conversation they were asked for.
  const [older, setOlder] = useState<{ loading: boolean; error: string | null }>({ loading: false, error: null });
  const olderAbortRef = useRef<AbortController | null>(null);
  useEffect(() => () => olderAbortRef.current?.abort(), [conv]);
  const anchorRef = useRef<number | null>(null);
  const loadOlder = async () => {
    if (!conv || !olderCursor) return;
    const forConv = conv;
    olderAbortRef.current?.abort();
    const controller = new AbortController();
    olderAbortRef.current = controller;
    setOlder({ loading: true, error: null });
    try {
      const page = await readNativeChat(nodeId, { before: olderCursor, signal: controller.signal });
      if (controller.signal.aborted) return;
      if ("refused" in page || page.identity.conversationId !== forConv) {
        setOlder({ loading: false, error: "The conversation changed; earlier messages were not added." });
        return;
      }
      anchorRef.current = scrollRef.current?.scrollHeight ?? null;
      setTimeline((t) => {
        if (t.conv !== forConv) return t;
        const merged = mergeMessages(t.messages, page.messages, "older");
        // Never drop what was just loaded: past the limit, keep the view.
        return merged.length > NATIVE_CHAT_VIEW_LIMIT ? { ...t, olderCursor: null } : { ...t, messages: merged, olderCursor: page.history.olderCursor, jumped: false };
      });
      setOlder({ loading: false, error: null });
    } catch (err) {
      if (!controller.signal.aborted) setOlder({ loading: false, error: `Earlier messages could not be read (${err instanceof Error ? err.message : "read failed"}).` });
    }
  };

  // Rows for sends not yet seen as a native record: the daemon's receipts
  // (they survive reload) plus this tab's own send before its receipt exists.
  const pendingRows: Array<{ requestId: string; text: string; phase: PendingPhase; detail: string }> = [];
  for (const r of data?.requests ?? []) {
    if (r.kind !== "message" || isReceiptDismissed(r.requestId)) continue;
    if (r.state === "sending" || r.state === "submitted" || r.state === "indeterminate") {
      pendingRows.push({ requestId: r.requestId, text: r.text, phase: slot.pending?.requestId === r.requestId && slot.pending.phase === "unknown" ? "unknown" : r.state, detail: r.detail });
    }
  }
  if (slot.pending && slot.pending.phase !== "observed" && !pendingRows.some((p) => p.requestId === slot.pending!.requestId)) {
    pendingRows.push(slot.pending);
  }

  // Follow the newest only when already at the end or after an own send.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const followRef = useRef(true);
  const [atEnd, setAtEnd] = useState(true);
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const end = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
    followRef.current = end;
    setAtEnd(end);
  };
  const toLatest = () => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    followRef.current = true;
    setAtEnd(true);
  };
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (anchorRef.current !== null) {
      el.scrollTop += el.scrollHeight - anchorRef.current;
      anchorRef.current = null;
    } else if (followRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, pendingRows.length]);
  // Reflow without a scroll event (width change, rotation, a tool card or
  // receipt opening): keep following at the new bottom, or keep the reader's
  // place and report accurately whether they are at the end.
  const historyMounted = !!data && !refused;
  useEffect(() => {
    const el = scrollRef.current;
    if (!historyMounted || !el || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(() => {
      if (followRef.current) {
        el.scrollTop = el.scrollHeight;
        return;
      }
      const end = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
      followRef.current = end;
      setAtEnd(end);
    });
    observer.observe(el);
    const list = el.querySelector("ol");
    if (list) observer.observe(list);
    return () => observer.disconnect();
  }, [historyMounted]);

  // Why Send is off (first reason wins). Reading never stops for these.
  const inFlight = slot.pending && slot.pending.phase !== "submitted" ? slot.pending : null;
  const draftRefusal = composeRefusal(slot.draft);
  const blocked: string | null =
    target.blockedReason
    ?? (query.status === "error" ? "The latest chat read failed, so the seat's current state is unknown. Sending resumes after a successful read." : null)
    ?? (!data ? null : target.expectedSession && data.identity.sessionName !== target.expectedSession
      ? `The chat endpoint reports session ${data.identity.sessionName}, not this seat's ${target.expectedSession}. Select the seat again.`
      : null)
    ?? (data && !data.availability.canSend ? data.availability.detail || "The agent cannot take a chat message right now." : null)
    ?? (inFlight || pendingRows.some((p) => p.phase !== "submitted" && p.phase !== "indeterminate") ? "Waiting for the previous message's outcome." : null)
    ?? (pendingRows.some((p) => p.phase === "indeterminate") ? "A previous message's outcome is unknown. Check the history or Terminal, then dismiss it before sending again." : null)
    ?? draftRefusal;
  const canSend = !!data && !!slotKey && !blocked && slot.draft.trim().length > 0;

  const send = async () => {
    if (!canSend || !data || !slotKey) return;
    const key = slotKey;
    // The store is synchronous: a second click before re-render sees this.
    const prior = readChatSlot(key).pending;
    if (prior && prior.phase !== "submitted") return;
    const text = slot.draft.replace(/\r\n?/g, "\n");
    const ownerKey = data.identity.ownerKey;
    const requestId = crypto.randomUUID();
    updateChatSlot(key, (s) => ({ ...s, draft: text, notice: null, pending: { requestId, text, ownerKey, phase: "posting", detail: "" } }));
    followRef.current = true;
    const outcome = await postNativeChatMessage(nodeId, { requestId, ownerKey, text });
    settlePending(key, requestId, outcome);
    void queryClient.invalidateQueries({ queryKey });
  };
  /** Same request id, so the daemon reads its receipt instead of resending. */
  const retrySame = async () => {
    const pending = slot.pending;
    if (!slotKey || !pending || pending.phase !== "unknown") return;
    const key = slotKey;
    updateChatSlot(key, (s) => (s.pending?.requestId === pending.requestId ? { ...s, pending: { ...pending, phase: "posting", detail: "" } } : s));
    const outcome = await postNativeChatMessage(nodeId, { requestId: pending.requestId, ownerKey: pending.ownerKey, text: pending.text });
    settlePending(key, pending.requestId, outcome);
    void queryClient.invalidateQueries({ queryKey });
  };
  const dismiss = (requestId: string) => {
    dismissReceipt(requestId);
    if (slotKey) updateChatSlot(slotKey, (s) => (s.pending?.requestId === requestId ? { ...s, pending: null } : s));
    rerender();
  };

  // Interrupt: one request at a time, kept under its own id like a send. This
  // tab's own request (with its owner key) can be checked again by id; a
  // newer or reloaded unresolved receipt from the daemon is shown read-only
  // (receipts carry no owner key, so it is never re-posted) and blocks a new
  // interrupt until it resolves or the operator acknowledges the Terminal.
  const newestStop = (data?.requests ?? []).filter((r) => r.kind === "interrupt")
    .reduce<NativeChatResponse["requests"][number] | null>((a, r) => (!a || r.createdAt > a.createdAt ? r : a), null);
  const own = slot.interrupt;
  const ownCurrent = own && (!newestStop || newestStop.requestId === own.requestId || own.phase === "posting" || own.phase === "unknown");
  const interrupt: { requestId: string; phase: PendingPhase; detail: string; own: boolean } | null = ownCurrent
    ? { ...own, own: true }
    : newestStop && interruptPhaseBlocks(newestStop.state) && !isReceiptDismissed(newestStop.requestId)
      ? { requestId: newestStop.requestId, phase: newestStop.state, detail: newestStop.detail, own: false }
      : null;
  const interruptBlocked = interruptPhaseBlocks(interrupt?.phase);
  const acknowledgeInterrupt = (requestId: string) => {
    dismissReceipt(requestId);
    if (slotKey) updateChatSlot(slotKey, (s) => (s.interrupt?.requestId === requestId ? { ...s, interrupt: null } : s));
    rerender();
  };
  const sendInterrupt = async () => {
    if (!data || !slotKey || interruptBlocked || interruptUnresolved(readChatSlot(slotKey))) return;
    const key = slotKey;
    const request = { requestId: crypto.randomUUID(), ownerKey: data.identity.ownerKey };
    updateChatSlot(key, (s) => ({ ...s, interrupt: { ...request, text: "", phase: "posting", detail: "" } }));
    settleInterrupt(key, request.requestId, await postNativeChatInterrupt(nodeId, request));
    void queryClient.invalidateQueries({ queryKey });
  };
  const retryInterrupt = async () => {
    if (!slotKey || !own || !ownCurrent || own.phase !== "unknown") return;
    const key = slotKey;
    const { requestId, ownerKey } = own;
    updateChatSlot(key, (s) => (s.interrupt?.requestId === requestId ? { ...s, interrupt: { ...own, phase: "posting", detail: "" } } : s));
    settleInterrupt(key, requestId, await postNativeChatInterrupt(nodeId, { requestId, ownerKey }));
    void queryClient.invalidateQueries({ queryKey });
  };
  const interruptText = !interrupt ? null : {
    posting: "Sending interrupt…",
    sending: "Sending interrupt…",
    submitted: "Interrupt sent (Escape). The agent may still finish its current step.",
    observed: "Interrupt sent (Escape). The agent may still finish its current step.",
    failed: `Interrupt not sent: ${interrupt.detail || "refused"}.`,
    indeterminate: `Interrupt outcome unknown${interrupt.detail ? ` (${interrupt.detail})` : ""}. Check the Terminal before interrupting again.`,
    unknown: `Interrupt outcome unknown (${interrupt.detail}). Checking again reuses the same request, so Escape is never sent twice.`,
  }[interrupt.phase];

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Desktop: Enter sends, Shift+Enter is a newline. Touch keyboards keep
    // Enter as a newline and send with the button.
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
    if (typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches) return;
    e.preventDefault();
    void send();
  };

  if (refused || (!data && query.status === "error") || (!data && query.status === "pending")) {
    return (
      <Frame layout={layout}>
        <div data-testid="native-chat-state" data-state={refused ? "refused" : query.status === "error" ? "error" : "loading"} role={refused || query.status === "error" ? "alert" : "status"}
          className="space-y-2 px-3 py-4 font-mono text-[11px] text-on-surface-variant">
          {refused ? (
            <>
              <p>Chat unavailable for this seat.</p>
              <p className="text-on-surface">{refused.error}</p>
            </>
          ) : query.status === "error" ? (
            <>
              <p>The native conversation could not be read.</p>
              <p className="text-on-surface">{query.error instanceof Error ? query.error.message : "Read failed."}</p>
              <button type="button" onClick={() => void query.refetch()} className="min-h-9 border border-outline-variant px-3 uppercase tracking-[0.08em] text-on-surface hover:bg-surface-low">Retry</button>
            </>
          ) : <p>Reading this seat&apos;s native conversation…</p>}
          {refused || query.status === "error" ? <TerminalButton onClick={onOpenTerminal} /> : null}
        </div>
      </Frame>
    );
  }
  const d = data!;
  const needsTerminal = d.availability.state === "needs_terminal" || d.availability.state === "unavailable";
  const textareaId = `native-chat-input-${nodeId}`;
  const reasonId = `${textareaId}-reason`;
  const readOnlyDraft = !!inFlight;

  return (
    <Frame layout={layout}>
      <div className="flex min-h-9 items-center gap-2 border-b border-outline-variant px-3 py-1 font-mono text-[9px] uppercase tracking-[0.14em] text-on-surface-variant">
        <span className="min-w-0 flex-1 truncate">Chat · {target.displayName}</span>
        <span data-testid="native-chat-availability" data-state={d.availability.state} className="shrink-0">
          {d.availability.state === "ready" ? "Ready" : d.availability.state === "busy" ? "Working" : d.availability.state === "needs_terminal" ? "Needs Terminal" : "Unavailable"}
        </span>
        {d.availability.canInterrupt ? (
          <button type="button" data-testid="native-chat-interrupt" disabled={interruptBlocked} onClick={() => void sendInterrupt()}
            className="inline-flex min-h-8 items-center gap-1 border border-outline-variant px-2 text-on-surface hover:bg-surface-low disabled:opacity-50">
            <Square aria-hidden="true" className="h-3 w-3" /> Interrupt
          </button>
        ) : null}
      </div>
      {needsTerminal ? (
        <div data-testid="native-chat-needs-terminal" role="alert" className="flex flex-wrap items-center gap-2 border-b border-outline-variant bg-surface-low px-3 py-2 font-mono text-[11px]">
          <p className="min-w-0 flex-1">
            {d.availability.detail || "The agent is waiting on a native prompt."} Approvals, questions and pickers are answered in the Terminal.
          </p>
          <TerminalButton onClick={onOpenTerminal} label="Answer in Terminal" />
        </div>
      ) : null}
      {interruptText ? (
        <div data-testid="native-chat-interrupt-status" data-phase={interrupt!.phase} role="status" className="flex flex-wrap items-center gap-2 border-b border-outline-variant px-3 py-1 font-mono text-[10px] text-on-surface-variant">
          <span className="min-w-0 flex-1">{interruptText}</span>
          {interrupt!.own && interrupt!.phase === "unknown" ? (
            <button type="button" data-testid="native-chat-interrupt-retry" onClick={() => void retryInterrupt()} className="min-h-8 border border-outline-variant px-2 uppercase tracking-[0.08em] text-on-surface hover:bg-surface-low">Check / retry</button>
          ) : null}
          {interrupt!.phase === "indeterminate" ? (
            <button type="button" data-testid="native-chat-interrupt-ack" onClick={() => acknowledgeInterrupt(interrupt!.requestId)} className="min-h-8 border border-outline-variant px-2 uppercase tracking-[0.08em] text-on-surface hover:bg-surface-low">I checked the Terminal</button>
          ) : null}
          {interruptBlocked && !interrupt!.own ? <TerminalButton onClick={onOpenTerminal} /> : null}
        </div>
      ) : null}

      <div className="relative">
        <div
          ref={scrollRef}
          onScroll={onScroll}
          data-testid="native-chat-history"
          role="log"
          aria-label={`Conversation with ${target.displayName}`}
          aria-live="polite"
          aria-relevant="additions"
          className={cn("native-chat-history overflow-y-auto overscroll-contain px-3 py-2", HISTORY_HEIGHT[layout])}
        >
          {d.history.state !== "available" ? (
            <p data-testid="native-chat-history-note" className="mb-2 font-mono text-[10px] text-on-surface-variant">
              {d.history.state === "partial" ? "Partial history" : "History unavailable"}{d.history.detail ? `: ${d.history.detail}` : "."}
            </p>
          ) : null}
          {olderCursor ? (
            <div className="mb-2 flex justify-center">
              <button type="button" data-testid="native-chat-older" disabled={older.loading} onClick={() => void loadOlder()}
                className="min-h-8 border border-outline-variant px-3 font-mono text-[10px] uppercase tracking-[0.08em] text-on-surface hover:bg-surface-low disabled:opacity-50">
                {older.loading ? "Loading…" : "Load earlier messages"}
              </button>
            </div>
          ) : null}
          {jumped ? (
            <p data-testid="native-chat-jumped" role="status" className="mb-2 font-mono text-[10px] text-on-surface-variant">
              More messages arrived than one refresh returns, so this view moved to the latest messages.{" "}
              {olderCursor ? "Load earlier messages to see what came before them." : "Earlier messages are in the native record and Terminal."}
            </p>
          ) : null}
          {trimmed || atLimit ? (
            <p data-testid="native-chat-limit" className="mb-2 font-mono text-[10px] text-on-surface-variant">
              This view keeps the latest {NATIVE_CHAT_VIEW_LIMIT} messages{trimmed ? "; earlier ones were removed from it" : ""}. The full conversation stays in the native record and Terminal.
            </p>
          ) : null}
          {older.error ? <p role="alert" className="mb-2 font-mono text-[10px] text-tertiary">{older.error}</p> : null}
          {messages.length === 0 && pendingRows.length === 0 ? (
            <p className="py-6 text-center font-mono text-[11px] text-on-surface-variant">No messages in this conversation yet.</p>
          ) : null}
          <ol className="space-y-2">
            {messages.map((m) => <MessageRow key={m.id} message={m} agentName={target.displayName} />)}
            {pendingRows.map((p) => p.phase === "submitted" ? (
              // A submitted receipt is not another message: the native record
              // may already be in the timeline above, and only the daemon may
              // mark it observed. Collapsed; its text and detail on demand.
              <li key={p.requestId} data-testid="native-chat-pending" data-phase="submitted" className="ml-auto max-w-[92%]">
                <details data-testid="native-chat-receipt" className="border border-dashed border-outline-variant">
                  <summary className="cursor-pointer px-2 py-1 font-mono text-[9px] uppercase tracking-[0.12em] text-on-surface-variant">Delivery receipt · submitted</summary>
                  <div className="space-y-1.5 border-t border-dashed border-outline-variant px-3 py-2">
                    <MessageText text={p.text} />
                    <p data-testid="native-chat-receipt-detail" className="font-mono text-[10px] text-on-surface-variant">{p.detail || "The daemon gave no further detail."}</p>
                  </div>
                </details>
              </li>
            ) : (
              <li key={p.requestId} data-testid="native-chat-pending" data-phase={p.phase} className="ml-auto max-w-[92%] border border-dashed border-outline-variant px-3 py-2">
                <div className="mb-1 font-mono text-[9px] uppercase tracking-[0.12em] text-on-surface-variant">You · {phaseLabel(p.phase)}</div>
                <MessageText text={p.text} />
                {p.phase === "unknown" || p.phase === "indeterminate" ? (
                  <div className="mt-2 space-y-2 font-mono text-[10px] text-on-surface-variant">
                    <p>{p.phase === "unknown"
                      ? `The daemon's answer was lost (${p.detail}); it may have received this message. Retrying reuses the same request id, so it is never sent twice.`
                      : `Some effect may have happened${p.detail ? ` (${p.detail})` : ""}. Check the history or Terminal before sending it again.`}</p>
                    <div className="flex flex-wrap gap-2">
                      {p.phase === "unknown" && slot.pending?.requestId === p.requestId ? (
                        <button type="button" data-testid="native-chat-retry-same" onClick={() => void retrySame()} className="min-h-8 border border-outline-variant px-2 uppercase tracking-[0.08em] text-on-surface hover:bg-surface-low">Check / retry</button>
                      ) : null}
                      {p.phase === "indeterminate" ? (
                        <button type="button" data-testid="native-chat-dismiss" onClick={() => dismiss(p.requestId)} className="min-h-8 border border-outline-variant px-2 uppercase tracking-[0.08em] text-on-surface hover:bg-surface-low">Dismiss, keep draft</button>
                      ) : null}
                      <TerminalButton onClick={onOpenTerminal} />
                    </div>
                  </div>
                ) : null}
              </li>
            ))}
          </ol>
        </div>
        {!atEnd ? (
          <button type="button" data-testid="native-chat-latest" onClick={toLatest}
            className="absolute bottom-2 right-3 inline-flex min-h-8 items-center gap-1 border border-outline-variant bg-background px-2 font-mono text-[10px] uppercase tracking-[0.08em] text-on-surface shadow">
            <ArrowDown aria-hidden="true" className="h-3 w-3" /> Latest
          </button>
        ) : null}
      </div>

      <form
        className="border-t border-outline-variant p-2"
        onSubmit={(e) => { e.preventDefault(); void send(); }}
      >
        {carried ? (
          <div data-testid="native-chat-carried" role="status" className="mb-2 flex flex-wrap items-center gap-2 font-mono text-[10px] text-on-surface-variant">
            <span className="min-w-0 flex-1">The native conversation changed. Your unsent draft stayed with the previous conversation and was not sent.</span>
            {slot.draft ? <span>Empty this composer to bring it here.</span> : null}
            <button type="button" disabled={!!slot.draft || readOnlyDraft} onClick={() => {
              if (!slotKey || readChatSlot(slotKey).draft || readChatSlot(slotKey).pending) return;
              const old = readChatSlot(carried).draft;
              updateChatSlot(slotKey, (s) => ({ ...s, draft: old }));
              updateChatSlot(carried, (s) => ({ ...s, draft: "" }));
              setCarried(null);
            }} className="min-h-8 border border-outline-variant px-2 uppercase tracking-[0.08em] text-on-surface hover:bg-surface-low disabled:opacity-50">Use it here</button>
          </div>
        ) : null}
        {slot.notice ? <p data-testid="native-chat-notice" role="alert" className="mb-2 font-mono text-[10px] text-tertiary">{slot.notice} Your draft is kept.</p> : null}
        <label htmlFor={textareaId} className="sr-only">Message to {target.displayName}</label>
        <div className="flex items-end gap-2">
          <textarea
            id={textareaId}
            data-testid="native-chat-input"
            value={slot.draft}
            readOnly={readOnlyDraft}
            disabled={!slotKey}
            rows={2}
            enterKeyHint="send"
            aria-describedby={blocked ? reasonId : undefined}
            placeholder={`Message ${target.displayName}`}
            onChange={(e) => { if (slotKey) { const v = e.target.value; updateChatSlot(slotKey, (s) => ({ ...s, draft: v, notice: null })); } }}
            onKeyDown={onKeyDown}
            // 16px on touch keeps iOS Safari from zooming the page on focus.
            className="max-h-[40svh] min-h-[2.75rem] min-w-0 flex-1 resize-none border border-outline-variant bg-background px-2 py-1.5 font-mono text-base leading-snug text-on-surface [field-sizing:content] focus-visible:outline focus-visible:outline-2 focus-visible:outline-on-surface read-only:opacity-70 [@media(pointer:fine)]:text-[13px]"
          />
          <button type="submit" data-testid="native-chat-send" disabled={!canSend} aria-label="Send message"
            className="inline-flex h-11 shrink-0 items-center gap-1.5 border border-on-surface bg-on-surface px-3 font-mono text-[10px] uppercase tracking-[0.08em] text-background disabled:border-outline-variant disabled:bg-transparent disabled:text-on-surface-variant focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-on-surface">
            <CornerDownLeft aria-hidden="true" className="h-3.5 w-3.5" /> Send
          </button>
        </div>
        {blocked ? (
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <p id={reasonId} data-testid="native-chat-blocked" className="min-w-0 flex-1 font-mono text-[10px] text-on-surface-variant">{blocked}</p>
            {draftRefusal === blocked || needsTerminal ? <TerminalButton onClick={onOpenTerminal} /> : null}
          </div>
        ) : null}
      </form>
    </Frame>
  );
}

function phaseLabel(phase: PendingPhase): string {
  switch (phase) {
    case "posting": return "sending…";
    case "sending": return "sending to the terminal…";
    case "submitted": return "submitted";
    case "unknown": return "outcome unknown";
    case "indeterminate": return "unconfirmed";
    case "failed": return "not sent";
    case "observed": return "confirmed";
  }
}

function MessageRow({ message, agentName }: { message: NativeChatMessage; agentName: string }) {
  const meta = (
    <span className="normal-case tracking-normal">
      {message.timestamp ? <> · <DisplayTime iso={message.timestamp} /></> : null}
      {message.truncated ? " · truncated" : null}
    </span>
  );
  if (message.role === "tool") {
    return (
      <li data-testid="native-chat-message" data-role="tool">
        <details className="border border-outline-variant">
          <summary className="cursor-pointer px-2 py-1 font-mono text-[10px] text-on-surface-variant">
            {message.tool?.kind === "result" ? "Tool result" : "Tool call"}{message.tool?.name ? ` · ${message.tool.name}` : ""}{meta}
          </summary>
          {/* Tool output is untrusted literal text. */}
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words border-t border-outline-variant px-2 py-1 font-mono text-[11px]">{message.text}</pre>
        </details>
      </li>
    );
  }
  const user = message.role === "user";
  return (
    <li data-testid="native-chat-message" data-role={message.role}
      className={cn("max-w-[92%] px-3 py-2", user ? "ml-auto border border-outline-variant bg-surface-low" : "border-l-2 border-primary")}>
      <div className="mb-1 font-mono text-[9px] uppercase tracking-[0.12em] text-on-surface-variant">{user ? "User" : agentName}{meta}</div>
      <MessageText text={message.text} />
    </li>
  );
}

/** Plain text with ``` fences as code blocks; no markup is interpreted. */
export function splitFences(text: string): Array<{ code: boolean; text: string }> {
  const out: Array<{ code: boolean; text: string }> = [];
  let code = false;
  let buf: string[] = [];
  const flush = () => {
    if (buf.length) out.push({ code, text: buf.join("\n") });
    buf = [];
  };
  for (const line of text.split("\n")) {
    if (line.trimStart().startsWith("```")) { flush(); code = !code; continue; }
    buf.push(line);
  }
  flush();
  return out;
}

function MessageText({ text }: { text: string }) {
  return (
    <div className="space-y-1.5 text-[13px] leading-relaxed">
      {splitFences(text).map((part, i) => part.code ? (
        <pre key={i} className="overflow-x-auto border border-outline-variant bg-surface-lowest px-2 py-1.5 font-mono text-[11.5px]"><code>{part.text}</code></pre>
      ) : (
        <p key={i} className="whitespace-pre-wrap break-words">{part.text}</p>
      ))}
    </div>
  );
}
