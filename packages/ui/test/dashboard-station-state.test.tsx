// Dashboard header "STATION <host> IS [ … ]". usePsEntries does not retry, so
// a failed /api/ps read is a SETTLED failure: the header must not claim the
// station is still "CONNECTING" (pending) — nor ONLINE (false healthy).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, waitFor } from "@testing-library/react";
import { createTestRouter } from "./helpers/test-router.js";
import { render } from "@testing-library/react";
import { Dashboard } from "../src/components/dashboard/Dashboard.js";

const mockFetch = vi.fn();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let psStatus = 200;
beforeEach(() => {
  globalThis.fetch = mockFetch as unknown as typeof fetch;
  mockFetch.mockReset();
  mockFetch.mockImplementation(async (url: string) => {
    if (String(url).startsWith("/api/ps")) return psStatus === 200 ? json([]) : json({ error: "boom" }, psStatus);
    return json([]);
  });
});
afterEach(() => cleanup());

// The existing header element (no markup added): <div class="df-sub">STATION … IS <b>[ … ]</b></div>.
const state = () => {
  const el = document.querySelector(".df-sub b");
  if (!el) throw new Error("station state element not rendered");
  return el;
};

describe("Dashboard station state", () => {
  it("a settled failed /api/ps read is disclosed, not shown as CONNECTING or ONLINE", async () => {
    psStatus = 500;
    render(createTestRouter({ component: () => <Dashboard /> }));
    await waitFor(() => expect(mockFetch.mock.calls.some(([u]) => String(u).startsWith("/api/ps"))).toBe(true));
    await waitFor(() => expect(state().textContent).toContain("STATUS UNAVAILABLE"));
    expect(state().textContent).not.toContain("CONNECTING");
    expect(state().textContent).not.toContain("ONLINE");
  });

  it("pending stays CONNECTING and a successful read is ONLINE (unchanged)", async () => {
    psStatus = 200;
    render(createTestRouter({ component: () => <Dashboard /> }));
    await waitFor(() => expect(state().textContent).toContain("ONLINE"));
  });
});
