// Connected-instance operator views (Attention, Health, Configuration,
// Connections) against the actual components, canonical hooks, bounded
// operator transport, a real TanStack Router and QueryClient. Only `fetch`
// is replaced; served bodies come from the test-only twin fixtures, which
// are typed against the daemon contracts.

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { AttentionView } from "../src/components/operator/AttentionView.js";
import { DrawerSelectionContext } from "../src/components/AppShell.js";
import { HealthPage } from "../src/components/operator/HealthPage.js";
import { ConfigurationPage } from "../src/components/operator/ConfigurationPage.js";
import { ConnectionsPage } from "../src/components/operator/ConnectionsPage.js";
import { validateConfigurationSearch, validateConnectionsSearch, validateHealthSearch } from "../src/components/operator/operator-search.js";
import type { AttentionRead } from "../src/hooks/useCanonicalAttention.js";
import {
  operatorTwinBody, twinConfiguration, twinConnections, twinHealthList, twinHealthRecords,
} from "../twin/operator-fixtures.js";

const DELIVERED_KEY = ["operator", "local-instance", "attention", "human-updates", 20];
const MANIFEST_KEY = ["operator", "local-instance", "gateway", "slack-manifest"];

type Override = (url: URL, init?: RequestInit) => Response | undefined;
interface Call { url: URL; method: string }

let qc: QueryClient | undefined;
afterEach(() => { cleanup(); qc?.clear(); qc = undefined; vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function json(body: unknown, status = 200) { return Response.json(body, { status }); }

function transport(override?: Override, hosts: { ownName: string; selected: string } = { ownName: "demo-studio", selected: "local" }) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://local");
    calls.push({ url, method: init?.method ?? "GET" });
    const custom = override?.(url, init);
    if (custom) return custom;
    if (url.pathname === "/api/hosts") return json({ ...hosts, hosts: [] });
    const served = operatorTwinBody(url.pathname, url.searchParams);
    return served ? json(served.body, served.status) : json({ error: "not_found" }, 404);
  }));
  return calls;
}

function mount(path: string, component: () => ReactNode, validateSearch?: (s: Record<string, unknown>) => object, initial = path) {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const client = qc;
  const root = createRootRoute({ component: () => <QueryClientProvider client={client}><Outlet /></QueryClientProvider> });
  const route = createRoute({ getParentRoute: () => root, path, component, validateSearch } as never);
  const elsewhere = createRoute({ getParentRoute: () => root, path: "/elsewhere", component: () => <p>elsewhere</p> });
  const router = createRouter({ routeTree: root.addChildren([route, elsewhere]), history: createMemoryHistory({ initialEntries: [initial] }) });
  render(<RouterProvider router={router} />);
  return { client, router };
}

const forYou = (selected?: string) => () => <AttentionView selectedItem={selected} onSelect={() => {}} />;
const fail = (status = 503, error = "source_failed") => json({ error }, status);

// ------------------------------------------------------------------ Attention

describe("Attention · independent sources", () => {
  it("canonical failure keeps delivered updates and the exact selected delivered detail", async () => {
    const calls = transport((url) => (url.pathname === "/api/attention" ? fail() : undefined));
    mount("/for-you", forYou("human-update:q-twin-120"));
    await screen.findByTestId("attention-list-error");
    expect((await screen.findByTestId("attention-delivered-body")).textContent).toContain("412 tests");
    expect(screen.getByTestId("attention-row-human-update:q-twin-118")).toBeTruthy();
    // Canonical sections say unknown — never the reassuring empty copy.
    expect(screen.getByTestId("attention-unknown-action").textContent).toMatch(/Unknown/);
    expect(screen.queryByText(/No current items/)).toBeNull();
    expect(screen.getByTestId("attention-source-canonical").textContent).toContain("unavailable");
    // A delivered ID is never resolved through canonical detail.
    expect(calls.some((c) => c.url.pathname === "/api/attention" && c.url.searchParams.has("item"))).toBe(false);
  });

  it("delivered failure does not hide canonical rows", async () => {
    transport((url) => (url.pathname === "/api/queue/human-updates" ? fail() : undefined));
    mount("/for-you", forYou());
    expect(await screen.findByTestId("attention-row-queue:q-twin-101")).toBeTruthy();
    expect(await screen.findByTestId("attention-delivered-error")).toBeTruthy();
    expect(screen.getByTestId("attention-source-delivered").getAttribute("data-state")).toBe("unavailable");
    expect(screen.queryByTestId("attention-empty-delivered")).toBeNull();
  });

  it("both sources failing shows no reassuring empty copy anywhere", async () => {
    transport((url) => (url.pathname === "/api/attention" || url.pathname === "/api/queue/human-updates" ? fail() : undefined));
    mount("/for-you", forYou());
    await screen.findByTestId("attention-list-error");
    await screen.findByTestId("attention-delivered-error");
    const view = screen.getByTestId("attention-view").textContent ?? "";
    expect(view).not.toMatch(/No current items|No delivered updates in the retained window/);
    expect(screen.getByTestId("attention-incomplete")).toBeTruthy();
  });

  it("shows loading for each source independently, never an empty answer", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://local");
      if (url.pathname === "/api/attention") await gate;
      const served = operatorTwinBody(url.pathname, url.searchParams);
      return served ? json(served.body, served.status) : json({ error: "not_found" }, 404);
    }));
    mount("/for-you", forYou());
    expect(await screen.findByTestId("attention-list-loading")).toBeTruthy();
    expect(await screen.findByTestId("attention-row-human-update:q-twin-120")).toBeTruthy();
    expect(screen.queryByTestId("attention-empty-action")).toBeNull();
    release();
    expect(await screen.findByTestId("attention-row-queue:q-twin-101")).toBeTruthy();
  });

  it("delivered refresh failure marks list, source and selected detail stale, then recovers", async () => {
    let failing = false;
    transport((url) => (failing && url.pathname === "/api/queue/human-updates" ? fail() : undefined));
    const { client } = mount("/for-you", forYou("human-update:q-twin-120"));
    const detail = await screen.findByTestId("attention-delivered-detail");
    expect(within(detail).queryByTestId("attention-delivered-detail-read-stale")).toBeNull();

    failing = true;
    await act(async () => { await client.invalidateQueries({ queryKey: DELIVERED_KEY }); });
    await waitFor(() => expect(screen.getByTestId("attention-source-delivered").getAttribute("data-state")).toBe("unavailable"));
    expect(client.getQueryState(DELIVERED_KEY)?.status).toBe("error");
    // The earlier content is kept, labeled and dated — in the list and in the
    // selected detail (the only panel visible on a narrow screen).
    expect(screen.getByTestId("attention-delivered-read-stale").textContent).toMatch(/Delivered updates refresh failed/);
    expect(within(screen.getByTestId("attention-delivered-detail")).getByTestId("attention-delivered-detail-read-stale")).toBeTruthy();
    expect(screen.getByTestId("attention-delivered-body").textContent).toContain("412 tests");

    failing = false;
    await act(async () => { await client.invalidateQueries({ queryKey: DELIVERED_KEY }); });
    await waitFor(() => expect(screen.getByTestId("attention-source-delivered").getAttribute("data-state")).toBe("available"));
    expect(screen.queryByTestId("attention-delivered-detail-read-stale")).toBeNull();
  });

  it("a delivered update that leaves a new successful window stays inspectable, labeled as an earlier read", async () => {
    let window = "both";
    transport((url) => {
      if (url.pathname !== "/api/queue/human-updates" || window === "both") return undefined;
      const served = operatorTwinBody(url.pathname, url.searchParams)!.body as { items: Array<{ qitemId: string }> };
      return json({ ...served, items: served.items.filter((i) => i.qitemId !== "q-twin-120") });
    });
    const { client } = mount("/for-you", forYou("human-update:q-twin-120"));
    await screen.findByTestId("attention-delivered-body");
    window = "later";
    await act(async () => { await client.invalidateQueries({ queryKey: DELIVERED_KEY }); });
    await screen.findByTestId("attention-delivered-retained");
    expect(screen.getByTestId("attention-delivered-detail-retained-note").textContent).toMatch(/Not in the latest delivered window/);
    expect(screen.queryByTestId("attention-row-human-update:q-twin-120")).toBeNull();
  });
});

describe("Attention · detail identity", () => {
  it("a closed request stays inspectable by exact ID and is labeled closed", async () => {
    transport();
    mount("/for-you", forYou("queue:q-twin-099"));
    expect((await screen.findByTestId("attention-detail-summary")).textContent).toContain("Confirm deploy window");
    await screen.findByTestId("attention-row-queue:q-twin-101");
    expect(await screen.findByTestId("attention-detail-closed")).toBeTruthy();
    expect(screen.getByTestId("attention-detail-lines").textContent).toContain("State: done");
  });

  it("absence from a list that failed to read is not presented as closure", async () => {
    transport((url) => (url.pathname === "/api/attention" && !url.searchParams.has("item") ? fail() : undefined));
    mount("/for-you", forYou("queue:q-twin-099"));
    await screen.findByTestId("attention-detail-summary");
    expect(screen.getByTestId("attention-detail-list-unknown")).toBeTruthy();
    expect(screen.queryByTestId("attention-detail-closed")).toBeNull();
  });

  it("absence while the item's own source is unavailable is unknown membership, not closure", async () => {
    // HTTP 200 list with the queue source unavailable and no queue rows; the
    // exact detail still reads. An unrelated degraded source (health partial)
    // must not make a queue item unknown — covered by the closed-request case.
    transport((url) => {
      if (url.pathname !== "/api/attention" || url.searchParams.has("item")) return undefined;
      const served = operatorTwinBody(url.pathname, url.searchParams)!.body as AttentionRead;
      return json({ ...served, items: served.items.filter((i) => !i.id.startsWith("queue:")),
        sources: served.sources.map((s) => (s.source === "queue" ? { ...s, state: "unavailable", detail: "queue read failed" } : s)) });
    });
    mount("/for-you", forYou("queue:q-twin-101"));
    await screen.findByTestId("attention-detail-summary");
    await screen.findByTestId("attention-row-health:hf-queue-stall-builder2");
    expect(screen.getByTestId("attention-detail-list-unknown")).toBeTruthy();
    expect(screen.queryByTestId("attention-detail-closed")).toBeNull();
    expect(screen.queryByTestId("attention-detail-retained")).toBeNull();
  });

  it("an unrecognized ID is reported and never requested", async () => {
    const calls = transport();
    mount("/for-you", forYou("event-42"));
    expect(await screen.findByTestId("attention-detail-unrecognized")).toBeTruthy();
    await screen.findByTestId("attention-row-queue:q-twin-101");
    expect(calls.some((c) => c.url.searchParams.get("item") !== null)).toBe(false);
  });

  it("source detail keeps exact links, files and anchors", async () => {
    transport();
    mount("/for-you", forYou("queue:q-twin-101"));
    const file = await screen.findByTestId("attention-file");
    expect(file.textContent).toContain("/home/demo/work/acme-project/missions/release-train/PLAN.md");
    expect(file.textContent).toContain("#scope");
    cleanup(); qc?.clear();
    transport();
    mount("/for-you", forYou("workflow:wf-twin-5"));
    const link = await screen.findByTestId("attention-workflow-link");
    expect(link.getAttribute("href")).toBe("/workflow/instance/wf-twin-5");
  });

  it("file evidence carries its producing origin (local), exact anchor and project — never the remote selection", async () => {
    transport(undefined, { ownName: "demo-studio", selected: "remote-box" });
    const opened: unknown[] = [];
    mount("/for-you", () => (
      <DrawerSelectionContext.Provider value={{ selection: null, setSelection: (sel) => { opened.push(sel); } }}>
        <AttentionView selectedItem="queue:q-twin-101" onSelect={() => {}} />
      </DrawerSelectionContext.Provider>
    ));
    fireEvent.click(await screen.findByTestId("attention-file-open"));
    expect(opened).toEqual([{ type: "file", data: {
      path: "/home/demo/work/acme-project/missions/release-train/PLAN.md",
      absolutePath: "/home/demo/work/acme-project/missions/release-train/PLAN.md",
      originInstance: "local", anchor: "scope",
      project: { projectId: "acme-project", projectRoot: "/home/demo/work/acme-project" },
    } }]);
  });

  it("opens no EventSource of its own", async () => {
    const EventSourceSpy = vi.fn();
    vi.stubGlobal("EventSource", EventSourceSpy);
    transport();
    mount("/for-you", forYou("queue:q-twin-101"));
    await screen.findByTestId("attention-detail-summary");
    expect(EventSourceSpy).not.toHaveBeenCalled();
  });
});

// --------------------------------------------------------------------- Health

describe("Health", () => {
  it("search follows the URL: direct link, same-route navigation, Back and clearing", async () => {
    transport();
    const { router } = mount("/settings/health", HealthPage, validateHealthSearch, "/settings/health?q=context");
    await screen.findByTestId("health-row-hf-context-reviewer1");
    const input = () => screen.getByTestId("health-search") as HTMLInputElement;
    expect(input().value).toBe("context");
    expect(screen.queryByTestId("health-row-hf-queue-stall-builder2")).toBeNull();

    await act(async () => { await router.navigate({ to: "/settings/health", search: { q: "no-such-finding" } } as never); });
    await waitFor(() => expect(input().value).toBe("no-such-finding"));
    expect(screen.getByTestId("health-filter-empty").textContent).toMatch(/2 findings hidden/);

    await act(async () => { router.history.back(); });
    await waitFor(() => expect(input().value).toBe("context"));

    await act(async () => { await router.navigate({ to: "/settings/health", search: {} } as never); });
    await waitFor(() => expect(input().value).toBe(""));
    expect(screen.getByTestId("health-row-hf-queue-stall-builder2")).toBeTruthy();
  });

  it("typing replaces history; selecting a finding pushes it so Back returns to the list", async () => {
    transport();
    const { router } = mount("/settings/health", HealthPage, validateHealthSearch);
    await screen.findByTestId("health-row-hf-queue-stall-builder2");
    const before = router.history.length;
    fireEvent.change(screen.getByTestId("health-search"), { target: { value: "queue" } });
    await waitFor(() => expect(router.state.location.search).toMatchObject({ q: "queue" }));
    expect(router.history.length).toBe(before);
    fireEvent.click(screen.getByTestId("health-row-hf-queue-stall-builder2"));
    await waitFor(() => expect(router.state.location.search).toMatchObject({ q: "queue", finding: "hf-queue-stall-builder2" }));
    expect((await screen.findByTestId("health-detail-id")).textContent).toContain("hf-queue-stall-builder2");
    await act(async () => { router.history.back(); });
    await waitFor(() => expect(screen.getByTestId("health-detail-empty")).toBeTruthy());
    expect((screen.getByTestId("health-search") as HTMLInputElement).value).toBe("queue");
  });

  it("the default read omits cleared findings and says so; status=cleared reads them from the server", async () => {
    const calls = transport();
    mount("/settings/health", HealthPage, validateHealthSearch);
    await screen.findByTestId("health-row-hf-queue-stall-builder2");
    expect(screen.queryByTestId("health-row-hf-rig-restore-gamma")).toBeNull();
    expect(screen.getByTestId("health-count-cleared").textContent).toMatch(/not in this read/);
    expect(screen.getByTestId("health-filter-status-all").textContent).toBe("Open");
    fireEvent.click(screen.getByTestId("health-filter-status-cleared"));
    expect(await screen.findByTestId("health-row-hf-rig-restore-gamma")).toBeTruthy();
    await waitFor(() => expect(screen.queryByTestId("health-row-hf-queue-stall-builder2")).toBeNull());
    expect(calls.some((c) => c.url.pathname === "/api/health" && c.url.searchParams.get("status") === "cleared")).toBe(true);
  });

  it("an empty read with unavailable or absent coverage is never a healthy verdict", async () => {
    transport((url) => (url.pathname === "/api/health"
      ? json({ ...twinHealthList, total: 0, records: [], coverage: [{ source: "watchdog-history", evaluatedAt: twinHealthList.evaluatedAt, status: "unavailable", partial: true, reason: "store not readable" }] })
      : undefined));
    mount("/settings/health", HealthPage, validateHealthSearch);
    const empty = await screen.findByTestId("health-empty");
    expect(empty.textContent).toMatch(/not a healthy verdict: watchdog-history could not be assessed/);
    expect(screen.getByTestId("health-partial")).toBeTruthy();
    cleanup(); qc?.clear();

    transport((url) => (url.pathname === "/api/health" ? json({ ...twinHealthList, total: 0, records: [], coverage: undefined }) : undefined));
    mount("/settings/health", HealthPage, validateHealthSearch);
    expect((await screen.findByTestId("health-empty")).textContent).toMatch(/coverage was not reported/);
    expect(screen.getByTestId("health-coverage-absent")).toBeTruthy();
  });

  it("discloses truncation and partial coverage with omitted counts", async () => {
    transport((url) => (url.pathname === "/api/health" ? json({ ...twinHealthList, total: 3, limit: 1, truncated: true, records: [twinHealthRecords[0]] }) : undefined));
    mount("/settings/health", HealthPage, validateHealthSearch);
    expect((await screen.findByTestId("health-truncated")).textContent).toMatch(/showing 1 of 3/);
    expect(screen.getByTestId("health-coverage-queue-transition").textContent).toMatch(/evaluated 500 of 640 transitions; 140 omitted/);
  });

  it("a scope filter uses the exact terminal seat ID, never a composite", async () => {
    const calls = transport();
    const { router } = mount("/settings/health", HealthPage, validateHealthSearch, "/settings/health?finding=hf-queue-stall-builder2");
    fireEvent.click(await screen.findByTestId("health-filter-this-scope"));
    await waitFor(() => expect(router.state.location.search).toMatchObject({ scopeType: "seat", scopeId: "node_builder2" }));
    await waitFor(() => expect(calls.some((c) => c.url.pathname === "/api/health"
      && c.url.searchParams.get("scope_type") === "seat" && c.url.searchParams.get("scope_id") === "node_builder2")).toBe(true));
  });

  it("keeps rows dated and labeled after a failed refresh", async () => {
    let failing = false;
    transport((url) => (failing && url.pathname === "/api/health" ? fail() : undefined));
    const { client } = mount("/settings/health", HealthPage, validateHealthSearch);
    await screen.findByTestId("health-row-hf-queue-stall-builder2");
    failing = true;
    await act(async () => { await client.invalidateQueries({ queryKey: ["operator", "local-instance", "health", "list"] }); });
    expect(await screen.findByTestId("health-read-stale")).toBeTruthy();
    expect(screen.getByTestId("health-row-hf-queue-stall-builder2")).toBeTruthy();
  });

  it("an exact finding outside the current list is still shown by ID and labeled", async () => {
    transport();
    mount("/settings/health", HealthPage, validateHealthSearch, "/settings/health?finding=hf-rig-restore-gamma");
    expect((await screen.findByTestId("health-detail-summary")).textContent).toContain("Restore completed");
    expect(await screen.findByTestId("health-detail-not-listed")).toBeTruthy();
    expect(screen.getByTestId("health-evidence-lifecycle-receipt").textContent).toMatch(/rcpt-twin-12.*restore.*completed/s);
  });
});

// -------------------------------------------------------- instance labelling

describe("Connected-instance labelling", () => {
  it("names the connected instance and explains a remote topology selection without fetching remotely", async () => {
    const calls = transport(undefined, { ownName: "demo-studio", selected: "remote-box" });
    mount("/settings/health", HealthPage, validateHealthSearch, "/settings/health?finding=hf-queue-stall-builder2");
    await waitFor(() => expect(screen.getByTestId("operator-instance-label").textContent).toBe("Connected instance · demo-studio"));
    expect((await screen.findByTestId("operator-remote-context")).textContent).toMatch(/remote-box.*still\s+describes the connected instance/s);
    await screen.findByTestId("health-detail-summary");
    expect(screen.queryByTestId("health-scope-rig-link")).toBeNull();
    expect(calls.some((c) => c.url.searchParams.has("host"))).toBe(false);
  });

  it("does not claim a name before the hosts read lands or after it fails", async () => {
    transport((url) => (url.pathname === "/api/hosts" ? fail() : undefined));
    mount("/settings/configuration", ConfigurationPage, validateConfigurationSearch);
    await waitFor(() => expect(screen.getByTestId("operator-instance-label").textContent).toBe("Connected instance · name unavailable"));
    expect(screen.queryByTestId("operator-remote-context")).toBeNull();
  });
});

// -------------------------------------------------------------- Configuration

describe("Configuration", () => {
  it("never renders a withheld value or default, even when a payload carries one", async () => {
    const withheld = { ...twinConfiguration.entries[3]!, value: "SENTINEL-VALUE", defaultValue: "SENTINEL-DEFAULT" };
    transport((url) => (url.pathname === "/api/config" ? json({ ...twinConfiguration, entries: [...twinConfiguration.entries.slice(0, 3), withheld] }) : undefined));
    mount("/settings/configuration", ConfigurationPage, validateConfigurationSearch,
      `/settings/configuration?key=${encodeURIComponent(withheld.key)}`);
    expect((await screen.findByTestId("configuration-detail-value")).textContent).toContain("Contents withheld");
    expect(screen.getByTestId("configuration-detail-default").textContent).toContain("Contents withheld");
    expect(document.body.textContent).not.toMatch(/SENTINEL/);
    fireEvent.change(screen.getByTestId("configuration-search"), { target: { value: "SENTINEL" } });
    expect(await screen.findByTestId("configuration-filter-empty")).toBeTruthy();
  });

  it("search follows same-route URL changes and Back", async () => {
    transport();
    const { router } = mount("/settings/configuration", ConfigurationPage, validateConfigurationSearch);
    await screen.findByTestId("configuration-list");
    const input = () => screen.getByTestId("configuration-search") as HTMLInputElement;
    await act(async () => { await router.navigate({ to: "/settings/configuration", search: { q: "workspace" } } as never); });
    await waitFor(() => expect(input().value).toBe("workspace"));
    expect(screen.getByTestId("configuration-row-workspace.root")).toBeTruthy();
    expect(screen.queryByTestId("configuration-row-host.name")).toBeNull();
    await act(async () => { await router.navigate({ to: "/settings/configuration", search: { q: "nothing-matches" } } as never); });
    expect(await screen.findByTestId("configuration-filter-empty")).toBeTruthy();
    await act(async () => { router.history.back(); });
    await waitFor(() => expect(input().value).toBe("workspace"));
  });

  it("selects by exact key + subject when the same key serves several subjects", async () => {
    const shared = (subject: string, value: string) => ({ ...twinConfiguration.entries[7]!, key: "people.shared.availability", subject, value });
    transport((url) => (url.pathname === "/api/config" ? json({ ...twinConfiguration, entries: [shared("Avery Demo", "focus"), shared("Blake Demo", "away")] }) : undefined));
    mount("/settings/configuration", ConfigurationPage, validateConfigurationSearch,
      "/settings/configuration?key=people.shared.availability&subject=Blake%20Demo");
    expect((await screen.findByTestId("configuration-detail-value")).textContent).toContain("away");
    expect(screen.getByTestId("configuration-row-people.shared.availability@Blake Demo").getAttribute("aria-current")).toBe("true");
    expect(screen.getByTestId("configuration-row-people.shared.availability@Avery Demo").getAttribute("aria-current")).toBeNull();
  });

  it("reports unknown defaults and unavailable values without inventing them", async () => {
    transport();
    mount("/settings/configuration", ConfigurationPage, validateConfigurationSearch, "/settings/configuration?key=health.policy.disabledDetectors");
    expect((await screen.findByTestId("configuration-detail-value")).textContent).toContain("Unavailable");
    cleanup(); qc?.clear();
    transport();
    mount("/settings/configuration", ConfigurationPage, validateConfigurationSearch, "/settings/configuration?key=slack.botToken");
    expect((await screen.findByTestId("configuration-detail-default")).textContent).toMatch(/Not reported.*default not known/);
    expect(screen.getByTestId("configuration-source-health").textContent).toContain("malformed");
  });
});

// ---------------------------------------------------------------- Connections

describe("Connections", () => {
  it("never presents a dated ready-at-check or running gateway as current reachability", async () => {
    transport();
    mount("/settings/connections", ConnectionsPage, validateConnectionsSearch);
    const matrix = await screen.findByTestId("connections-matrix");
    // Dated in the display zone; the exact served instant stays on <time>.
    const verified = within(matrix).getByTestId("connections-matrix-verified");
    expect(verified.textContent).toMatch(/ready-at-check at \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} /);
    expect(verified.querySelector("time")?.getAttribute("datetime")).toBe("2025-09-01T01:42:00.000Z");
    expect(within(matrix).getByTestId("connections-matrix-reach").textContent).toMatch(/not observed/);
    expect(within(matrix).getByTestId("connections-matrix-applied").textContent).toMatch(/changed.*Do not assume it is applied/);
    expect(screen.getByTestId("connections-state").textContent).toBe("unverified");
    expect(screen.getByTestId("connections-verification-caveat").textContent).toMatch(/does not prove delivery/);
    expect(screen.getByTestId("connections-next-action").textContent).toBe(twinConnections.nextAction);
    expect(screen.getByTestId("connections-credentials").textContent).toMatch(/values hidden/);
  });

  it("reads the manifest only on explicit reveal, with GETs only and no Slack or apply calls", async () => {
    const calls = transport();
    mount("/settings/connections", ConnectionsPage, validateConnectionsSearch);
    await screen.findByTestId("connections-matrix");
    expect(calls.some((c) => c.url.pathname.includes("manifest"))).toBe(false);
    fireEvent.click(screen.getByTestId("connections-manifest-toggle"));
    expect((await screen.findByTestId("connections-manifest-yaml")).textContent).toContain("OpenRig Demo");
    expect(calls.filter((c) => c.url.pathname === "/api/gateway/slack/manifest")).toHaveLength(1);
    expect(calls.every((c) => c.method === "GET")).toBe(true);
    expect(calls.some((c) => /verify|setup|enable|apply|probe|slack\.com/.test(c.url.href))).toBe(false);
  });

  it("a failed manifest refresh keeps the earlier YAML, dated and labeled, until recovery", async () => {
    let failing = false;
    transport((url) => (failing && url.pathname === "/api/gateway/slack/manifest" ? fail(503, "manifest_unavailable") : undefined));
    const { client } = mount("/settings/connections", ConnectionsPage, validateConnectionsSearch);
    fireEvent.click(await screen.findByTestId("connections-manifest-toggle"));
    await screen.findByTestId("connections-manifest-yaml");
    failing = true;
    await act(async () => { await client.invalidateQueries({ queryKey: MANIFEST_KEY }); });
    expect((await screen.findByTestId("connections-manifest-read-stale")).textContent).toMatch(/Slack manifest refresh failed.*HTTP 503/s);
    expect(screen.getByTestId("connections-manifest-yaml")).toBeTruthy();
    failing = false;
    await act(async () => { await client.invalidateQueries({ queryKey: MANIFEST_KEY }); });
    await waitFor(() => expect(screen.queryByTestId("connections-manifest-read-stale")).toBeNull());
  });

  it("a cold manifest failure is reported, not an empty manifest", async () => {
    transport((url) => (url.pathname === "/api/gateway/slack/manifest" ? fail(503, "manifest_unavailable") : undefined));
    mount("/settings/connections", ConnectionsPage, validateConnectionsSearch);
    fireEvent.click(await screen.findByTestId("connections-manifest-toggle"));
    expect(await screen.findByTestId("connections-manifest-error")).toBeTruthy();
    expect(screen.queryByTestId("connections-manifest-yaml")).toBeNull();
  });

  it("every registered human is inspectable with identity, delivery preferences and excluded/away state", async () => {
    transport();
    const { router } = mount("/settings/connections", ConnectionsPage, validateConnectionsSearch);
    fireEvent.click(await screen.findByTestId("connections-human-human-blake"));
    await waitFor(() => expect(router.state.location.search).toMatchObject({ human: "k2" }));
    const detail = await screen.findByTestId("connections-human-detail");
    expect(detail.textContent).toContain("human-blake");
    expect(detail.textContent).toContain("human:observer");
    expect(within(detail).getByTestId("connections-human-away").textContent).toBe("yes");
    expect(within(detail).getByTestId("connections-human-route").textContent).toBe("Excluded by outbound policy");
    expect(detail.textContent).toMatch(/Delivery class\s*C/);
    fireEvent.click(screen.getByTestId("connections-human-human-avery"));
    expect(await screen.findAllByTestId("connections-human-binding")).toHaveLength(2);
  });

  it("an unavailable registry reports unknown recipients rather than none", async () => {
    transport((url) => (url.pathname === "/api/gateway/connections" ? json({ ...twinConnections, registry: { state: "unavailable", path: null }, humans: [] }) : undefined));
    mount("/settings/connections", ConnectionsPage, validateConnectionsSearch);
    expect(await screen.findByTestId("connections-registry-unavailable")).toBeTruthy();
    expect(screen.queryByTestId("connections-humans-empty")).toBeNull();
  });
});
