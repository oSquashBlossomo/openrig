// Selected-agent workspace: live-terminal lifecycle against the redesign
// terminal contract. WebSocket and xterm are stubbed; the node-detail read,
// the admission rules, the shared cap and the FocusedTerminal seam are real.
// These prove identity/lifecycle wiring in isolation — not tmux, the broker or
// a browser.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";

const sockets: MockWS[] = [];
class MockWS {
  url: string;
  readyState = 1;
  onopen: ((evt?: unknown) => void) | null = null;
  onclose: ((evt: { code: number; reason: string }) => void) | null = null;
  onmessage: ((evt: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closeCalled = false;
  sent: string[] = [];
  /** Sockets still open when this one was constructed. */
  openAtCreation: number;
  constructor(url: string) {
    this.url = url;
    this.openAtCreation = sockets.filter((s) => !s.closeCalled).length;
    sockets.push(this);
    setTimeout(() => this.onopen?.(), 0);
  }
  send(data: string) { this.sent.push(data); }
  close() { this.closeCalled = true; this.readyState = 3; }
  static OPEN = 1;
}
vi.stubGlobal("WebSocket", MockWS);
let focusCalls = 0;
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    open(el: HTMLElement) { el.appendChild(document.createElement("div")); }
    write() {}
    onData() {}
    focus() { focusCalls++; }
    scrollToBottom() {}
    attachCustomWheelEventHandler() {}
    resize() {}
    dispose() {}
    options = { fontSize: 13 };
  },
}));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

import { SpatialAgentWorkspace } from "../src/components/topology/spatial/SpatialAgentWorkspace.js";
import { LiveTerminalProvider, useLiveTerminal } from "../src/components/terminal/LiveTerminalProvider.js";
import { readSpatialPalette } from "../src/components/topology/spatial/spatial-palette.js";
import { buildSpatialModel, deriveSeatStatus, parseSpatialRig, type SpatialAgent } from "../src/lib/spatial-topology.js";
import { setPreferredSeatView } from "../src/components/native-chat/NativeChatPanel.js";
// These cover the terminal; seats open in Chat by default (native-chat-panel.test.tsx).
setPreferredSeatView("terminal");

// Two rigs whose seats share a logical id and display name: only rig, node
// and session tell them apart.
function rigGraph(nodeId: string, session: string) {
  return {
    nodes: [
      { id: "pod", type: "podGroup", data: { podNamespace: "lead" } },
      { id: nodeId, type: "rigNode", parentId: "pod", data: { logicalId: "lead.coord", canonicalSessionName: session, runtime: "claude-code", status: "running", terminalActive: true } },
    ],
    edges: [],
  };
}
const model = buildSpatialModel("local", [
  parseSpatialRig("local", { rigId: "ra", rigName: "alpha", graph: rigGraph("node-a", "coord@alpha") }),
  parseSpatialRig("local", { rigId: "rb", rigName: "beta", graph: rigGraph("node-b", "coord@beta") }),
]);
const agentA = model.rigs[0]!.agents[0]!;
const agentB = model.rigs[1]!.agents[0]!;
const palette = readSpatialPalette("dark");

function detailFor(agent: SpatialAgent, over: Record<string, unknown> = {}) {
  return {
    nodeId: agent.nodeId, rigId: agent.rigId, rigName: agent.rigName, logicalId: agent.logicalId, podId: "pod", podNamespace: "lead",
    canonicalSessionName: agent.canonicalSessionName, nodeKind: "agent", runtime: "claude-code", sessionStatus: "running",
    startupStatus: "attention_required", restoreOutcome: "n-a", tmuxAttachCommand: null, resumeCommand: null, latestError: null,
    model: null, agentRef: null, profile: null, resolvedSpecName: null, resolvedSpecVersion: null, cwd: null,
    startupFiles: [], startupActions: [], recentEvents: [{ type: "session.started", createdAt: "2026-10-05 10:00:00" }],
    infrastructureStartupCommand: null, peers: [], edges: { outgoing: [], incoming: [] },
    transcript: { enabled: false, path: null, tailCommand: null },
    compactSpec: { name: null, version: null, profile: null, skillCount: 0, guidanceCount: 0 },
    binding: { attachmentType: "tmux", tmuxSession: agent.canonicalSessionName, tmuxPane: "%1" },
    ...over,
  };
}

type DetailResponder = (url: string) => Promise<Response> | Response;
let respond: DetailResponder;
const fetchMock = vi.fn((url: string, init?: RequestInit) => {
  void init;
  return Promise.resolve(respond(url));
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const detailUrl = (agent: SpatialAgent, host?: string) =>
  `/api/rigs/${agent.rigId}/nodes/${encodeURIComponent(agent.logicalId!)}${host ? `?host=${host}` : ""}`;

let qc: QueryClient;
let setAgentExternal: (a: SpatialAgent | null) => void = () => {};

function OtherSurface() {
  const live = useLiveTerminal();
  const [, setTick] = useState(0);
  return (
    <>
      <button type="button" data-testid="other-live" onClick={() => live.requestLive("other-surface", () => {})} />
      <button type="button" data-testid="probe" onClick={() => setTick((n) => n + 1)} />
      <output data-testid="slot-state">{String(live.isLive(`spatial:local:ra:node-a:${encodeURIComponent("coord@alpha")}`))}</output>
    </>
  );
}

function Harness({ initial, hostId, isRemote }: { initial: SpatialAgent; hostId: string; isRemote: boolean }) {
  const [agent, setAgent] = useState<SpatialAgent | null>(initial);
  setAgentExternal = setAgent;
  return agent ? (
    <SpatialAgentWorkspace
      agent={agent}
      model={model}
      status={deriveSeatStatus(agent)}
      palette={palette}
      hostId={hostId}
      isRemote={isRemote}
      linkSource={hostId}
      from={{ kind: "host" }}
      canFocus={false}
      onFocus={() => {}}
      onSelect={(key) => setAgent(model.agentsByKey.get(key) ?? null)}
      onClose={() => setAgent(null)}
      layout="side"
    />
  ) : <div data-testid="closed" />;
}

function renderWorkspace(opts: { agent?: SpatialAgent; hostId?: string; isRemote?: boolean; cap?: number } = {}) {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRootRoute({
    component: () => (
      <QueryClientProvider client={qc}>
        <LiveTerminalProvider cap={opts.cap ?? 2}>
          <OtherSurface />
          <Harness initial={opts.agent ?? agentA} hostId={opts.hostId ?? "local"} isRemote={opts.isRemote ?? false} />
        </LiveTerminalProvider>
      </QueryClientProvider>
    ),
  });
  const route = createRoute({ getParentRoute: () => root, path: "/", component: () => null });
  const router = createRouter({ routeTree: root.addChildren([route]), history: createMemoryHistory({ initialEntries: ["/"] }) });
  return render(<RouterProvider router={router} />);
}

const terminalSockets = (session: string) => sockets.filter((s) => s.url.includes(`/api/terminal/${encodeURIComponent(session)}?`));
const dockState = () => screen.queryByTestId("spatial-terminal-state")?.getAttribute("data-state") ?? (screen.queryByTestId("spatial-terminal-live") ? "live" : null);

beforeEach(() => {
  sockets.length = 0;
  focusCalls = 0;
  fetchMock.mockClear();
  respond = (url) => {
    if (url === detailUrl(agentA)) return json(detailFor(agentA));
    if (url === detailUrl(agentB)) return json(detailFor(agentB));
    return json({ error: "not found" }, 404);
  };
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("a native command handed over from Chat", () => {
  const chatFor = (agent: SpatialAgent) => ({
    identity: { nodeId: agent.nodeId, sessionId: `s-${agent.nodeId}`, sessionName: agent.canonicalSessionName, runtime: "claude-code", conversationId: `conv-${agent.nodeId}`, ownerKey: `owner-${agent.nodeId}` },
    availability: { state: "ready", detail: "", canSend: true, canInterrupt: false },
    history: { state: "available", detail: "", olderCursor: null },
    messages: [],
    requests: [],
  });
  const geometry = (ws: MockWS) => act(() => { ws.onmessage?.({ data: JSON.stringify({ type: "geometry", cols: 90, rows: 4 }) }); });

  it("reaches the same seat's admitted terminal with zero bytes until Paste command, then one literal frame without Enter, and never follows a seat switch", async () => {
    setPreferredSeatView("chat");
    try {
      respond = (url) => {
        if (url === detailUrl(agentA)) return json(detailFor(agentA));
        if (url === detailUrl(agentB)) return json(detailFor(agentB));
        if (url === `/api/native-chat/${agentA.nodeId}`) return json(chatFor(agentA));
        if (url === `/api/native-chat/${agentB.nodeId}`) return json(chatFor(agentB));
        return json({ error: "not found" }, 404);
      };
      renderWorkspace();
      const draft = await screen.findByTestId("native-chat-input") as HTMLTextAreaElement;
      await waitFor(() => expect(draft.disabled).toBe(false));
      fireEvent.change(draft, { target: { value: "/review résumé ✓" } });
      // Offered once the seat's identity is verified by the current detail read.
      await waitFor(() => expect(screen.getByTestId("native-chat-blocked").textContent).toMatch(/Slash commands/));
      fireEvent.click(await screen.findByRole("button", { name: "Open native command" }));
      await waitFor(() => expect(terminalSockets("coord@alpha")).toHaveLength(1));
      const ws = terminalSockets("coord@alpha")[0]!;
      await act(async () => { await vi.advanceTimersByTimeAsync(10); });
      geometry(ws);
      expect((screen.getByRole("textbox", { name: "Native command" }) as HTMLTextAreaElement).value).toBe("/review résumé ✓");
      expect(ws.sent).toEqual([]);
      fireEvent.click(screen.getByRole("button", { name: "Paste command" }));
      await waitFor(() => expect(ws.sent.map((f) => JSON.parse(f))).toEqual([{ type: "text", text: "/review résumé ✓" }]));
      expect(fetchMock.mock.calls.every(([, init]) => ((init as RequestInit | undefined)?.method ?? "GET") === "GET")).toBe(true);

      // Another seat and back: nothing staged, nothing sent anywhere else.
      act(() => setAgentExternal(agentB));
      await waitFor(() => expect(terminalSockets("coord@beta")).toHaveLength(1));
      act(() => setAgentExternal(agentA));
      await waitFor(() => expect(terminalSockets("coord@alpha")).toHaveLength(2));
      await act(async () => { await vi.advanceTimersByTimeAsync(10); });
      geometry(terminalSockets("coord@alpha")[1]!);
      expect(screen.queryByRole("textbox", { name: "Native command" })).toBeNull();
      expect(sockets.flatMap((s) => s.sent)).toEqual([JSON.stringify({ type: "text", text: "/review résumé ✓" })]);
    } finally {
      setPreferredSeatView("terminal");
    }
  });
});

describe("selection opens one live terminal, admitted by a fresh exact detail read", () => {
  it("verifies first, then mounts exactly one viewer for the canonical session, sending zero input and not stealing focus", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    respond = async (url) => { await held; return url === detailUrl(agentA) ? json(detailFor(agentA)) : json({}, 404); };
    renderWorkspace();
    await waitFor(() => expect(dockState()).toBe("verifying"));
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    expect(sockets).toHaveLength(0);
    await act(async () => { release(); });
    await waitFor(() => expect(dockState()).toBe("live"));
    expect(fetchMock).toHaveBeenCalledWith(detailUrl(agentA), expect.objectContaining({ method: "GET" }));
    await waitFor(() => expect(sockets).toHaveLength(1));
    expect(sockets[0]!.url).toMatch(/\/api\/terminal\/coord%40alpha\?protocol=2/);
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(sockets[0]!.sent).toEqual([]);
    expect(focusCalls).toBe(0);
    // A native attention prompt is not a reason to hide the terminal.
    expect(screen.getByTestId("spatial-terminal-live")).toBeTruthy();
    // Served history only, with its served time.
    fireEvent.click(screen.getByTestId("spatial-workspace-tab-evidence"));
    expect(within(screen.getByTestId("spatial-workspace-events")).getByText(/session\.started/)).toBeTruthy();
    expect(fetchMock.mock.calls.every(([, init]) => (init as RequestInit | undefined)?.method === "GET")).toBe(true);
  });

  it("switching to a same-named seat in another rig closes the old socket first and never aliases", async () => {
    renderWorkspace();
    await waitFor(() => expect(terminalSockets("coord@alpha")).toHaveLength(1));
    act(() => setAgentExternal(agentB));
    await waitFor(() => expect(terminalSockets("coord@beta")).toHaveLength(1));
    const [oldSocket] = terminalSockets("coord@alpha");
    const [newSocket] = terminalSockets("coord@beta");
    expect(oldSocket!.closeCalled).toBe(true);
    expect(newSocket!.openAtCreation).toBe(0);
    expect(fetchMock).toHaveBeenCalledWith(detailUrl(agentB), expect.anything());
    expect(screen.getByTestId("spatial-terminal-live").getAttribute("data-terminal-key")).toContain("node-b");
  });

  it.each([
    ["another node", { nodeId: "node-other" }, "identity-mismatch"],
    ["no node id", { nodeId: undefined }, "identity-mismatch"],
    ["another session", { canonicalSessionName: "coord@other" }, "identity-mismatch"],
    ["a non-tmux attachment", { binding: { attachmentType: "external_cli", tmuxSession: null } }, "not-tmux"],
    ["no attachment", { binding: null }, "not-tmux"],
    ["a different tmux session", { binding: { attachmentType: "tmux", tmuxSession: "coord@stale" } }, "identity-mismatch"],
  ])("a current detail reporting %s refuses honestly and opens nothing", async (_label, over, state) => {
    respond = (url) => (url === detailUrl(agentA) ? json(detailFor(agentA, over)) : json({}, 404));
    renderWorkspace();
    await waitFor(() => expect(dockState()).toBe(state));
    expect(screen.getByTestId("spatial-terminal-state").textContent).not.toBe("");
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    expect(sockets).toHaveLength(0);
  });

  it("a failed current read cannot enable a terminal; Retry re-reads", async () => {
    let fail = true;
    respond = (url) => (url === detailUrl(agentA) ? (fail ? json({ error: "boom" }, 503) : json(detailFor(agentA))) : json({}, 404));
    renderWorkspace();
    await waitFor(() => expect(dockState()).toBe("unreadable"));
    expect(sockets).toHaveLength(0);
    fail = false;
    fireEvent.click(within(screen.getByTestId("spatial-terminal-state")).getByRole("button", { name: /retry/i }));
    await waitFor(() => expect(sockets).toHaveLength(1));
  });

  it("a registered remote source stays read-only: no terminal, no local substitute", async () => {
    // The remote host's own model: same rig/node ids, read through host "other".
    const remoteAgent = buildSpatialModel("other", [parseSpatialRig("other", { rigId: "ra", rigName: "alpha", graph: rigGraph("node-a", "coord@alpha") })]).rigs[0]!.agents[0]!;
    respond = (url) => (url === detailUrl(agentA, "other") ? json(detailFor(agentA)) : json({}, 404));
    renderWorkspace({ agent: remoteAgent, hostId: "other", isRemote: true });
    await waitFor(() => expect(dockState()).toBe("remote"));
    expect(screen.getByTestId("spatial-terminal-state").textContent).toContain("remote");
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    expect(sockets).toHaveLength(0);
    // Details still read through the remote host envelope.
    expect(fetchMock).toHaveBeenCalledWith(detailUrl(agentA, "other"), expect.anything());
  });
});

describe("current identity is re-checked while open and on reconnect", () => {
  it("an identity change observed on refresh detaches the viewer", async () => {
    renderWorkspace();
    await waitFor(() => expect(sockets).toHaveLength(1));
    respond = (url) => (url === detailUrl(agentA) ? json(detailFor(agentA, { canonicalSessionName: "coord@replaced" })) : json({}, 404));
    await act(async () => { await qc.refetchQueries({ queryKey: ["spatial", "seat-detail"] }); });
    await waitFor(() => expect(dockState()).toBe("identity-mismatch"));
    expect(sockets[0]!.closeCalled).toBe(true);
    expect(sockets).toHaveLength(1);
  });

  it("a reconnect re-reads detail first; a stale resolution after switching seats never connects", async () => {
    renderWorkspace();
    await waitFor(() => expect(sockets).toHaveLength(1));
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    respond = async (url) => {
      if (url === detailUrl(agentA)) { await held; return json(detailFor(agentA)); }
      if (url === detailUrl(agentB)) return json(detailFor(agentB));
      return json({}, 404);
    };
    // Transient drop; the reconnect waits on a fresh detail read.
    act(() => { sockets[0]!.onclose?.({ code: 1006, reason: "" }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(sockets).toHaveLength(1);
    // Switch seats while that read is in flight, then let it resolve.
    act(() => setAgentExternal(agentB));
    await waitFor(() => expect(terminalSockets("coord@beta")).toHaveLength(1));
    await act(async () => { release(); await vi.advanceTimersByTimeAsync(10); });
    expect(terminalSockets("coord@alpha")).toHaveLength(1);
    expect(terminalSockets("coord@beta")).toHaveLength(1);
  });

  it("a reconnect whose fresh detail still matches reopens the same session", async () => {
    renderWorkspace();
    await waitFor(() => expect(sockets).toHaveLength(1));
    const before = fetchMock.mock.calls.length;
    act(() => { sockets[0]!.onclose?.({ code: 1006, reason: "" }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    await waitFor(() => expect(terminalSockets("coord@alpha")).toHaveLength(2));
    expect(fetchMock.mock.calls.length).toBeGreaterThan(before);
    expect(sockets[1]!.sent).toEqual([]);
  });
});

describe("shared live-terminal cap and closing", () => {
  it("another terminal taking the only slot releases this viewer honestly; Reconnect re-admits with a fresh read", async () => {
    renderWorkspace({ cap: 1 });
    await waitFor(() => expect(sockets).toHaveLength(1));
    fireEvent.click(screen.getByTestId("probe"));
    expect(screen.getByTestId("slot-state").textContent).toBe("true");
    fireEvent.click(screen.getByTestId("other-live"));
    await waitFor(() => expect(dockState()).toBe("released"));
    expect(sockets[0]!.closeCalled).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    const reads = fetchMock.mock.calls.length;
    fireEvent.click(screen.getByTestId("spatial-terminal-reconnect"));
    await waitFor(() => expect(sockets).toHaveLength(2));
    expect(fetchMock.mock.calls.length).toBeGreaterThan(reads);
  });

  it("a definitive server close (session ended) frees the slot and offers Retry instead of a dead viewer", async () => {
    renderWorkspace();
    await waitFor(() => expect(sockets).toHaveLength(1));
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    act(() => { sockets[0]!.onclose?.({ code: 1001, reason: "tmux session terminated" }); });
    await waitFor(() => expect(screen.queryByTestId("spatial-terminal-retry")).toBeTruthy());
    expect(screen.queryByTestId("spatial-terminal-live")).toBeNull();
    expect(screen.getByTestId("spatial-terminal-state").textContent).toContain("tmux session terminated");
    fireEvent.click(screen.getByTestId("probe"));
    expect(screen.getByTestId("slot-state").textContent).toBe("false");
    // Nothing reconnects by itself; the operator's Retry re-reads, then attaches.
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(sockets).toHaveLength(1);
    const reads = fetchMock.mock.calls.length;
    fireEvent.click(screen.getByTestId("spatial-terminal-retry"));
    await waitFor(() => expect(terminalSockets("coord@alpha")).toHaveLength(2));
    expect(fetchMock.mock.calls.length).toBeGreaterThan(reads);
    expect(sockets[1]!.sent).toEqual([]);
  });

  it("closing the workspace disconnects the viewer and frees its slot without any write", async () => {
    renderWorkspace();
    await waitFor(() => expect(sockets).toHaveLength(1));
    fireEvent.click(screen.getByTestId("probe"));
    expect(screen.getByTestId("slot-state").textContent).toBe("true");
    fireEvent.click(screen.getByTestId("spatial-workspace-close"));
    expect(await screen.findByTestId("closed")).toBeTruthy();
    expect(sockets[0]!.closeCalled).toBe(true);
    fireEvent.click(screen.getByTestId("probe"));
    expect(screen.getByTestId("slot-state").textContent).toBe("false");
    expect(sockets[0]!.sent).toEqual([]);
    expect(fetchMock.mock.calls.every(([, init]) => (init as RequestInit | undefined)?.method === "GET")).toBe(true);
  });
});

// Independent review (Astra) findings 1–5 plus strict source host, as
// maintained regressions. An admitted viewer is pinned to its exact pane; any
// failed current read, applicable native identity failure or observed change
// closes it and refuses until the operator's Retry evaluates a fresh read.
describe("current-seat admission hardening", () => {
  const paneDetail = (pane: string | null, over: Record<string, unknown> = {}) =>
    detailFor(agentA, { binding: { attachmentType: "tmux", tmuxSession: "coord@alpha", tmuxPane: pane }, ...over });

  it("a failed current refresh closes the viewer even with cached detail; a later automatic success does not re-admit; Retry does", async () => {
    renderWorkspace();
    await waitFor(() => expect(sockets).toHaveLength(1));
    respond = (url) => (url === detailUrl(agentA) ? json({ error: "unavailable" }, 503) : json({}, 404));
    await act(async () => { await qc.refetchQueries({ queryKey: ["spatial", "seat-detail"] }); });
    expect(qc.getQueryState(["spatial", "seat-detail", "local", "ra", "lead.coord", "node-a"])?.data).toBeTruthy();
    expect(dockState()).toBe("unreadable");
    expect(sockets[0]!.closeCalled).toBe(true);
    respond = (url) => (url === detailUrl(agentA) ? json(detailFor(agentA)) : json({}, 404));
    await act(async () => { await qc.refetchQueries({ queryKey: ["spatial", "seat-detail"] }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    expect(dockState()).toBe("unreadable");
    expect(sockets).toHaveLength(1);
    fireEvent.click(screen.getByTestId("spatial-terminal-retry"));
    await waitFor(() => expect(sockets).toHaveLength(2));
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(sockets[1]!.sent).toEqual([]);
  });

  it.each(["mismatch", "pane_missing"])("an applicable native %s verdict refuses, and detaches an open viewer when it appears", async (verdict) => {
    const failing = { verdict, sessionName: "coord@alpha", evidence: { registeredPane: "%1" }, reason: "pane runs zsh" };
    respond = (url) => (url === detailUrl(agentA) ? json(paneDetail("%1", { identityVerdict: failing })) : json({}, 404));
    renderWorkspace();
    await waitFor(() => expect(dockState()).toBe("native-identity"));
    expect(screen.getByTestId("spatial-terminal-state").textContent).toContain("pane runs zsh");
    expect(sockets).toHaveLength(0);
    cleanup();
    sockets.length = 0;
    respond = (url) => (url === detailUrl(agentA) ? json(paneDetail("%1")) : json({}, 404));
    renderWorkspace();
    await waitFor(() => expect(sockets).toHaveLength(1));
    respond = (url) => (url === detailUrl(agentA) ? json(paneDetail("%1", { identityVerdict: failing })) : json({}, 404));
    await act(async () => { await qc.refetchQueries({ queryKey: ["spatial", "seat-detail"] }); });
    expect(sockets[0]!.closeCalled).toBe(true);
    expect(dockState()).toBe("native-identity");
  });

  it("a verdict for another pane/session is not applicable and does not hide an attention prompt", async () => {
    const other = { verdict: "mismatch", sessionName: "coord@alpha", evidence: { registeredPane: "%9" } };
    respond = (url) => (url === detailUrl(agentA) ? json(paneDetail("%1", { identityVerdict: other })) : json({}, 404));
    renderWorkspace();
    await waitFor(() => expect(sockets).toHaveLength(1));
    expect(dockState()).toBe("live");
  });

  it("a cap Reconnect right after eviction reads current detail first and refuses a changed seat", async () => {
    renderWorkspace({ cap: 1 });
    await waitFor(() => expect(sockets).toHaveLength(1));
    fireEvent.click(screen.getByTestId("other-live"));
    await waitFor(() => expect(dockState()).toBe("released"));
    const reads = fetchMock.mock.calls.length;
    respond = (url) => (url === detailUrl(agentA) ? json(paneDetail("%2")) : json({}, 404));
    fireEvent.click(screen.getByTestId("spatial-terminal-reconnect"));
    await waitFor(() => expect(dockState()).toBe("changed"));
    expect(fetchMock.mock.calls.length).toBeGreaterThan(reads);
    expect(sockets).toHaveLength(1);
    expect(screen.getByTestId("spatial-terminal-state").textContent).toContain("%1 → %2");
  });

  it("an observed pane change closes the pinned viewer and is not auto-admitted; Retry attaches the current pane", async () => {
    renderWorkspace();
    await waitFor(() => expect(sockets).toHaveLength(1));
    expect(screen.getByTestId("spatial-terminal-live").getAttribute("data-terminal-pane")).toBe("%1");
    respond = (url) => (url === detailUrl(agentA) ? json(paneDetail("%2")) : json({}, 404));
    await act(async () => { await qc.refetchQueries({ queryKey: ["spatial", "seat-detail"] }); });
    expect(sockets[0]!.closeCalled).toBe(true);
    expect(dockState()).toBe("changed");
    await act(async () => { await qc.refetchQueries({ queryKey: ["spatial", "seat-detail"] }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    expect(sockets).toHaveLength(1);
    fireEvent.click(screen.getByTestId("spatial-terminal-retry"));
    await waitFor(() => expect(sockets).toHaveLength(2));
    expect(screen.getByTestId("spatial-terminal-live").getAttribute("data-terminal-pane")).toBe("%2");
  });

  it("a socket reconnect whose fresh read reports another pane is revoked, not reopened", async () => {
    renderWorkspace();
    await waitFor(() => expect(sockets).toHaveLength(1));
    respond = (url) => (url === detailUrl(agentA) ? json(paneDetail("%2")) : json({}, 404));
    act(() => { sockets[0]!.onclose?.({ code: 1006, reason: "" }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    await waitFor(() => expect(dockState()).toBe("changed"));
    expect(sockets).toHaveLength(1);
  });

  it("a tmux binding without a registered pane is not an attachment", async () => {
    respond = (url) => (url === detailUrl(agentA) ? json(paneDetail(null)) : json({}, 404));
    renderWorkspace();
    await waitFor(() => expect(dockState()).toBe("no-pane"));
    expect(sockets).toHaveLength(0);
  });

  it("a seat read from another host than the selected source never opens", async () => {
    renderWorkspace({ agent: { ...agentA, hostId: "elsewhere" } });
    await waitFor(() => expect(dockState()).toBe("identity-mismatch"));
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    expect(sockets).toHaveLength(0);
  });
});

describe("runtime identity copy", () => {
  function seatWithRuntime(runtime: string | null) {
    const graph = rigGraph("node-s", "stub@sigma");
    (graph.nodes[1] as { data: Record<string, unknown> }).data.runtime = runtime;
    return buildSpatialModel("local", [parseSpatialRig("local", { rigId: "rs", rigName: "sigma", graph })]).rigs[0]!.agents[0]!;
  }

  it("shows a served runtime that is not a known brand literally (e.g. the stub runtime)", async () => {
    respond = () => json({}, 404);
    renderWorkspace({ agent: seatWithRuntime("stub") });
    const context = await screen.findByTestId("spatial-workspace-context");
    expect(context.textContent).toContain("stub");
    expect(context.textContent).not.toContain("not reported");
    expect(screen.getByTestId("spatial-workspace-portrait").getAttribute("title")).toBe("stub");
  });

  it("reserves 'not reported' for a seat with no served runtime", async () => {
    respond = () => json({}, 404);
    renderWorkspace({ agent: seatWithRuntime(null) });
    expect((await screen.findByTestId("spatial-workspace-context")).textContent).toContain("Runtime not reported");
  });
});
