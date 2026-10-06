// Library navigation model: catalog filters, exact kind/name resolution,
// read-failure classification and declared/observed consumer facts.
//
// Identity rules (gui-spec-library-contracts.md, gui-spec-library-identity-data.md):
// served entry IDs are opaque — never split, decoded, rebuilt or derived from a
// name; a kind/name lookup filters exact served `kind` + `name` bytes and asks
// for a choice when more than one entry matches (never first-match).

import type { SpecLibraryEntry, SpecLibraryKind } from "../../hooks/useSpecLibrary.js";
import type { NodeInventoryEntry } from "../../hooks/useNodeInventory.js";
import { OperatorReadError } from "../../lib/operator-read.js";

// ---------------------------------------------------------------------------
// Catalog filter (URL search state: q, kind, origin)

export const CATALOG_KINDS = [
  { id: "all", label: "All kinds" },
  { id: "rig", label: "Rig specs" },
  { id: "agent", label: "Agent specs" },
  { id: "workflow", label: "Workflow specs" },
  { id: "application", label: "Applications" },
  { id: "context-pack", label: "Context packs" },
  { id: "agent-image", label: "Agent images" },
  { id: "plugin", label: "Plugins" },
  { id: "skill", label: "Skills" },
] as const;
export type CatalogKind = (typeof CATALOG_KINDS)[number]["id"];

export const CATALOG_ORIGINS = [
  { id: "all", label: "All sources" },
  { id: "builtin", label: "Shipped with OpenRig" },
  { id: "user", label: "Your files and installs" },
] as const;
export type CatalogOrigin = (typeof CATALOG_ORIGINS)[number]["id"];

export interface CatalogFilter { text: string; kind: CatalogKind; origin: CatalogOrigin }
export const EMPTY_FILTER: CatalogFilter = { text: "", kind: "all", origin: "all" };

const primitiveText = (value: unknown): string =>
  typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : "";

/** Parsed router search → filter. Unknown kinds/origins fall back to "all";
 * a hand-typed numeric `q` (router-coerced) is restored to its text. */
export function parseCatalogFilter(search: Record<string, unknown>): CatalogFilter {
  const kind = primitiveText(search.kind);
  const origin = primitiveText(search.origin);
  return {
    text: primitiveText(search.q),
    kind: CATALOG_KINDS.some((k) => k.id === kind) ? (kind as CatalogKind) : "all",
    origin: CATALOG_ORIGINS.some((o) => o.id === origin) ? (origin as CatalogOrigin) : "all",
  };
}

/** Filter → search fields; defaults are omitted so a clean catalog has a clean URL. */
export function catalogSearch(filter: CatalogFilter): Record<string, string> {
  const search: Record<string, string> = {};
  if (filter.text) search.q = filter.text;
  if (filter.kind !== "all") search.kind = filter.kind;
  if (filter.origin !== "all") search.origin = filter.origin;
  return search;
}

export function isFiltered(filter: CatalogFilter): boolean {
  return filter.text.trim() !== "" || filter.kind !== "all" || filter.origin !== "all";
}

/** Case-insensitive substring match over the row's served text facts. */
export function matchesText(text: string, fields: ReadonlyArray<string | null | undefined>): boolean {
  const needle = text.trim().toLowerCase();
  if (!needle) return true;
  return fields.some((field) => typeof field === "string" && field.toLowerCase().includes(needle));
}

/** Maps each library's served source label onto the two catalog origins.
 * Unknown labels match only "all" — they are never guessed into a bucket. */
export function originOf(source: string | null | undefined): Exclude<CatalogOrigin, "all"> | null {
  switch (source) {
    case "builtin": case "openrig-managed": case "vendored": return "builtin";
    case "user_file": case "workspace": case "claude-cache": case "codex-cache": return "user";
    default: return null;
  }
}

export function matchesOrigin(origin: CatalogOrigin, source: string | null | undefined): boolean {
  return origin === "all" || originOf(source) === origin;
}

export function specCatalogKind(entry: SpecLibraryEntry): CatalogKind {
  return entry.kind === "rig" && entry.hasServices ? "application" : entry.kind;
}

// ---------------------------------------------------------------------------
// Exact kind/name resolution

export const SPEC_KINDS: readonly SpecLibraryKind[] = ["rig", "agent", "workflow"];
export function isSpecKind(value: string): value is SpecLibraryKind {
  return (SPEC_KINDS as readonly string[]).includes(value);
}

export interface SpecLookup {
  kind: SpecLibraryKind;
  name: string;
  /** Optional exact served version. */
  version?: string;
}

export type SpecResolution =
  | { state: "unavailable"; lookup: SpecLookup }
  | { state: "exact"; lookup: SpecLookup; entry: SpecLibraryEntry }
  /** Every candidate is an unparseable diagnostic row: nothing to open. */
  | { state: "invalid"; lookup: SpecLookup; candidates: SpecLibraryEntry[] }
  | { state: "ambiguous"; lookup: SpecLookup; candidates: SpecLibraryEntry[] };

export function resolveSpec(entries: readonly SpecLibraryEntry[], lookup: SpecLookup): SpecResolution {
  const candidates = entries.filter((entry) => entry.kind === lookup.kind && entry.name === lookup.name
    && (lookup.version === undefined || entry.version === lookup.version));
  if (candidates.length === 0) return { state: "unavailable", lookup };
  const openable = candidates.filter((entry) => entry.status !== "error");
  if (openable.length === 0) return { state: "invalid", lookup, candidates };
  if (candidates.length === 1) return { state: "exact", lookup, entry: candidates[0]! };
  return { state: "ambiguous", lookup, candidates };
}

/** Human-readable distinguishing facts for a candidate (never its ID parts). */
export function candidateFacts(entry: SpecLibraryEntry): string {
  const source = entry.sourceType === "builtin" ? "built-in" : "user file";
  return `v${entry.version} · ${source} · ${entry.relativePath || entry.sourcePath}`;
}

// ---------------------------------------------------------------------------
// Read-failure classification

export type LibraryReadFailure =
  /** 409: retired/legacy ID or a changed source address — reselect. */
  | { kind: "reselect"; reason: "legacy_spec_id" | "source_changed" | "identity_conflict"; message: string }
  /** 404: this origin's library does not contain the ID. */
  | { kind: "absent"; message: string }
  /** The origin is unknown; nothing was read. */
  | { kind: "unknown-origin"; message: string }
  /** Transport, timeout, 5xx, malformed contract: availability unknown. */
  | { kind: "unavailable"; message: string };

const SERVED_REASON_CODES = new Set(["legacy_spec_id", "source_changed"]);

export function classifyLibraryReadError(error: unknown): LibraryReadFailure {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof OperatorReadError) {
    if (error.code === "invalid_request") return { kind: "unknown-origin", message };
    if (error.code === "http" && error.status === 409) {
      const reason = error.serverCode && SERVED_REASON_CODES.has(error.serverCode)
        ? (error.serverCode as "legacy_spec_id" | "source_changed")
        : "identity_conflict";
      return { kind: "reselect", reason, message };
    }
    if (error.code === "http" && error.status === 404) return { kind: "absent", message };
  } else if (/\bHTTP 404\b/.test(message)) {
    // Legacy hooks (plain Error with "HTTP <status>") — status only, no body parsing.
    return { kind: "absent", message };
  }
  return { kind: "unavailable", message };
}

// ---------------------------------------------------------------------------
// Declared versus observed consumers

/** An authored `local:` member reference resolved exactly as the rig spec
 * declares it (relative to the rig file's directory). Only an exact served
 * `<dir>/agent.yaml` (or .yml) sourcePath counts as a catalog match; other
 * ref forms are retained as written, never guessed. */
export type AuthoredRefResolution =
  | { state: "catalog"; agentRef: string; path: string; entry: SpecLibraryEntry }
  | { state: "uncatalogued"; agentRef: string; path: string }
  | { state: "nonstandard"; agentRef: string };

export function resolveAuthoredAgentRef(rigSourcePath: string, agentRef: string, agentEntries: readonly SpecLibraryEntry[]): AuthoredRefResolution {
  if (!agentRef.startsWith("local:") || !rigSourcePath.startsWith("/")) return { state: "nonstandard", agentRef };
  const rigDir = rigSourcePath.replace(/\/[^/]+$/, "");
  const resolved: string[] = [];
  for (const segment of `${rigDir}/${agentRef.slice("local:".length)}`.split("/")) {
    if (segment === "..") resolved.pop();
    else if (segment !== "." && segment !== "") resolved.push(segment);
  }
  const path = `/${resolved.join("/")}`;
  const entry = agentEntries.find((candidate) => candidate.kind === "agent"
    && (candidate.sourcePath === `${path}/agent.yaml` || candidate.sourcePath === `${path}/agent.yml` || candidate.sourcePath === path));
  return entry ? { state: "catalog", agentRef, path, entry } : { state: "uncatalogued", agentRef, path };
}

export interface ObservedSeat {
  hostId: string;
  rigId: string;
  rigName: string;
  logicalId: string;
  canonicalSessionName: string | null;
  lifecycleState: string | null;
  runtime: string | null;
  resolvedSpecName: string;
  resolvedSpecVersion: string | null;
  resolvedSpecHash: string | null;
  profile: string | null;
  agentRef: string | null;
  /** Which inventory observation produced this row; never merged across. */
  observation: SeatObservation;
}

/** current: latest successful read. retained: an older successful read whose
 * refresh failed. partial: the verified rows of a newer response that also
 * carried rejected records (its own receipt time and rejected count). */
export type SeatObservation =
  | { kind: "current"; at: number }
  | { kind: "retained"; at: number }
  | { kind: "partial"; at: number; rejectedCount: number };

/** Seats whose daemon-served EFFECTIVE binding names this spec. An absent
 * version means every served version of that exact name; an explicit version
 * (including "") is exact. The binding cannot prove which physical source was
 * launched — callers show `sameBindingEntries` when several entries share it. */
export function observedSeatsForSpec(hostId: string, rows: readonly NodeInventoryEntry[], spec: { name: string; version?: string },
  observation: SeatObservation = { kind: "current", at: 0 }): ObservedSeat[] {
  return rows
    .filter((row) => row.nodeKind === "agent" && row.resolvedSpecName === spec.name
      && (spec.version === undefined || row.resolvedSpecVersion === spec.version))
    .map((row) => ({
      observation,
      hostId, rigId: row.rigId, rigName: row.rigName, logicalId: row.logicalId,
      canonicalSessionName: row.canonicalSessionName, lifecycleState: row.lifecycleState ?? null,
      runtime: row.runtime, resolvedSpecName: row.resolvedSpecName!, resolvedSpecVersion: row.resolvedSpecVersion ?? null,
      resolvedSpecHash: row.resolvedSpecHash ?? null, profile: row.profile ?? null, agentRef: row.agentRef ?? null,
    }));
}

/** Catalog entries that share an effective binding's name (and version, when
 * served) — more than one means the binding cannot identify its source. */
export function sameBindingEntries(entries: readonly SpecLibraryEntry[], name: string, version: string | null | undefined): SpecLibraryEntry[] {
  return entries.filter((entry) => entry.kind === "agent" && entry.name === name && (version == null || entry.version === version));
}

/** A list read as facts: only "ok" may support absence; "stale" entries are
 * the dated last good read; "pending"/"failed" mean the contents are unknown. */
export interface ListRead<T> {
  state: "idle" | "pending" | "ok" | "stale" | "failed";
  entries: readonly T[] | undefined;
  error: Error | null;
  updatedAt: number;
  retry: () => void;
}

export function listRead<T>(query: { data?: readonly T[]; error: unknown; dataUpdatedAt: number; fetchStatus?: string; refetch: () => unknown },
  enabled = true): ListRead<T> {
  const error = query.error instanceof Error ? query.error : query.error ? new Error(String(query.error)) : null;
  const state = !enabled ? "idle" : query.data !== undefined ? (error ? "stale" : "ok") : error ? "failed" : "pending";
  return { state, entries: query.data, error, updatedAt: query.dataUpdatedAt, retry: () => void query.refetch() };
}

// ---------------------------------------------------------------------------
// Freshness

export function readAge(updatedAt: number, now = Date.now()): string {
  if (!updatedAt) return "never";
  const seconds = Math.max(0, Math.round((now - updatedAt) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}
