// Catalog metadata, daemon preview authority and explicit Open contract.
// UI tests stub HTTP boundaries; they do not operate native terminal providers.

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { NodeInventoryEntry } from "../src/hooks/useNodeInventory.js";

// ── Catalog hooks are isolated from the preview HTTP contract under test. ──
// Node data is inlined INSIDE the factory: vitest hoists vi.mock above the file
// body, so a factory must not reference an outer const.
const host = vi.hoisted(() => ({ id: "local", known: true }));
vi.mock("../src/hooks/useHosts.js", () => ({
  useSelectedHostId: () => host.id,
  useHostSelection: () => ({ known: host.known, isLocal: host.id === "local" }),
}));
vi.mock("../src/hooks/useNodeInventory.js", () => ({
  useNodeInventory: () => ({
    data: [
      { rigId: "00000000-0000-4000-8000-000000000042", rigName: "v-openrig-build", logicalId: "orch.lead", canonicalSessionName: "orch-lead@acme-build", nodeKind: "agent", podNamespace: "orch", agentActivity: { state: "running" } },
      { rigId: "00000000-0000-4000-8000-000000000042", rigName: "v-openrig-build", logicalId: "dev.d1", canonicalSessionName: "dev-d1@acme-build", nodeKind: "agent", podNamespace: "dev", agentActivity: { state: "idle" } },
      { rigId: "00000000-0000-4000-8000-000000000042", rigName: "v-openrig-build", logicalId: "infra.daemon", canonicalSessionName: "infra@acme-build", nodeKind: "infrastructure", podNamespace: null },
    ],
  }),
}));
vi.mock("../src/hooks/useSlices.js", () => ({
  useSlices: () => ({ data: { slices: [{ name: "02-ride", missionId: "release-0.4.6", displayName: "02 ride" }] } }),
}));
vi.mock("../src/hooks/useTerminalViews.js", () => ({
  useTerminalViews: () => ({ data: { saved: [{ id: "watchtower", name: "Watchtower", members: [{ seat: "lead@acme-ops", readOnly: true }] }], rigs: ["acme-build"] } }),
}));
vi.mock("../src/hooks/useReviewAgents.js", () => ({ useReviewAgents: () => ({ data: undefined }) }));
vi.mock("../src/components/mission-control/missionControlAuth.js", () => ({ terminalAuthHeaders: () => ({}) }));

import {
  TerminalLauncher,
  buildLauncherViews,
  describeOpenResult,
  type OpenViewResult,
} from "../src/components/topology/TerminalLauncher.js";

const node = (partial: Partial<NodeInventoryEntry>): NodeInventoryEntry =>
  ({
    rigId: "rig-1",
    rigName: "acme",
    nodeKind: "agent",
    canonicalSessionName: null,
    logicalId: "x",
    podNamespace: null,
    ...partial,
  } as unknown as NodeInventoryEntry);

beforeEach(() => {
  host.id = "local";
  host.known = true;
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(preview()))));
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
  window.history.replaceState({}, "", "/");
});

describe("buildLauncherViews — the view library", () => {
  const slices = [{ name: "02-ride", missionId: "release-0.4.6", displayName: "02 ride" }];
  const saved = [{ id: "watchtower", name: "Watchtower", members: [{ seat: "a@r", readOnly: true }, { seat: "b@r", readOnly: true }] }];

  it("puts the rig first, interactive, with all agent seats (infra excluded)", () => {
    const views = buildLauncherViews({
      nodes: [node({ logicalId: "orch.lead", canonicalSessionName: "orch-lead@acme", podNamespace: "orch" }), node({ nodeKind: "infrastructure", canonicalSessionName: "infra@acme" })],
      rigId: "rig-1",
      rigName: "acme",
      slices: [],
      savedViews: [],
    });
    expect(views[0]).toMatchObject({ id: "rig:rig-1", kind: "rig", label: "acme" });
    expect(views[0]!.crossRig).toBeUndefined(); // a rig view is interactive
    expect(views[0]!.seats).toHaveLength(1); // infra excluded
  });

  it.each([null, ""])(
    "resolves a missing caller name from the matching node and never labels the rig with its UUID (%j)",
    (rigName) => {
      const rigId = "00000000-0000-4000-8000-000000000042";
      const views = buildLauncherViews({
        nodes: [node({ rigId, rigName: "v-openrig-build" })],
        rigId,
        rigName,
        slices: [],
        savedViews: [],
      });

      expect(views[0]!.label).toBe("v-openrig-build");
      expect(views[0]!.label).not.toContain(rigId);
    },
  );

  it("keeps an explicit nonblank caller name ahead of the node fallback", () => {
    const rigId = "00000000-0000-4000-8000-000000000042";
    const views = buildLauncherViews({
      nodes: [node({ rigId, rigName: "node-name" })],
      rigId,
      rigName: "summary-name",
      slices: [],
      savedViews: [],
    });

    expect(views[0]!.label).toBe("summary-name");
  });

  it("uses the exact honest unavailable label for mismatched or blank node names", () => {
    const rigId = "00000000-0000-4000-8000-000000000042";
    const views = buildLauncherViews({
      nodes: [
        node({ rigId: "00000000-0000-4000-8000-000000000099", rigName: "another-rig" }),
        node({ rigId, rigName: "   " }),
      ],
      rigId,
      rigName: " ",
      slices: [],
      savedViews: [],
    });

    expect(views[0]!.label).toBe("Rig name unavailable");
  });

  it("groups catalog members by podNamespace without guessing terminal readiness", () => {
    const views = buildLauncherViews({
      nodes: [
        node({ logicalId: "dev.d1", canonicalSessionName: "dev-d1@acme", podNamespace: "dev" }),
        node({ logicalId: "dev.d2", canonicalSessionName: null, podNamespace: "dev" }),
        node({ logicalId: "orch.lead", canonicalSessionName: "orch-lead@acme", podNamespace: "orch" }),
      ],
      rigId: "rig-1",
      slices: [],
      savedViews: [],
    });
    const dev = views.find((v) => v.id === "pod:rig-1/dev");
    expect(dev).toBeTruthy();
    expect(dev!.seats).toHaveLength(2);
    expect(dev!.seats!.map((s) => s.session)).toEqual(["dev-d1@acme", "dev.d2"]);
    expect(dev!.seats!.every((s) => !("live" in s) && !("reason" in s))).toBe(true);
    expect(views.some((v) => v.id === "pod:rig-1/orch")).toBe(true);
  });

  it("adds derived mission + slice views (seats null, read-only by construction)", () => {
    const views = buildLauncherViews({ nodes: [], rigId: "rig-1", slices, savedViews: [] });
    const mission = views.find((v) => v.id === "mission:release-0.4.6");
    const slice = views.find((v) => v.id === "slice:02-ride");
    expect(mission).toMatchObject({ kind: "mission", seats: null, crossRig: true });
    expect(slice).toMatchObject({ kind: "slice", seats: null, crossRig: true });
  });

  it("marks a fully read-only saved view as read-only (crossRig)", () => {
    const views = buildLauncherViews({ nodes: [], rigId: "rig-1", slices: [], savedViews: saved });
    expect(views.find((v) => v.id === "saved:watchtower")).toMatchObject({ kind: "saved", crossRig: true });
  });

  it("a saved view with an interactive member is NOT read-only", () => {
    const mixed = [{ id: "mix", name: "Mix", members: [{ seat: "a@r", readOnly: true }, { seat: "b@r" }] }];
    const views = buildLauncherViews({ nodes: [], rigId: "rig-1", slices: [], savedViews: mixed });
    expect(views.find((v) => v.id === "saved:mix")!.crossRig).toBe(false);
  });
});

describe("describeOpenResult — Guard G2: a 200 body is authoritative, not auto-green", () => {
  const base = (over: Partial<OpenViewResult>): OpenViewResult => ({
    provider: "herdr", ok: true, opened: [], absent: [], degraded: [], pages: 0, ...over,
  });

  it("200 provider-failure (ok:false, opened:[], code herdr_unavailable) → NOT success", () => {
    const d = describeOpenResult(base({ ok: false, opened: [], code: "herdr_unavailable", error: "no binary" }));
    expect(d.ok).toBe(false);
    expect(d.headline).toContain("No tiles opened");
    expect(d.headline).toContain("herdr_unavailable");
    expect(d.headline).toContain("no binary");
  });

  it("200 zero-pane with absent/degraded → failure, seats NAMED with reasons (not a count)", () => {
    const d = describeOpenResult(
      base({
        ok: false,
        opened: [],
        absent: [{ seat: "a@r", host: null, reason: "not alive" }],
        degraded: [{ seat: "b@r", host: "front-door", reason: "host front-door is http-registered; tiles need ssh" }],
      }),
    );
    expect(d.ok).toBe(false);
    expect(d.disclosure).toContain("a@r: not alive");
    expect(d.disclosure).toContain("b@r (front-door): host front-door is http-registered; tiles need ssh");
  });

  it("200 partial success (>=1 opened) → success PLUS named absent/degraded disclosure", () => {
    const d = describeOpenResult(
      base({ ok: true, opened: ["x@r"], absent: [{ seat: "y@r", host: null, reason: "not alive" }] }),
    );
    expect(d.ok).toBe(true);
    expect(d.headline).toBe("Opened 1 in herdr");
    expect(d.disclosure).toContain("y@r: not alive");
  });
});

describe("TerminalLauncher — mounts with its live hooks (collapsed)", () => {
  it("renders the collapsed trigger button", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    render(
      <QueryClientProvider client={qc}>
        <TerminalLauncher rigId="rig-1" rigName="acme-build" />
      </QueryClientProvider>,
    );
    const btn = screen.getByTestId("terminal-launcher-button");
    expect(btn.textContent).toContain("Open in terminal");
  });

  it("uses one resolved canonical label in the deep-linked header and rig row without exposing the UUID", () => {
    const rigId = "00000000-0000-4000-8000-000000000042";
    window.history.replaceState(
      {},
      "",
      `/topology/rig/${rigId}?launcher=open&provider=cmux&view=${encodeURIComponent(`rig:${rigId}`)}`,
    );
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });

    render(
      <QueryClientProvider client={qc}>
        <TerminalLauncher rigId={rigId} rigName={null} />
      </QueryClientProvider>,
    );

    const dialog = screen.getByTestId("terminal-launcher-dialog");
    const rigRow = screen.getByTestId(`launcher-view-rig:${rigId}`);
    expect(dialog.textContent).toContain("v-openrig-build · topology");
    expect(rigRow.textContent).toContain("v-openrig-build");
    expect(dialog.textContent).not.toContain(rigId);
  });

  it("keeps the deep-linked dialog inside a one-rem viewport inset with vertically reachable content", () => {
    window.history.replaceState({}, "", "/topology/rig/rig-1?launcher=open");
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });

    render(
      <QueryClientProvider client={qc}>
        <TerminalLauncher rigId="rig-1" rigName="acme-build" />
      </QueryClientProvider>,
    );

    const classes = screen.getByTestId("terminal-launcher-dialog").className;
    expect(classes).toContain("w-[calc(100vw-2rem)]");
    expect(classes).toContain("max-h-[calc(100vh-2rem)]");
    expect(classes).toContain("overflow-y-auto");
    expect(classes).not.toContain("overflow-hidden");
  });
});

function preview(over: Record<string, unknown> = {}) {
  const pane = { seat: "confirmed@rig", label: "Confirmed", readOnly: true, paneCommand: "tmux attach -r" };
  return {
    view: "rig:rig-1", provider: "herdr", planId: "validated-plan", status: { available: true },
    composed: { id: "rig:rig-1", opened: [pane], pages: [[pane]],
      absent: [{ seat: "saved-stopped@rig", host: null, reason: "not alive" }],
      degraded: [{ seat: "remote@rig", host: "http-host", reason: "tiles need ssh" }] },
    grids: [{ columns: 1, rows: 1, blanks: 0 }], ...over,
  };
}

function openLauncher() {
  window.history.replaceState({}, "", "/topology/rig/rig-1?launcher=open");
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return { qc, ...render(<QueryClientProvider client={qc}><TerminalLauncher rigId="rig-1" rigName="acme" /></QueryClientProvider>) };
}

describe("TerminalLauncher canonical preview contract", () => {
  it("uses daemon readiness and sends the exact preview fingerprint only after explicit Open", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async (url, options) => new Response(JSON.stringify(
      options?.method === "POST"
        ? { provider: "herdr", ok: true, opened: ["confirmed@rig"], absent: [], degraded: [], pages: 1 }
        : preview(),
    )));
    openLauncher();
    await waitFor(() => expect(screen.getByTestId("launcher-layout").textContent).toContain("1 pane"));
    expect(screen.getByTestId("terminal-launcher-dialog").textContent).toContain("saved-stopped@rig: not alive");
    expect(screen.getByTestId("terminal-launcher-dialog").textContent).toContain("remote@rig (http-host): tiles need ssh");
    expect(screen.getByTestId("launcher-view-rig:rig-1").textContent).toContain("2 unavailable");
    expect(fetchMock.mock.calls.every(([, options]) => options?.method !== "POST")).toBe(true);
    fireEvent.click(screen.getByTestId("launcher-open"));
    await waitFor(() => expect(fetchMock.mock.calls.some(([, options]) => options?.method === "POST")).toBe(true));
    const call = fetchMock.mock.calls.find(([, options]) => options?.method === "POST")!;
    expect(call[0]).toBe("/api/terminal/open");
    expect(JSON.parse(String(call[1]!.body))).toEqual({ provider: "herdr", view: "rig:rig-1", expectedPlan: "validated-plan" });
  });

  it("never enables Open while preview is unresolved or the provider is unavailable", async () => {
    vi.mocked(fetch).mockImplementation(() => new Promise(() => {}));
    const mounted = openLauncher();
    expect((screen.getByTestId("launcher-open") as HTMLButtonElement).disabled).toBe(true);
    mounted.unmount();
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(preview({ status: { available: false } }))));
    openLauncher();
    await waitFor(() => expect(screen.getByTestId("terminal-launcher-dialog").textContent).toContain("herdr unavailable"));
    expect((screen.getByTestId("launcher-open") as HTMLButtonElement).disabled).toBe(true);
  });

  it("drops the old plan on provider changes until a new preview lands", async () => {
    vi.mocked(fetch).mockImplementation(async (url) => String(url).includes("provider=cmux")
      ? new Promise(() => {}) : new Response(JSON.stringify(preview())));
    openLauncher();
    await waitFor(() => expect((screen.getByTestId("launcher-open") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId("launcher-provider-cmux"));
    expect((screen.getByTestId("launcher-open") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("launcher-layout").textContent).not.toContain("1 pane");
  });

  it("uses explicit saved view arguments and previews saved membership without claiming it is live", async () => {
    openLauncher();
    const row = screen.getByTestId("launcher-view-saved:watchtower");
    expect(row.textContent).not.toContain("1 live");
    fireEvent.click(row);
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes("view=saved%3Awatchtower"))).toBe(true));
  });

  it("renders daemon page grids and filler cells without claiming a configurable show limit", async () => {
    const first = preview();
    const panes = Array.from({ length: 10 }, (_, i) => ({ ...first.composed.opened[0], seat: `seat-${i}` }));
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(preview({
      composed: { ...first.composed, opened: panes, pages: [panes.slice(0, 9), panes.slice(9)] },
      grids: [{ columns: 3, rows: 3, blanks: 0 }, { columns: 1, rows: 1, blanks: 0 }],
    }))));
    openLauncher();
    await waitFor(() => expect(screen.getByTestId("launcher-layout").textContent).toContain("Page 1/2"));
    expect(screen.getByTestId("launcher-open").textContent).toContain("all 2 pages");
    fireEvent.click(screen.getByTestId("launcher-next-page"));
    expect(screen.getByTestId("launcher-layout").textContent).toContain("Page 2/2");
    expect(screen.getByTestId("terminal-launcher-dialog").textContent).not.toContain("show-limit");
  });

  it("keeps unknown host selection from launching a local terminal", () => {
    host.known = false;
    openLauncher();
    expect((screen.getByTestId("launcher-open") as HTMLButtonElement).disabled).toBe(true);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});

describe("TerminalLauncher preview failures and scope changes", () => {
  it("rejects invalid geometry rather than opening a plan it cannot render", async () => {
    vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify(preview({ grids: [{ columns: 0, rows: 1, blanks: 0 }] }))));
    openLauncher();
    await waitFor(() => expect(screen.getByTestId("terminal-launcher-dialog").textContent).toContain("could not be verified"));
    expect((screen.getByTestId("launcher-open") as HTMLButtonElement).disabled).toBe(true);
  });

  it("blocks empty plans and reports the daemon preview error without a fallback roster", async () => {
    const first = preview();
    vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify(preview({ composed: { ...first.composed, opened: [], pages: [] }, grids: [] }))));
    const mounted = openLauncher();
    await waitFor(() => expect(screen.getByTestId("terminal-launcher-dialog").textContent).toContain("Nothing attachable"));
    expect((screen.getByTestId("launcher-open") as HTMLButtonElement).disabled).toBe(true);
    mounted.unmount();
    vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify({ code: "view_not_found", error: "unknown view" }), { status: 404 }));
    openLauncher();
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("unknown view"));
    expect((screen.getByTestId("launcher-open") as HTMLButtonElement).disabled).toBe(true);
  });

  it("requires the refreshed plan after the daemon rejects changed membership", async () => {
    let revision = 0;
    vi.mocked(fetch).mockImplementation(async (_url, options) => {
      if (options?.method === "POST") {
        revision++;
        return new Response(JSON.stringify({ provider: "herdr", ok: false, opened: [], absent: [], degraded: [], pages: 0,
          code: "preview_changed", error: "View membership or layout changed. Refresh the preview before Open; nothing was launched." }), { status: 409 });
      }
      return new Response(JSON.stringify(preview({ planId: `plan-${revision}` })));
    });
    openLauncher();
    await waitFor(() => expect((screen.getByTestId("launcher-open") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId("launcher-open"));
    await waitFor(() => expect(screen.getByTestId("launcher-open-error").textContent).toContain("nothing was launched"));
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.filter(([, options]) => options?.method !== "POST")).toHaveLength(2));
    await waitFor(() => expect((screen.getByTestId("launcher-open") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId("launcher-open"));
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(2));
    expect(vi.mocked(fetch).mock.calls.filter(([, options]) => options?.method === "POST").map(([, options]) => JSON.parse(String(options!.body)).expectedPlan)).toEqual(["plan-0", "plan-1"]);
  });

  it("drops an attachable local plan immediately when selection changes to remote", async () => {
    const mounted = openLauncher();
    await waitFor(() => expect((screen.getByTestId("launcher-open") as HTMLButtonElement).disabled).toBe(false));
    host.id = "remote";
    mounted.rerender(<QueryClientProvider client={mounted.qc}><TerminalLauncher rigId="rig-1" rigName="acme" /></QueryClientProvider>);
    expect((screen.getByTestId("launcher-open") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId("launcher-open"));
    expect(vi.mocked(fetch).mock.calls.every(([, options]) => options?.method !== "POST")).toBe(true);
  });

  it("blocks a cached plan when refreshing it fails", async () => {
    openLauncher();
    await waitFor(() => expect((screen.getByTestId("launcher-open") as HTMLButtonElement).disabled).toBe(false));
    vi.mocked(fetch).mockRejectedValue(new Error("preview offline"));
    fireEvent.click(screen.getByTestId("launcher-refresh-preview"));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("preview offline"));
    expect((screen.getByTestId("launcher-open") as HTMLButtonElement).disabled).toBe(true);
  });
});

it("does not substitute the rig for an unknown deep-linked target", async () => {
  window.history.replaceState({}, "", "/topology/rig/rig-1?launcher=open&view=saved:deleted");
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(<QueryClientProvider client={qc}><TerminalLauncher rigId="rig-1" rigName="acme" /></QueryClientProvider>);
  expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  expect((screen.getByTestId("launcher-open") as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByTestId("terminal-launcher-dialog").textContent).toContain("Select an available view");
});
