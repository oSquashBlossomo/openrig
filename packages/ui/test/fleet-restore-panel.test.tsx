import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FleetRestorePanel } from "../src/components/restore/FleetRestorePanel.js";
import type { FleetRestoreStatus } from "../src/lib/startup-contracts.js";
import {
  fleetCancelledRunning, fleetDoneAllFailed, fleetDoneCancelled, fleetDoneMixed, fleetDoneNoneAttempted, fleetRunningEmpty, fleetRunningPartial,
  recoveryHostsLocal, recoveryHostsRemote,
} from "../twin/recovery-fixtures.js";
import { deferred, installFetch, json, renderShell, type FetchCall } from "./recovery-harness.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); sessionStorage.clear(); });

const KICKOFF = "/api/crash-cart/restore-fleet";
const ATTEMPT = "fleet/demo 1";
const STATUS = `${KICKOFF}/${encodeURIComponent(ATTEMPT)}`;
const CANCEL = `${STATUS}/cancel`;
const poll = { pollIntervalMs: 15 };

function daemon(options: {
  hosts?: () => unknown; kickoff?: () => Response | Promise<Response>; status?: () => Response | Promise<Response>;
  cancel?: () => Response | Promise<Response>;
} = {}) {
  return installFetch((call: FetchCall) => {
    if (call.path === "/api/hosts") return json(options.hosts ? options.hosts() : recoveryHostsLocal);
    if (call.method === "POST" && call.path === KICKOFF) return options.kickoff ? options.kickoff() : json({ fleetAttemptId: ATTEMPT, status: "started" }, 202);
    if (call.method === "GET" && call.path.startsWith(`${KICKOFF}/`)) return options.status ? options.status() : json(fleetRunningEmpty);
    if (call.method === "POST" && call.path === CANCEL) return options.cancel ? options.cancel() : json({ ok: true, cancelled: true });
    return undefined;
  });
}

async function start() {
  const button = await screen.findByTestId("fleet-kickoff-start") as HTMLButtonElement;
  await waitFor(() => expect(button.disabled).toBe(false));
  fireEvent.click(button);
}

describe("connected fleet restore", () => {
  it("keeps the accepted handle when the page unmounts before 202 and shows progressive rows on return without a second kickoff", async () => {
    const accepted = deferred<Response>();
    let status: FleetRestoreStatus = fleetRunningEmpty;
    const net = daemon({ kickoff: () => accepted.promise, status: () => json(status) });
    const app = renderShell(<FleetRestorePanel />, { pollOptions: poll });
    await start();
    expect(await screen.findByTestId("fleet-kickoff-pending")).toBeTruthy();

    app.show(<p>another page</p>);
    await act(async () => { accepted.resolve(json({ fleetAttemptId: ATTEMPT, status: "started" }, 202)); });
    status = fleetRunningPartial;

    app.show(<FleetRestorePanel />);
    expect((await screen.findByTestId("fleet-attempt-id")).textContent).toBe(ATTEMPT);
    await waitFor(() => expect(screen.getAllByTestId("fleet-row")).toHaveLength(2));
    expect(within(screen.getByTestId("fleet-count-partially_restored")).getByText("1")).toBeTruthy();
    expect(screen.getByTestId("fleet-kickoff-held")).toBeTruthy();
    expect(net.posts(KICKOFF)).toHaveLength(1);
    expect(net.gets(STATUS).length).toBeGreaterThan(0);
  });

  it("reattaches the exact stored handle after a reload with no kickoff", async () => {
    daemon();
    const first = renderShell(<FleetRestorePanel />, { pollOptions: poll });
    await start();
    expect(await screen.findByTestId("fleet-attempt-id")).toBeTruthy();
    first.unmount(); vi.unstubAllGlobals();

    const net = daemon({ status: () => json(fleetRunningPartial) });
    renderShell(<FleetRestorePanel />, { pollOptions: poll });
    expect((await screen.findByTestId("fleet-attempt-id")).textContent).toBe(ATTEMPT);
    await waitFor(() => expect(screen.getAllByTestId("fleet-row")).toHaveLength(2));
    expect(net.posts()).toHaveLength(0);
    expect(new Set(net.calls.filter(c => c.path.startsWith(KICKOFF)).map(c => c.path))).toEqual(new Set([STATUS]));
  });

  it("discloses storage failure separately and still observes the accepted handle from app state", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
    daemon({ status: () => json(fleetRunningPartial) });
    renderShell(<FleetRestorePanel />, { pollOptions: poll });
    await start();
    expect(await screen.findByTestId("fleet-retention-error")).toBeTruthy();
    expect((await screen.findByTestId("fleet-attempt-id")).textContent).toBe(ATTEMPT);
    await waitFor(() => expect(screen.getAllByTestId("fleet-row")).toHaveLength(2));
  });

  it("keeps a lost 202 uncertain with no handle and blocks another kickoff until the operator acknowledges it", async () => {
    const net = daemon({ kickoff: () => { throw new TypeError("socket closed"); } });
    renderShell(<FleetRestorePanel />, { pollOptions: poll });
    await start();
    expect(await screen.findByTestId("fleet-kickoff-unknown")).toBeTruthy();
    expect(screen.queryByTestId("fleet-attempt")).toBeNull();
    expect((screen.getByTestId("fleet-kickoff-start") as HTMLButtonElement).disabled).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(net.posts(KICKOFF)).toHaveLength(1);
    fireEvent.click(screen.getByTestId("fleet-kickoff-acknowledge"));
    expect((screen.getByTestId("fleet-kickoff-start") as HTMLButtonElement).disabled).toBe(false);
    expect(net.posts(KICKOFF)).toHaveLength(1);
  });

  it("stops before the next rig: an accepted stop is not done, and observation continues until served done", async () => {
    let status: FleetRestoreStatus = fleetRunningPartial;
    const net = daemon({ status: () => json(status) });
    renderShell(<FleetRestorePanel />, { pollOptions: poll });
    await start();
    await waitFor(() => expect(screen.getAllByTestId("fleet-row")).toHaveLength(2));
    fireEvent.click(screen.getByTestId("fleet-stop"));
    expect(await screen.findByTestId("fleet-cancel-accepted")).toBeTruthy();
    expect(screen.getByTestId("fleet-phase").textContent).not.toBe("done");
    expect(net.posts(CANCEL)).toHaveLength(1);

    status = fleetCancelledRunning;
    expect(await screen.findByText("Stop observed · current rig finishing")).toBeTruthy();
    status = fleetDoneCancelled;
    await waitFor(() => expect(screen.getByTestId("fleet-phase").textContent).toBe("done"));
    expect(screen.getByText("Stopped before the next rig · done")).toBeTruthy();
    expect(screen.queryByTestId("fleet-stop")).toBeNull();
    const reads = net.gets(STATUS).length;
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(net.gets(STATUS).length).toBe(reads);
    expect(net.posts(CANCEL)).toHaveLength(1);
  });

  it("requires a newer status read after a lost stop response before another deliberate stop", async () => {
    // Control receipt timestamps only; polling/observer timers remain real.
    // Every later GET is held, so an immediate onSettled invalidation cannot
    // race the unknown-state assertion with an already delivered newer read.
    const firstReadAt = Date.UTC(2026, 9, 4, 20, 0, 0);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(firstReadAt);
    try {
      const lostStop = deferred<Response>();
      const pendingReads: Array<{ startedAt: number; response: ReturnType<typeof deferred<Response>> }> = [];
      let reads = 0;
      const net = daemon({
        status: () => {
          if (++reads === 1) return json(fleetRunningPartial);
          const response = deferred<Response>();
          pendingReads.push({ startedAt: Date.now(), response });
          return response.promise;
        },
        cancel: () => lostStop.promise,
      });
      const app = renderShell(<FleetRestorePanel />, { pollOptions: { pollIntervalMs: 200 } });
      await start();
      await waitFor(() => expect(screen.getAllByTestId("fleet-row")).toHaveLength(2));
      const statusQuery = app.client.getQueryCache().getAll().find(query => query.queryKey[0] === "fleet-restore" && query.queryKey.at(-1) === ATTEMPT)!;
      expect(statusQuery.state.dataUpdatedAt).toBe(firstReadAt);

      const lostStopAt = firstReadAt + 1000;
      vi.setSystemTime(lostStopAt);
      fireEvent.click(screen.getByTestId("fleet-stop"));
      expect(await screen.findByTestId("fleet-cancel-pending")).toBeTruthy();
      expect(net.posts(CANCEL)).toHaveLength(1);
      await act(async () => { lostStop.reject(new TypeError("reset")); });
      const unknown = await screen.findByTestId("fleet-cancel-unknown");
      expect(unknown.textContent).toMatch(/Waiting for a newer status read/);
      expect((screen.getByTestId("fleet-stop") as HTMLButtonElement).disabled).toBe(true);
      expect(statusQuery.state.dataUpdatedAt).toBe(firstReadAt);
      fireEvent.click(screen.getByTestId("fleet-stop"));
      expect(net.posts(CANCEL)).toHaveLength(1);

      // Begin a deliberate exact-attempt status GET AFTER the lost response,
      // then deliver only that request; earlier automatic reads remain held.
      const beforeRead = net.gets(STATUS).length;
      const newerReadAt = lostStopAt + 1000;
      vi.setSystemTime(newerReadAt);
      let readBack!: Promise<void>;
      act(() => { readBack = app.client.refetchQueries({ queryKey: statusQuery.queryKey, exact: true }); });
      await waitFor(() => expect(net.gets(STATUS).length).toBeGreaterThan(beforeRead));
      const newerRead = pendingReads.at(-1)!;
      expect(newerRead.startedAt).toBe(newerReadAt);
      expect((screen.getByTestId("fleet-stop") as HTMLButtonElement).disabled).toBe(true);
      expect(screen.getByTestId("fleet-cancel-unknown").textContent).toMatch(/Waiting for a newer status read/);
      await act(async () => { newerRead.response.resolve(json(fleetRunningPartial)); await readBack; });
      await waitFor(() => expect(screen.getByTestId("fleet-cancel-unknown").textContent).toMatch(/newer status has been read/), { timeout: 2000 });
      expect(statusQuery.state.dataUpdatedAt).toBe(newerReadAt);
      expect(statusQuery.state.dataUpdatedAt).toBeGreaterThan(lostStopAt);
      expect((screen.getByTestId("fleet-stop") as HTMLButtonElement).disabled).toBe(false);
      expect(net.posts(CANCEL)).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });

  it("pauses only this view's observation, keeps the exact attempt, and resumes the same read", async () => {
    const net = daemon({ status: () => json(fleetRunningPartial) });
    renderShell(<FleetRestorePanel />, { pollOptions: poll });
    await start();
    await waitFor(() => expect(screen.getAllByTestId("fleet-row")).toHaveLength(2));
    fireEvent.click(screen.getByTestId("fleet-pause"));
    expect(await screen.findByTestId("fleet-paused")).toBeTruthy();
    expect(screen.getByTestId("fleet-kickoff-held")).toBeTruthy();
    const paused = net.gets(STATUS).length;
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(net.gets(STATUS).length).toBe(paused);
    expect(screen.getAllByTestId("fleet-row")).toHaveLength(2);

    fireEvent.click(screen.getByTestId("fleet-resume"));
    await waitFor(() => expect(net.gets(STATUS).length).toBeGreaterThan(paused));
    expect(net.posts(CANCEL)).toHaveLength(0);
    expect(net.posts(KICKOFF)).toHaveLength(1);
  });

  it("reports a 404 as unknown to this daemon, not as nothing ran, and allows a deliberate new kickoff", async () => {
    let known = true;
    const net = daemon({ status: () => known ? json(fleetRunningPartial) : json({ error: "unknown fleet restore attempt" }, 404) });
    renderShell(<FleetRestorePanel />, { pollOptions: poll });
    await start();
    await waitFor(() => expect(screen.getAllByTestId("fleet-row")).toHaveLength(2));
    known = false;
    const notice = await screen.findByTestId("fleet-unknown-attempt");
    expect(notice.textContent).toMatch(/does not mean nothing ran/);
    expect(screen.getAllByTestId("fleet-row")).toHaveLength(2);
    expect((screen.getByTestId("fleet-kickoff-start") as HTMLButtonElement).disabled).toBe(false);
    expect(net.posts(KICKOFF)).toHaveLength(1);
  });

  it("never relabels an attempt accepted by another connected instance", async () => {
    let hosts: unknown = recoveryHostsLocal;
    const net = daemon({ hosts: () => hosts, status: () => json(fleetRunningPartial) });
    const app = renderShell(<FleetRestorePanel />, { pollOptions: poll });
    await start();
    await waitFor(() => expect(screen.getAllByTestId("fleet-row")).toHaveLength(2));
    hosts = { ...recoveryHostsLocal, ownName: "another-instance" };
    await act(async () => { await app.client.refetchQueries({ queryKey: ["hosts"] }); });
    const foreign = await screen.findByTestId("fleet-foreign-handle");
    expect(foreign.textContent).toContain(ATTEMPT);
    expect(screen.queryByTestId("fleet-attempt")).toBeNull();
    const reads = net.gets(STATUS).length;
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(net.gets(STATUS).length).toBe(reads);
  });

  it("refuses kickoff under a remote host selection and sends nothing", async () => {
    const net = daemon({ hosts: () => recoveryHostsRemote });
    renderShell(<FleetRestorePanel />, { pollOptions: poll });
    expect(await screen.findByTestId("fleet-remote-scope")).toBeTruthy();
    expect((screen.getByTestId("fleet-kickoff-start") as HTMLButtonElement).disabled).toBe(true);
    expect(net.posts()).toHaveLength(0);
  });

  it("keeps fully/partial/failed/not-attempted outcomes, attention and remediation distinct", async () => {
    let status: FleetRestoreStatus = fleetDoneMixed;
    const inspect = vi.fn(); const openRig = vi.fn(); let kickoffs = 0;
    daemon({ status: () => json(status), kickoff: () => json({ fleetAttemptId: `fleet-demo-${++kickoffs}`, status: "started" }, 202) });
    const app = renderShell(<FleetRestorePanel onInspectSeat={inspect} onOpenRig={openRig} />, { pollOptions: poll });
    await start();
    await waitFor(() => expect(screen.getByTestId("fleet-phase").textContent).toBe("done"));
    expect(screen.getByTestId("fleet-fact-verdict").textContent).toMatch(/Mixed outcomes/);
    expect(screen.getAllByTestId("fleet-row").map(row => row.getAttribute("data-outcome"))).toEqual(["fully_restored", "partially_restored", "not_attempted"]);
    expect(screen.getByTestId("fleet-row-remediation").textContent).toMatch(/Capture a snapshot/);
    fireEvent.click(within(screen.getByTestId("fleet-attention")).getByTestId("fleet-attention-inspect"));
    expect(inspect).toHaveBeenCalledWith({ rigId: "rig_demo_alpha", seat: "build.worker" });
    fireEvent.click(screen.getByRole("button", { name: "Open rig rig_demo_beta/with-slash" }));
    expect(openRig).toHaveBeenCalledWith("rig_demo_beta/with-slash");

    // A finished attempt allows a deliberate new kickoff; each verdict keeps its own copy.
    status = fleetDoneAllFailed;
    fireEvent.click(screen.getByTestId("fleet-kickoff-start"));
    await waitFor(() => expect(screen.getByTestId("fleet-fact-verdict").textContent).toMatch(/Every finished rig failed/));
    status = fleetDoneNoneAttempted;
    fireEvent.click(screen.getByTestId("fleet-kickoff-start"));
    await waitFor(() => expect(screen.getByTestId("fleet-fact-verdict").textContent).toMatch(/No rig attempted/));
    expect(screen.getByTestId("fleet-attempt-id").textContent).toBe("fleet-demo-3");
    app.unmount();
  });
});
