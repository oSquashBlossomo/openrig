// Connections context journeys (TUI connections-model.ts:91–123) on the
// actual ConnectionsPage with the actual canonical, Pulse and spec-library
// hooks, a real TanStack Router and QueryClient. Only `fetch` is replaced;
// bodies are fictional (operator twin fixtures plus explicit inventory).

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { ConnectionsPage } from "../src/components/operator/ConnectionsPage.js";
import { validateConnectionsSearch } from "../src/components/operator/operator-search.js";
import { humanRequestSample, matchAuthoredSpec, resolveInbound } from "../src/components/operator/connections-model.js";
import { topologyTarget } from "../src/components/topology/topology-navigation.js";
import { operatorTwinBody, twinConnections } from "../twin/operator-fixtures.js";

const RIGS = [
  { id: "rig_alpha", name: "acme-build", nodeCount: 2, latestSnapshotAt: null, latestSnapshotId: null, lifecycleState: "running" },
  { id: "rig_bravo", name: "acme-comms", nodeCount: 1, latestSnapshotAt: null, latestSnapshotId: null, lifecycleState: "degraded" },
  { id: "rig_gamma", name: "acme-core", nodeCount: 1, latestSnapshotAt: null, latestSnapshotId: null, lifecycleState: "stopped" },
];
const node = (rigId: string, logicalId: string, session: string, nodeKind = "agent") => ({ rigId, logicalId, canonicalSessionName: session, podNamespace: logicalId.split(".")[0], nodeKind, terminalActive: true });
const NODES: Record<string, unknown[]> = {
  rig_alpha: [node("rig_alpha", "lead.coordinator", "coordinator@acme-build"), node("rig_alpha", "builders.builder2", "builder2@acme-build"), node("rig_alpha", "infra.proxy", "proxy@acme-build", "infrastructure")],
  rig_bravo: [node("rig_bravo", "desk.editor", "editor@acme-comms")],
  rig_gamma: [node("rig_gamma", "core.keeper", "keeper@acme-core")],
};
const libraryEntry = (id: string, name: string, version: string, relativePath: string) => ({
  id, kind: "rig", name, version, sourceType: "user_file", sourcePath: `/home/demo/specs/${relativePath}`, relativePath, updatedAt: "2025-09-01T00:00:00.000Z",
});
const LIBRARY = [
  libraryEntry("rig:build-a", "acme-build", "0.2", "build/a.yaml"),
  libraryEntry("rig:build-b", "acme-build", "0.3", "build/b.yaml"),
  libraryEntry("rig:comms", "acme-comms", "0.2", "comms.yaml"),
];

interface Call { method: string; url: URL }
type Override = (url: URL) => Response | undefined;
let qc: QueryClient | undefined;
afterEach(() => { cleanup(); qc?.clear(); qc = undefined; vi.unstubAllGlobals(); });

function transport(override?: Override) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://local");
    calls.push({ method: init?.method ?? "GET", url });
    const custom = override?.(url);
    if (custom) return custom;
    if (url.pathname === "/api/hosts") return Response.json({ ownName: "demo-studio", selected: "far-host", hosts: [] });
    if (url.pathname === "/api/rigs/summary") return Response.json(RIGS);
    const nodes = /^\/api\/rigs\/([^/]+)\/nodes$/.exec(url.pathname);
    if (nodes) return Response.json(NODES[decodeURIComponent(nodes[1]!)] ?? []);
    if (url.pathname === "/api/specs/library") return Response.json(LIBRARY);
    const served = operatorTwinBody(url.pathname, url.searchParams);
    return served ? Response.json(served.body, { status: served.status }) : Response.json({ error: "not_found" }, { status: 404 });
  }));
  return calls;
}

function mount(initial = "/settings/connections") {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const client = qc;
  const root = createRootRoute({ component: () => <QueryClientProvider client={client}><Outlet /></QueryClientProvider> });
  const page = createRoute({ getParentRoute: () => root, path: "/settings/connections", validateSearch: validateConnectionsSearch, component: ConnectionsPage });
  const router = createRouter({ routeTree: root.addChildren([page]), history: createMemoryHistory({ initialEntries: [initial] }) });
  render(<RouterProvider router={router} />);
  return router;
}

const fail = () => Response.json({ error: "source_failed" }, { status: 503 });

describe("Connections · inbound destination", () => {
  it("links the exact served seat on the connected instance (raw identity, sourceHost=local), even with a remote selection", async () => {
    const calls = transport();
    mount();
    const link = await screen.findByTestId("connections-inbound-seat");
    const expected = topologyTarget({ scope: { kind: "seat", rigId: "rig_alpha", logicalId: "lead.coordinator" }, sourceHost: "local" })!;
    expect(link.getAttribute("href")).toBe(expected.href);
    expect(screen.getByTestId("connections-inbound").getAttribute("data-state")).toBe("matched");
    // Connected-instance reads only: the remote selection never adds host=.
    expect(calls.some((c) => c.url.searchParams.has("host"))).toBe(false);
  });

  it("an unmatched session in a complete inventory stays text; a partial inventory makes it unknown", async () => {
    transport((url) => (url.pathname === "/api/gateway/connections"
      ? Response.json({ ...twinConnections, configuration: { ...twinConnections.configuration!, inboundDestination: "ghost@acme-build" } }) : undefined));
    mount();
    await waitFor(() => expect(screen.getByTestId("connections-inbound").getAttribute("data-state")).toBe("not-found"));
    expect(screen.queryByTestId("connections-inbound-seat")).toBeNull();
    cleanup(); qc?.clear();

    transport((url) => {
      if (url.pathname === "/api/gateway/connections") return Response.json({ ...twinConnections, configuration: { ...twinConnections.configuration!, inboundDestination: "ghost@acme-build" } });
      if (url.pathname === "/api/rigs/rig_gamma/nodes") return fail();
      return undefined;
    });
    mount();
    await waitFor(() => expect(screen.getByTestId("connections-inbound").getAttribute("data-state")).toBe("unknown"));
    expect(screen.getByTestId("connections-inbound-unknown").textContent).toMatch(/seats unreadable for rig_gamma.*No seat is guessed/);
  });

  it("never splits a display name, and lists duplicate exact sessions without choosing one", async () => {
    const pulse = (sessions: Array<[string, string, string]>) => ({
      inventory: { state: "available", data: RIGS, readAt: 1, error: null },
      nodeSources: RIGS.map((rig) => ({ rig, source: { state: "available", data: sessions.filter(([r]) => r === rig.id).map(([r, l, s]) => node(r, l, s)), readAt: 1, error: null } })),
      truncatedRigCount: 0, truncatedSeatCount: 0,
    }) as never;
    expect(resolveInbound("coordinator", pulse([["rig_alpha", "lead.coordinator", "coordinator@acme-build"]]), false).kind).toBe("not-found");
    const twice = resolveInbound("dup@x", pulse([["rig_alpha", "a.one", "dup@x"], ["rig_bravo", "b.one", "dup@x"]]), false);
    expect(twice).toMatchObject({ kind: "ambiguous", seats: [{ rigId: "rig_alpha" }, { rigId: "rig_bravo" }] });
  });
});

describe("Connections · human request sample", () => {
  it("joins loaded windows by exact address: at most three, with qitem/source/state and a sample-not-total disclosure", async () => {
    transport();
    const router = mount("/settings/connections?human=k1");
    const detail = await screen.findByTestId("connections-human-detail");
    const rows = await within(detail).findAllByTestId("connections-human-request");
    expect(rows).toHaveLength(3);
    expect(rows[0]!.textContent).toMatch(/pending.*q-twin-101.*from coordinator@acme-build/s);
    expect(within(detail).getByTestId("connections-human-requests-coverage").textContent).toMatch(/Showing 3 of 4 matched in loaded windows/);
    expect(within(rows[0]!).getByTestId("connections-human-request-open").getAttribute("href")).toBe("/for-you?view=attention&item=queue%3Aq-twin-101");
    expect(detail.textContent).not.toContain("q-twin-105"); // another address
    expect(router.state.location.search).toMatchObject({ human: "k1" });
  });

  it("failed queue reads are unknown, never zero; partial windows disclose coverage", async () => {
    transport((url) => (url.pathname === "/api/queue/list" ? fail() : undefined));
    mount("/settings/connections?human=k2");
    const state = await screen.findByTestId("connections-human-requests-state");
    await waitFor(() => expect(screen.getByTestId("connections-human-requests-state").getAttribute("data-state")).toBe("unknown"));
    expect(state.textContent).toMatch(/not zero/);
    cleanup(); qc?.clear();

    transport((url) => (url.pathname === "/api/queue/list" && url.searchParams.get("state") === "blocked" ? fail() : undefined));
    mount("/settings/connections?human=k2");
    await waitFor(() => expect(screen.getByTestId("connections-human-request")).toBeTruthy());
    expect(screen.getByTestId("connections-human-requests-coverage").textContent).toMatch(/Unavailable: blocked/);
  });

  it("model: an empty successful window set is a genuine empty sample", () => {
    const source = (data: unknown[]) => ({ state: "available", data, readAt: 1, error: null });
    const pulse = { sources: { attention: source([]), pending: source([]), inProgress: source([]), blocked: source([]), finished: source([]) } } as never;
    expect(humanRequestSample("human:x", pulse)).toMatchObject({ rows: [], unknown: false, unavailableWindows: [], boundedWindows: [] });
  });
});

describe("Connections · work and configuration", () => {
  it("shows lifecycle, seat counts, exact authored spec links and duplicate-name ambiguity", async () => {
    transport((url) => (url.pathname === "/api/rigs/rig_gamma/spec.json" ? fail() : undefined));
    mount();
    const alpha = await screen.findByTestId("connections-rig-rig_alpha");
    expect(alpha.textContent).toMatch(/running/);
    await waitFor(() => expect(screen.getByTestId("connections-rig-seats-rig_alpha").textContent).toBe("2 seats"));
    // Two library entries share "acme-build": both listed, none chosen.
    const ambiguous = await screen.findByTestId("connections-rig-spec-ambiguous");
    expect(within(ambiguous).getAllByTestId("connections-rig-spec-candidate").map((a) => a.getAttribute("href")))
      .toEqual(["/specs/library/rig%3Abuild-a?source=local", "/specs/library/rig%3Abuild-b?source=local"]);
    const comms = await within(screen.getByTestId("connections-rig-rig_bravo")).findByTestId("connections-rig-spec-link");
    expect(comms.getAttribute("href")).toBe("/specs/library/rig%3Acomms?source=local");
    expect(await screen.findByTestId("connections-rig-spec-error-rig_gamma")).toBeTruthy();
    expect(within(screen.getByTestId("connections-rig-rig_alpha")).getByTestId("connections-rig-link").getAttribute("href"))
      .toBe(topologyTarget({ scope: { kind: "rig", rigId: "rig_alpha" }, sourceHost: "local" })!.href);
  });

  it("discloses unreadable seats and an unavailable rig inventory instead of counts or 'no rigs'", async () => {
    transport((url) => (url.pathname === "/api/rigs/rig_bravo/nodes" ? fail() : undefined));
    mount();
    await waitFor(() => expect(screen.getByTestId("connections-rig-seats-rig_bravo").textContent).toBe("seat inventory unavailable"));
    expect(screen.getByTestId("connections-work-gap").textContent).toMatch(/rig_bravo/);
    cleanup(); qc?.clear();
    transport((url) => (url.pathname === "/api/rigs/summary" ? fail() : undefined));
    mount();
    await waitFor(() => expect(screen.getByTestId("connections-work-state").textContent).toMatch(/Rig inventory unavailable.*not absent/));
  });

  it("a failed library refresh is unavailable, with earlier matches dated and never shown as current; recovery restores", async () => {
    let failing = false;
    transport((url) => (failing && url.pathname === "/api/specs/library" ? fail() : undefined));
    mount();
    const bravo = await screen.findByTestId("connections-rig-rig_bravo");
    await within(bravo).findByTestId("connections-rig-spec-link");
    failing = true;
    await act(async () => { await qc!.refetchQueries({ queryKey: ["spec-library", "rig", "local"], exact: true }); });
    await waitFor(() => expect(screen.getByTestId("connections-rig-spec-rig_bravo").getAttribute("data-state")).toBe("unavailable"));
    expect(within(bravo).queryByTestId("connections-rig-spec-link")).toBeNull();
    const retained = within(bravo).getByTestId("connections-rig-spec-retained");
    expect(retained.textContent).toMatch(/Earlier read at .*not current/);
    expect(retained.querySelector("time")).toBeTruthy();
    expect(within(retained).getByTestId("connections-rig-spec-retained-link").getAttribute("href")).toBe("/specs/library/rig%3Acomms?source=local");
    // The ambiguous name is not resolved from retained data either.
    expect(screen.queryByTestId("connections-rig-spec-ambiguous")).toBeNull();
    failing = false;
    await act(async () => { await qc!.refetchQueries({ queryKey: ["spec-library", "rig", "local"], exact: true }); });
    await waitFor(() => expect(screen.getByTestId("connections-rig-spec-rig_bravo").getAttribute("data-state")).toBe("matched"));
  });

  it("a visible Retry re-reads only the library: retained dated links stay through a failed retry; success restores current", async () => {
    let failing = false;
    const calls = transport((url) => (failing && url.pathname === "/api/specs/library" ? fail() : undefined));
    mount();
    const bravo = await screen.findByTestId("connections-rig-rig_bravo");
    await within(bravo).findByTestId("connections-rig-spec-link");
    expect(screen.queryByTestId("connections-library-retry")).toBeNull();
    failing = true;
    await act(async () => { await qc!.refetchQueries({ queryKey: ["spec-library", "rig", "local"], exact: true }); });
    const retry = await screen.findByTestId("connections-library-retry");
    const libraryReads = () => calls.filter((c) => c.url.pathname === "/api/specs/library").length;
    const gatewayReads = () => calls.filter((c) => c.url.pathname === "/api/gateway/connections").length;
    const before = { library: libraryReads(), gateway: gatewayReads() };

    fireEvent.click(retry); // still failing
    await waitFor(() => expect(libraryReads()).toBe(before.library + 1));
    await waitFor(() => expect((screen.getByTestId("connections-library-retry") as HTMLButtonElement).disabled).toBe(false));
    expect(screen.getByTestId("connections-rig-spec-rig_bravo").getAttribute("data-state")).toBe("unavailable");
    expect(within(bravo).getByTestId("connections-rig-spec-retained-link").getAttribute("href")).toBe("/specs/library/rig%3Acomms?source=local");

    failing = false;
    fireEvent.click(screen.getByTestId("connections-library-retry"));
    await waitFor(() => expect(screen.getByTestId("connections-rig-spec-rig_bravo").getAttribute("data-state")).toBe("matched"));
    expect(libraryReads()).toBe(before.library + 2);
    expect(gatewayReads()).toBe(before.gateway); // the library retry does not imply a gateway refresh
    expect(screen.queryByTestId("connections-library-retry")).toBeNull();
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("model: matches authored specs by exact kind+name only", () => {
    expect(matchAuthoredSpec("acme-comms", LIBRARY as never, new Error("503"), 5)).toMatchObject({ kind: "unavailable", retained: { kind: "matched" }, retainedAt: 5 });
    expect(matchAuthoredSpec("acme-build", LIBRARY as never, null).kind).toBe("ambiguous");
    expect(matchAuthoredSpec("acme", LIBRARY as never, null).kind).toBe("absent");
    expect(matchAuthoredSpec("acme-comms", undefined, new Error("x"))).toEqual({ kind: "unavailable", message: "x" });
  });
});

describe("Connections · return continuity and passivity", () => {
  it("keeps the humans filter and selection in the URL across detail and Back; browsing is GET-only", async () => {
    const calls = transport();
    const router = mount();
    fireEvent.change(await screen.findByTestId("connections-humans-filter"), { target: { value: "avery" } });
    await waitFor(() => expect(router.state.location.search).toMatchObject({ q: "avery" }));
    expect(screen.queryByTestId("connections-human-human-blake")).toBeNull();
    fireEvent.click(screen.getByTestId("connections-human-human-avery"));
    await waitFor(() => expect(router.state.location.search).toMatchObject({ q: "avery", human: "k1" }));
    await screen.findByTestId("connections-human-detail");
    await act(async () => { router.history.back(); });
    await waitFor(() => expect(screen.queryByTestId("connections-human-detail")).toBeNull());
    expect((screen.getByTestId("connections-humans-filter") as HTMLInputElement).value).toBe("avery");
    expect(calls.every((c) => c.method === "GET")).toBe(true);
    expect(calls.some((c) => /slack|verify|enable|readiness|setup/.test(c.url.pathname) && !c.url.pathname.endsWith("/manifest"))).toBe(false);
  });

  it("a selected person hidden by the filter remains inspectable", async () => {
    transport();
    mount("/settings/connections?human=k2&q=avery");
    expect((await screen.findByTestId("connections-human-detail")).textContent).toContain("human-blake");
  });

  it("dates the gateway matrix in the display zone and keeps the exact ISO on the element", async () => {
    transport();
    mount();
    const verified = await screen.findByTestId("connections-matrix-verified");
    expect(verified.querySelector("time")?.getAttribute("datetime")).toBe("2025-09-01T01:42:00.000Z");
    expect(verified.textContent).not.toContain("2025-09-01T01:42:00.000Z");
    expect(screen.getByTestId("connections-matrix-running").querySelector("time")).toBeTruthy();
  });
});
