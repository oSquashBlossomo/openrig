import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DaemonHealthProvider } from "../src/components/DaemonHealthProvider.js";
import { SettingsSystemStatusPanel } from "../src/components/system/SettingsSystemStatusPanel.js";
import { useDaemonHealthSignal } from "../src/hooks/useDaemonHealth.js";

vi.mock("../src/hooks/useRigSummary.js", () => ({
  useRigSummary: () => ({ data: [], isLoading: false, error: null }),
}));
vi.mock("../src/hooks/usePsEntries.js", () => ({
  usePsEntries: () => ({ data: [] }),
}));

const unhealthyHealth = {
  status: "ok",
  eventLoop: { lagMeanMs: 900, lagP99Ms: 1200, utilization: 0.99, lastTickAgeMs: 1500, healthy: false },
};

function HealthConsumer() {
  const signal = useDaemonHealthSignal();
  return <span data-testid="health-signal">{JSON.stringify(signal)}</span>;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Settings status shared daemon health", () => {
  it("preserves event-loop evidence in the shared cache and terminal signal after status refetch", async () => {
    vi.useFakeTimers();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    client.setQueryData(["daemon", "health"], unhealthyHealth);
    const healthCacheUpdates: unknown[] = [];
    const unsubscribe = client.getQueryCache().subscribe((event) => {
      if (event.type === "updated" && event.action.type === "success" && event.query.queryKey.join("/") === "daemon/health") {
        healthCacheUpdates.push(event.query.state.data);
      }
    });
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => new Response(
      JSON.stringify(String(url) === "/healthz" ? unhealthyHealth : { available: true }),
      { status: 200 },
    )));

    const tree = (showStatus: boolean) => (
      <QueryClientProvider client={client}>
        <DaemonHealthProvider>
          {showStatus && <SettingsSystemStatusPanel />}
          <HealthConsumer />
        </DaemonHealthProvider>
      </QueryClientProvider>
    );
    const view = render(tree(false));
    expect(JSON.parse(screen.getByTestId("health-signal").textContent!).controlPlaneUnhealthy).toBe(true);
    // The app-wide provider starts before route navigation mounts Status.
    // Its 10s timer and the later Status observer's 10s timer are offset.
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    view.rerender(tree(true));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
      await vi.advanceTimersByTimeAsync(1);
    });
    unsubscribe();
    expect(healthCacheUpdates.length).toBeGreaterThan(0);
    expect(healthCacheUpdates.every((data) => typeof data === "object" && data !== null)).toBe(true);
    expect(client.getQueryData(["daemon", "health"])).toEqual(unhealthyHealth);
    expect(JSON.parse(screen.getByTestId("health-signal").textContent!)).toEqual({
      controlPlaneUnhealthy: true,
      evidence: unhealthyHealth.eventLoop,
    });
  });

  it("shows an unhealthy verdict and evidence when the responding daemon reports a starved event loop", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => new Response(
      JSON.stringify(String(url) === "/healthz" ? unhealthyHealth : { available: true }),
      { status: 200 },
    )));
    render(<QueryClientProvider client={client}><SettingsSystemStatusPanel /></QueryClientProvider>);

    await waitFor(() => {
      expect(screen.getByTestId("status-daemon").textContent).toBe("UNHEALTHY");
    });
    expect(screen.getByTestId("status-daemon-evidence").textContent).toContain("1500ms");
  });

  it.each([
    { status: "ok" },
    { status: "ok", eventLoop: { ...unhealthyHealth.eventLoop, healthy: true } },
  ])("keeps healthy and older monitor-less daemons reachable: %j", async (body) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => new Response(
      JSON.stringify(String(url) === "/healthz" ? body : { available: true }),
      { status: 200 },
    )));
    render(<QueryClientProvider client={client}><SettingsSystemStatusPanel /></QueryClientProvider>);
    await waitFor(() => expect(screen.getByTestId("status-daemon").textContent).toBe("OK"));
    expect(screen.queryByTestId("status-daemon-evidence")).toBeNull();
    expect(screen.getByTestId("status-cmux").textContent).toBe("AVAILABLE");
  });

  it("reports a failed health poll as ERROR and cmux status as unknown", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => new Response(
      JSON.stringify({ available: true }), { status: String(url) === "/healthz" ? 503 : 200 },
    )));
    render(<QueryClientProvider client={client}><SettingsSystemStatusPanel /></QueryClientProvider>);
    await waitFor(() => expect(screen.getByTestId("status-daemon").textContent).toBe("ERROR"));
    expect(screen.getByTestId("status-cmux").textContent).toBe("UNKNOWN");
  });
});
