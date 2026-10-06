// A FAILED status read is not a pending one. The dashboard kernel card and the
// topology rig-status control used to render "loading…" forever after their
// read failed (404 from an older/partial daemon, 5xx, network), hiding the
// failure and — for the rig control — any way to retry. Root dogfood: Dashboard
// kernel status stayed "Loading" under a failed /api/kernel/status read.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { RigStatusControl } from "../src/components/RigStatusControl.js";
import { KernelStatusCard } from "../src/components/KernelStatusCard.js";

const mockFetch = vi.fn();

beforeEach(() => {
  globalThis.fetch = mockFetch as unknown as typeof fetch;
  mockFetch.mockReset();
});
afterEach(() => cleanup());

function renderWithClient(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("failed status reads are disclosed, not shown as loading", () => {
  it("kernel card: a failed /api/kernel/status read says so and stays non-green", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url === "/api/kernel/status") return json({ error: "not found" }, 404);
      return json([]);
    });
    renderWithClient(<KernelStatusCard />);
    const src = await screen.findByTestId("rig-status-src-kernel");
    await waitFor(() => expect(src.textContent).toContain("read failed"));
    expect(src.textContent).toContain("HTTP 404");
    expect(src.textContent).not.toContain("loading");
    expect(screen.getByTestId("rig-status-badge-kernel").textContent).toContain("unknown");
    expect((screen.getByTestId("rig-primary-action-kernel") as HTMLButtonElement).disabled).toBe(true);
  });

  it("rig control: a failed /api/rigs/:id/status read says so and offers Retry", async () => {
    let fail = true;
    mockFetch.mockImplementation(async (url: string) => {
      if (url === "/api/rigs/rig1/status") {
        return fail ? json({ error: "boom" }, 500) : json({
          rigId: "rig1", rigName: "alpha", isKernel: false, status: "down", seatsTotal: 2, seatsRunning: 0,
          recoverable: true, perSeat: [], src: ["ps"],
        });
      }
      return json([]);
    });
    renderWithClient(<RigStatusControl rigId="rig1" rigName="alpha" />);
    const control = await screen.findByTestId("rig-status-control-rig1");
    await waitFor(() => expect(control.textContent).toContain("unavailable"));
    expect(control.textContent).toContain("HTTP 500");
    expect(control.textContent).not.toMatch(/loading/i);
    fail = false;
    fireEvent.click(screen.getByTestId("rig-status-retry-rig1"));
    await waitFor(() => expect(screen.getByTestId("rig-status-control-rig1").getAttribute("data-status")).toBe("down"));
    expect(screen.getByTestId("rig-primary-action-rig1")).toBeTruthy();
  });
});
