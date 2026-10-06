// LiveNodeDetails seams used by the topology seat route: the uncontrolled
// (legacy /rigs/... route) tab is bound to the exact seat identity, and
// startup-file references carry the admitted source host when one is given.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { createTestRouter } from "./helpers/test-router.js";
import { LiveNodeDetails } from "../src/components/LiveNodeDetails.js";
import { DrawerSelectionContext, type DrawerSelection } from "../src/components/AppShell.js";
import { createMockEventSourceClass } from "./helpers/mock-event-source.js";

const detail = (logicalId: string) => ({
  rigId: "rig-1", rigName: "test-rig", logicalId, podId: null, canonicalSessionName: `${logicalId}@test-rig`,
  nodeKind: "agent", runtime: null, sessionStatus: null, startupStatus: null, restoreOutcome: "n-a",
  tmuxAttachCommand: null, resumeCommand: null, recoveryGuidance: null, latestError: null, model: null,
  agentRef: null, profile: null, resolvedSpecName: null, resolvedSpecVersion: null, cwd: null,
  startupFiles: [{ path: "role.md", deliveryHint: "guidance_merge", required: true, absolutePath: "/remote/specs/role.md" }],
  startupActions: [], recentEvents: [], infrastructureStartupCommand: null, peers: [],
  edges: { outgoing: [], incoming: [] }, transcript: { enabled: false, path: null, tailCommand: null },
  compactSpec: { name: null, version: null, profile: null, skillCount: 0, guidanceCount: 0 },
});

const fetchMock = vi.fn();
let OriginalEventSource: typeof EventSource | undefined;
beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const match = String(input).match(/^\/api\/rigs\/rig-1\/nodes\/([^/?]+)/);
    return match ? Response.json(detail(decodeURIComponent(match[1]!))) : Response.json([]);
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  OriginalEventSource = globalThis.EventSource;
  globalThis.EventSource = createMockEventSourceClass() as unknown as typeof EventSource;
});
afterEach(() => { cleanup(); if (OriginalEventSource) globalThis.EventSource = OriginalEventSource; });

describe("LiveNodeDetails seat seams", () => {
  it("uncontrolled: another seat rendered by the same component starts at Overview", async () => {
    function Harness() {
      const [seat, setSeat] = useState("dev.a");
      return (
        <>
          <button type="button" data-testid="switch-seat" onClick={() => setSeat("dev.b")} />
          <LiveNodeDetails rigId="rig-1" logicalId={seat} />
        </>
      );
    }
    render(createTestRouter({ component: () => <Harness />, path: "/test" }));
    await screen.findByText("dev.a@test-rig");
    fireEvent.click(screen.getByTestId("live-tab-details"));
    expect(screen.getByTestId("live-tab-details").getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByTestId("switch-seat"));
    await screen.findByText("dev.b@test-rig");
    expect(screen.getByTestId("live-tab-overview").getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByTestId("live-details-section")).toBeNull();
  });

  it("controlled: the tab follows the prop and choices are reported, not applied locally", async () => {
    const onTabChange = vi.fn();
    render(createTestRouter({ component: () => <LiveNodeDetails rigId="rig-1" logicalId="dev.a" activeTab="details" onTabChange={onTabChange} />, path: "/test" }));
    await screen.findByText("dev.a@test-rig");
    expect(screen.getByTestId("live-details-section")).toBeTruthy();
    fireEvent.click(screen.getByTestId("live-tab-overview"));
    expect(onTabChange).toHaveBeenCalledWith("overview");
    expect(screen.getByTestId("live-tab-details").getAttribute("aria-selected")).toBe("true");
  });

  it.each([
    ["vps-a", { originInstance: "vps-a" }],
    [undefined, {}],
  ])("startup file from source %s carries that exact origin (or leaves open-time capture to the drawer)", async (sourceHost, expected) => {
    const setSelection = vi.fn<(selection: DrawerSelection) => void>();
    render(createTestRouter({
      component: () => (
        <DrawerSelectionContext.Provider value={{ selection: null, setSelection }}>
          <LiveNodeDetails rigId="rig-1" logicalId="dev.a" activeTab="details" sourceHost={sourceHost} />
        </DrawerSelectionContext.Provider>
      ),
      path: "/test",
    }));
    fireEvent.click(await screen.findByTestId("live-startup-file-trigger-role.md"));
    await waitFor(() => expect(setSelection).toHaveBeenCalled());
    const data = (setSelection.mock.calls[0]![0] as { data: Record<string, unknown> }).data;
    expect(data).toMatchObject({ path: "role.md", absolutePath: "/remote/specs/role.md", ...expected });
    if (sourceHost === undefined) expect(data).not.toHaveProperty("originInstance");
  });
});

// AgentSpecDisplay origin (Library contract, gui-library-repair.md): the
// review's file chips carry the host that SERVED SeatSpecProvenance's review —
// this page's admitted seat source — never the current selection recaptured.
describe("LiveNodeDetails AgentSpecDisplay origin at the caller boundary", () => {
  const entry = { id: "agent-1", kind: "agent", name: "impl", version: "1.0.0", updatedAt: "2026-05-04T00:00:00.000Z", sourceType: "builtin", sourcePath: "/x/agent.yaml", relativePath: "x/agent.yaml" };
  const review = { kind: "agent", name: "impl", version: "1.0.0", raw: "", sourcePath: "/x/agent.yaml", sourceState: "library_item", libraryEntryId: "agent-1", description: null, profiles: [], resources: { plugins: [], skills: [], guidance: ["role.md"], subagents: [] }, startup: { files: [], actions: [] } };
  const libraryReads = () => fetchMock.mock.calls.map(([u]) => String(u)).filter((u) => u.startsWith("/api/specs/library"));

  beforeEach(() => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      const match = url.match(/^\/api\/rigs\/rig-1\/nodes\/([^/?]+)/);
      if (match) return Response.json({ ...detail(decodeURIComponent(match[1]!)), resolvedSpecName: "impl", resolvedSpecVersion: "1.0.0" });
      if (url.startsWith("/api/specs/library?kind=agent")) return Response.json([entry]);
      if (url.startsWith("/api/specs/library/agent-1/review")) return Response.json(review);
      if (url === "/api/plugins") return Response.json([]);
      return Response.json([]);
    });
  });

  function renderWithSource(initial: string | undefined) {
    const setSelection = vi.fn<(selection: DrawerSelection) => void>();
    let setSource: (next: string | undefined) => void = () => {};
    function Harness() {
      const [source, update] = useState(initial);
      setSource = update;
      return (
        <DrawerSelectionContext.Provider value={{ selection: null, setSelection }}>
          <LiveNodeDetails rigId="rig-1" logicalId="dev.a" activeTab="details" sourceHost={source} />
        </DrawerSelectionContext.Provider>
      );
    }
    render(createTestRouter({ component: () => <Harness />, path: "/test" }));
    return { setSelection, setSource: (next: string | undefined) => setSource(next) };
  }
  const openGuidance = async () => fireEvent.click(await screen.findByTestId("live-agent-guidance-file-trigger-role.md"));
  const lastPayload = (spy: ReturnType<typeof vi.fn>) => (spy.mock.calls.at(-1)![0] as { data: Record<string, unknown> }).data;

  it("a remote seat source reads that host's review and binds its chips to that host", async () => {
    const { setSelection } = renderWithSource("vps-a");
    await openGuidance();
    expect(lastPayload(setSelection)).toMatchObject({ path: "role.md", originInstance: "vps-a" });
    expect(libraryReads()).toEqual(expect.arrayContaining(["/api/specs/library?kind=agent&host=vps-a", "/api/specs/library/agent-1/review?host=vps-a"]));
  });

  it("switching the admitted source rebinds chips to the new serving host (no stale origin)", async () => {
    const { setSelection, setSource } = renderWithSource("local");
    await openGuidance();
    expect(lastPayload(setSelection)).toMatchObject({ originInstance: "local" });
    act(() => setSource("vps-a"));
    await waitFor(() => expect(libraryReads()).toContain("/api/specs/library/agent-1/review?host=vps-a"));
    await openGuidance();
    expect(lastPayload(setSelection)).toMatchObject({ originInstance: "vps-a" });
  });

  it("an unknown source (no assertion) reads no library and renders no origin-less chip", async () => {
    renderWithSource(undefined);
    expect(await screen.findByTestId("seat-spec-origin-unknown")).toBeTruthy();
    expect(screen.queryByTestId("live-agent-guidance-file-trigger-role.md")).toBeNull();
    expect(libraryReads()).toEqual([]);
  });
});
