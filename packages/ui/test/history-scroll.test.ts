// Logical history-entry identity for shared scroll restoration.

import { describe, expect, it } from "vitest";
import type { ParsedLocation } from "@tanstack/react-router";
import { createMainScrollStore, entryChangeScrollRestoration, logicalEntryScrollKey } from "../src/components/shell/history-scroll.js";

const at = (key: string, index: number, extra: Record<string, unknown> = {}) =>
  ({ href: `/x?${key}`, state: { __TSR_key: key, __TSR_index: index, ...extra } }) as unknown as ParsedLocation;

function memoryStorage() {
  const map = new Map<string, string>();
  return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) };
}

describe("logicalEntryScrollKey", () => {
  it("a replace at the same index inherits the entry's identity, repeatedly", () => {
    const key = logicalEntryScrollKey(memoryStorage());
    expect(key(at("a", 0))).toBe("a");
    expect(key(at("a2", 0))).toBe("a");
    expect(key(at("a3", 0, { openrigTopologyVisit: "v1" }))).toBe("a");
  });

  it("push and a new branch after Back get fresh identities; revisited keys keep theirs", () => {
    const key = logicalEntryScrollKey(memoryStorage());
    key(at("a", 0)); key(at("b", 1)); key(at("b2", 1));
    expect(key(at("a", 0))).toBe("a"); // Back
    expect(key(at("c", 1))).toBe("c"); // branch reuses index 1, new entry
    expect(key(at("b2", 1))).toBe("b"); // an old key still maps to its own entry
  });

  it("persists aliases so reload keeps a replaced entry's identity", () => {
    const storage = memoryStorage();
    const first = logicalEntryScrollKey(storage);
    first(at("a", 0)); first(at("a2", 0));
    expect(logicalEntryScrollKey(storage)(at("a2", 0))).toBe("a");
  });

  it("falls back to href when the router supplies no entry key", () => {
    expect(logicalEntryScrollKey(null)({ href: "/plain", state: {} } as unknown as ParsedLocation)).toBe("/plain");
  });
});

describe("entryChangeScrollRestoration", () => {
  it("restores on index changes only, never on same-index replaces", () => {
    const restore = entryChangeScrollRestoration();
    expect(restore({ location: at("a", 0) })).toBe(true);
    expect(restore({ location: at("a2", 0) })).toBe(false);
    expect(restore({ location: at("b", 1) })).toBe(true);
    expect(restore({ location: at("a2", 0) })).toBe(true);
  });
});

describe("createMainScrollStore", () => {
  it("records under the current logical entry only, persists, and ignores unknown/invalid input", () => {
    const storage = memoryStorage();
    const store = createMainScrollStore(storage);
    store.record(10); // no current entry yet → ignored
    store.setCurrent("a"); store.record(400);
    store.setCurrent("b"); store.record(120); store.record(Number.NaN);
    expect(store.get("a")).toBe(400);
    expect(store.get("b")).toBe(120);
    expect(store.get("c")).toBeUndefined();
    expect(createMainScrollStore(storage).get("a")).toBe(400);
  });
});
