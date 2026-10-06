// Startup / fleet restore / terminal catalog absolute stamps adopt the connected
// instance's configured display zone through the actual DisplayTimeProvider
// (settings read of ui.timezone), never browser-local time. Only Date is faked
// so every receipt/read stamp is one exact, known instant; timers stay real.

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { DisplayTimeProvider } from "../src/components/time/DisplayTime.js";
import { StartupChooser } from "../src/components/startup/StartupChooser.js";
import { FleetRestorePanel } from "../src/components/restore/FleetRestorePanel.js";
import { TerminalCatalog } from "../src/components/terminal-catalog/TerminalCatalog.js";
import { RecoveryStamp } from "../src/components/startup/recovery-primitives.js";
import {
  fleetRunningPartial, recoveryHostsLocal, recoveryRigSummaries, startupPrerequisitesFixture, startupRigAlpha,
  terminalPreviewFixture, terminalViewsFixture,
} from "../twin/recovery-fixtures.js";
import { installFetch, json, renderShell, type FetchCall } from "./recovery-harness.js";

const NOW = "2026-07-01T23:30:00.000Z";
const TOKYO = "2026-07-02 08:30:00 GMT+9";
const LOS_ANGELES = "2026-07-01 16:30:00 PDT";

beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"], now: new Date(NOW) }); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); sessionStorage.clear(); localStorage.clear(); });

const settings = (zone: string) => ({ settings: { "ui.timezone": { value: zone, source: "file", defaultValue: "America/Los_Angeles" } } });

function daemon(zone: () => unknown, options: { post?: (call: FetchCall) => Response | Promise<Response> } = {}) {
  return installFetch(call => {
    if (call.path === "/api/config") { const body = zone(); return body instanceof Response ? body : json(body); }
    if (call.path === "/api/hosts") return json(recoveryHostsLocal);
    if (call.path === "/api/rigs/summary") return json(recoveryRigSummaries);
    if (call.path === "/api/startup/prerequisites") return json(startupPrerequisitesFixture);
    if (call.method === "GET" && call.path === "/api/startup/rig_demo_alpha") return json(startupRigAlpha);
    if (call.path === "/api/terminal/views") return json(terminalViewsFixture);
    if (call.path === "/api/terminal/preview") return json(terminalPreviewFixture(call.search.get("view")!, call.search.get("provider")!, ["orch.lead@alpha"]));
    if (call.method === "GET" && call.path.startsWith("/api/crash-cart/restore-fleet/")) return json(fleetRunningPartial);
    if (call.method === "POST" && options.post) return options.post(call);
    if (call.method === "POST" && call.path === "/api/terminal/open") return json({ provider: "herdr", ok: true, opened: ["orch.lead@alpha"], absent: [], degraded: [], pages: 1 });
    if (call.method === "POST" && call.path === "/api/crash-cart/restore-fleet") return json({ fleetAttemptId: "fleet-demo-1", status: "started" }, 202);
    if (call.method === "POST") return json({ ok: true, code: "resumed", logicalId: "orch.lead" });
    return undefined;
  });
}

const withZone = (page: ReactNode) => <DisplayTimeProvider>{page}</DisplayTimeProvider>;

function expectStamp(element: HTMLElement, text: string) {
  expect(element.textContent).toBe(text);
  expect(element.tagName).toBe("TIME");
  expect(element.getAttribute("datetime")).toBe(NOW);
  expect(element.getAttribute("title")).toMatch(new RegExp(`^${NOW.replace(/[.]/g, "\\.")} · `));
}

async function resumeSeat() {
  fireEvent.click(await screen.findByTestId("startup-rig-rig_demo_alpha"));
  fireEvent.click(await screen.findByTestId("startup-seat-node_orch_lead"));
  fireEvent.click(await screen.findByTestId("startup-action-primary"));
  return screen.findByTestId("startup-receipt");
}

describe("startup receipt and readback stamps", () => {
  for (const [zone, expected] of [["Asia/Tokyo", TOKYO], ["America/Los_Angeles", LOS_ANGELES]] as const) {
    it(`renders submitted, settled and readback as the same exact instant in configured ${zone}`, async () => {
      const net = daemon(() => settings(zone));
      renderShell(withZone(<StartupChooser />));
      const receipt = await resumeSeat();
      await waitFor(() => expect(receipt.getAttribute("data-status")).toBe("succeeded"));
      await within(receipt).findByTestId("startup-readback");
      await waitFor(() => expect(screen.getByTestId("startup-zone-note").getAttribute("data-state")).toBe("configured"));
      expectStamp(within(receipt).getByTestId("startup-receipt-submitted"), expected);
      expectStamp(within(receipt).getByTestId("startup-receipt-settled"), expected);
      expectStamp(within(receipt).getByTestId("startup-readback-at"), expected);
      expect(screen.getByTestId("startup-zone-note").textContent).toContain(`Showing ${zone} (ui.timezone · file).`);
      expect(net.posts()).toHaveLength(1);
    });
  }

  it("keeps an unknown outcome unknown while its stamps adopt the zone", async () => {
    const net = daemon(() => settings("Asia/Tokyo"), { post: () => { throw new TypeError("connection reset"); } });
    renderShell(withZone(<StartupChooser />));
    const receipt = await resumeSeat();
    await waitFor(() => expect(receipt.getAttribute("data-status")).toBe("outcome_unknown"));
    await waitFor(() => expectStamp(within(receipt).getByTestId("startup-receipt-settled"), TOKYO));
    expectStamp(within(receipt).getByTestId("startup-receipt-submitted"), TOKYO);
    expect(within(receipt).getByTestId("startup-receipt-unknown")).toBeTruthy();
    expect(net.posts()).toHaveLength(1);
  });

  it("does not show a settled stamp while the attempt is pending", async () => {
    daemon(() => settings("Asia/Tokyo"), { post: () => new Promise<Response>(() => {}) });
    renderShell(withZone(<StartupChooser />));
    const receipt = await resumeSeat();
    expect(receipt.getAttribute("data-status")).toBe("pending");
    await waitFor(() => expectStamp(within(receipt).getByTestId("startup-receipt-submitted"), TOKYO));
    expect(within(receipt).queryByTestId("startup-receipt-settled")).toBeNull();
  });
});

describe("terminal catalog stamps", () => {
  it("renders catalog read, preview read and Open submission in the configured zone", async () => {
    const net = daemon(() => settings("Asia/Tokyo"));
    const app = renderShell(withZone(<TerminalCatalog view={null} />));
    await waitFor(() => expect(screen.getByTestId("terminal-catalog-zone-note").getAttribute("data-state")).toBe("configured"));
    expectStamp(await screen.findByTestId("terminal-catalog-read-at"), TOKYO);

    app.show(withZone(<TerminalCatalog view="rig:alpha" />));
    expectStamp(await screen.findByTestId("terminal-preview-read-at"), TOKYO);
    const open = await screen.findByTestId("terminal-open") as HTMLButtonElement;
    await waitFor(() => expect(open.disabled).toBe(false));
    fireEvent.click(open);
    const result = await screen.findByTestId("terminal-open-result");
    expectStamp(within(result).getByTestId("terminal-open-sent-at"), TOKYO);
    expect(net.posts("/api/terminal/open")).toHaveLength(1);
    expect(net.posts("/api/terminal/open")[0]!.body).toEqual({ provider: "herdr", view: "rig:alpha", expectedPlan: "plan-rig:alpha-herdr-1" });
  });
});

describe("fleet restore stamp", () => {
  it("renders the last status read in the configured zone and keeps the read count", async () => {
    daemon(() => settings("Asia/Tokyo"));
    renderShell(withZone(<FleetRestorePanel />), { pollOptions: { pollIntervalMs: 1000 } });
    const start = await screen.findByTestId("fleet-kickoff-start") as HTMLButtonElement;
    await waitFor(() => expect(start.disabled).toBe(false));
    fireEvent.click(start);
    await waitFor(() => expect(screen.getAllByTestId("fleet-row")).toHaveLength(2));
    expectStamp(screen.getByTestId("fleet-last-read-at"), TOKYO);
    expect(screen.getByTestId("fleet-last-read").textContent).toMatch(/· 1 reads$/);
    expect(screen.getByTestId("fleet-zone-note").getAttribute("data-state")).toBe("configured");
  });
});

describe("zone provenance on these surfaces", () => {
  it("keeps the last valid zone, marked stale, when the settings refresh fails", async () => {
    let body: unknown = settings("Asia/Tokyo");
    daemon(() => body);
    const app = renderShell(withZone(<TerminalCatalog view={null} />));
    await screen.findByTestId("terminal-catalog-read-at");
    await waitFor(() => expectStamp(screen.getByTestId("terminal-catalog-read-at"), TOKYO));
    expect(screen.getByTestId("terminal-catalog-zone-note").getAttribute("data-state")).toBe("configured");
    body = json({ error: "settings unavailable" }, 503);
    await act(async () => { await app.client.refetchQueries({ queryKey: ["settings", "all"] }); });
    await waitFor(() => expect(screen.getByTestId("terminal-catalog-zone-note").getAttribute("data-state")).toBe("stale"));
    expect(screen.getByTestId("terminal-catalog-zone-note").textContent).toMatch(/Asia\/Tokyo from the last successful settings read; the latest refresh failed/);
    expectStamp(screen.getByTestId("terminal-catalog-read-at"), TOKYO);
  });

  it("discloses the default zone as a fallback, not as observed configuration", async () => {
    daemon(() => json({ error: "unavailable" }, 503));
    renderShell(withZone(<FleetRestorePanel />));
    await waitFor(() => expect(screen.getByTestId("fleet-zone-note").getAttribute("data-state")).toBe("unavailable"));
    expect(screen.getByTestId("fleet-zone-note").textContent).toMatch(/Settings could not be read; showing America\/Los_Angeles \(fallback\)/);
  });

  it("renders absent and malformed stamps as honest unknowns through the owner stamp", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(settings("Asia/Tokyo"))));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <DisplayTimeProvider>
          <RecoveryStamp iso={null} testId="absent" />
          <RecoveryStamp iso="not-a-time" testId="malformed" />
          <RecoveryStamp iso="2026-07-01T23:30:00" testId="zoneless" />
          <RecoveryStamp iso="2026-07-01 23:30:00" testId="sqlite" />
        </DisplayTimeProvider>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("sqlite").textContent).toBe(TOKYO));
    expect(screen.getByTestId("absent").textContent).toBe("unknown");
    expect(screen.getByTestId("malformed").textContent).toBe("time unknown");
    expect(screen.getByTestId("zoneless").textContent).toBe("time unknown");
    expect(screen.getByTestId("malformed").getAttribute("title")).toBe("not-a-time");
  });
});
