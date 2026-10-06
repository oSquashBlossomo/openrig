// TopologyTableView through the ACTUAL bounded inventory reader
// (lib/fleet-inventory-reads.ts readNodeInventory, real operatorRead
// transport over a fetch fixture). Partial evidence, an older successful
// snapshot and a failed read are distinct observations: the table shows one
// per rig, dated, and never splices or relabels them.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@tanstack/react-router", async (importActual) => ({ ...(await importActual<object>()), useNavigate: () => vi.fn() }));
import { TopologyTableView, rigInventoryView } from "../src/components/topology/TopologyTableView.js";
import { NodeInventoryPartialReadError } from "../src/lib/fleet-inventory-reads.js";

const row = (rigId: string, logicalId: string, extra: Record<string, unknown> = {}) => ({
  rigId, rigName: "alpha", logicalId, podId: null, podNamespace: "desk", canonicalSessionName: `${logicalId}@alpha`,
  nodeKind: "agent", runtime: "claude-code", sessionStatus: "running", startupStatus: "ready", restoreOutcome: "n-a",
  tmuxAttachCommand: null, resumeCommand: null, latestError: null, contextUsage: null, ...extra,
});

let inventory: () => Response | Promise<Response>;
const fetchMock = vi.fn();
let qc: QueryClient;

beforeEach(() => {
  inventory = () => Response.json([row("rig-1", "desk.a")]);
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/api/rigs/summary")) return Response.json([{ id: "rig-1", name: "alpha", nodeCount: 2 }]);
    if (url.startsWith("/api/rigs/rig-1/nodes")) return inventory();
    return Response.json([]);
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});
afterEach(() => { cleanup(); qc?.clear(); });

function renderTable(selectedHost = "local") {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  qc.setQueryData(["hosts"], { ownName: "fixture", selected: selectedHost, hosts: selectedHost === "local" ? [] : [{ id: selectedHost, transport: "http", url: "http://h.invalid", selected: true, status: "reachable" }] });
  render(<QueryClientProvider client={qc}><TopologyTableView /></QueryClientProvider>);
}
const rows = () => screen.queryAllByTestId(/^topology-table-row-/);
const refetchInventory = (host = "local") => act(() => { void qc.refetchQueries({ queryKey: ["rig", "rig-1", "nodes", host] }); });

describe("table inventory through the bounded reader", () => {
  it("reads with the query signal under the exact source host", async () => {
    renderTable("vps-a");
    await waitFor(() => expect(rows()).toHaveLength(1));
    const call = fetchMock.mock.calls.find(([u]) => String(u).startsWith("/api/rigs/rig-1/nodes"))!;
    expect(call[0]).toBe("/api/rigs/rig-1/nodes?host=vps-a");
    expect((call[1] as RequestInit).signal).toBeInstanceOf(AbortSignal);
    expect(rows()[0]!.getAttribute("data-inventory-state")).toBe("current");
  });

  it("mixed valid / malformed / foreign rows: only verified same-rig rows, with rejected count and receipt time", async () => {
    inventory = () => Response.json([row("rig-1", "desk.a"), { logicalId: null }, row("rig-other", "desk.foreign"), row("rig-1", "desk.b", { contextUsage: null, agentActivity: null })]);
    renderTable();
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(rows().map((r) => r.getAttribute("data-testid"))).toEqual(["topology-table-row-desk.a", "topology-table-row-desk.b"]);
    expect(rows().every((r) => r.getAttribute("data-inventory-state") === "partial")).toBe(true);
    const notice = screen.getByTestId("topology-table-inventory-partial");
    expect(notice.textContent).toContain("2 verified agents shown; 2 records rejected as malformed or foreign");
    expect(within(notice).getByRole("time" as never, { hidden: true }) ?? notice.querySelector("time")).toBeTruthy();
    expect(screen.queryByTestId("topology-table-rig-errors")).toBeNull();
  });

  it("all-invalid is not a successful empty inventory", async () => {
    inventory = () => Response.json([{ logicalId: null }, row("rig-other", "x")]);
    renderTable();
    const notice = await screen.findByTestId("topology-table-inventory-partial");
    expect(notice.textContent).toContain("had no valid agent records (2 rejected) — agents not listed");
    expect(rows()).toHaveLength(0);
    expect(screen.getByText("No agents could be read.")).toBeTruthy();
    cleanup();
    inventory = () => Response.json([]);
    renderTable();
    await waitFor(() => expect(screen.getByText("No agents match.")).toBeTruthy());
    expect(screen.queryByTestId("topology-table-inventory-partial")).toBeNull();
  });

  it("a newer partial read replaces the older successful snapshot on screen without splicing; the cache keeps the old array", async () => {
    renderTable();
    await waitFor(() => expect(rows().map((r) => r.getAttribute("data-testid"))).toEqual(["topology-table-row-desk.a"]));
    const before = qc.getQueryState(["rig", "rig-1", "nodes", "local"])!;
    inventory = () => Response.json([row("rig-1", "desk.new"), { broken: true }]);
    await refetchInventory();
    await waitFor(() => expect(rows().map((r) => r.getAttribute("data-testid"))).toEqual(["topology-table-row-desk.new"]));
    expect(rows()[0]!.getAttribute("data-inventory-state")).toBe("partial");
    const after = qc.getQueryState(["rig", "rig-1", "nodes", "local"])!;
    expect(after.data).toBe(before.data);
    expect(after.dataUpdatedAt).toBe(before.dataUpdatedAt);
    expect(after.error).toBeInstanceOf(NodeInventoryPartialReadError);
  });

  it.each([
    ["HTTP 503", () => Response.json({ error: "down" }, { status: 503 })],
    ["non-array body", () => Response.json({ nodes: [] })],
  ])("%s after a success keeps the old rows as dated stale evidence, not 'agents not listed'", async (_name, failure) => {
    renderTable();
    await waitFor(() => expect(rows()).toHaveLength(1));
    const successAt = qc.getQueryState(["rig", "rig-1", "nodes", "local"])!.dataUpdatedAt;
    inventory = failure;
    await refetchInventory();
    const stale = await screen.findByTestId("topology-table-inventory-stale");
    expect(stale.textContent).toContain("refresh failed");
    expect(stale.querySelector("time")!.getAttribute("dateTime")).toBe(new Date(successAt).toISOString());
    expect(rows()[0]!.getAttribute("data-inventory-state")).toBe("stale");
    expect(screen.queryByTestId("topology-table-rig-errors")).toBeNull();
    expect(screen.queryByTestId("topology-table-inventory-partial")).toBeNull();
  });

  it("a cold failure is unavailable (never partial success, never empty)", async () => {
    inventory = () => Response.json({ error: "down" }, { status: 503 });
    renderTable();
    const errors = await screen.findByTestId("topology-table-rig-errors");
    expect(errors.textContent).toContain("alpha");
    expect(rows()).toHaveLength(0);
    expect(screen.getByText("No agents could be read.")).toBeTruthy();
  });

  it("unmounting cancels the in-flight read; no late body surfaces as evidence", async () => {
    let signal: AbortSignal | undefined;
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/rigs/summary")) return Response.json([{ id: "rig-1", name: "alpha", nodeCount: 1 }]);
      signal = init?.signal ?? undefined;
      return new Promise<Response>(() => {});
    });
    renderTable();
    await waitFor(() => expect(signal).toBeDefined());
    cleanup();
    expect(signal!.aborted).toBe(true);
    expect(qc.getQueryState(["rig", "rig-1", "nodes", "local"])?.error ?? null).toBeNull();
  });
});

describe("rigInventoryView admission", () => {
  const partial = (hostId: string, rigId: string) => new NodeInventoryPartialReadError({ hostId, rigId, rows: [row(rigId, "x") as never], rejectedCount: 1, receivedAt: 1_700_000_000_000 });
  const old = [row("rig-1", "old") as never];

  it("admits partial evidence only for the exact host and rig shown", () => {
    expect(rigInventoryView({ data: old, error: partial("local", "rig-1"), isError: true, dataUpdatedAt: 5 }, { hostId: "local", rigId: "rig-1" }))
      .toMatchObject({ kind: "partial", at: 1_700_000_000_000, rejectedCount: 1 });
    expect(rigInventoryView({ data: old, error: partial("vps-a", "rig-1"), isError: true, dataUpdatedAt: 5 }, { hostId: "local", rigId: "rig-1" }))
      .toMatchObject({ kind: "stale", rows: old, at: 5 });
    expect(rigInventoryView({ data: undefined, error: partial("local", "rig-2"), isError: true, dataUpdatedAt: 0 }, { hostId: "local", rigId: "rig-1" }))
      .toMatchObject({ kind: "unavailable" });
  });

  it("success and pending are their own states", () => {
    expect(rigInventoryView({ data: [], error: null, isError: false, dataUpdatedAt: 9 }, { hostId: "local", rigId: "rig-1" })).toEqual({ kind: "current", rows: [], at: 9 });
    expect(rigInventoryView({ data: undefined, error: null, isError: false, dataUpdatedAt: 0 }, { hostId: "local", rigId: "rig-1" })).toEqual({ kind: "pending" });
  });
});
