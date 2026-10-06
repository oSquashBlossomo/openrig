import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StartupChooser } from "../src/components/startup/StartupChooser.js";
import {
  recoveryHostsLocal, recoveryHostsRemote, recoveryRigSummaries, startupPrerequisitesFixture,
  startupRigAlpha, startupRigAlphaRevised, startupSeatAttention, startupSeatOrchestrator,
} from "../twin/recovery-fixtures.js";
import { deferred, installFetch, json, renderShell, type FetchCall } from "./recovery-harness.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); sessionStorage.clear(); localStorage.clear(); });

function daemon(overrides: { rig?: () => unknown; post?: (call: FetchCall) => Response | Promise<Response>; hosts?: unknown } = {}) {
  return installFetch(call => {
    if (call.path === "/api/hosts") return json(overrides.hosts ?? recoveryHostsLocal);
    if (call.path === "/api/rigs/summary") return json(recoveryRigSummaries);
    if (call.path === "/api/startup/prerequisites") return json(startupPrerequisitesFixture);
    if (call.method === "GET" && call.path === "/api/startup/rig_demo_alpha") return json(overrides.rig ? overrides.rig() : startupRigAlpha);
    if (call.method === "POST" && overrides.post) return overrides.post(call);
    return undefined;
  });
}

async function openSeat(nodeId: string) {
  fireEvent.click(await screen.findByTestId("startup-rig-rig_demo_alpha"));
  fireEvent.click(await screen.findByTestId(`startup-seat-${nodeId}`));
  return screen.findByTestId("startup-seat-detail");
}

describe("per-seat startup chooser", () => {
  it("keeps a runtime:null seat inspectable without hiding healthy siblings or offering it an action", async () => {
    const net = daemon();
    renderShell(<StartupChooser />);
    fireEvent.click(await screen.findByTestId("startup-rig-rig_demo_alpha"));
    const list = await screen.findByTestId("startup-seat-scroll");
    expect(within(list).getAllByRole("button")).toHaveLength(4);
    expect(within(screen.getByTestId("startup-seat-node_scratch_pad")).getByText("runtime unconfigured")).toBeTruthy();

    fireEvent.click(screen.getByTestId("startup-seat-node_scratch_pad"));
    expect(await screen.findByTestId("startup-null-runtime")).toBeTruthy();
    expect(screen.queryByTestId("startup-action-primary")).toBeNull();
    expect(screen.queryByTestId("startup-action-fresh")).toBeNull();

    fireEvent.click(screen.getByTestId("startup-seat-node_custom_helper"));
    expect(screen.getByTestId("startup-fact-runtime").textContent).toBe("acme-agent");
    expect(screen.getByTestId("startup-action-primary").textContent).toBe("Start");

    fireEvent.click(screen.getByTestId("startup-seat-node_orch_lead"));
    expect(screen.getByTestId("startup-action-primary").textContent).toBe("Resume");
    expect(net.posts()).toHaveLength(0);
  });

  it("binds Fresh consent to the inspected revision: decline and refresh send nothing; a changed revision blocks confirmation", async () => {
    let rig: unknown = startupRigAlpha;
    const net = daemon({ rig: () => rig, post: () => json({ ok: true, code: "launched" }) });
    renderShell(<StartupChooser />);
    await openSeat("node_orch_lead");

    fireEvent.click(screen.getByTestId("startup-action-fresh"));
    const identity = screen.getByTestId("startup-fresh-identity");
    expect(within(identity).getByText("rev-node_orch_lead-1")).toBeTruthy();
    expect(within(identity).getByText("orch.lead@alpha")).toBeTruthy();
    fireEvent.click(screen.getByTestId("startup-fresh-decline"));
    expect(screen.queryByTestId("startup-fresh-confirmation")).toBeNull();

    fireEvent.click(screen.getByTestId("startup-action-fresh"));
    rig = startupRigAlphaRevised;
    fireEvent.click(screen.getByTestId("startup-rig-refresh"));
    expect(await screen.findByTestId("startup-fresh-stale")).toBeTruthy();
    expect((screen.getByTestId("startup-fresh-confirm") as HTMLButtonElement).disabled).toBe(true);
    expect(net.posts()).toHaveLength(0);

    fireEvent.click(screen.getByTestId("startup-fresh-decline"));
    fireEvent.click(screen.getByTestId("startup-action-fresh"));
    expect(within(screen.getByTestId("startup-fresh-identity")).getByText("rev-node_orch_lead-2")).toBeTruthy();
    fireEvent.click(screen.getByTestId("startup-fresh-confirm"));
    await waitFor(() => expect(net.posts()).toHaveLength(1));
    expect(net.posts()[0]!.path).toBe("/api/startup/rig_demo_alpha/orch.lead");
    expect(net.posts()[0]!.body).toEqual({ action: "fresh", revision: "rev-node_orch_lead-2" });
  });

  it("sends one POST for repeated input and keeps the pending attempt across route unmount", async () => {
    const answer = deferred<Response>();
    const net = daemon({ post: () => answer.promise });
    const app = renderShell(<StartupChooser />);
    await openSeat("node_orch_lead");
    fireEvent.change(screen.getByTestId("startup-seat-filter"), { target: { value: "orch" } });
    const primary = screen.getByTestId("startup-action-primary");
    fireEvent.click(primary); fireEvent.click(primary);
    await waitFor(() => expect(net.posts()).toHaveLength(1));
    expect((primary as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("startup-busy")).toBeTruthy();

    app.show(<p>elsewhere</p>);
    await act(async () => { answer.resolve(json({ ok: true, code: "resumed", logicalId: "orch.lead" })); });

    app.show(<StartupChooser />);
    const receipt = await screen.findByTestId("startup-receipt");
    await waitFor(() => expect(receipt.getAttribute("data-status")).toBe("succeeded"));
    expect(within(receipt).getByText("resumed")).toBeTruthy();
    expect((screen.getByTestId("startup-seat-filter") as HTMLInputElement).value).toBe("orch");
    expect(screen.getByTestId("startup-seat-detail")).toBeTruthy();
    expect(net.posts()).toHaveLength(1);
  });

  it("keeps a lost startup response outcome-unknown, never retries it, and reads the exact seat back", async () => {
    const net = daemon({ post: () => { throw new TypeError("connection reset"); } });
    renderShell(<StartupChooser />);
    await openSeat("node_orch_lead");
    fireEvent.click(screen.getByTestId("startup-action-primary"));
    const receipt = await screen.findByTestId("startup-receipt");
    await waitFor(() => expect(receipt.getAttribute("data-status")).toBe("outcome_unknown"));
    expect(within(receipt).getByTestId("startup-receipt-unknown").textContent).toMatch(/not retried|nothing is resent/i);
    expect(await within(receipt).findByTestId("startup-readback")).toBeTruthy();
    expect(within(receipt).getByText("Seat identity and revision unchanged.")).toBeTruthy();
    expect(net.posts()).toHaveLength(1);
    expect(net.posts()[0]!.body).toEqual({ action: "resume", revision: startupSeatOrchestrator.revision });
  });

  it("treats a response naming another seat as unknown rather than success", async () => {
    daemon({ post: () => json({ ok: true, logicalId: "someone.else" }) });
    renderShell(<StartupChooser />);
    await openSeat("node_orch_lead");
    fireEvent.click(screen.getByTestId("startup-action-primary"));
    const receipt = await screen.findByTestId("startup-receipt");
    await waitFor(() => expect(receipt.getAttribute("data-status")).toBe("outcome_unknown"));
    expect(receipt.textContent).toMatch(/different seat/);
  });

  it("offers Continue only from served contextPending, keeps the native prompt native, and treats 409 attention as unknown", async () => {
    const net = daemon({ post: () => json({ ok: false, code: "startup_failed", message: "native prompt still open" }, 409) });
    const inspect = vi.fn();
    renderShell(<StartupChooser onInspectSeat={inspect} />);
    await openSeat("node_build_worker");
    expect(screen.getByTestId("startup-native-attention").textContent).toMatch(/native session itself/);
    fireEvent.click(screen.getByTestId("startup-inspect-session"));
    expect(inspect).toHaveBeenCalledWith({ rigId: "rig_demo_alpha", logicalId: "build.worker", sessionName: "build.worker@alpha" });
    expect(net.posts()).toHaveLength(0);

    fireEvent.click(screen.getByTestId("startup-action-continue"));
    await waitFor(() => expect(net.posts()).toHaveLength(1));
    expect(net.posts()[0]!.body).toEqual({ action: "continue", revision: startupSeatAttention.revision });
    const receipt = await screen.findByTestId("startup-receipt");
    await waitFor(() => expect(receipt.getAttribute("data-status")).toBe("outcome_unknown"));

    await openSeat("node_orch_lead");
    expect(screen.queryByTestId("startup-action-continue")).toBeNull();
  });

  it("shows a known pre-effect selection conflict as refused and requires a new inspected choice", async () => {
    let rig: unknown = startupRigAlpha;
    daemon({ rig: () => rig, post: () => { rig = startupRigAlphaRevised; return json({ ok: false, code: "selection_changed", message: "revision changed" }, 409); } });
    renderShell(<StartupChooser />);
    await openSeat("node_orch_lead");
    fireEvent.click(screen.getByTestId("startup-action-primary"));
    const refused = await screen.findByTestId("startup-receipt-rejected");
    expect(refused.textContent).toMatch(/Seat changed before effect|new choice/);
    expect(await screen.findByTestId("startup-readback-changed")).toBeTruthy();
  });

  it("never reads or acts on startup under a remote host selection", async () => {
    const net = daemon({ hosts: recoveryHostsRemote });
    renderShell(<StartupChooser />);
    expect(await screen.findByTestId("startup-remote-scope")).toBeTruthy();
    expect(screen.queryByTestId("startup-rig-list")).toBeNull();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(net.calls.filter(c => c.path.startsWith("/api/startup"))).toHaveLength(0);
  });

  it("keeps the chooser usable when kernel preparation selects its returned rig for inspection", async () => {
    const net = daemon({ post: call => call.path === "/api/startup/kernel" ? json({ ok: true, rigId: "rig_demo_alpha", reused: true }) : json({ ok: true }) });
    renderShell(<StartupChooser />);
    fireEvent.click(await screen.findByTestId("startup-kernel-codex"));
    await waitFor(() => expect(net.posts("/api/startup/kernel")).toHaveLength(1));
    expect(net.posts("/api/startup/kernel")[0]!.body).toEqual({ runtime: "codex" });
    expect(await screen.findByTestId("startup-seat-scroll")).toBeTruthy();
    expect(screen.getByTestId("startup-rig-rig_demo_alpha").getAttribute("aria-pressed")).toBe("true");
    expect(net.posts().filter(c => c.path.startsWith("/api/startup/rig_demo_alpha/"))).toHaveLength(0);
  });
});
