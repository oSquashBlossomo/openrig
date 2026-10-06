import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode } from "react";
import { MAX_ACTIVITY_EVENTS, useActivityFeed } from "../src/hooks/useActivityFeed.js";
import { subscribeTopologyEvents } from "../src/lib/topology-events.js";
import { createMockEventSourceClass, instances } from "./helpers/mock-event-source.js";

let keepHub: () => void;
const clients: QueryClient[] = [];
const timestamp = "2026-10-04T00:00:00.000Z";

function client() {
  const value = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  clients.push(value);
  return value;
}

function emit(seq: number, summary = `Receipt ${seq}`) {
  instances[0]!.simulateMessage(JSON.stringify({
    seq, type: "queue.updated", createdAt: timestamp, summary, qitemId: "fictional-item",
  }));
}

beforeEach(() => {
  vi.stubGlobal("EventSource", createMockEventSourceClass());
  // AppShell keeps the actual shared hub alive while its feed mounts/re-subscribes.
  keepHub = subscribeTopologyEvents(() => {});
});

afterEach(() => {
  cleanup();
  keepHub();
  for (const value of clients.splice(0)) value.clear();
  vi.unstubAllGlobals();
});

describe("Activity replay continuity", () => {
  it("shows each cached receipt once when StrictMode reattaches its effect", async () => {
    emit(102);
    const queryClient = client();
    const { result } = renderHook(() => useActivityFeed(), {
      reactStrictMode: true,
      wrapper: ({ children }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>,
    });
    await waitFor(() => expect(result.current.events.map(event => event.seq)).toEqual([102]));
    expect(instances).toHaveLength(1);
  });

  it("keeps every cached row in order instead of replacing half the window with replay duplicates", async () => {
    for (let seq = 1; seq <= 70; seq++) emit(seq);
    const queryClient = client();
    const { result } = renderHook(() => useActivityFeed(), {
      reactStrictMode: true,
      wrapper: ({ children }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>,
    });
    await waitFor(() => expect(result.current.events.map(event => event.seq)).toEqual(
      Array.from({ length: 70 }, (_, index) => 70 - index),
    ));
    act(() => { for (let seq = 71; seq <= 120; seq++) emit(seq); });
    expect(result.current.events.map(event => event.seq)).toEqual(
      Array.from({ length: MAX_ACTIVITY_EVENTS }, (_, index) => 120 - index),
    );
  });

  it("preserves distinct received events that reuse sequence and timestamp fields", async () => {
    const queryClient = client();
    const { result } = renderHook(() => useActivityFeed(), {
      wrapper: ({ children }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>,
    });
    act(() => { emit(102, "Before daemon restart"); emit(102, "After daemon restart"); });
    await waitFor(() => expect(result.current.events.map(event => event.payload.summary)).toEqual([
      "After daemon restart", "Before daemon restart",
    ]));
  });

  it("retains receipt identity on QueryClient replacement while refreshing the new cache", async () => {
    emit(102);
    let currentClient = client();
    const wrapper = ({ children }: { children: ReactNode }) =>
      <QueryClientProvider client={currentClient}>{children}</QueryClientProvider>;
    const hook = renderHook(() => useActivityFeed(), { wrapper });
    await waitFor(() => expect(hook.result.current.events).toHaveLength(1));
    const original = hook.result.current.events[0];
    currentClient = client();
    currentClient.setQueryData(["attention-items"], { items: [] });
    hook.rerender();
    await waitFor(() => expect(currentClient.getQueryState(["attention-items"])?.isInvalidated).toBe(true));
    expect(hook.result.current.events).toEqual([original]);
  });

  it("gives a genuinely new feed its own replay while the existing feed stays unchanged", async () => {
    emit(102);
    const queryClient = client();
    const wrapper = ({ children }: { children: ReactNode }) =>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
    const first = renderHook(() => useActivityFeed(), { wrapper });
    const second = renderHook(() => useActivityFeed(), { wrapper, reactStrictMode: true });
    await waitFor(() => expect(second.result.current.events.map(event => event.seq)).toEqual([102]));
    expect(first.result.current.events.map(event => event.seq)).toEqual([102]);
  });
});
