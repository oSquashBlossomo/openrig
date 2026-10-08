// Native agent chat panel: client rules against a mocked daemon (fetch is
// stubbed; the panel, query cache and in-memory draft store are real). These
// prove UI identity, draft and receipt handling only — not tmux, the daemon's
// guarded transport, Claude/Codex records or Safari keyboard behaviour.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SeatChatTerminal, setPreferredSeatView, splitFences, type SeatChatTarget } from "../src/components/native-chat/NativeChatPanel.js";
import { NATIVE_CHAT_VIEW_LIMIT, composeRefusal, mergeMessages, readNativeChat, resetNativeChatStore, type NativeChatMessage, type NativeChatRequest, type NativeChatResponse } from "../src/lib/native-chat.js";

type Page = NativeChatResponse | { status: number; body: unknown };
const pages = new Map<string, Page>();
type Reply = { status: number; body: unknown };
/** A reply, a lost answer, a held reply, or one built from the posted body. */
type PostReply = Reply | "network-error" | Promise<Reply> | ((body: Record<string, unknown>) => Reply);
let postReplies: PostReply[] = [];
const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
const gets: string[] = [];

function page(nodeId: string, over: Partial<NativeChatResponse> & { conversationId?: string; sessionName?: string } = {}): NativeChatResponse {
  return {
    identity: {
      nodeId, sessionId: `s-${nodeId}`, sessionName: over.sessionName ?? `sess-${nodeId}`, runtime: "claude-code",
      conversationId: over.conversationId ?? `conv-${nodeId}`, ownerKey: `owner-${nodeId}`,
    },
    availability: over.availability ?? { state: "ready", detail: "", canSend: true, canInterrupt: false },
    history: over.history ?? { state: "available", detail: "", olderCursor: null },
    messages: over.messages ?? [],
    requests: over.requests ?? [],
  };
}
const msg = (id: string, role: NativeChatMessage["role"], text: string): NativeChatMessage => ({ id, role, text, timestamp: null, truncated: false });
const receipt = (requestId: string, text: string, state: NativeChatRequest["state"], detail = ""): NativeChatRequest =>
  ({ requestId, kind: "message", text, state, detail, createdAt: "2026-10-08T00:00:00Z", updatedAt: "2026-10-08T00:00:00Z" });

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  resetNativeChatStore();
  setPreferredSeatView("chat");
  pages.clear();
  postReplies = [];
  posts.length = 0;
  gets.length = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      posts.push({ url, body: JSON.parse(String(init.body)) });
      const body = posts[posts.length - 1]!.body;
      const reply = postReplies.shift() ?? { status: 500, body: {} };
      if (reply === "network-error") throw new TypeError("Failed to fetch");
      const r = typeof reply === "function" ? reply(body) : await reply;
      return json(r.status, r.body);
    }
    gets.push(url);
    const nodeId = decodeURIComponent(url.split("/api/native-chat/")[1]!.split("?")[0]!);
    const p = pages.get(nodeId);
    if (!p) return json(404, { error: "not found" });
    return "status" in p ? json(p.status, p.body) : json(200, p);
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function target(nodeId: string, over: Partial<SeatChatTarget> = {}): SeatChatTarget {
  return { hostId: "local", rigId: "rig-1", nodeId, isRemote: false, expectedSession: `sess-${nodeId}`, displayName: `agent-${nodeId}`, ...over };
}

function renderChat(t: SeatChatTarget) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui = (x: SeatChatTarget) => (
    <QueryClientProvider client={client}>
      <SeatChatTerminal key={`${x.hostId}|${x.rigId}|${x.nodeId}`} layout="stacked" target={x} terminal={<div data-testid="fake-terminal">terminal for {x.nodeId}</div>} />
    </QueryClientProvider>
  );
  const r = render(ui(t));
  return { ...r, client, show: (x: SeatChatTarget) => r.rerender(ui(x)) };
}

const input = () => screen.getByTestId("native-chat-input") as HTMLTextAreaElement;
const sendButton = () => screen.getByTestId("native-chat-send") as HTMLButtonElement;
async function type(text: string) {
  await waitFor(() => expect(input().disabled).toBe(false));
  fireEvent.change(input(), { target: { value: text } });
}

describe("native chat: send and reply", () => {
  it("sends once with a fresh id and the owner key, then shows the native record without a duplicate row", async () => {
    pages.set("n1", page("n1", { messages: [msg("m1", "assistant", "Hello from the agent")] }));
    renderChat(target("n1"));
    expect(await screen.findByText("Hello from the agent")).toBeTruthy();

    let release!: (r: Reply) => void;
    postReplies.push(new Promise((res) => { release = res; }));
    await type("Please summarize\r\nthe plan");
    fireEvent.click(sendButton());

    await waitFor(() => expect(posts).toHaveLength(1));
    const sent = posts[0]!;
    expect(sent.url).toBe("/api/native-chat/n1/messages");
    expect(sent.body).toEqual({ requestId: expect.stringMatching(/^[0-9a-f-]{36}$/), ownerKey: "owner-n1", text: "Please summarize\nthe plan" });
    // While the request is out, the draft is locked and Send is off.
    expect(input().readOnly).toBe(true);
    expect(sendButton().disabled).toBe(true);
    expect(screen.getByTestId("native-chat-pending").getAttribute("data-phase")).toBe("posting");

    const id = sent.body.requestId as string;
    await act(async () => release({ status: 200, body: { request: receipt(id, "Please summarize\nthe plan", "submitted") } }));
    await waitFor(() => expect(input().value).toBe(""));
    expect(screen.getByTestId("native-chat-pending").getAttribute("data-phase")).toBe("submitted");

    // The native record and the reply arrive; the receipt is observed.
    pages.set("n1", page("n1", {
      messages: [msg("m1", "assistant", "Hello from the agent"), msg("m2", "user", "Please summarize\nthe plan"), msg("m3", "assistant", "Here is the plan.")],
      requests: [receipt(id, "Please summarize\nthe plan", "observed")],
    }));
    expect(await screen.findByText("Here is the plan.", undefined, { timeout: 4000 })).toBeTruthy();
    await waitFor(() => expect(screen.queryByTestId("native-chat-pending")).toBeNull());
    const users = screen.getAllByTestId("native-chat-message").filter((el) => el.getAttribute("data-role") === "user");
    expect(users).toHaveLength(1);
    expect(posts).toHaveLength(1);
  });

  it("renders agent text literally and fenced code as code, never as HTML", async () => {
    pages.set("n1", page("n1", { messages: [msg("m1", "assistant", "<img src=x onerror=alert(1)>\n```ts\nconst a = 1;\n```")] }));
    const { container } = renderChat(target("n1"));
    expect(await screen.findByText("<img src=x onerror=alert(1)>")).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("pre code")?.textContent).toBe("const a = 1;");
    expect(splitFences("a\n```\nb")).toEqual([{ code: false, text: "a" }, { code: true, text: "b" }]);
  });
});

describe("native chat: uncertain and failed sends", () => {
  it("keeps the draft and request id when the answer is lost, never resends on its own, and retries with the same id", async () => {
    pages.set("n1", page("n1"));
    renderChat(target("n1"));
    postReplies.push("network-error");
    await type("deploy notes");
    fireEvent.click(sendButton());

    await waitFor(() => expect(screen.getByTestId("native-chat-pending").getAttribute("data-phase")).toBe("unknown"));
    expect(input().value).toBe("deploy notes");
    expect(input().readOnly).toBe(true);
    expect(sendButton().disabled).toBe(true);
    const firstId = posts[0]!.body.requestId;

    // Several polls later: still exactly one POST.
    const polled = gets.length;
    await waitFor(() => expect(gets.length).toBeGreaterThan(polled), { timeout: 4000 });
    expect(posts).toHaveLength(1);

    postReplies.push({ status: 200, body: { request: receipt(String(firstId), "deploy notes", "submitted") } });
    fireEvent.click(screen.getByTestId("native-chat-retry-same"));
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[1]!.body).toEqual(posts[0]!.body);
    await waitFor(() => expect(input().value).toBe(""));
  });

  it("reconciles a lost answer from the receipt a later read reports", async () => {
    pages.set("n1", page("n1"));
    renderChat(target("n1"));
    postReplies.push("network-error");
    await type("status?");
    fireEvent.click(sendButton());
    await waitFor(() => expect(screen.getByTestId("native-chat-pending").getAttribute("data-phase")).toBe("unknown"));
    const id = String(posts[0]!.body.requestId);
    pages.set("n1", page("n1", { messages: [msg("u1", "user", "status?")], requests: [receipt(id, "status?", "observed")] }));
    await waitFor(() => expect(screen.queryByTestId("native-chat-pending")).toBeNull(), { timeout: 4000 });
    expect(input().value).toBe("");
    expect(posts).toHaveLength(1);
  });

  it("keeps the draft on a refusal (HTTP 409 or failed receipt) and a new send is a new request", async () => {
    pages.set("n1", page("n1"));
    renderChat(target("n1"));
    postReplies.push({ status: 409, body: { error: "the native composer is not empty", code: "composer_busy" } });
    await type("first try");
    fireEvent.click(sendButton());
    expect((await screen.findByTestId("native-chat-notice")).textContent).toContain("the native composer is not empty");
    expect(input().value).toBe("first try");
    expect(input().readOnly).toBe(false);
    expect(screen.queryByTestId("native-chat-pending")).toBeNull();

    postReplies.push((b) => ({ status: 200, body: { request: receipt(String(b.requestId), "first try", "failed", "target needs input") } }));
    fireEvent.click(sendButton());
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[1]!.body.requestId).not.toBe(posts[0]!.body.requestId);
    await waitFor(() => expect(screen.getByTestId("native-chat-notice").textContent).toContain("target needs input"));
    expect(input().value).toBe("first try");
  });

  it("an indeterminate receipt warns before any resend and can be dismissed with the draft kept", async () => {
    pages.set("n1", page("n1"));
    renderChat(target("n1"));
    await type("maybe sent");
    postReplies.push((b) => ({ status: 200, body: { request: receipt(String(b.requestId), "maybe sent", "indeterminate", "Enter failed after paste") } }));
    fireEvent.click(sendButton());
    const row = await screen.findByTestId("native-chat-pending");
    await waitFor(() => expect(row.getAttribute("data-phase")).toBe("indeterminate"));
    expect(row.textContent).toContain("Check the history or Terminal");
    expect(sendButton().disabled).toBe(true);
    fireEvent.click(within(row).getByTestId("native-chat-dismiss"));
    await waitFor(() => expect(screen.queryByTestId("native-chat-pending")).toBeNull());
    expect(input().value).toBe("maybe sent");
    expect(posts).toHaveLength(1);
  });
});

describe("native chat: exact seat and conversation identity", () => {
  it("switching seats shows only the selected seat's history and draft, and a late answer stays with its own seat", async () => {
    pages.set("a", page("a", { messages: [msg("ma", "assistant", "history of A")] }));
    pages.set("b", page("b", { messages: [msg("mb", "assistant", "history of B")] }));
    const view = renderChat(target("a"));
    await screen.findByText("history of A");
    await type("draft for A");
    let release!: (r: Reply) => void;
    postReplies.push(new Promise((res) => { release = res; }));
    fireEvent.click(sendButton());
    await waitFor(() => expect(posts).toHaveLength(1));

    view.show(target("b"));
    await screen.findByText("history of B");
    expect(screen.queryByText("history of A")).toBeNull();
    await waitFor(() => expect(input().disabled).toBe(false));
    expect(input().value).toBe("");
    expect(screen.queryByTestId("native-chat-pending")).toBeNull();

    // A's request finishes while B is shown: B is untouched.
    await act(async () => release({ status: 200, body: { request: receipt(String(posts[0]!.body.requestId), "draft for A", "failed", "busy") } }));
    expect(screen.queryByTestId("native-chat-notice")).toBeNull();
    expect(input().value).toBe("");
    await type("draft for B");

    view.show(target("a"));
    await screen.findByText("history of A");
    await waitFor(() => expect(input().value).toBe("draft for A"));
    expect(screen.getByTestId("native-chat-notice").textContent).toContain("busy");
    expect(posts.every((p) => p.url === "/api/native-chat/a/messages")).toBe(true);
  });

  it("a replaced conversation never inherits or sends the old draft", async () => {
    pages.set("n1", page("n1", { conversationId: "conv-1", messages: [msg("m1", "assistant", "before clear")] }));
    renderChat(target("n1"));
    await screen.findByText("before clear");
    await type("unsent words");
    pages.set("n1", page("n1", { conversationId: "conv-2", messages: [] }));
    await screen.findByTestId("native-chat-carried", undefined, { timeout: 4000 });
    expect(input().value).toBe("");
    expect(screen.queryByText("before clear")).toBeNull();
    expect(posts).toHaveLength(0);
    // An occupied composer blocks the transfer and the old draft is kept.
    fireEvent.change(input(), { target: { value: "new words" } });
    const carry = within(screen.getByTestId("native-chat-carried")).getByRole("button", { name: "Use it here" }) as HTMLButtonElement;
    expect(carry.disabled).toBe(true);
    fireEvent.click(carry);
    expect(input().value).toBe("new words");
    fireEvent.change(input(), { target: { value: "" } });
    fireEvent.click(carry);
    expect(input().value).toBe("unsent words");
    expect(posts).toHaveLength(0);
  });

  it("disables send when the endpoint reports another session than the selected seat", async () => {
    pages.set("n1", page("n1", { sessionName: "someone-else" }));
    renderChat(target("n1"));
    await type("hi");
    expect(screen.getByTestId("native-chat-blocked").textContent).toContain("someone-else");
    expect(sendButton().disabled).toBe(true);
  });

  it("a response for another node is never shown", async () => {
    pages.set("n1", page("other"));
    renderChat(target("n1"));
    const state = await screen.findByTestId("native-chat-state");
    await waitFor(() => expect(state.getAttribute("data-state")).toBe("error"));
    expect(screen.queryByTestId("native-chat-input")).toBeNull();
  });

  it("a host refusal (terminal admission) blocks sending while history stays readable", async () => {
    pages.set("n1", page("n1", { messages: [msg("m1", "assistant", "still readable")] }));
    renderChat(target("n1", { blockedReason: "The seat's tmux pane changed." }));
    await screen.findByText("still readable");
    await type("hi");
    expect(sendButton().disabled).toBe(true);
    expect(screen.getByTestId("native-chat-blocked").textContent).toContain("tmux pane changed");
  });

  it("a remote source reads nothing", () => {
    renderChat(target("n1", { hostId: "far", isRemote: true }));
    expect(screen.getByTestId("native-chat-state").getAttribute("data-state")).toBe("refused");
    expect(gets).toHaveLength(0);
  });
});

describe("native chat: Terminal fallback", () => {
  it("a native approval or question points to the Terminal, with no approval controls in chat", async () => {
    pages.set("n1", page("n1", { availability: { state: "needs_terminal", detail: "A permission prompt is open.", canSend: false, canInterrupt: false } }));
    renderChat(target("n1"));
    const banner = await screen.findByTestId("native-chat-needs-terminal");
    expect(banner.textContent).toContain("A permission prompt is open.");
    expect(screen.queryByRole("button", { name: /approve|allow|deny|yes|no/i })).toBeNull();
    await type("go ahead");
    expect(sendButton().disabled).toBe(true);
    fireEvent.click(within(banner).getByTestId("native-chat-open-terminal"));
    expect(screen.getByTestId("fake-terminal").textContent).toBe("terminal for n1");
    expect(posts).toHaveLength(0);
    // And back to Chat keeps the draft.
    fireEvent.click(screen.getByTestId("seat-view-chat"));
    await waitFor(() => expect(input().value).toBe("go ahead"));
  });

  it("slash commands are not sent from chat", async () => {
    pages.set("n1", page("n1"));
    renderChat(target("n1"));
    await type("  /clear");
    expect(sendButton().disabled).toBe(true);
    expect(screen.getByTestId("native-chat-blocked").textContent).toContain("Slash commands");
    fireEvent.keyDown(input(), { key: "Enter" });
    fireEvent.click(screen.getByTestId("native-chat-open-terminal"));
    expect(screen.getByTestId("fake-terminal")).toBeTruthy();
    expect(posts).toHaveLength(0);
  });

  it("an unestablished identity (409) shows the reason and the Terminal action", async () => {
    pages.set("n1", { status: 409, body: { error: "No current native conversation for this seat.", code: "identity_unavailable" } });
    renderChat(target("n1"));
    const state = await screen.findByTestId("native-chat-state");
    await waitFor(() => expect(state.getAttribute("data-state")).toBe("refused"));
    expect(state.textContent).toContain("No current native conversation");
    fireEvent.click(screen.getByTestId("native-chat-open-terminal"));
    expect(screen.getByTestId("fake-terminal")).toBeTruthy();
  });
});

describe("native chat: interrupt", () => {
  it("sends one interrupt at a time and checks a lost answer under the same id", async () => {
    pages.set("n1", page("n1", { availability: { state: "busy", detail: "The agent is working.", canSend: false, canInterrupt: true } }));
    renderChat(target("n1"));
    const button = await screen.findByTestId("native-chat-interrupt") as HTMLButtonElement;
    postReplies.push("network-error");
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByTestId("native-chat-interrupt-status").getAttribute("data-phase")).toBe("unknown"));
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toBe("/api/native-chat/n1/interrupt");
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(posts).toHaveLength(1);

    postReplies.push((b) => ({ status: 200, body: { request: { ...receipt(String(b.requestId), "", "submitted"), kind: "interrupt" } } }));
    fireEvent.click(screen.getByTestId("native-chat-interrupt-retry"));
    await waitFor(() => expect(screen.getByTestId("native-chat-interrupt-status").getAttribute("data-phase")).toBe("submitted"));
    expect(posts).toHaveLength(2);
    expect(posts[1]!.body).toEqual(posts[0]!.body);
  });
});

describe("native chat: bounded and verified reads", () => {
  it("keeps loaded earlier pages, stops at the view limit and says so", async () => {
    const many = Array.from({ length: NATIVE_CHAT_VIEW_LIMIT }, (_, i) => msg(`m${i}`, "assistant", `line ${i}`));
    expect(mergeMessages(many.slice(10), many.slice(0, 10), "older").map((m) => m.id)).toEqual(many.map((m) => m.id));
    pages.set("n1", page("n1", { messages: many, history: { state: "partial", detail: "thinking omitted", olderCursor: "c1" } }));
    renderChat(target("n1"));
    expect((await screen.findByTestId("native-chat-limit")).textContent).toContain(String(NATIVE_CHAT_VIEW_LIMIT));
    expect(screen.queryByTestId("native-chat-older")).toBeNull();
    expect(screen.getByTestId("native-chat-history-note").textContent).toContain("thinking omitted");
  });

  it("loads an earlier page for the same conversation in front of the latest", async () => {
    pages.set("n1", page("n1", { messages: [msg("m2", "assistant", "latest")], history: { state: "available", detail: "", olderCursor: "c1" } }));
    renderChat(target("n1"));
    await screen.findByText("latest");
    const latest = pages.get("n1")!;
    pages.set("n1", page("n1", { messages: [msg("m1", "user", "earlier")], history: { state: "available", detail: "", olderCursor: null } }));
    fireEvent.click(screen.getByTestId("native-chat-older"));
    await screen.findByText("earlier");
    expect(gets.some((u) => u.endsWith("?before=c1"))).toBe(true);
    pages.set("n1", latest);
    const texts = screen.getAllByTestId("native-chat-message").map((el) => el.textContent);
    expect(texts[0]).toContain("earlier");
    expect(texts[1]).toContain("latest");
    expect(screen.queryByTestId("native-chat-older")).toBeNull();
  });

  it("rejects malformed tool, availability or identity fields", async () => {
    const bad = [
      { ...page("n1"), messages: [{ ...msg("t", "tool", "x"), tool: { name: 1, callId: null, kind: "call" } }] },
      { ...page("n1"), availability: { state: "ready", detail: "", canSend: "yes", canInterrupt: false } },
      { ...page("n1"), identity: { ...page("n1").identity, runtime: "other" } },
      { ...page("n1"), messages: [{ ...msg("m", "assistant", "x"), timestamp: 5 }] },
    ];
    for (const body of bad) {
      pages.set("n1", { status: 200, body });
      await expect(readNativeChat("n1")).rejects.toThrow(/could not be verified/);
    }
  });
});

describe("native chat: review follow-ups", () => {
  const stop = (requestId: string, state: NativeChatRequest["state"], detail = ""): NativeChatRequest => ({ ...receipt(requestId, "", state, detail), kind: "interrupt" });
  const busy = { state: "busy" as const, detail: "working", canSend: false, canInterrupt: true };
  const latestKey = ["native-chat", "local", "rig-1", "n1"];

  it("an empty view adopts the first populated page and its cursor, with no gap note", async () => {
    pages.set("n1", page("n1"));
    const view = renderChat(target("n1"));
    await screen.findByText("No messages in this conversation yet.");
    expect(screen.queryByTestId("native-chat-older")).toBeNull();
    pages.set("n1", page("n1", { messages: [msg("m102", "assistant", "first record")], history: { state: "available", detail: "", olderCursor: "before-102" } }));
    await act(async () => { await view.client.invalidateQueries({ queryKey: latestKey }); });
    await screen.findByText("first record");
    expect(screen.getByTestId("native-chat-older")).toBeTruthy();
    expect(screen.queryByTestId("native-chat-jumped")).toBeNull();
  });

  it("a latest page disjoint from the view restarts at that page with its cursor and says so, keeping the draft", async () => {
    pages.set("n1", page("n1", { messages: [msg("m1", "assistant", "old first reply")] }));
    const view = renderChat(target("n1"));
    await screen.findByText("old first reply");
    await type("half-written");
    // A paused tab returns after more than one page of new messages.
    pages.set("n1", page("n1", {
      messages: Array.from({ length: 100 }, (_, i) => msg(`m${i + 102}`, "assistant", `new reply ${i + 102}`)),
      history: { state: "available", detail: "", olderCursor: "before-102" },
    }));
    await act(async () => { await view.client.invalidateQueries({ queryKey: latestKey }); });
    await screen.findByText("new reply 201");
    expect(screen.queryByText("old first reply")).toBeNull();
    expect(screen.getByTestId("native-chat-jumped").textContent).toContain("Load earlier messages");
    expect(input().value).toBe("half-written");

    pages.set("n1", page("n1", { messages: [msg("m101", "assistant", "reply 101")], history: { state: "available", detail: "", olderCursor: null } }));
    fireEvent.click(screen.getByTestId("native-chat-older"));
    await screen.findByText("reply 101");
    expect(gets.some((u) => u.endsWith("?before=before-102"))).toBe(true);
    expect(screen.queryByTestId("native-chat-jumped")).toBeNull();
    expect(screen.getAllByTestId("native-chat-message")[0]!.textContent).toContain("reply 101");
  });

  it("after a reload, an indeterminate interrupt receipt is shown and blocks a new interrupt until the Terminal is acknowledged", async () => {
    // Before the reload: this tab's interrupt answer is lost.
    pages.set("n1", page("n1", { availability: busy }));
    const first = renderChat(target("n1"));
    postReplies.push("network-error");
    fireEvent.click(await screen.findByTestId("native-chat-interrupt"));
    await waitFor(() => expect(screen.getByTestId("native-chat-interrupt-status").getAttribute("data-phase")).toBe("unknown"));
    const id = String(posts[0]!.body.requestId);
    first.unmount();

    // Reload: page memory is gone; the daemon still has the receipt.
    resetNativeChatStore();
    pages.set("n1", page("n1", { availability: busy, requests: [stop(id, "indeterminate", "Escape may have been sent")] }));
    renderChat(target("n1"));
    const status = await screen.findByTestId("native-chat-interrupt-status");
    expect(status.getAttribute("data-phase")).toBe("indeterminate");
    expect(status.textContent).toContain("Escape may have been sent");
    // No owner key came back with the receipt: nothing to re-post.
    expect(within(status).queryByTestId("native-chat-interrupt-retry")).toBeNull();
    const button = screen.getByTestId("native-chat-interrupt") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(posts).toHaveLength(1);

    fireEvent.click(within(status).getByTestId("native-chat-interrupt-ack"));
    await waitFor(() => expect(button.disabled).toBe(false));
    postReplies.push((b) => ({ status: 200, body: { request: stop(String(b.requestId), "submitted") } }));
    fireEvent.click(button);
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[1]!.body.requestId).not.toBe(id);
  });

  it("after a reload, an interrupt still sending elsewhere is read-only and points to the Terminal", async () => {
    pages.set("n1", page("n1", { availability: busy, requests: [stop("4d0a5f5e-0000-4000-8000-000000000001", "sending")] }));
    renderChat(target("n1"));
    const status = await screen.findByTestId("native-chat-interrupt-status");
    expect(status.getAttribute("data-phase")).toBe("sending");
    expect(within(status).queryByTestId("native-chat-interrupt-retry")).toBeNull();
    expect(within(status).queryByTestId("native-chat-interrupt-ack")).toBeNull();
    expect(within(status).getByTestId("native-chat-open-terminal")).toBeTruthy();
    expect((screen.getByTestId("native-chat-interrupt") as HTMLButtonElement).disabled).toBe(true);
  });

  it("after a reload, an indeterminate message receipt blocks a new send until dismissed", async () => {
    pages.set("n1", page("n1", { requests: [receipt("4d0a5f5e-0000-4000-8000-000000000002", "earlier words", "indeterminate", "Enter failed")] }));
    renderChat(target("n1"));
    await type("next words");
    expect(sendButton().disabled).toBe(true);
    expect(screen.getByTestId("native-chat-blocked").textContent).toContain("outcome is unknown");
    fireEvent.click(screen.getByTestId("native-chat-dismiss"));
    await waitFor(() => expect(sendButton().disabled).toBe(false));
    expect(posts).toHaveLength(0);
  });

  it("an unexpected daemon fault (500) is an unknown outcome, never 'Not sent'", async () => {
    pages.set("n1", page("n1"));
    renderChat(target("n1"));
    postReplies.push({ status: 500, body: { error: "Native chat could not verify this operation. Open Terminal.", code: "native_chat_unavailable" } });
    await type("hello");
    fireEvent.click(sendButton());
    await waitFor(() => expect(screen.getByTestId("native-chat-pending").getAttribute("data-phase")).toBe("unknown"));
    expect(screen.queryByTestId("native-chat-notice")).toBeNull();
    expect(input().value).toBe("hello");
  });

  it("refuses the same control characters as the daemon (tab, C0, DEL, C1), allowing LF and CRLF", () => {
    expect(composeRefusal("a\tb")).toMatch(/control characters/);
    expect(composeRefusal("a\u0085b")).toMatch(/control characters/);
    expect(composeRefusal("a\u007fb")).toMatch(/control characters/);
    expect(composeRefusal("a\u001bb")).toMatch(/control characters/);
    expect(composeRefusal("line one\nline two")).toBeNull();
    // A send turns CRLF and lone CR into LF before it leaves the browser.
    expect(composeRefusal("line one\r\nline two")).toBeNull();
    expect(composeRefusal("line one\rline two")).toBeNull();
  });
});
