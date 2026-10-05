// Exact workflow spec identity for connected-instance workflow surfaces.
//
// Library IDs are opaque daemon addresses (a colon-bearing version is encoded
// as `workflow:@<base64url tuple>`), so the browser never builds
// `workflow:<name>:<version>`, splits an ID, or coerces a version. It selects
// the served catalog row whose name and version bytes equal the instance's,
// from the same origin as the trace, and uses its review only after the served
// review names that same entry and tuple. Absent, ambiguous, unavailable and
// mismatched states stay explicit; no sibling or other host is substituted.

import { useCallback } from "react";
import { useRouter } from "@tanstack/react-router";
import { useLibraryReview, useSpecLibrary, type LibraryWorkflowReview, type SpecLibraryEntry } from "../../hooks/useSpecLibrary.js";
import { LOCAL_HOST_ID } from "../../lib/host-param.js";
import type { OperatorReadError } from "../../lib/operator-read.js";

/** The connected instance's own read origin (workflow traces are local-only). */
export const CONNECTED_SPEC_SOURCE = LOCAL_HOST_ID;

export type WorkflowSpecMatch =
  | { kind: "pending" }
  | { kind: "unavailable"; error: OperatorReadError | Error | null }
  | { kind: "absent" }
  | { kind: "ambiguous"; entries: SpecLibraryEntry[] }
  | { kind: "matched"; entry: SpecLibraryEntry };

export function matchWorkflowSpec(entries: readonly SpecLibraryEntry[] | undefined, name: string, version: string): WorkflowSpecMatch {
  if (!entries) return { kind: "pending" };
  const exact = entries.filter((e) => e.kind === "workflow" && e.name === name && e.version === version);
  if (exact.length === 0) return { kind: "absent" };
  if (exact.length > 1) return { kind: "ambiguous", entries: exact };
  return { kind: "matched", entry: exact[0]! };
}

/** The served review is usable only for exactly the matched entry and tuple. */
export function verifiedWorkflowReview(review: unknown, entryId: string, name: string, version: string): LibraryWorkflowReview | null {
  if (!review || typeof review !== "object") return null;
  const r = review as Partial<LibraryWorkflowReview>;
  return r.kind === "workflow" && r.libraryEntryId === entryId && r.name === name && r.version === version ? (r as LibraryWorkflowReview) : null;
}

export type ConnectedWorkflowSpecState =
  | { state: "catalog"; match: Exclude<WorkflowSpecMatch, { kind: "matched" }>; retry: () => void }
  | { state: "review-pending"; entry: SpecLibraryEntry }
  | { state: "review-unavailable"; entry: SpecLibraryEntry; error: Error | null; retry: () => void }
  | { state: "review-mismatch"; entry: SpecLibraryEntry; served: { name: unknown; version: unknown; libraryEntryId: unknown } }
  | { state: "verified"; entry: SpecLibraryEntry; review: LibraryWorkflowReview };

/** One library read's observation. `readAt` is the time of the last
 * SUCCESSFUL read of the retained data (never the failed attempt); `error`
 * is the latest refresh failure, which may sit beside retained data. */
export interface SpecReadFreshness { readAt: string | null; error: Error | null; fetching: boolean; retained: boolean }

export interface SpecFreshness {
  catalog: SpecReadFreshness;
  /** Null until an exact entry is selected (no review read exists yet). */
  review: SpecReadFreshness | null;
  /** A refresh failed while earlier data is still shown: last-good, not current. */
  stale: boolean;
  /** Refetch whichever reads failed (or both). Never another host. */
  refresh: () => void;
}

export type ConnectedWorkflowSpec = ConnectedWorkflowSpecState & { freshness: SpecFreshness };

/** Observation facts for one library read (shared by the list and instance pages). */
export function specReadFreshness(query: { data: unknown; error: unknown; dataUpdatedAt: number; isFetching: boolean }): SpecReadFreshness {
  const retained = query.data !== undefined;
  return {
    readAt: retained && query.dataUpdatedAt > 0 ? new Date(query.dataUpdatedAt).toISOString() : null,
    error: query.error instanceof Error ? query.error : query.error ? new Error(String(query.error)) : null,
    fetching: query.isFetching,
    retained,
  };
}

/** Catalog AND review pinned to the connected instance, regardless of the
 * topology host selection (which unrelated library callers keep following).
 * A failed refresh never relabels retained data as current: the result keeps
 * the last-good facts with their original read time and marks them stale. */
export function useConnectedWorkflowSpec(tuple: { name: string; version: string } | null): ConnectedWorkflowSpec | null {
  const catalog = useSpecLibrary("workflow", { sourceHostId: CONNECTED_SPEC_SOURCE });
  const match: WorkflowSpecMatch = catalog.data === undefined && catalog.error
    ? { kind: "unavailable", error: catalog.error }
    : tuple ? matchWorkflowSpec(catalog.data, tuple.name, tuple.version) : { kind: "pending" };
  const entry = match.kind === "matched" ? match.entry : null;
  const review = useLibraryReview(entry?.id ?? null, { sourceHostId: CONNECTED_SPEC_SOURCE });
  if (!tuple) return null;

  const catalogFreshness = specReadFreshness(catalog);
  const reviewFreshness = entry ? specReadFreshness(review) : null;
  const freshness: SpecFreshness = {
    catalog: catalogFreshness,
    review: reviewFreshness,
    stale: (catalogFreshness.retained && catalogFreshness.error !== null) || (reviewFreshness !== null && reviewFreshness.retained && reviewFreshness.error !== null),
    refresh: () => {
      const failedReview = reviewFreshness?.error != null;
      if (catalogFreshness.error || !failedReview) void catalog.refetch();
      if (failedReview) void review.refetch();
    },
  };
  const result = (state: ConnectedWorkflowSpecState): ConnectedWorkflowSpec => ({ ...state, freshness });

  if (!entry) return result({ state: "catalog", match: match as Exclude<WorkflowSpecMatch, { kind: "matched" }>, retry: () => void catalog.refetch() });
  if (review.data === undefined) {
    return result(review.error ? { state: "review-unavailable", entry, error: review.error as Error, retry: () => void review.refetch() } : { state: "review-pending", entry });
  }
  const verified = verifiedWorkflowReview(review.data, entry.id, tuple.name, tuple.version);
  if (!verified) {
    const served = review.data as Partial<LibraryWorkflowReview>;
    return result({ state: "review-mismatch", entry, served: { name: served.name, version: served.version, libraryEntryId: served.libraryEntryId } });
  }
  return result({ state: "verified", entry, review: verified });
}

/** Library review URL that carries its read origin. The /specs/library/$entryId
 * route consumes the `source` search field; the path parameter is the exact
 * served ID, encoded once by the router. */
export function useOpenLibraryEntry() {
  const router = useRouter();
  return useCallback((entryId: string, sourceHostId: string = CONNECTED_SPEC_SOURCE) => {
    const location = router.buildLocation({ to: "/specs/library/$entryId", params: { entryId } });
    const path = location.href.split(/[?#]/)[0]!;
    router.history.push(`${path}?${new URLSearchParams({ source: sourceHostId }).toString()}`);
  }, [router]);
}
