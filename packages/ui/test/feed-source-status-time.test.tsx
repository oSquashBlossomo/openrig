// FeedSourceStatus adopts the connected instance's display zone through the
// ACTUAL shared DisplayTimeProvider (useSettings over a stubbed /api/config).
// Same served receipt instant, two configured zones; unknown receipt; failed
// settings refresh keeps the dated stale zone. Structural check of the
// readable warning treatment (painted contrast is root's browser check).

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DisplayTimeProvider } from "../src/components/time/DisplayTime.js";
import { FeedSourceStatus } from "../src/components/for-you/FeedSourceStatus.js";

const RECEIPT = Date.parse("2026-07-01T12:00:00.000Z");
let client: QueryClient | undefined;
afterEach(() => { cleanup(); client?.clear(); client = undefined; vi.unstubAllGlobals(); });

function settings(zone: string) {
  return { settings: { "ui.timezone": { value: zone, source: "file", defaultValue: "America/Los_Angeles" } } };
}

function mount(serve: () => Response, props: Partial<Parameters<typeof FeedSourceStatus>[0]> = {}) {
  vi.stubGlobal("fetch", vi.fn(async () => serve()));
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  render(
    <QueryClientProvider client={client}>
      <DisplayTimeProvider>
        <FeedSourceStatus
          attention="stale" attentionError={new Error("HTTP 503")} attentionReadAt={RECEIPT} onRetryAttention={() => {}}
          needsInput="stale" needsInputError={new Error("HTTP 503")} needsInputReadAt={RECEIPT} coverage={undefined} omittedRigIds={[]} onRetryNeedsInput={() => {}}
          {...props}
        />
      </DisplayTimeProvider>
    </QueryClientProvider>,
  );
  return client;
}

describe("Feed source status · display time", () => {
  it("renders the same served receipt in each configured zone, keeping the exact instant", async () => {
    mount(() => Response.json(settings("Europe/London")));
    await waitFor(() => expect(screen.getByTestId("feed-source-attention-read-at").textContent).toBe("2026-07-01 13:00:00 GMT+1"));
    expect(screen.getByTestId("feed-source-attention-read-at").getAttribute("datetime")).toBe("2026-07-01T12:00:00.000Z");
    expect(screen.getByTestId("feed-source-needs-input-read-at").textContent).toBe("2026-07-01 13:00:00 GMT+1");
    expect(screen.getByTestId("feed-display-zone").textContent).toMatch(/Showing Europe\/London \(ui.timezone · file\)/);
    cleanup(); client?.clear();

    mount(() => Response.json(settings("Asia/Tokyo")));
    await waitFor(() => expect(screen.getByTestId("feed-source-attention-read-at").textContent).toBe("2026-07-01 21:00:00 GMT+9"));
    expect(screen.getByTestId("feed-source-attention-read-at").getAttribute("datetime")).toBe("2026-07-01T12:00:00.000Z");
  });

  it("an unknown or non-finite receipt says so instead of a time", async () => {
    mount(() => Response.json(settings("Europe/London")), { attentionReadAt: null, needsInputReadAt: Number.NaN });
    expect((await screen.findByTestId("feed-source-attention-read-at")).textContent).toBe("an unknown time");
    expect(screen.getByTestId("feed-source-needs-input-read-at").textContent).toBe("an unknown time");
  });

  it("a failed settings refresh keeps the last zone, dated as stale", async () => {
    let failing = false;
    const qc = mount(() => (failing ? Response.json({ error: "settings_unavailable" }, { status: 503 }) : Response.json(settings("Europe/London"))));
    await waitFor(() => expect(screen.getByTestId("feed-display-zone").getAttribute("data-state")).toBe("configured"));
    failing = true;
    await act(async () => { await qc.refetchQueries({ queryKey: ["settings", "all"] }); });
    await waitFor(() => expect(screen.getByTestId("feed-display-zone").getAttribute("data-state")).toBe("stale"));
    expect(screen.getByTestId("feed-display-zone").textContent).toMatch(/Showing Europe\/London from the last successful settings read/);
    expect(screen.getByTestId("feed-source-attention-read-at").textContent).toBe("2026-07-01 13:00:00 GMT+1");
  });

  it("warning rows use primary text on the tinted opaque surface (not warning-coloured text); Retry and roles kept", async () => {
    mount(() => Response.json(settings("Europe/London")));
    const row = await screen.findByTestId("feed-source-attention");
    expect(row.getAttribute("role")).toBe("alert");
    expect(row.className).toMatch(/bg-\[hsl\(var\(--warning\)\/0\.15\)\]/);
    expect(row.className).toMatch(/border-warning/);
    expect(row.querySelector("span")!.className).toBe("text-on-surface");
    expect(row.innerHTML).not.toMatch(/text-warning/);
    expect(screen.getByTestId("feed-source-status").className).toMatch(/bg-surface-lowest/);
    expect(screen.getByTestId("feed-source-attention-retry")).toBeTruthy();
    expect(screen.getByTestId("feed-display-zone").className).toBe("text-on-surface-variant");
  });
});
