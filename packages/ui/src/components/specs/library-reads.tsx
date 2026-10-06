// Library consumers composed from EXISTING bounded readers (no new transport):
// host-selection admission observed from the shared ["hosts"] cache, the
// origin's rig summary (topologyRead) and per-rig node inventory
// (readNodeInventory), keyed exactly like useRigSummary/useNodeInventory so
// the cache is shared rather than duplicated.

import { useCallback, type MouseEvent, type ReactNode } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import type { HostsResponse } from "../../hooks/useHosts.js";
import type { NodeInventoryEntry } from "../../hooks/useNodeInventory.js";
import type { RigSummary } from "../../hooks/useRigSummary.js";
import { readHosts } from "../../lib/hosts-read.js";
import { NodeInventoryPartialReadError, readNodeInventory } from "../../lib/fleet-inventory-reads.js";
import { isTopologyRigSummary, topologyRead } from "../../lib/topology-read.js";

export type HostSelectionState =
  | { state: "unknown" }
  | { state: "failed"; error: Error; cachedSelected: string | null }
  | { state: "known"; selected: string };

/** Observer of the shared hosts read. Passive by default (HostIndicator keeps
 * it warm); `active` joins the same polled key for standalone destinations.
 * `failed` carries the retained selection only as disclosure, never authority. */
export function useHostSelectionState({ active = false }: { active?: boolean } = {}): HostSelectionState {
  const query = useQuery<HostsResponse>({
    queryKey: ["hosts"],
    queryFn: ({ signal }) => readHosts({ signal }),
    enabled: active,
    refetchInterval: active ? 5_000 : undefined,
    retry: false,
    placeholderData: undefined,
  });
  if (query.error) return { state: "failed", error: query.error as Error, cachedSelected: query.data?.selected ?? null };
  if (query.data) return { state: "known", selected: query.data.selected };
  return { state: "unknown" };
}

/** Plain-language origin label. "local" is the connected instance. */
export function originLabel(hostId: string | null): string {
  if (hostId === null) return "unknown origin";
  return hostId === "local" ? "the connected instance" : `host ${hostId}`;
}

export interface InventoryPartial {
  rows: NodeInventoryEntry[];
  rejectedCount: number;
  receivedAt: number;
}

export interface RigCoverage {
  rig: RigSummary;
  /** ok: current complete read. stale: an older successful read, refresh
   * failed. partial: the newest response carried rejected records. failed:
   * nothing verified. Only "ok" counts towards complete coverage. */
  status: "pending" | "ok" | "stale" | "partial" | "failed";
  /** Rows of the last SUCCESSFUL read (current when ok, retained otherwise). */
  rows: NodeInventoryEntry[];
  updatedAt: number;
  /** Verified rows of a newer partial response, kept separate from `rows`. */
  partial: InventoryPartial | null;
  error: Error | null;
}

export interface OriginInventory {
  hostId: string | null;
  /** stale: the rig list shown is an older successful read whose refresh failed. */
  summary: { status: "idle" | "pending" | "ok" | "stale" | "failed"; error: Error | null; updatedAt: number; retry: () => void };
  rigs: RigCoverage[];
  /** True only when the rig list and every rig inventory are current and complete. */
  complete: boolean;
}

/** Typed partial evidence admitted only for this exact origin and rig. */
function admittedPartial(error: unknown, hostId: string, rigId: string): InventoryPartial | null {
  if (!(error instanceof NodeInventoryPartialReadError)) return null;
  const { partial } = error;
  if (partial.hostId !== hostId || partial.rigId !== rigId) return null;
  return { rows: partial.rows, rejectedCount: partial.rejectedCount, receivedAt: partial.receivedAt };
}

/** Every rig's inventory on one exact origin. A failed, pending, partial or
 * stale read is incomplete coverage, never zero consumers; retained and
 * partial rows remain dated evidence, each attributed to its own read. */
export function useOriginInventory(hostId: string | null, enabled = true): OriginInventory {
  const active = enabled && hostId !== null;
  const summary = useQuery({
    queryKey: ["rigs", "summary", hostId],
    queryFn: ({ signal }) => topologyRead<RigSummary[]>("/api/rigs/summary", hostId!, signal, isTopologyRigSummary),
    enabled: active,
    retry: false,
    placeholderData: undefined,
  });
  const rigs = active ? summary.data ?? [] : [];
  const inventories = useQueries({
    queries: rigs.map((rig) => ({
      queryKey: ["rig", rig.id, "nodes", hostId],
      queryFn: ({ signal }: { signal: AbortSignal }) => readNodeInventory(rig.id, hostId!, { signal }),
      retry: false,
      refetchInterval: 30_000,
      placeholderData: undefined,
    })),
  });
  const summaryStatus = !active ? "idle" : summary.data ? (summary.error ? "stale" : "ok") : summary.error ? "failed" : "pending";
  const coverage: RigCoverage[] = rigs.map((rig, index) => {
    const query = inventories[index]!;
    const rows = (query.data as NodeInventoryEntry[] | undefined) ?? [];
    const error = (query.error as Error | null) ?? null;
    const partial = admittedPartial(error, hostId!, rig.id);
    const status = partial ? "partial" : query.data ? (error ? "stale" : "ok") : error ? "failed" : "pending";
    return { rig, rows, updatedAt: query.dataUpdatedAt, partial, error, status };
  });
  return {
    hostId,
    summary: {
      status: summaryStatus,
      error: (summary.error as Error | null) ?? null,
      updatedAt: summary.dataUpdatedAt,
      retry: () => void summary.refetch(),
    },
    rigs: coverage,
    complete: summaryStatus === "ok" && coverage.every((rig) => rig.status === "ok"),
  };
}

/** `/specs/library/<id>` with the existing raw `?source=` contract: the path
 * parameter is the exact served ID encoded once by the router; the origin is
 * URLSearchParams-encoded so values such as "1.0" are never JSON-coerced. */
export function useLibraryEntryHref() {
  const router = useRouter();
  return useCallback((entryId: string, sourceHostId?: string) => {
    const path = router.buildLocation({ to: "/specs/library/$entryId", params: { entryId } }).href.split(/[?#]/)[0]!;
    return sourceHostId === undefined ? path : `${path}?${new URLSearchParams({ source: sourceHostId }).toString()}`;
  }, [router]);
}

/** Anchor to an exact library entry: real href (copy/middle-click), router push.
 * `sourceHostId` is the origin of the read that SERVED `entryId` (an opaque ID
 * is not cross-host identity), so a saved link keeps reading that origin. */
export function LibraryEntryLink({ entryId, sourceHostId, className, testId, onOpen, children, ...attributes }: {
  entryId: string;
  sourceHostId?: string;
  className?: string;
  testId?: string;
  /** Runs before the push (e.g. remember the opened row). */
  onOpen?: () => void;
  children: ReactNode;
  title?: string;
  "aria-label"?: string;
  "aria-current"?: "true";
} & { [attribute: `data-${string}`]: string | undefined }) {
  const router = useRouter();
  const href = useLibraryEntryHref()(entryId, sourceHostId);
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    onOpen?.();
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    router.history.push(href);
  };
  return <a {...attributes} href={href} onClick={onClick} className={className} data-testid={testId}>{children}</a>;
}

/** Push an exact library entry, carrying the origin of the read that named it. */
export function useLibraryEntryNavigate(sourceHostId: string | null) {
  const router = useRouter();
  const href = useLibraryEntryHref();
  return useCallback((entryId: string) => {
    router.history.push(href(entryId, sourceHostId ?? undefined));
  }, [router, href, sourceHostId]);
}
