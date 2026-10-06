// URL state for the connected-instance Recent / Pulse / maintained-stream
// destination (`/pulse`).
//
// Identities (rig names, qitem IDs, stream cursors, session filters) are read
// RAW from the entry's publicHref and written byte-for-byte through router
// history, never through the router's JSON search serializer: a rig named
// "2024" or a sort key "1.0" must stay that exact string, not become a
// number and silently widen the scope. Unknown or malformed values are kept
// as issues for a visible notice; they are never mapped onto another entity.

import type { freezeRecentSelection } from "../../lib/recent-pulse-contracts.js";
import { operatorScopeKey, type OperatorInstanceScope } from "../../lib/operator-read.js";

export const RECENT_PULSE_PATH = "/pulse";
export const RECENT_PULSE_VIEWS = ["pulse", "recent", "stream"] as const;
export type RecentPulseView = (typeof RECENT_PULSE_VIEWS)[number];
export const STREAM_LIMITS = [5, 10, 20, 50, 100] as const;
const MAX_TEXT = 512;

export interface StreamLocation {
  direction: "latest" | "chronological";
  limit: number;
  after: string | null;
  source: string | null;
  dest: string | null;
  tag: string | null;
  since: string | null;
  until: string | null;
  archived: boolean;
}

export interface RecentPulseLocation {
  view: RecentPulseView;
  /** Exact Recent rig name; null = instance scope. */
  rig: string | null;
  /** Recent window: every served row (default) or the TUI's collapsed last five. */
  window: "full" | "collapsed";
  /** Selected Recent transition ID (positive integer). */
  transition: number | null;
  /** Exact queue item opened for current evidence. */
  qitem: string | null;
  stream: StreamLocation;
  /** Selected stream item ID within the served page. */
  item: string | null;
  /** Malformed values that were present but not applied. */
  issues: string[];
}

export const DEFAULT_STREAM: StreamLocation = {
  direction: "latest", limit: 5, after: null, source: null, dest: null, tag: null, since: null, until: null, archived: false,
};

export const DEFAULT_RECENT_PULSE_LOCATION: RecentPulseLocation = {
  view: "pulse", rig: null, window: "full", transition: null, qitem: null, stream: DEFAULT_STREAM, item: null, issues: [],
};

/** The raw query string of a history entry's publicHref (no hash). */
export function rawQueryOf(publicHref: string): string {
  const hash = publicHref.indexOf("#");
  const path = hash >= 0 ? publicHref.slice(0, hash) : publicHref;
  const query = path.indexOf("?");
  return query >= 0 ? path.slice(query + 1) : "";
}

/** Search validator for `/pulse`: exact strings in, typed location out. */
export function parseRecentPulseLocation(rawQuery: string | URLSearchParams): RecentPulseLocation {
  const params = typeof rawQuery === "string" ? new URLSearchParams(rawQuery) : rawQuery;
  const issues: string[] = [];
  const text = (key: string): string | null => {
    if (!params.has(key)) return null;
    const value = params.get(key)!;
    if (value.trim().length === 0 || value.length > MAX_TEXT) { issues.push(`${key} was empty or too long and was not applied`); return null; }
    return value;
  };
  const rawView = params.get("view");
  const view = rawView === null ? "pulse" : (RECENT_PULSE_VIEWS as readonly string[]).includes(rawView) ? rawView as RecentPulseView : (issues.push(`unknown view "${rawView}"`), "pulse");
  const rawTransition = params.get("transition");
  let transition: number | null = null;
  if (rawTransition !== null) {
    if (/^[1-9]\d{0,14}$/.test(rawTransition)) transition = Number(rawTransition);
    else issues.push(`transition "${rawTransition}" is not a transition ID`);
  }
  const rawWindow = params.get("window");
  if (rawWindow !== null && rawWindow !== "collapsed" && rawWindow !== "full") issues.push(`unknown window "${rawWindow}"`);
  const rawDir = params.get("dir");
  if (rawDir !== null && rawDir !== "latest" && rawDir !== "chronological") issues.push(`unknown stream direction "${rawDir}"`);
  const rawLimit = params.get("limit");
  let limit = DEFAULT_STREAM.limit;
  if (rawLimit !== null) {
    if (/^\d{1,3}$/.test(rawLimit) && Number(rawLimit) >= 1 && Number(rawLimit) <= 100) limit = Number(rawLimit);
    else issues.push(`stream limit "${rawLimit}" must be 1–100`);
  }
  const rawArchived = params.get("archived");
  if (rawArchived !== null && rawArchived !== "1") issues.push(`archived "${rawArchived}" must be 1`);
  return {
    view,
    rig: text("rig"),
    window: rawWindow === "collapsed" ? "collapsed" : "full",
    transition,
    qitem: text("qitem"),
    stream: {
      direction: rawDir === "chronological" ? "chronological" : "latest",
      limit,
      after: text("after"),
      source: text("source"),
      dest: text("dest"),
      tag: text("tag"),
      since: text("since"),
      until: text("until"),
      archived: rawArchived === "1",
    },
    item: text("item"),
    issues,
  };
}

export type RecentPulseLocationInput = Partial<Omit<RecentPulseLocation, "stream" | "issues">> & { stream?: Partial<StreamLocation> };

/** Exact href for a location; only non-default fields are written. */
export function recentPulseHref(input: RecentPulseLocationInput = {}): string {
  const loc = { ...DEFAULT_RECENT_PULSE_LOCATION, ...input, stream: { ...DEFAULT_STREAM, ...input.stream } };
  const params = new URLSearchParams();
  if (loc.view !== "pulse") params.set("view", loc.view);
  if (loc.rig !== null) params.set("rig", loc.rig);
  if (loc.window === "collapsed") params.set("window", "collapsed");
  if (loc.transition !== null) params.set("transition", String(loc.transition));
  if (loc.qitem !== null) params.set("qitem", loc.qitem);
  const s = loc.stream;
  if (s.direction !== "latest") params.set("dir", s.direction);
  if (s.limit !== DEFAULT_STREAM.limit) params.set("limit", String(s.limit));
  for (const key of ["after", "source", "dest", "tag", "since", "until"] as const) if (s[key] !== null) params.set(key, s[key]!);
  if (s.archived) params.set("archived", "1");
  if (loc.item !== null) params.set("item", loc.item);
  const query = params.toString();
  return query ? `${RECENT_PULSE_PATH}?${query}` : RECENT_PULSE_PATH;
}

// ------------------------------------------------- retained frozen originals

export type FrozenRecentSelection = NonNullable<ReturnType<typeof freezeRecentSelection>>;
export interface RetainedRecentSelection {
  selection: FrozenRecentSelection;
  /** Browser time the original served row was frozen (not a daemon fact). */
  capturedAt: number;
  /** The Recent scope whose served window supplied the row. */
  capturedFrom: string;
}

const RETAINED_LIMIT = 100;
const retained = new Map<string, RetainedRecentSelection>();
const retainedKey = (authorityKey: string, transitionId: number) => `${authorityKey}\0${transitionId}`;

/** App-lifetime memory of frozen originals so a drill to topology and Back
 * (which remounts the page) still shows the exact selected record. Never
 * persisted: after a reload an evicted original is honestly unavailable. */
export function retainRecentSelection(selection: FrozenRecentSelection, capturedFrom: string): RetainedRecentSelection {
  const key = retainedKey(selection.authorityKey, selection.row.transitionId);
  const existing = retained.get(key);
  if (existing) return existing;
  const entry = { selection, capturedAt: Date.now(), capturedFrom };
  retained.set(key, entry);
  if (retained.size > RETAINED_LIMIT) retained.delete(retained.keys().next().value as string);
  return entry;
}

export function retainedRecentSelection(scope: OperatorInstanceScope, transitionId: number): RetainedRecentSelection | null {
  return retained.get(retainedKey(operatorScopeKey(scope).join("\0"), transitionId)) ?? null;
}

/** Test seam: forget retained originals (a browser reload). */
export function forgetRetainedRecentSelections() { retained.clear(); }
