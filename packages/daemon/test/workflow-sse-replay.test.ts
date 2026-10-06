import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { EventBus } from "../src/domain/event-bus.js";
import type { PersistedEvent } from "../src/domain/types.js";
import { workflowRoutes } from "../src/routes/workflow.js";
import { followInstance } from "../../cli/src/commands/workflow-follow.js";

async function readEvents(response: Response, count: number, afterEvent?: (event: PersistedEvent) => void) {
  const reader = response.body!.getReader();
  const received: PersistedEvent[] = [];
  const decoder = new TextDecoder();
  let buffer = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 500); });
  try {
    while (received.length < count) {
      const next = await Promise.race([reader.read(), timeout]);
      if (!next || next.done) break;
      buffer += decoder.decode(next.value, { stream: true });
      const blocks = buffer.split("\n\n");
      buffer = blocks.pop()!;
      for (const block of blocks) {
        const data = block.split("\n").find(line => line.startsWith("data: "))?.slice(6);
        if (!data) continue;
        const event = JSON.parse(data) as PersistedEvent;
        expect(block.split("\n")).toContain(`id: ${event.seq}`);
        received.push(event);
        afterEvent?.(event);
      }
    }
    return received;
  } finally {
    clearTimeout(timer);
    await reader.cancel();
  }
}

describe("workflow SSE reconnect replay", () => {
  let db: Database.Database;
  let bus: EventBus;
  let app: Hono;
  const completed = (instanceId: string) => bus.emit({ type: "workflow.completed", instanceId });

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, eventsSchema]);
    bus = new EventBus(db);
    app = new Hono();
    app.use("*", async (c, next) => { c.set("eventBus" as never, bus); await next(); });
    app.route("/api/workflow", workflowRoutes());
  });
  afterEach(() => { vi.restoreAllMocks(); db.close(); });

  for (const endpoint of ["sse", "watch"]) {
    for (const payload of ["{not-json", "null"]) {
      it(`${endpoint} replays the valid tail past an invalid ${payload === "null" ? "shape" : "JSON"} row and keeps delivering`, async () => {
        const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
        const first = completed("before-poison");
        db.prepare("INSERT INTO events (type, payload) VALUES (?, ?)").run("workflow.completed", payload);
        const tail = completed("after-poison");
        const response = await app.request(`/api/workflow/${endpoint}`, { headers: { "Last-Event-ID": "0" } });
        const live = completed("during-replay");
        expect(await readEvents(response, 3)).toEqual([first, tail, live]);
        expect(warning).toHaveBeenCalledExactlyOnceWith(`Workflow SSE replay skipped event 2: invalid event payload ${payload === "null" ? "shape" : "JSON"}`);
        await vi.waitFor(() => expect(bus.subscriberCount).toBe(0));
      });
    }

    it(`${endpoint} checkpoints an invalid-only tail so the next reconnect starts after it`, async () => {
      const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
      const seen = completed("seen");
      const poisonedSeq = Number(db.prepare("INSERT INTO events (type, payload) VALUES (?, ?)").run("workflow.completed", "{private-payload").lastInsertRowid);
      const response = await app.request(`/api/workflow/${endpoint}`, { headers: { "Last-Event-ID": String(seen.seq) } });
      const reader = response.body!.getReader();
      try {
        const first = await reader.read();
        expect(new TextDecoder().decode(first.value)).toBe(`id: ${poisonedSeq}\n\n`);
      } finally { await reader.cancel(); }
      await vi.waitFor(() => expect(bus.subscriberCount).toBe(0));
      const missed = completed("after-poison-checkpoint");
      const reconnected = await app.request(`/api/workflow/${endpoint}`, { headers: { "Last-Event-ID": String(poisonedSeq) } });
      expect(await readEvents(reconnected, 1)).toEqual([missed]);
      expect(warning).toHaveBeenCalledExactlyOnceWith(`Workflow SSE replay skipped event ${poisonedSeq}: invalid event payload JSON`);
      await vi.waitFor(() => expect(bus.subscriberCount).toBe(0));
    });

    it(`${endpoint} replays only missed workflow events after the exact saved sequence`, async () => {
      const seen = completed("already-seen");
      bus.emit({ type: "rig.created", rigId: "unrelated" });
      const missed = completed("changed-offline");
      const response = await app.request(`/api/workflow/${endpoint}`, { headers: { "Last-Event-ID": String(seen.seq) } });
      expect(await readEvents(response, 1)).toEqual([missed]);
      expect(bus.subscriberCount).toBe(0);
    });

    it(`${endpoint} delivers live events when the saved cursor is ahead of the current log`, async () => {
      completed("restored-history");
      const response = await app.request(`/api/workflow/${endpoint}`, { headers: { "Last-Event-ID": String(bus.currentSequence() + 1000) } });
      bus.emit({ type: "rig.created", rigId: "filtered-live" });
      const live = completed("after-restore");
      expect(await readEvents(response, 1)).toEqual([live]);
      await vi.waitFor(() => expect(bus.subscriberCount).toBe(0));
    });

    for (const hasHistory of [false, true]) {
      it(`${endpoint} resets an ahead-of-log cursor to ${hasHistory ? "current history" : "empty-log zero"} for the next reconnect`, async () => {
        if (hasHistory) completed("restored-history");
        const currentSeq = bus.currentSequence();
        const response = await app.request(`/api/workflow/${endpoint}`, { headers: { "Last-Event-ID": String(currentSeq + 1000) } });
        const reader = response.body!.getReader();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const first = await Promise.race([reader.read(), new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 500); })]);
          expect(first && new TextDecoder().decode(first.value)).toBe(`id: ${currentSeq}\n\n`);
        } finally { clearTimeout(timer); await reader.cancel(); }
        await vi.waitFor(() => expect(bus.subscriberCount).toBe(0));
        const missed = completed("missed-after-reset");
        const reconnected = await app.request(`/api/workflow/${endpoint}`, { headers: { "Last-Event-ID": String(currentSeq) } });
        expect(await readEvents(reconnected, 1)).toEqual([missed]);
        await vi.waitFor(() => expect(bus.subscriberCount).toBe(0));
      });
    }
  }

  it("a fresh stream checkpoints current history without replaying historical workflow payloads", async () => {
    bus.emit({ type: "workflow.failed", instanceId: "resumed", workflowName: "fixture", reason: "old failure" });
    const resumed = bus.emit({ type: "workflow.resumed", instanceId: "resumed", workflowName: "fixture", stepId: "work", resumedBy: "fixture", decision: null, resumeCount: 1 });
    const response = await app.request("/api/workflow/sse");
    const reader = response.body!.getReader();
    try {
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toBe(`id: ${resumed.seq}\n\n`);
    } finally { await reader.cancel(); }
  });

  it("an empty-history checkpoint recovers the first workflow event missed while offline", async () => {
    const response = await app.request("/api/workflow/sse");
    const reader = response.body!.getReader();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const first = await Promise.race([reader.read(), new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 500); })]);
      expect(first && new TextDecoder().decode(first.value)).toBe("id: 0\n\n");
    } finally { clearTimeout(timer); await reader.cancel(); }
    const missed = completed("first-workflow-event");
    const reconnected = await app.request("/api/workflow/sse", { headers: { "Last-Event-ID": "0" } });
    expect(await readEvents(reconnected, 1)).toEqual([missed]);
  });

  it("the actual CLI follower ignores historical failure and waits for the resumed workflow's new outcome", async () => {
    const instanceId = "resumed-fixture";
    bus.emit({ type: "workflow.failed", instanceId, workflowName: "fixture", reason: "historical failure" });
    bus.emit({ type: "workflow.resumed", instanceId, workflowName: "fixture", stepId: "work", resumedBy: "fixture", decision: null, resumeCount: 1 });
    const output: string[] = [];
    let response: Response | undefined;
    const client = { baseUrl: "http://fixture.invalid", get: async () => {
      // The real follower opens SSE before reading its snapshot. A new outcome
      // in that window must be delivered; the old failure must never win.
      completed(instanceId);
      return { status: 200, data: { instance: { instanceId, workflowName: "fixture", status: "active", currentStepId: "work" }, trail: [] } };
    } };
    try {
      const code = await followInstance(client as never, instanceId, { json: true, maxReconnects: 0, io: {
        out: line => output.push(line), err: line => output.push(line), sleep: async () => { throw new Error("unexpected poll fallback"); },
        fetchImpl: async (_url, init) => {
          response = await app.request("/api/workflow/sse", init);
          return response;
        },
      } });
      expect(code).toBe(0);
      expect(output.join("\n")).not.toContain("historical failure");
      expect(output.map(line => JSON.parse(line)).filter(row => row.type === "workflow.completed")).toHaveLength(1);
    } finally { await response?.body?.cancel(); }
    await vi.waitFor(() => expect(bus.subscriberCount).toBe(0));
  });

  for (const cursor of ["garbage", "-1", "9".repeat(400)]) {
    it(`an invalid cursor ${cursor.slice(0, 12)} falls back to retained history`, async () => {
      const missed = completed("missed");
      const response = await app.request("/api/workflow/sse", { headers: { "Last-Event-ID": cursor } });
      expect(await readEvents(response, 1)).toEqual([missed]);
    });
  }

  it("does not lose or duplicate events emitted inside replay or while replay writes yield", async () => {
    const first = completed("first");
    let overlap: PersistedEvent | undefined;
    let duringWrite: PersistedEvent | undefined;
    const originalReplay = bus.replayAllSettled.bind(bus);
    vi.spyOn(bus, "replayAllSettled").mockImplementation((...args) => {
      if (!overlap) overlap = completed("inside-replay");
      return originalReplay(...args);
    });
    const response = await app.request("/api/workflow/sse", { headers: { "Last-Event-ID": "0" } });
    const received = await readEvents(response, 3, () => {
      if (!duringWrite) duringWrite = completed("during-write");
    });
    expect(received).toEqual([first, overlap, duringWrite]);
    expect(new Set(received.map(event => event.seq)).size).toBe(3);
    await vi.waitFor(() => expect(bus.subscriberCount).toBe(0));
  });

  it("replays an event notified after the last page query before switching live", async () => {
    const first = completed("first");
    let afterQuery: PersistedEvent | undefined;
    const originalReplay = bus.replayAllSettled.bind(bus);
    vi.spyOn(bus, "replayAllSettled").mockImplementation((...args) => {
      const page = originalReplay(...args);
      if (!afterQuery) afterQuery = completed("after-query");
      return page;
    });
    const response = await app.request("/api/workflow/sse", { headers: { "Last-Event-ID": "0" } });
    expect(await readEvents(response, 2)).toEqual([first, afterQuery]);
    await vi.waitFor(() => expect(bus.subscriberCount).toBe(0));
  });

  it("pages past unrelated events without dropping the later workflow event", async () => {
    const seen = completed("seen");
    for (let i = 0; i < 600; i++) bus.emit({ type: "rig.created", rigId: `unrelated-${i}` });
    const missed = completed("after-filtered-pages");
    const replay = vi.spyOn(bus, "replayAllSettled");
    const response = await app.request("/api/workflow/sse", { headers: { "Last-Event-ID": String(seen.seq) } });
    expect(await readEvents(response, 1)).toEqual([missed]);
    expect(replay.mock.calls.length).toBeGreaterThan(1);
    for (const result of replay.mock.results) expect(result.value.length).toBeLessThanOrEqual(250);
  });

  it("advances bounded raw pages even when the first page contains only invalid rows", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    for (let i = 0; i < 251; i++) db.prepare("INSERT INTO events (type, payload) VALUES (?, ?)").run("workflow.completed", "null");
    const tail = completed("after-invalid-pages");
    const replay = vi.spyOn(bus, "replayAllSettled");
    const response = await app.request("/api/workflow/sse", { headers: { "Last-Event-ID": "0" } });
    expect(await readEvents(response, 1)).toEqual([tail]);
    expect(replay.mock.calls).toEqual([[0, 250], [250, 250]]);
    expect(replay.mock.results.map(result => result.value.length)).toEqual([250, 2]);
    await vi.waitFor(() => expect(bus.subscriberCount).toBe(0));
  });

  it("cancelling an invalid-only page releases the subscriber and stops replay queries", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    for (let i = 0; i < 600; i++) db.prepare("INSERT INTO events (type, payload) VALUES (?, ?)").run("workflow.completed", "null");
    const replay = vi.spyOn(bus, "replayAllSettled");
    const response = await app.request("/api/workflow/watch", { headers: { "Last-Event-ID": "0" } });
    expect(replay).toHaveBeenCalledTimes(1);
    await response.body!.cancel();
    await vi.waitFor(() => expect(bus.subscriberCount).toBe(0));
    expect(replay).toHaveBeenCalledTimes(1);
  });

  it("an empty replay switches to live delivery and keeps non-workflow events filtered", async () => {
    const seen = completed("seen");
    const response = await app.request("/api/workflow/sse", { headers: { "Last-Event-ID": String(seen.seq) } });
    bus.emit({ type: "rig.created", rigId: "filtered-live" });
    const live = completed("live");
    expect(await readEvents(response, 1)).toEqual([live]);
    expect(bus.subscriberCount).toBe(0);
  });

  it("cancelling during a populated replay releases its subscription", async () => {
    for (let i = 0; i < 300; i++) completed(`pending-${i}`);
    const response = await app.request("/api/workflow/sse", { headers: { "Last-Event-ID": "0" } });
    expect(bus.subscriberCount).toBe(1);
    await response.body!.cancel();
    await vi.waitFor(() => expect(bus.subscriberCount).toBe(0));
  });

  it("cancelling a filtered page stops further replay queries", async () => {
    for (let i = 0; i < 600; i++) bus.emit({ type: "rig.created", rigId: `unrelated-${i}` });
    const replay = vi.spyOn(bus, "replayAllSettled");
    const response = await app.request("/api/workflow/sse", { headers: { "Last-Event-ID": "0" } });
    const readsBeforeCancel = replay.mock.calls.length;
    expect(readsBeforeCancel).toBe(1);
    await response.body!.cancel();
    await vi.waitFor(() => expect(bus.subscriberCount).toBe(0));
    expect(replay).toHaveBeenCalledTimes(readsBeforeCancel);
  });

  it("bounded EventBus replay preserves the unlimited default and exact next-page sequence", () => {
    const first = completed("first"), second = completed("second"), third = completed("third");
    expect(bus.replayAll(0, 2)).toEqual([first, second]);
    expect(bus.replayAll(second.seq, 2)).toEqual([third]);
    expect(bus.replayAll(0)).toEqual([first, second, third]);
  });

  it("settled replay preserves strict callers and does not change stored rows or notify-drain state", () => {
    const first = completed("first");
    db.prepare("INSERT INTO events (type, payload) VALUES (?, ?)").run("workflow.completed", "null");
    const last = completed("last");
    db.prepare("UPDATE events SET rig_id = ?").run("fixture");
    const status = bus.getNotifyDrainStatus();
    const rows = db.prepare("SELECT * FROM events ORDER BY seq").all();
    expect(bus.replayAllSettled(0, 2)).toEqual([
      { seq: first.seq, event: first }, { seq: 2, error: "invalid event payload shape" },
    ]);
    expect(bus.replayAllSettled(2, 2)).toEqual([{ seq: last.seq, event: last }]);
    expect(() => bus.replayAll(0)).toThrow("invalid event payload shape");
    expect(() => bus.replaySince(0, "fixture")).toThrow("invalid event payload shape");
    expect(db.prepare("SELECT * FROM events ORDER BY seq").all()).toEqual(rows);
    expect(bus.getNotifyDrainStatus()).toEqual(status);
  });
});
