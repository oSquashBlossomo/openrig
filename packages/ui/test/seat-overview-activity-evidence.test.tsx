import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { LiveNodeDetails } from "../src/components/LiveNodeDetails.js";
import { createTestRouter } from "./helpers/test-router.js";
import { resetTopologyActivityStoreForTests, useTopologyActivity } from "../src/hooks/useTopologyActivity.js";
import { buildTopologySessionIndex, TOPOLOGY_NODE_ACTIVITY_TTL_MS } from "../src/lib/topology-activity.js";
import { createMockEventSourceClass, instances } from "./helpers/mock-event-source.js";

// Seat Overview activity text must reflect EVIDENCE: a seat with no activity
// observation (null/omitted/explicit unknown, no terminal signal) is "unknown",
// not "idle". The topology ring's quiet non-animated idle default is a visual
// default, not an observation, so it never replaces an unknown text fact; a
// fresh recent event still overrides it and, once expired, unknown returns.
// Regressions for the independently reproduced no-observation label defect.
// No hook or renderer mocks: the real node reader, ring store and Overview
// are mounted.
const NODE_DETAIL = {
  rigId: "rig-1", rigName: "test-rig", logicalId: "dev.impl", podId: "dev",
  canonicalSessionName: "dev-impl@test-rig", nodeKind: "agent", runtime: "claude-code",
  sessionStatus: "running", startupStatus: "ready", restoreOutcome: "n-a",
  tmuxAttachCommand: "tmux attach -t dev-impl@test-rig", resumeCommand: null,
  latestError: null, model: "opus", agentRef: "local:agents/impl", profile: "default",
  resolvedSpecName: "impl", resolvedSpecVersion: "1.0.0", cwd: "/workspace",
  startupFiles: [{
    path: "role.md",
    deliveryHint: "guidance_merge",
    required: true,
    absolutePath: "/workspace/specs/agents/impl/guidance/role.md",
  }],
  startupActions: [], recentEvents: [],
  infrastructureStartupCommand: null,
  binding: { tmuxSession: "dev-impl@test-rig" },
  peers: [{ logicalId: "dev.qa", canonicalSessionName: "dev-qa@test-rig", runtime: "codex" }],
  edges: {
    outgoing: [{ kind: "delegates_to", to: { logicalId: "dev.qa", sessionName: "dev-qa@test-rig" } }],
    incoming: [],
  },
  transcript: { enabled: true, path: "/tmp/test.log", tailCommand: "rig transcript dev-impl --tail 100" },
  compactSpec: { name: "impl", version: "1.0.0", profile: "default", skillCount: 2, guidanceCount: 1 },
  agentActivity: {
    state: "running",
    reason: "edit",
    evidenceSource: "runtime_hook",
    sampledAt: "2026-05-04T07:58:31.057Z",
    evidence: "edit",
  },
  currentQitems: [
    {
      qitemId: "qitem-20260504001234-driver",
      bodyExcerpt: "Implement PL-019 edge activity pulse and graph qitem hover.",
      tier: "mode-2",
    },
  ],
  contextUsage: {
    availability: "known",
    usedPercentage: 42,
    remainingPercentage: 58,
    contextWindowSize: 320000,
    sampledAt: "2026-05-04T07:58:31.057Z",
    fresh: true,
    totalInputTokens: 120000,
    totalOutputTokens: 14000,
  },
};


const originalFetch = globalThis.fetch;
const originalEventSource = globalThis.EventSource;
const noObservation = { ...NODE_DETAIL, agentActivity: null, terminalActive: null, currentQitems: [] };
function serve(detail: Record<string, unknown>) {
  vi.stubGlobal("fetch", vi.fn(async (input: string | Request | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method && init.method !== "GET") throw new Error("private fixture refuses mutations");
    if (url.includes("/nodes/")) return Response.json(detail);
    if (url.includes("/api/hosts")) return Response.json({ selected: "local", ownName: "fixture", hosts: [] });
    if (url.includes("/api/specs/library")) return Response.json([]);
    if (url.includes("/preview")) return Response.json({ sessionName: NODE_DETAIL.canonicalSessionName, capturedAt: new Date().toISOString(), text: "" });
    return Response.json({});
  }));
}
async function mount(detail: Record<string, unknown>) {
  serve(detail);
  render(createTestRouter({ component: () => <LiveNodeDetails rigId="rig-1" logicalId="dev.impl" />, path: "/test" }));
  return screen.findByTestId("seat-overview-activity-state");
}
function Warmup() {
  useTopologyActivity(buildTopologySessionIndex([{ nodeId: "rig-1::dev.impl", rigId: "rig-1", rigName: "test-rig", logicalId: "dev.impl", canonicalSessionName: NODE_DETAIL.canonicalSessionName }]));
  return <span data-testid="warmup" />;
}
async function seedRecentActivity() {
  const warm = render(<Warmup />);
  await waitFor(() => expect(instances).toHaveLength(1));
  act(() => instances[0]!.simulateMessage(JSON.stringify({ type: "agent.activity", sessionName: NODE_DETAIL.canonicalSessionName, activity: { state: "running" } })));
  warm.unmount();
}
beforeEach(() => {
  resetTopologyActivityStoreForTests();
  vi.stubGlobal("EventSource", createMockEventSourceClass());
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  globalThis.fetch = originalFetch;
  if (originalEventSource) globalThis.EventSource = originalEventSource;
});

describe("mounted seat activity text evidence", () => {
  it("unknown: explicit null activity and null terminal observation stay unknown without a recent event", async () => {
    const el = await mount(noObservation);
    expect(el.getAttribute("data-activity-source")).toBe("none");
    expect(el.textContent).toContain("unknown");
    expect(el.getAttribute("data-activity-state")).toBe("unknown");
  });
  it("unknown: omitted activity and terminal observation stay unknown without a recent event", async () => {
    const { agentActivity, terminalActive, ...omitted } = noObservation;
    const el = await mount(omitted);
    expect(el.getAttribute("data-activity-source")).toBe("none");
    expect(el.textContent).toContain("unknown");
    expect(el.getAttribute("data-activity-state")).toBe("unknown");
  });
  it("unknown: explicit unknown/no_activity_signal stays unknown without a recent event", async () => {
    const el = await mount({ ...noObservation, agentActivity: { ...NODE_DETAIL.agentActivity, state: "unknown", reason: "no_activity_signal", fallback: true } });
    expect(el.getAttribute("data-activity-source")).toBe("none");
    expect(el.textContent).toContain("unknown");
    expect(el.getAttribute("data-activity-state")).toBe("unknown");
  });
  it("unknown: after real ring pruning expires a recent event, the no-observation baseline returns to unknown", async () => {
    // Fake only the observation clock. Production 1-second pruning, Router and
    // React Query notification timers stay real. Wait for the source receipt,
    // not an arbitrary sleep or a predicted observer delivery time.
    vi.useFakeTimers({ toFake: ["Date"] });
    const eventAt = Date.parse("2026-10-05T01:00:00Z");
    vi.setSystemTime(eventAt);
    await seedRecentActivity();
    const el = await mount(noObservation);
    expect(el.textContent).toBe("active");
    expect(el.getAttribute("data-activity-source")).toBe("ring");
    vi.setSystemTime(eventAt + TOPOLOGY_NODE_ACTIVITY_TTL_MS + 1);
    await waitFor(() => expect(el.getAttribute("data-activity-source")).toBe("none"), { timeout: 2500 });
    expect(el.textContent).toContain("unknown");
    expect(el.getAttribute("data-activity-state")).toBe("unknown");
  });
  it("control: explicit terminal false is observed idle", async () => {
    const el = await mount({ ...noObservation, terminalActive: false });
    expect(el.textContent).toContain("idle");
    expect(el.getAttribute("data-activity-state")).toBe("idle");
    expect(el.getAttribute("data-activity-source")).toBe("terminal_activity");
  });
  it("control: observed hook idle remains idle", async () => {
    const el = await mount({ ...noObservation, agentActivity: { ...NODE_DETAIL.agentActivity, state: "idle" } });
    expect(el.textContent).toContain("idle");
    expect(el.getAttribute("data-activity-state")).toBe("idle");
    expect(el.getAttribute("data-activity-source")).toBe("hook");
  });
  it("control: explicit terminal true is active", async () => {
    const el = await mount({ ...noObservation, terminalActive: true });
    expect(el.textContent).toContain("active");
    expect(el.getAttribute("data-activity-state")).toBe("active");
    expect(el.getAttribute("data-activity-source")).toBe("terminal_activity");
    expect(el.className).toContain("topology-table-active-shimmer");
  });
  it("control: running hook is active", async () => {
    const el = await mount({ ...noObservation, agentActivity: NODE_DETAIL.agentActivity });
    expect(el.textContent).toContain("active");
    expect(el.getAttribute("data-activity-state")).toBe("active");
    expect(el.getAttribute("data-activity-source")).toBe("hook");
  });
  it("control: a fresh recent event overrides an unknown baseline as active", async () => {
    await seedRecentActivity();
    const el = await mount(noObservation);
    expect(el.textContent).toBe("active");
    expect(el.getAttribute("data-activity-state")).toBe("active");
    expect(el.getAttribute("data-activity-source")).toBe("ring");
    expect(el.className).toContain("topology-table-active-shimmer");
  });
  it("control: failed startup keeps the blocked ring state over an unknown observation", async () => {
    const el = await mount({ ...noObservation, startupStatus: "failed" });
    expect(el.textContent).toContain("blocked");
    expect(el.getAttribute("data-activity-state")).toBe("blocked");
  });
  it("control: attention-required startup keeps needs input over an unknown observation", async () => {
    const el = await mount({ ...noObservation, startupStatus: "attention_required" });
    expect(el.textContent).toContain("needs input");
    expect(el.getAttribute("data-activity-state")).toBe("needs_input");
  });
});
