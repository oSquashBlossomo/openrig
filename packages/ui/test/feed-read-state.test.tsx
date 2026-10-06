// Activity feed decision-source freshness. The actual Feed and actual
// attention transport hook (`useAttentionItems`) are used; unrelated reads
// and card internals are isolated. Needs-input is mocked with the hook's
// published read-state contract (gui-needs-input-data.md).

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const fixture = vi.hoisted(() => ({
  aggregate: false,
  needs: { readState: "ready" as string, data: [] as unknown[], error: null as Error | null, coverage: undefined as unknown, omittedRigIds: [] as string[], readAt: 0, refetch: () => {} },
}));
vi.mock("../src/hooks/useActivityFeed.js", () => ({ useActivityFeed: () => ({ events: [] }) }));
vi.mock("../src/hooks/useNeedsInputSeats.js", () => ({ useNeedsInputSeats: () => fixture.needs }));
vi.mock("../src/hooks/useSlices.js", () => ({
  useQueueItemMap: () => ({ itemsById: new Map() }), useSlices: () => ({ data: { slices: [] } }), useSliceDetails: () => ({ itemsByName: new Map() }),
}));
vi.mock("../src/hooks/useFeedSubscriptions.js", () => ({
  useFeedSubscriptions: () => ({ anyRemoteEnabled: fixture.aggregate, state: {} }),
  isCardKindSubscribed: () => true,
}));
vi.mock("../src/hooks/useDismissedSeqs.js", () => ({ useDismissedSeqs: () => ({ dismissedSeqs: new Set(), dismiss: () => {}, undismiss: () => {} }) }));
vi.mock("../src/hooks/useDismissedCardIds.js", () => ({ useDismissedCardIds: () => ({ dismissedIds: new Set(), dismiss: () => {}, undismiss: () => {} }) }));
vi.mock("../src/components/mission-control/hooks/useMissionControlAudit.js", () => ({ useMissionControlAudit: () => ({ data: { rows: [] } }) }));
vi.mock("../src/components/for-you/LevelControl.js", () => ({ LevelControl: () => null }));
vi.mock("../src/components/for-you/FeedCard.js", () => ({ FeedCard: ({ card }: { card: { id: string; title: string } }) => <article data-testid={card.id}>{card.title}</article> }));

import { Feed } from "../src/components/for-you/Feed.js";
import { attentionFeedState, emptyIsConfirmed, needsInputFeedState } from "../src/components/for-you/feed-read-state.js";

let qc: QueryClient | undefined;
const key = () => ["attention-items", 50, fixture.aggregate];
const item = {
  qitemId: "q-1", tsCreated: "2026-10-04T03:00:00Z", tsUpdated: "2026-10-04T03:00:00Z", sourceSession: "sender@rig", destinationSession: "human@host",
  state: "pending", priority: "urgent", tier: null, tags: null, blockedOn: null, handedOffTo: null, handedOffFrom: null, summary: "Cached decision", evidenceRef: null, body: "Exact cached request",
};
function mount(aggregate = false) {
  fixture.aggregate = aggregate;
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  render(<QueryClientProvider client={qc}><Feed /></QueryClientProvider>);
  return qc;
}
afterEach(() => {
  cleanup(); qc?.clear(); qc = undefined; vi.unstubAllGlobals();
  fixture.needs = { readState: "ready", data: [], error: null, coverage: undefined, omittedRigIds: [], readAt: 0, refetch: () => {} };
});
const served = (aggregate: boolean, items: unknown[], hosts = [{ hostId: "local", status: "ok" }]) =>
  Response.json(aggregate ? { items: items.map((i) => ({ ...(i as object), hostId: "local" })), hosts } : items);

describe("Feed · decision-source read state", () => {
  for (const aggregate of [false, true]) {
    for (const failure of ["http", "malformed"] as const) {
      it(`does not claim caught up after an initial ${failure} attention failure (aggregate=${aggregate})`, async () => {
        vi.stubGlobal("fetch", vi.fn(async () => (failure === "http" ? new Response("unavailable", { status: 503 }) : Response.json(aggregate ? {} : { unavailable: true }))));
        const client = mount(aggregate);
        await waitFor(() => expect(client.getQueryState(key())?.status).toBe("error"));
        await screen.findByTestId("for-you-empty-unconfirmed");
        const feed = screen.getByTestId("for-you-feed");
        expect(feed.textContent).not.toMatch(/All caught up|Nothing needs you right now/);
        expect(screen.getByTestId("feed-source-attention").getAttribute("data-state")).toBe("unavailable");
        fireEvent.click(screen.getByTestId("feed-lens-action-required"));
        expect(feed.textContent).not.toContain("No actions waiting");
        expect(screen.getByTestId("for-you-empty-unconfirmed").textContent).toContain("Can't confirm no actions are waiting");
        // Event-derived lenses keep their own (non-decision) copy.
        fireEvent.click(screen.getByTestId("feed-lens-shipped"));
        expect(screen.getByTestId("for-you-empty").textContent).toContain("No shipped proof yet");
      });
    }

    it(`labels retained request cards and host status after a failed refresh, then recovers (aggregate=${aggregate})`, async () => {
      const fetch = vi.fn(async () => served(aggregate, [item]));
      vi.stubGlobal("fetch", fetch);
      const client = mount(aggregate);
      await screen.findByText("Cached decision");
      expect(screen.queryByTestId("feed-source-status")).toBeNull();

      fetch.mockImplementation(async () => new Response("unavailable", { status: 503 }));
      await act(async () => { await client.refetchQueries({ queryKey: key(), exact: true }); });
      await waitFor(() => expect(screen.getByTestId("feed-source-attention").getAttribute("data-state")).toBe("stale"));
      expect(screen.getByTestId("feed-source-attention").textContent).toMatch(/last successful read/);
      expect(screen.getByTestId("feed-card-earlier-read-queue-attention-q-1").textContent).toContain("Cached decision");
      if (aggregate) expect(screen.getByTestId("feed-host-stale")).toBeTruthy();

      fetch.mockImplementation(async () => served(aggregate, [item]));
      fireEvent.click(screen.getByTestId("feed-source-attention-retry"));
      await waitFor(() => expect(screen.queryByTestId("feed-source-status")).toBeNull());
      expect(screen.queryByTestId("feed-card-earlier-read-queue-attention-q-1")).toBeNull();
    });
  }

  it("treats a failed remote host as partial: no reassuring empty copy", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => served(true, [], [{ hostId: "local", status: "ok" }, { hostId: "far", status: "unreachable" }])));
    mount(true);
    await waitFor(() => expect(screen.getByTestId("feed-source-attention").getAttribute("data-state")).toBe("partial"));
    expect(screen.getByTestId("for-you-empty-unconfirmed")).toBeTruthy();
    expect(screen.getByTestId("feed-host-status-far")).toBeTruthy();
  });

  it("an incomplete seat prompt scan keeps the empty state unconfirmed and states coverage", async () => {
    fixture.needs = { ...fixture.needs, readState: "partial", coverage: { inspectedRigCount: 3, discoveredRigCount: 5, unknownSeatCount: 2, rejectedRowCount: 1, complete: false }, omittedRigIds: ["rig-d"] };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json([])));
    mount();
    expect(await screen.findByTestId("for-you-empty-unconfirmed")).toBeTruthy();
    expect(screen.getByTestId("feed-source-needs-input").textContent).toMatch(/inspected 3 of 5 rigs; 2 seats unknown; 1 rows rejected; not inspected: rig-d/);
  });

  it("while reads are pending the empty state says so", async () => {
    fixture.needs = { ...fixture.needs, readState: "pending" };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json([])));
    mount();
    expect((await screen.findByTestId("for-you-empty-unconfirmed")).textContent).toMatch(/Still reading/);
  });

  it("control: complete successful empty reads truthfully show All caught up", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json([])));
    mount();
    expect((await screen.findByTestId("for-you-empty")).textContent).toContain("All caught up");
    expect(screen.queryByTestId("feed-source-status")).toBeNull();
  });
});

describe("feed-read-state model", () => {
  it("derives states without treating absence as evidence", () => {
    expect(attentionFeedState({ data: undefined, error: null })).toBe("pending");
    expect(attentionFeedState({ data: { items: [], hosts: [] }, error: new Error("x") })).toBe("stale");
    expect(needsInputFeedState(undefined)).toBe("pending");
    expect(emptyIsConfirmed("all", "ready", "stale")).toBe(false);
    expect(emptyIsConfirmed("progress", "unavailable", "unavailable")).toBe(true);
  });
});
