import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useNeedsInputSeats } from "../src/hooks/useNeedsInputSeats.js";

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

function wrapper(client: QueryClient) {
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

afterEach(() => {
  cleanup();
  mockFetch.mockReset();
});

describe("useNeedsInputSeats", () => {
  it("keeps later needs-input seats when one rig nodes request rejects", async () => {
    const rejected = vi.fn();
    mockFetch.mockImplementation(async (url: string) => {
      if (url === "/api/ps") {
        return new Response(JSON.stringify([
          { rigId: "rig-stale", name: "rig-stale", nodeCount: 1, runningCount: 1, status: "running", uptime: null, latestSnapshot: null },
          { rigId: "product-team", name: "product-team", nodeCount: 1, runningCount: 1, status: "running", uptime: null, latestSnapshot: null },
        ]));
      }
      if (url === "/api/rigs/rig-stale/nodes?full=true") {
        rejected();
        throw new Error("resource exhausted");
      }
      if (url === "/api/rigs/product-team/nodes?full=true") {
        return new Response(JSON.stringify([
          {
            rigId: "product-team",
            rigName: "product-team",
            logicalId: "orch1.lead",
            canonicalSessionName: "orch1-lead@product-team",
            terminalActive: false,
            podId: null, nodeKind: "agent", runtime: null, sessionStatus: null, startupStatus: null,
            restoreOutcome: "unknown", tmuxAttachCommand: null, resumeCommand: null, latestError: null,
            agentActivity: {
              state: "needs_input",
              reason: "selection_prompt",
              evidenceSource: "pane_heuristic",
              sampledAt: "2026-06-19T09:35:29.847Z",
              fallback: true,
            },
          },
        ]));
      }
      return new Response("[]");
    });

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useNeedsInputSeats(), { wrapper: wrapper(client) });

    await waitFor(() => expect(result.current.data).toHaveLength(1));
    expect(rejected).toHaveBeenCalledTimes(1);
    expect(result.current.data![0]).toMatchObject({
      logicalId: "orch1.lead",
      sessionName: "orch1-lead@product-team",
      source: "pane_heuristic",
      rigId: "product-team",
    });
  });
});
