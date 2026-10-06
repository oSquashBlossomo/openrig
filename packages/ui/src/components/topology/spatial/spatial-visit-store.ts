// Bounded per-visit local state for the 3D topology view: camera pose,
// scroll offsets and the focused region. Keyed by the visit id that lives in
// router history state, so Back/Forward and same-tab reload recover a visit
// while a copied link or new tab starts fresh (it has no visit id yet).
//
// Constant-size per record (no graph data, DOM nodes, selectors, WebGL
// objects or tokens), at most MAX_RECORDS records with LRU eviction, and at
// most MAX_RECORD_BYTES each. sessionStorage when available, in-memory
// otherwise; a failed or evicted write never blocks navigation — the URL's
// semantic state is always sufficient on its own.

export type Vec3Tuple = [number, number, number];

export interface SpatialCameraSnapshot {
  position: Vec3Tuple;
  target: Vec3Tuple;
  /** false = auto-fit (Reset or never moved); restoring it means "fit". */
  userMoved: boolean;
  bounds: { center: Vec3Tuple; radius: number };
}

export interface SpatialVisitScope {
  host: string;
  kind: "host" | "rig" | "pod";
  rig?: string;
  pod?: string;
}

export interface SpatialVisitSnapshot {
  v: 1;
  scope: SpatialVisitScope;
  camera?: SpatialCameraSnapshot;
  scroll: { main: number; index: number; inspector: number; list: number };
  focus?: { region: "search" | "index" | "inspector" | "stage"; node?: string };
}

export const SPATIAL_VISIT_MAX_RECORDS = 50;
export const SPATIAL_VISIT_MAX_RECORD_BYTES = 16 * 1024;
const STORAGE_KEY = "openrig.topology.visits.v1";
const MAX_COORD = 1e6;

const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isVec3 = (v: unknown): v is Vec3Tuple =>
  Array.isArray(v) && v.length === 3 && v.every((n) => isFiniteNumber(n) && Math.abs(n) <= MAX_COORD);
const isText = (v: unknown, max = 2_048): v is string => typeof v === "string" && v.length > 0 && v.length <= max;

export function isSpatialCameraSnapshot(value: unknown): value is SpatialCameraSnapshot {
  if (!value || typeof value !== "object") return false;
  const c = value as Record<string, unknown>;
  const bounds = c.bounds as Record<string, unknown> | undefined;
  return isVec3(c.position) && isVec3(c.target) && typeof c.userMoved === "boolean"
    && !!bounds && isVec3(bounds.center) && isFiniteNumber(bounds.radius) && bounds.radius > 0 && bounds.radius <= MAX_COORD;
}

export function isSpatialVisitSnapshot(value: unknown): value is SpatialVisitSnapshot {
  if (!value || typeof value !== "object") return false;
  const s = value as Record<string, unknown>;
  const scope = s.scope as Record<string, unknown> | undefined;
  const scroll = s.scroll as Record<string, unknown> | undefined;
  const focus = s.focus as Record<string, unknown> | undefined;
  if (s.v !== 1 || !scope || !scroll) return false;
  if (!isText(scope.host) || !["host", "rig", "pod"].includes(scope.kind as string)) return false;
  if (scope.kind !== "host" && !isText(scope.rig)) return false;
  if (scope.kind === "pod" && !isText(scope.pod)) return false;
  if (!["main", "index", "inspector", "list"].every((k) => isFiniteNumber(scroll[k]) && (scroll[k] as number) >= 0)) return false;
  if (s.camera !== undefined && !isSpatialCameraSnapshot(s.camera)) return false;
  if (focus !== undefined) {
    if (!["search", "index", "inspector", "stage"].includes(focus.region as string)) return false;
    if (focus.node !== undefined && !isText(focus.node, 8_400)) return false;
  }
  return true;
}

export function sameVisitScope(a: SpatialVisitScope, b: SpatialVisitScope): boolean {
  return a.host === b.host && a.kind === b.kind && (a.rig ?? null) === (b.rig ?? null) && (a.pod ?? null) === (b.pod ?? null);
}

export interface SpatialVisitStore {
  get(visitId: string): SpatialVisitSnapshot | null;
  put(visitId: string, snapshot: SpatialVisitSnapshot): boolean;
  size(): number;
}

export function createSpatialVisitStore(storage: Pick<Storage, "getItem" | "setItem"> | null): SpatialVisitStore {
  // Map iteration order is insertion order: oldest first → LRU eviction.
  let records: Map<string, SpatialVisitSnapshot> | null = null;
  let storageUsable = storage !== null;

  const load = (): Map<string, SpatialVisitSnapshot> => {
    if (records) return records;
    records = new Map();
    if (!storage) return records;
    try {
      const raw = storage.getItem(STORAGE_KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : null;
      if (Array.isArray(parsed)) {
        for (const entry of parsed.slice(-SPATIAL_VISIT_MAX_RECORDS)) {
          if (Array.isArray(entry) && typeof entry[0] === "string" && isSpatialVisitSnapshot(entry[1])) {
            records.set(entry[0], entry[1]);
          }
        }
      }
    } catch {
      storageUsable = false;
    }
    return records;
  };

  const persist = () => {
    if (!storage || !storageUsable || !records) return;
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify([...records.entries()]));
    } catch {
      // Full or unavailable: keep the in-memory copy; navigation never waits on this.
      storageUsable = false;
    }
  };

  return {
    get(visitId) {
      const map = load();
      const snapshot = map.get(visitId);
      if (!snapshot) return null;
      map.delete(visitId);
      map.set(visitId, snapshot);
      return snapshot;
    },
    put(visitId, snapshot) {
      if (!isSpatialVisitSnapshot(snapshot)) return false;
      if (JSON.stringify(snapshot).length > SPATIAL_VISIT_MAX_RECORD_BYTES) return false;
      const map = load();
      map.delete(visitId);
      map.set(visitId, snapshot);
      while (map.size > SPATIAL_VISIT_MAX_RECORDS) map.delete(map.keys().next().value!);
      persist();
      return true;
    },
    size: () => load().size,
  };
}

function sessionStorageOrNull(): Storage | null {
  try {
    return typeof window !== "undefined" && window.sessionStorage ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

export const spatialVisitStore: SpatialVisitStore = createSpatialVisitStore(sessionStorageOrNull());
