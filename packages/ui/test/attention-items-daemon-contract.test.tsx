import React from "react";
import { expect, it, vi } from "vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Hono } from "hono";
import { createDb } from "../../daemon/src/db/connection.js";
import { migrate } from "../../daemon/src/db/migrate.js";
import { ALL_MIGRATIONS } from "../../daemon/src/db/all-migrations.js";
import { EventBus } from "../../daemon/src/domain/event-bus.js";
import { QueueRepository } from "../../daemon/src/domain/queue-repository.js";
import { queueRoutes } from "../../daemon/src/routes/queue.js";
import { useAttentionItems } from "../src/hooks/useAttentionItems.js";

it("accepts actual list and aggregate HTTP DTOs, preserving local facts and unavailable remote status", async () => {
  const db = createDb(); const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  try {
    migrate(db, ALL_MIGRATIONS);
    const queue = new QueueRepository(db, new EventBus(db), { loadHumanRegistry: () => ({ ok: true, entities: [] }) });
    // The route/repository, rather than a client reconstruction, decide which
    // authored tasks count as attention. Routine agent work stays excluded.
    await queue.create({ sourceSession: "sender@rig", destinationSession: "worker@rig", body: "Routine work", nudge: false });
    await queue.create({ sourceSession: "sender@rig", destinationSession: "human@host", body: "Please judge the artifact", summary: "First", evidenceRef: "docs/decision.md", nudge: false });
    await queue.create({ sourceSession: "sender@rig", destinationSession: "human-reviewer@host", body: "Please judge the second artifact", summary: "Second", evidenceRef: "docs/second.md", nudge: false });
    const registry = vi.fn(() => ({ ok: false, error: "Fixture registry unavailable" }));
    const app = new Hono(); app.use("*", async (c, next) => {
      c.set("queueRepo" as never, queue);
      c.set("settingsStore" as never, { listFeedHostSubscriptions: () => [{ hostId: "remote-fixture", enabled: true }] });
      c.set("hostRegistryLoader" as never, registry); await next();
    }); app.route("/api/queue", queueRoutes());
    const fetch = vi.fn((route: string, init?: RequestInit) => app.request(route, { method: init?.method, headers: init?.headers })); vi.stubGlobal("fetch", fetch);
    const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const hook = renderHook(({ aggregate }) => useAttentionItems(1, aggregate), { wrapper, initialProps: { aggregate: false } });
    await waitFor(() => expect(hook.result.current.isSuccess).toBe(true));
    expect(hook.result.current.data).toEqual({ items: queue.listAttention({ state: ["pending", "in-progress", "blocked"], limit: 1 }), hosts: [] });
    expect(registry).not.toHaveBeenCalled();
    hook.rerender({ aggregate: true }); await waitFor(() => expect(hook.result.current.isSuccess).toBe(true));
    const aggregate = await (await app.request("/api/queue/attention-aggregate")).json();
    expect(hook.result.current.data).toEqual({ ...aggregate, items: aggregate.items.slice(0, 1) });
    expect(hook.result.current.data?.items[0]).toMatchObject({ hostId: "local", body: expect.any(String), pickup: expect.any(Object), summary: expect.toBeOneOf(["First", "Second"]) });
    expect(hook.result.current.data?.hosts).toEqual([{ hostId: "local", status: "ok" }, { hostId: "remote-fixture", status: "unreachable", error: "Fixture registry unavailable" }]);
    expect(fetch.mock.calls.map(([route]) => route)).toEqual(["/api/queue/list?attention=1&limit=1", "/api/queue/attention-aggregate"]);
    expect(fetch.mock.calls.every(([, init]) => init?.method === "GET" && init.headers === undefined)).toBe(true);
  } finally { cleanup(); client.clear(); vi.unstubAllGlobals(); db.close(); }
});
