// The actual twin fetch stub's dispatch order and cross-fixture consistency
// (shared owns registration; each cohort owns its fixture data). Importing
// the stub installs its fictional fetch for this file only.

import { beforeAll, describe, expect, it } from "vitest";
import { libraryTwinInventory, libraryTwinRigs, LIBRARY_TWIN_IDS } from "../twin/library-fixtures.js";
import { rigSummary } from "../twin/fixtures.js";

beforeAll(async () => { await import("../twin/fetch-stub.js"); });

const get = async (path: string) => { const res = await fetch(path); return { status: res.status, body: await res.json() as unknown }; };

describe("twin dispatch", () => {
  it("appends Library's rigs to the summary without mutating either fixture", async () => {
    const before = { twin: rigSummary.length, library: libraryTwinRigs.length };
    const { body } = await get("/api/rigs/summary");
    expect((body as Array<{ id: string }>).map((r) => r.id)).toEqual([...rigSummary, ...libraryTwinRigs].map((r) => r.id));
    await get("/api/rigs/summary");
    expect({ twin: rigSummary.length, library: libraryTwinRigs.length }).toEqual(before);
  });

  it("answers Library's rig inventory before the legacy per-rig catch-all; unreadable stays 503", async () => {
    expect((await get("/api/rigs/rig-observer/nodes")).body).toEqual(libraryTwinInventory);
    expect((await get("/api/rigs/rig-unreadable/nodes")).status).toBe(503);
    expect(((await get("/api/rigs/rig_alpha/nodes")).body as unknown[]).length).toBeGreaterThan(0); // twin rigs unchanged
  });

  it("serves one consistent connected-instance catalog: every kind filter is a subset of the full list and every listed ID has a review", async () => {
    const all = (await get("/api/specs/library")).body as Array<{ id: string; kind: string }>;
    const ids = new Set(all.map((e) => e.id));
    expect(new Set(all.map((e) => e.id)).size).toBe(all.length);
    for (const kind of ["rig", "agent", "workflow"]) {
      const subset = (await get(`/api/specs/library?kind=${kind}`)).body as Array<{ id: string; kind: string }>;
      expect(subset.length).toBeGreaterThan(0);
      expect(subset.every((e) => e.kind === kind && ids.has(e.id))).toBe(true);
      expect(subset.map((e) => e.id).sort()).toEqual(all.filter((e) => e.kind === kind).map((e) => e.id).sort());
    }
    for (const entry of all) expect((await get(`/api/specs/library/${encodeURIComponent(entry.id)}/review`)).status, entry.id).toBe(200);
    expect((await get(`/api/specs/library/${LIBRARY_TWIN_IDS.legacy}/review`)).status).toBe(409);
  });

  it("keeps the other cohorts' routes and the explicit local host", async () => {
    expect((await get("/api/hosts")).body).toMatchObject({ selected: "local" });
    expect((await get("/api/health")).status).toBe(200);
    expect((await get("/api/queue/recent-transitions?scope=instance&limit=20")).status).toBe(200);
    expect(((await get("/api/files/roots")).body as { roots: Array<{ name: string }> }).roots.map((r) => r.name)).toEqual(expect.arrayContaining(["workspace", "demo-notes"]));
    expect((await get("/api/terminal/views")).status).toBe(200);
  });
});
