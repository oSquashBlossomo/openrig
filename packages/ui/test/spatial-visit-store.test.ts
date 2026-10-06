// Bounded per-visit snapshot store (camera / scroll / focus). Constant-size
// records, at most 50 with LRU eviction, 16 KiB per record, validated on the
// way in and out, and a failing storage never blocks the in-memory copy.

import { describe, expect, it } from "vitest";
import {
  SPATIAL_VISIT_MAX_RECORDS,
  createSpatialVisitStore,
  type SpatialVisitSnapshot,
} from "../src/components/topology/spatial/spatial-visit-store.js";

const snapshot = (over: Partial<SpatialVisitSnapshot> = {}): SpatialVisitSnapshot => ({
  v: 1,
  scope: { host: "local", kind: "host" },
  camera: { position: [10, 20, 30], target: [0, 0, 0], userMoved: true, bounds: { center: [0, 0, 0], radius: 25 } },
  scroll: { main: 0, index: 320, inspector: 0, list: 0 },
  focus: { region: "index", node: "local/rig_bravo/agent/node_editor" },
  ...over,
});

function memoryStorage() {
  const map = new Map<string, string>();
  return { map, getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) };
}

describe("spatial visit store", () => {
  it("keeps at most 50 visits across 100 writes, evicting least recently used", () => {
    const storage = memoryStorage();
    const store = createSpatialVisitStore(storage);
    for (let i = 0; i < 100; i++) {
      if (i === 60) store.get("visit-0000000049"); // touch: survives eviction
      expect(store.put(`visit-${String(i).padStart(10, "0")}`, snapshot())).toBe(true);
    }
    expect(store.size()).toBe(SPATIAL_VISIT_MAX_RECORDS);
    expect(store.get("visit-0000000000")).toBeNull();
    expect(store.get("visit-0000000049")).not.toBeNull();
    expect(store.get("visit-0000000099")).not.toBeNull();
    expect(storage.map.values().next().value!.length).toBeLessThan(50 * 16 * 1024);
  });

  it("rejects an oversized or invalid record instead of truncating it", () => {
    const store = createSpatialVisitStore(memoryStorage());
    expect(store.put("big-visit-01", snapshot({ focus: { region: "index", node: "x".repeat(17_000) } }))).toBe(false);
    expect(store.put("nan-visit-01", snapshot({ scroll: { main: Number.NaN, index: 0, inspector: 0, list: 0 } }))).toBe(false);
    expect(store.put("cam-visit-01", snapshot({ camera: { position: [Infinity, 0, 0], target: [0, 0, 0], userMoved: true, bounds: { center: [0, 0, 0], radius: 1 } } }))).toBe(false);
    expect(store.size()).toBe(0);
  });

  it("restores from storage on a new page instance and drops malformed persisted entries", () => {
    const storage = memoryStorage();
    createSpatialVisitStore(storage).put("visit-reload-1", snapshot());
    const raw = JSON.parse(storage.map.get("openrig.topology.visits.v1")!);
    raw.push(["visit-bad-0001", { v: 1, scope: { host: "", kind: "host" } }]);
    storage.map.set("openrig.topology.visits.v1", JSON.stringify(raw));
    const reloaded = createSpatialVisitStore(storage);
    expect(reloaded.get("visit-reload-1")).toEqual(snapshot());
    expect(reloaded.get("visit-bad-0001")).toBeNull();
    storage.map.set("openrig.topology.visits.v1", "{not json");
    expect(createSpatialVisitStore(storage).size()).toBe(0);
  });

  it("a full or throwing storage never blocks the in-memory copy", () => {
    const store = createSpatialVisitStore({
      getItem: () => { throw new Error("SecurityError"); },
      setItem: () => { throw new Error("QuotaExceededError"); },
    });
    expect(store.put("visit-memory-1", snapshot())).toBe(true);
    expect(store.get("visit-memory-1")).toEqual(snapshot());
    const none = createSpatialVisitStore(null);
    expect(none.put("visit-memory-2", snapshot())).toBe(true);
    expect(none.get("visit-memory-2")).not.toBeNull();
  });
});
