// Invocation-time admission and exact-attempt binding for the app-lifetime
// effect owners (startup lane, fleet kickoff/cancel, terminal catalog Open).
// Rendered state is never sufficient: these cases change the shared ["hosts"]
// cache (or the preview entry) and then invoke the still-mounted button or a
// retained callback before the observer re-renders.

import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StartupChooser } from "../src/components/startup/StartupChooser.js";
import { FleetRestorePanel } from "../src/components/restore/FleetRestorePanel.js";
import { TerminalCatalog } from "../src/components/terminal-catalog/TerminalCatalog.js";
import { useRecoveryOperations } from "../src/components/startup/RecoveryOperationsProvider.js";
import { useTerminalCatalogStore } from "../src/components/terminal-catalog/TerminalCatalogState.js";
import { TERMINAL_BEARER_STORAGE_KEY } from "../src/components/mission-control/missionControlAuth.js";
import type { TerminalPreviewDto } from "../src/lib/terminal-read.js";
import {
  fleetRunningPartial, recoveryHostsLocal, recoveryHostsRemote, recoveryRigSummaries, startupPrerequisitesFixture, startupRigAlpha,
  terminalPreviewFixture, terminalViewsFixture,
} from "../twin/recovery-fixtures.js";
import { deferred, installFetch, json, renderShell, type FetchCall } from "./recovery-harness.js";

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); sessionStorage.clear(); localStorage.clear(); });

let ops: ReturnType<typeof useRecoveryOperations> | null = null;
function CaptureOps() { ops = useRecoveryOperations(); return null; }
let store: ReturnType<typeof useTerminalCatalogStore> | null = null;
function CaptureStore() { store = useTerminalCatalogStore(); return null; }

/** Put the shared hosts entry into a failed-refresh state while keeping its last data. */
function failHostsRefresh(client: QueryClient) {
  client.getQueryCache().find({ queryKey: ["hosts"] })!.setState({ status: "error", error: new Error("hosts refresh failed"), fetchStatus: "idle" });
}

function startupDaemon(options: { hosts?: () => unknown; post?: (call: FetchCall) => Response | Promise<Response>; rig?: () => Response | Promise<Response> } = {}) {
  return installFetch(call => {
    if (call.path === "/api/hosts") return json(options.hosts ? options.hosts() : recoveryHostsLocal);
    if (call.path === "/api/rigs/summary") return json(recoveryRigSummaries);
    if (call.path === "/api/startup/prerequisites") return json(startupPrerequisitesFixture);
    if (call.method === "GET" && call.path === "/api/startup/rig_demo_alpha") return options.rig ? options.rig() : json(startupRigAlpha);
    if (call.method === "POST") return options.post ? options.post(call) : json({ ok: true, code: "resumed", logicalId: "orch.lead" });
    if (call.method === "GET" && call.path.startsWith("/api/crash-cart/restore-fleet/")) return json(fleetRunningPartial);
    return undefined;
  });
}

async function seatButton() {
  fireEvent.click(await screen.findByTestId("startup-rig-rig_demo_alpha"));
  fireEvent.click(await screen.findByTestId("startup-seat-node_orch_lead"));
  return screen.findByTestId("startup-action-primary");
}

describe("startup lane admission", () => {
  it("refuses a click after the cache failed its refresh, before any record or POST", async () => {
    const net = startupDaemon();
    const app = renderShell(<StartupChooser />);
    const button = await seatButton();
    act(() => { failHostsRefresh(app.client); fireEvent.click(button); });
    await act(async () => { await Promise.resolve(); });
    expect(net.posts()).toHaveLength(0);
    expect(screen.queryByTestId("startup-receipt")).toBeNull();
  });

  it("refuses a retained callback once the selection is remote or unknown, and keeps the local control", async () => {
    const net = startupDaemon();
    const app = renderShell(<><StartupChooser /><CaptureOps /></>);
    await seatButton();
    const retained = ops!.startup.submit;
    const selection = { rigId: "rig_demo_alpha", nodeId: "node_orch_lead", logicalId: "orch.lead", runtime: "codex", revision: "rev-node_orch_lead-1", sessionName: "orch.lead@alpha" };
    act(() => { app.client.setQueryData(["hosts"], recoveryHostsRemote); });
    expect(retained({ kind: "seat", input: { selection, action: "resume" } })).toMatchObject({ ok: false, reason: expect.stringMatching(/remote host edge-demo/) });
    act(() => { app.client.removeQueries({ queryKey: ["hosts"] }); });
    expect(retained({ kind: "seat", input: { selection, action: "resume" } })).toMatchObject({ ok: false, reason: expect.stringMatching(/not known yet/) });
    expect(net.posts()).toHaveLength(0);

    act(() => { app.client.setQueryData(["hosts"], recoveryHostsLocal); });
    let outcome: unknown;
    act(() => { outcome = retained({ kind: "seat", input: { selection, action: "resume" } }); });
    expect(outcome).toMatchObject({ ok: true });
    await waitFor(() => expect(net.posts()).toHaveLength(1));
    expect(net.posts()[0]!.body).toEqual({ action: "resume", revision: "rev-node_orch_lead-1" });
  });

  it("refuses a retained callback when the connected instance changed since it rendered", async () => {
    const net = startupDaemon();
    const app = renderShell(<><StartupChooser /><CaptureOps /></>);
    await seatButton();
    const retained = ops!.startup.submit;
    act(() => { app.client.setQueryData(["hosts"], { ...recoveryHostsLocal, ownName: "other-instance" }); });
    expect(retained({ kind: "terminal" })).toMatchObject({ ok: false, reason: expect.stringMatching(/connected instance changed/) });
    expect(net.posts()).toHaveLength(0);
  });

  it("defers late readback for a foreign receipt, then reads it back once the original instance is current again", async () => {
    const answer = deferred<Response>();
    const net = startupDaemon({ post: () => answer.promise });
    const app = renderShell(<StartupChooser />);
    fireEvent.click(await seatButton());
    await waitFor(() => expect(net.posts()).toHaveLength(1));
    await act(async () => { app.client.setQueryData(["hosts"], { ...recoveryHostsLocal, ownName: "instance-b" }); });
    await act(async () => { answer.resolve(json({ ok: true, code: "resumed", logicalId: "orch.lead" })); });
    const receipt = await screen.findByTestId("startup-receipt");
    await waitFor(() => expect(receipt.getAttribute("data-status")).toBe("succeeded"));
    expect(within(receipt).getByText("resumed")).toBeTruthy();
    expect(within(receipt).getByTestId("startup-receipt-foreign")).toBeTruthy();
    expect(within(receipt).getByTestId("startup-readback-deferred").textContent).toMatch(/connected instance changed/);
    expect(within(receipt).queryByTestId("startup-readback")).toBeNull();

    await act(async () => { app.client.setQueryData(["hosts"], recoveryHostsLocal); });
    await waitFor(() => expect(within(receipt).queryByTestId("startup-receipt-foreign")).toBeNull());
    fireEvent.click(within(receipt).getByTestId("startup-receipt-reread"));
    expect(await within(receipt).findByTestId("startup-readback")).toBeTruthy();
    expect(net.posts()).toHaveLength(1);
  });

  it("discards a readback whose source changed while the GET was in flight", async () => {
    const answer = deferred<Response>();
    let holdRig = false; const rigRead = deferred<Response>();
    const net = startupDaemon({ post: () => answer.promise, rig: () => holdRig ? rigRead.promise : json(startupRigAlpha) });
    const app = renderShell(<StartupChooser />);
    fireEvent.click(await seatButton());
    await waitFor(() => expect(net.posts()).toHaveLength(1));
    holdRig = true;
    await act(async () => { answer.resolve(json({ ok: true, code: "resumed", logicalId: "orch.lead" })); });
    const receipt = await screen.findByTestId("startup-receipt");
    await waitFor(() => expect(receipt.getAttribute("data-status")).toBe("succeeded"));
    await act(async () => { app.client.setQueryData(["hosts"], { ...recoveryHostsLocal, ownName: "instance-b" }); });
    await act(async () => { rigRead.resolve(json(startupRigAlpha)); });
    await waitFor(() => expect(within(receipt).getByTestId("startup-readback-deferred").textContent).toMatch(/result was discarded/));
    expect(within(receipt).queryByTestId("startup-readback")).toBeNull();
  });
});

describe("fleet admission", () => {
  it("refuses kickoff after a failed hosts refresh and stop after a remote switch, before rerender", async () => {
    const net = startupDaemon({ post: call => call.path.endsWith("/cancel") ? json({ ok: true, cancelled: true }) : json({ fleetAttemptId: "fleet-demo-1", status: "started" }, 202) });
    const app = renderShell(<FleetRestorePanel />, { pollOptions: { pollIntervalMs: 15 } });
    const start = await screen.findByTestId("fleet-kickoff-start") as HTMLButtonElement;
    await waitFor(() => expect(start.disabled).toBe(false));
    act(() => { failHostsRefresh(app.client); fireEvent.click(start); });
    await act(async () => { await Promise.resolve(); });
    expect(net.posts()).toHaveLength(0);

    await act(async () => { app.client.setQueryData(["hosts"], recoveryHostsLocal); });
    await waitFor(() => expect(start.disabled).toBe(false));
    fireEvent.click(start);
    await waitFor(() => expect(screen.getAllByTestId("fleet-row")).toHaveLength(2));
    const stop = screen.getByTestId("fleet-stop");
    act(() => { app.client.setQueryData(["hosts"], recoveryHostsRemote); fireEvent.click(stop); });
    await act(async () => { await Promise.resolve(); });
    expect(net.posts()).toHaveLength(1);
    expect(net.posts()[0]!.path).toBe("/api/crash-cart/restore-fleet");
  });
});

function catalogDaemon(options: { preview?: (view: string, provider: string) => TerminalPreviewDto; open?: (call: FetchCall) => Response | Promise<Response> } = {}) {
  return installFetch(call => {
    if (call.path === "/api/hosts") return json(recoveryHostsLocal);
    if (call.path === "/api/terminal/views") return json(terminalViewsFixture);
    if (call.path === "/api/terminal/preview") {
      const view = call.search.get("view")!; const provider = call.search.get("provider")!;
      return json(options.preview ? options.preview(view, provider) : terminalPreviewFixture(view, provider, ["orch.lead@alpha"]));
    }
    if (call.method === "POST" && call.path === "/api/terminal/open") return options.open ? options.open(call) : json({ provider: "herdr", ok: true, opened: ["orch.lead@alpha"], absent: [], degraded: [], pages: 1 });
    return undefined;
  });
}
async function openButton() {
  const button = await screen.findByTestId("terminal-open") as HTMLButtonElement;
  await waitFor(() => expect(button.disabled).toBe(false));
  return button;
}

describe("catalog Open admission and settlement", () => {
  it("refuses Open after a failed hosts refresh before rerender", async () => {
    const net = catalogDaemon();
    const app = renderShell(<TerminalCatalog view="rig:alpha" />);
    const button = await openButton();
    act(() => { failHostsRefresh(app.client); fireEvent.click(button); });
    await act(async () => { await Promise.resolve(); });
    expect(net.posts()).toHaveLength(0);
    expect(screen.queryByTestId("terminal-open-pending")).toBeNull();
  });

  it("opens only the current validated preview, never a retained older plan object", async () => {
    let plan = "plan-1";
    localStorage.setItem(TERMINAL_BEARER_STORAGE_KEY, "demo-terminal-token");
    const net = catalogDaemon({ preview: (view, provider) => terminalPreviewFixture(view, provider, ["orch.lead@alpha"], { planId: plan }) });
    const app = renderShell(<><TerminalCatalog view="rig:alpha" /><CaptureStore /></>);
    await openButton();
    const old = app.client.getQueryData<TerminalPreviewDto>(["terminal", "preview", "local", "rig:alpha", "herdr"])!;
    plan = "plan-2";
    fireEvent.click(screen.getByTestId("terminal-preview-refresh"));
    await waitFor(() => expect(screen.getByTestId("terminal-plan-id").textContent).toBe("plan-2"));
    let refusal: string | null = null;
    act(() => { refusal = store!.open(old, "local"); });
    expect(refusal).toMatch(/no longer the current validated plan/);
    expect(net.posts()).toHaveLength(0);

    fireEvent.click(await openButton());
    await screen.findByTestId("terminal-open-result");
    expect(net.posts()).toHaveLength(1);
    expect(net.posts()[0]!.body).toEqual({ provider: "herdr", view: "rig:alpha", expectedPlan: "plan-2" });
    expect(net.posts()[0]!.headers.get("Authorization")).toBe("Bearer demo-terminal-token");
  });

  it("keeps another provider's result unverifiable under the original attempt and does not resend", async () => {
    const net = catalogDaemon({ open: () => json({ provider: "cmux", ok: true, opened: ["orch.lead@alpha"], absent: [], degraded: [], pages: 1 }) });
    renderShell(<TerminalCatalog view="rig:alpha" />);
    fireEvent.click(await openButton());
    const uncertain = await screen.findByTestId("terminal-open-uncertain");
    expect(uncertain.textContent).toMatch(/provider “cmux”, not the requested “herdr”/);
    expect(uncertain.textContent).toMatch(/herdr · plan/);
    expect(screen.queryByTestId("terminal-open-result")).toBeNull();
    expect((screen.getByTestId("terminal-open") as HTMLButtonElement).disabled).toBe(true);
    expect(net.posts()).toHaveLength(1);
  });

  it("settles a hung Open at the total deadline, releases the lane, and ignores and disposes a late response", async () => {
    const late = deferred<Response>();
    const posts: unknown[] = [];
    // A transport that ignores AbortSignal entirely.
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(input), "http://twin.invalid");
      if (url.pathname === "/api/hosts") return json(recoveryHostsLocal);
      if (url.pathname === "/api/terminal/views") return json(terminalViewsFixture);
      if (url.pathname === "/api/terminal/preview") return json(terminalPreviewFixture(url.searchParams.get("view")!, url.searchParams.get("provider")!, ["orch.lead@alpha"]));
      if (init.method === "POST") { posts.push(init.body); return late.promise; }
      return json({ error: "unrouted" }, 599);
    }));
    const app = renderShell(<><TerminalCatalog view="rig:alpha" /><CaptureStore /></>);
    const button = await openButton();
    vi.useFakeTimers();
    fireEvent.click(button);
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByTestId("terminal-open-pending")).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(59_999); });
    expect(screen.getByTestId("terminal-open-pending")).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(2); });
    expect(screen.getByTestId("terminal-open-uncertain").textContent).toMatch(/No complete response within 60 seconds/);
    expect(store!.openPending).toBe(false);
    vi.useRealTimers();

    const lateResponse = json({ provider: "herdr", ok: true, opened: ["orch.lead@alpha"], absent: [], degraded: [], pages: 1 });
    const cancel = vi.spyOn(lateResponse.body!, "cancel");
    await act(async () => { late.resolve(lateResponse); await Promise.resolve(); await Promise.resolve(); });
    expect(screen.getByTestId("terminal-open-uncertain")).toBeTruthy();
    expect(screen.queryByTestId("terminal-open-result")).toBeNull();
    expect(cancel).toHaveBeenCalled();
    // The lane is released, but the same plan is not re-opened until a newer preview is read.
    const current = app.client.getQueryData<TerminalPreviewDto>(["terminal", "preview", "local", "rig:alpha", "herdr"])!;
    let refusal: string | null = null;
    act(() => { refusal = store!.open(current, "local"); });
    expect(refusal).toMatch(/last Open outcome is unknown/);
    expect(posts).toHaveLength(1);
  });
});

describe("catalog Open binds the connection a preview was read from", () => {
  function originDaemon(options: { previewGate?: () => Promise<void> | undefined } = {}) {
    let name = "instance-a";
    const net = installFetch(call => {
      if (call.path === "/api/hosts") return json({ ...recoveryHostsLocal, ownName: name });
      if (call.path === "/api/terminal/views") return json(terminalViewsFixture);
      if (call.path === "/api/terminal/preview") {
        const body = terminalPreviewFixture(call.search.get("view")!, call.search.get("provider")!, ["orch.lead@alpha"]);
        const gate = options.previewGate?.();
        return gate ? gate.then(() => json(body)) : json(body);
      }
      if (call.method === "POST" && call.path === "/api/terminal/open") return json({ provider: "herdr", ok: true, opened: ["orch.lead@alpha"], absent: [], degraded: [], pages: 1 });
      return undefined;
    });
    const hostsAs = (next: string) => { name = next; return { ...recoveryHostsLocal, ownName: next }; };
    return { net, hostsAs };
  }
  const cached = (client: QueryClient) => client.getQueryData<TerminalPreviewDto>(["terminal", "preview", "local", "rig:alpha", "herdr"])!;

  it("refuses the retained A preview in the same frame the connection becomes B, both local", async () => {
    const { net, hostsAs } = originDaemon();
    const app = renderShell(<><TerminalCatalog view="rig:alpha" /><CaptureStore /></>);
    const button = await openButton();
    const a = cached(app.client);
    let refusal: string | null = null;
    act(() => {
      app.client.setQueryData(["hosts"], hostsAs("instance-b"));
      expect(cached(app.client)).toBe(a);
      fireEvent.click(button);
      refusal = store!.open(a, "local");
    });
    await act(async () => { await Promise.resolve(); });
    expect(refusal).toMatch(/read from a different connected instance/);
    expect(net.posts()).toHaveLength(0);
  });

  it("keeps Open held after the rerender, until a genuinely new read on B; the B result keeps its original connection", async () => {
    const { net, hostsAs } = originDaemon();
    const app = renderShell(<TerminalCatalog view="rig:alpha" />);
    await openButton();
    await act(async () => { app.client.setQueryData(["hosts"], hostsAs("instance-b")); });
    await waitFor(() => expect(screen.getByTestId("terminal-open-hold").textContent).toMatch(/different connected instance/));
    expect((screen.getByTestId("terminal-open") as HTMLButtonElement).disabled).toBe(true);

    const reads = net.gets("/api/terminal/preview").length;
    fireEvent.click(screen.getByTestId("terminal-preview-refresh"));
    await waitFor(() => expect(net.gets("/api/terminal/preview").length).toBe(reads + 1));
    fireEvent.click(await openButton());
    const result = await screen.findByTestId("terminal-open-result");
    expect(within(result).queryByTestId("terminal-open-original-connection")).toBeNull();
    expect(net.posts()).toHaveLength(1);
    expect(net.posts()[0]!.body).toEqual({ provider: "herdr", view: "rig:alpha", expectedPlan: "plan-rig:alpha-herdr-1" });

    await act(async () => { app.client.setQueryData(["hosts"], hostsAs("instance-a")); });
    await waitFor(() => expect(screen.getByTestId("terminal-open-original-connection").textContent).toMatch(/instance=instance-b/));
  });

  it("does not certify a read whose connection changed while it was pending", async () => {
    let hold: ReturnType<typeof deferred<void>> | null = null;
    const { net, hostsAs } = originDaemon({ previewGate: () => hold?.promise });
    const app = renderShell(<><TerminalCatalog view="rig:alpha" /><CaptureStore /></>);
    await openButton();
    await act(async () => { app.client.setQueryData(["hosts"], hostsAs("instance-b")); });
    hold = deferred<void>();
    const gate = hold;
    fireEvent.click(screen.getByTestId("terminal-preview-refresh"));
    await waitFor(() => expect(app.client.getQueryState(["terminal", "preview", "local", "rig:alpha", "herdr"])!.fetchStatus).toBe("fetching"));
    act(() => { app.client.setQueryData(["hosts"], hostsAs("instance-c")); });
    await act(async () => { gate.resolve(); });
    await waitFor(() => expect(app.client.getQueryState(["terminal", "preview", "local", "rig:alpha", "herdr"])!.fetchStatus).toBe("idle"));
    let refusal: string | null = null;
    act(() => { refusal = store!.open(cached(app.client), "local"); });
    expect(refusal).toMatch(/source instance could not be confirmed/);
    hold = null;

    const reads = net.gets("/api/terminal/preview").length;
    fireEvent.click(screen.getByTestId("terminal-preview-refresh"));
    await waitFor(() => expect(net.gets("/api/terminal/preview").length).toBe(reads + 1));
    fireEvent.click(await openButton());
    await screen.findByTestId("terminal-open-result");
    expect(net.posts()).toHaveLength(1);
  });

  it("never certifies preview data placed in the cache without a read", async () => {
    const { net } = originDaemon();
    const app = renderShell(<><TerminalCatalog view="rig:alpha" /><CaptureStore /></>);
    await openButton();
    const forged = terminalPreviewFixture("rig:alpha", "herdr", ["orch.lead@alpha"], { planId: "plan-forged" });
    act(() => { app.client.setQueryData(["terminal", "preview", "local", "rig:alpha", "herdr"], forged); });
    let refusal: string | null = null;
    expect(cached(app.client).planId).toBe("plan-forged");
    act(() => { refusal = store!.open(cached(app.client), "local"); });
    expect(refusal).toMatch(/source instance could not be confirmed/);
    expect(net.posts()).toHaveLength(0);
  });
});
