// Topology navigation controller — the ONE place topology scope pages, the 3D
// view and topology link producers read and write navigation state.
//
// Contract (docs/plans/gui-spatial-navigation-contract.md):
//   - Semantic state (source host, view, Scene/List, search text, exact graph
//     selection) lives in the URL, parsed by the committed pure codec
//     (lib/topology-location.ts) from the router's raw-preserving search.
//   - Every semantic change REPLACES the current entry, preserving unrelated
//     search keys, the hash and history state, with no scroll reset. Only an
//     entity drill pushes, and it first commits pending drafts and captures
//     the visit's local camera/scroll/focus.
//   - Camera/scroll/focus are per-visit and keyed by a small visit id stored in
//     router history state (never in the URL), so a copied link or new tab
//     starts fresh while Back/reload recover the same visit.
//   - The source host in a URL is an origin assertion, not authority: the
//     gate below mounts a scope body only when the asserted host equals a
//     successfully read current selection. It never selects a host on its own.

import { useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";
import { Link, useRouter, useRouterState, type AnyRouter, type HistoryState } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useHosts, useSelectHost, type HostsResponse } from "../../hooks/useHosts.js";
import { LOCAL_HOST_ID } from "../../lib/host-param.js";
import { readHosts } from "../../lib/hosts-read.js";
import {
  buildTopologyLink,
  parseTopologyLocation,
  type ParsedTopologyLocation,
  type TopologyIssue,
  type TopologyLinkInput,
  type TopologyLinkTarget,
  type TopologyLocation,
  type TopologyScope,
  type TopologySelection,
  type TopologyView,
} from "../../lib/topology-location.js";
import { stringifyTopologySearch } from "../../lib/topology-search.js";
import { cn } from "../../lib/utils.js";

// ---------------------------------------------------------------------------
// Visit identity (history state, never URL)
// ---------------------------------------------------------------------------

export const TOPOLOGY_VISIT_STATE_KEY = "openrigTopologyVisit";
const VISIT_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

export function readTopologyVisitId(state: unknown): string | null {
  if (!state || typeof state !== "object") return null;
  const value = (state as Record<string, unknown>)[TOPOLOGY_VISIT_STATE_KEY];
  return typeof value === "string" && VISIT_ID_PATTERN.test(value) ? value : null;
}

/** getRandomValues works in insecure contexts too (randomUUID does not). */
export function createTopologyVisitId(): string {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function withVisit(state: HistoryState, visitId: string): HistoryState {
  return { ...state, [TOPOLOGY_VISIT_STATE_KEY]: visitId } as HistoryState;
}

/** A fresh visit for a pushed destination. Evaluated at navigation time. */
export const freshTopologyVisitState = (): HistoryState =>
  ({ [TOPOLOGY_VISIT_STATE_KEY]: createTopologyVisitId() }) as HistoryState;

// One id per history entry, even when several participants ask at once
// (the scope page and the 3D view both observe the same entry).
const assignedVisitIds = new WeakMap<AnyRouter, Map<string, string>>();
function visitIdFor(router: AnyRouter): string {
  const existing = readTopologyVisitId(router.latestLocation.state);
  if (existing) return existing;
  const entryKey = String((router.latestLocation.state as { __TSR_key?: string }).__TSR_key ?? router.latestLocation.href);
  let byEntry = assignedVisitIds.get(router);
  if (!byEntry) assignedVisitIds.set(router, (byEntry = new Map()));
  let id = byEntry.get(entryKey);
  if (!id) {
    id = createTopologyVisitId();
    byEntry.set(entryKey, id);
    if (byEntry.size > 64) byEntry.delete(byEntry.keys().next().value!);
  }
  return id;
}

// ---------------------------------------------------------------------------
// Leave participants: pending drafts + local snapshot capture
// ---------------------------------------------------------------------------

export type TopologyPatch = Partial<{
  sourceHost: string;
  view: TopologyView;
  spatialMode: "scene" | "list";
  spatialQuery: string;
  /** null clears the indivisible selection pair. */
  selection: TopologySelection | null;
}>;

export interface TopologyParticipant {
  /** Return (and drop) a pending, not-yet-written patch, e.g. a search draft. */
  takeDraft?: () => TopologyPatch | null;
  /** Persist this visit's local camera/scroll/focus before the entry is left. */
  capture?: () => void;
}

const participants = new WeakMap<AnyRouter, Set<TopologyParticipant>>();

function participantSet(router: AnyRouter): Set<TopologyParticipant> {
  let set = participants.get(router);
  if (!set) participants.set(router, (set = new Set()));
  return set;
}

export function useTopologyParticipant(participant: TopologyParticipant) {
  const router = useRouter();
  const ref = useRef(participant);
  ref.current = participant;
  useEffect(() => {
    const proxy: TopologyParticipant = {
      takeDraft: () => ref.current.takeDraft?.() ?? null,
      capture: () => ref.current.capture?.(),
    };
    const set = participantSet(router);
    set.add(proxy);
    return () => {
      set.delete(proxy);
    };
  }, [router]);
}

function takeDrafts(router: AnyRouter): TopologyPatch {
  let merged: TopologyPatch = {};
  for (const p of participantSet(router)) {
    const draft = p.takeDraft?.();
    if (draft) merged = { ...merged, ...draft };
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

function applyPatch(search: Record<string, unknown>, patch: TopologyPatch, scope: TopologyScope) {
  const next: Record<string, unknown> = { ...search };
  const defaultView = scope.kind === "seat" ? "overview" : "graph";
  if (patch.sourceHost !== undefined) next.sourceHost = patch.sourceHost;
  if (patch.view !== undefined) {
    if (patch.view === defaultView) delete next.view;
    else next.view = patch.view;
  }
  if (patch.spatialMode !== undefined) {
    if (patch.spatialMode === "scene") delete next.spatialMode;
    else next.spatialMode = patch.spatialMode;
  }
  if (patch.spatialQuery !== undefined) {
    if (patch.spatialQuery === "") delete next.spatialQuery;
    else next.spatialQuery = patch.spatialQuery;
  }
  if (patch.selection !== undefined) {
    if (patch.selection === null) {
      delete next.selectedRig;
      delete next.selectedNode;
    } else {
      next.selectedRig = patch.selection.rigId;
      next.selectedNode = patch.selection.nodeId;
    }
  }
  return next;
}

/** Replace the current entry's semantic fields (plus any pending drafts),
 *  keeping unrelated search keys, hash, history state and scroll. */
export function replaceTopologyLocation(router: AnyRouter, scope: TopologyScope, patch: TopologyPatch = {}) {
  const merged = { ...takeDrafts(router), ...patch };
  const current = router.latestLocation;
  // Match the LATEST location (not the last committed matches, which can lag
  // a just-started navigation) so a replace never lands on another path.
  const matched = router.getMatchedRoutes(current.pathname);
  if (!matched.foundRoute) return;
  const visitId = visitIdFor(router);
  const search = applyPatch(current.search as Record<string, unknown>, merged, scope);
  void router.navigate({
    to: matched.foundRoute.fullPath,
    params: matched.routeParams,
    search,
    hash: true,
    state: (prev: HistoryState) => withVisit(prev, visitId),
    replace: true,
    resetScroll: false,
  } as never);
}

/** Before leaving the current entry for a pushed destination: capture local
 *  visit state, commit pending drafts with an explicit replace, and flush the
 *  browser history queue. TanStack's browser history coalesces a replace and a
 *  push queued in the same tick into ONE pushState, which would drop the last
 *  typed characters from the entry Back returns to. */
export function prepareTopologyDrill(router: AnyRouter, scope: TopologyScope | null) {
  for (const p of participantSet(router)) p.capture?.();
  const drafts = takeDrafts(router);
  const needsVisit = readTopologyVisitId(router.latestLocation.state) === null;
  // Drafts only exist while a topology view is mounted, so they always commit
  // to the entry being left, even from a producer that does not know its
  // scope (Explorer tree, graph): the scope only decides the default view,
  // which a draft never changes.
  if (Object.keys(drafts).length > 0 || (scope && needsVisit)) {
    replaceTopologyLocation(router, scope ?? { kind: "host" }, drafts);
  }
  router.history.flush?.();
}

export function navigateTopology(router: AnyRouter, from: TopologyScope | null, target: TopologyLinkTarget) {
  prepareTopologyDrill(router, from);
  void router.navigate({
    to: target.to,
    params: target.params,
    search: target.search,
    state: freshTopologyVisitState,
  } as never);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface TopologyNavigation {
  scope: TopologyScope;
  parsed: ParsedTopologyLocation;
  location: TopologyLocation;
  /** History-state visit id of the current entry (null until assigned). */
  visitId: string | null;
  replace: (patch: TopologyPatch) => void;
}

export function scopeKeyOf(scope: TopologyScope): string {
  switch (scope.kind) {
    case "host": return "host";
    case "rig": return `rig\u0000${scope.rigId}`;
    case "pod": return `pod\u0000${scope.rigId}\u0000${scope.podName}`;
    case "seat": return `seat\u0000${scope.rigId}\u0000${scope.logicalId}`;
  }
}

/** Parse the current router location for a topology scope. Pass router-
 *  decoded (raw) params verbatim; they are never decoded again. */
export function useTopologyLocation(scope: TopologyScope): TopologyNavigation {
  const router = useRouter();
  const location = useRouterState({ select: (s) => s.location });
  const key = scopeKeyOf(scope);
  const scopeRef = useRef(scope);
  if (scopeKeyOf(scopeRef.current) !== key) scopeRef.current = scope;
  const stableScope = scopeRef.current;
  const parsed = useMemo(
    () => parseTopologyLocation(stableScope, location.search as Record<string, unknown>, {
      serializedPathAndQuery: location.publicHref ?? location.href,
    }),
    [stableScope, location.search, location.publicHref, location.href],
  );
  const visitId = readTopologyVisitId(location.state);

  // Every topology entry gets a visit id once (same URL, state-only replace).
  useEffect(() => {
    if (visitId === null && parsed.targetValid) replaceTopologyLocation(router, stableScope);
  }, [router, stableScope, visitId, parsed.targetValid]);

  const replace = useCallback(
    (patch: TopologyPatch) => replaceTopologyLocation(router, stableScope, patch),
    [router, stableScope],
  );
  return { scope: stableScope, parsed, location: parsed.location, visitId, replace };
}

/** Known current selection for qualifying NEW links: null until a hosts read
 *  has succeeded and while the latest read is failing. Cache observer only. */
export function useKnownSelectedHost(): string | null {
  const { data, isError } = useQuery<HostsResponse>({
    queryKey: ["hosts"],
    queryFn: ({ signal }) => readHosts({ signal }),
    enabled: false,
    retry: false,
    placeholderData: undefined,
  });
  return data && !isError ? data.selected : null;
}

/** Exact topology target, qualified when the source is known, legacy (bound
 *  on arrival after a successful host read) when it is not. Never a partial
 *  or shortened href: an unrepresentable identity yields null. */
export function topologyTarget(input: Omit<TopologyLinkInput, "sourceHost"> & { sourceHost: string | null }): TopologyLinkTarget | null {
  const result = buildTopologyLink({ ...input, sourceHost: input.sourceHost ?? LOCAL_HOST_ID });
  if (!result.ok) return null;
  if (input.sourceHost !== null) return result.target;
  const { sourceHost: _omit, ...search } = result.target.search;
  const query = result.target.href.indexOf("?");
  const path = query < 0 ? result.target.href : result.target.href.slice(0, query);
  return { ...result.target, search, href: path + stringifyTopologySearch(search) };
}

/** A pushed topology destination: exact raw params, a fresh visit, and the
 *  source entry's drafts/snapshot committed first. Unrepresentable targets
 *  render as plain text with a disclosure instead of a different entity. */
export function TopologyLink({
  target,
  from,
  children,
  className,
  title,
  unavailableTitle = "This identity cannot be represented in a link.",
  ...data
}: {
  target: TopologyLinkTarget | null;
  /** The scope being left, so pending drafts commit to ITS entry. */
  from: TopologyScope | null;
  children: ReactNode;
  className?: string;
  title?: string;
  unavailableTitle?: string;
} & { [attribute: `data-${string}`]: string | boolean | undefined }) {
  const router = useRouter();
  if (!target) {
    return (
      <span className={className} title={unavailableTitle} data-link-unavailable="true" {...data}>
        {children}
      </span>
    );
  }
  return (
    <Link
      to={target.to as never}
      params={target.params as never}
      search={target.search as never}
      state={freshTopologyVisitState as never}
      onClick={(e) => {
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        prepareTopologyDrill(router, from);
      }}
      className={className}
      title={title}
      {...data}
    >
      {children}
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Source admission
// ---------------------------------------------------------------------------

export type TopologySourceAdmission =
  | { kind: "invalid"; issues: TopologyIssue[] }
  | { kind: "resolving" }
  | { kind: "unavailable"; cachedSelected: string | null; message: string }
  | { kind: "mismatch"; asserted: string; selected: string; registered: boolean }
  | { kind: "admitted"; sourceHost: string; legacy: boolean };

export function admitTopologySource(
  parsed: ParsedTopologyLocation,
  hosts: { data: HostsResponse | undefined; isError: boolean; error: unknown },
): TopologySourceAdmission {
  if (!parsed.targetValid || parsed.sourceState === "invalid") {
    return { kind: "invalid", issues: parsed.issues.filter((i) => i.blocking) };
  }
  if (hosts.isError) {
    return {
      kind: "unavailable",
      cachedSelected: hosts.data?.selected ?? null,
      message: hosts.error instanceof Error ? hosts.error.message : "host read failed",
    };
  }
  if (!hosts.data) return { kind: "resolving" };
  const selected = hosts.data.selected;
  const asserted = parsed.location.sourceHost;
  if (asserted === undefined) return { kind: "admitted", sourceHost: selected, legacy: true };
  if (asserted === selected) return { kind: "admitted", sourceHost: selected, legacy: false };
  const registered = asserted === LOCAL_HOST_ID || hosts.data.hosts.some((h) => h.id === asserted);
  return { kind: "mismatch", asserted, selected, registered };
}

const ISSUE_COPY: Record<TopologyIssue["field"], string> = {
  scope: "the rig, pod or seat identity in this address",
  sourceHost: "the source host in this address",
  view: "the requested view",
  spatialMode: "the requested 3D mode",
  spatialQuery: "the search text",
  selection: "the selected seat",
  location: "this address",
};

function issueText(issue: TopologyIssue): string {
  const what = ISSUE_COPY[issue.field];
  switch (issue.code) {
    case "duplicate": return `${what} appears more than once`;
    case "too_large": return `${what} is too long`;
    case "wrong_scope": return `${what} belongs to a different rig`;
    case "unrepresentable_path": return `${what} cannot be represented exactly`;
    default: return `${what} is not valid`;
  }
}

function GateFrame({ children, testId, state }: { children: ReactNode; testId: string; state?: string }) {
  return (
    <div className="px-6 py-6" style={{ marginLeft: "var(--header-anchor-offset, 0px)" }}>
      <div
        data-testid={testId}
        data-state={state}
        role={state === "resolving" ? "status" : "alert"}
        className="max-w-2xl border-l-2 border-on-surface bg-surface-low px-4 py-4 font-mono text-xs"
      >
        {children}
      </div>
    </div>
  );
}

const gateButton =
  "border border-outline px-3 py-1 font-mono text-[10px] uppercase tracking-wide text-on-surface hover:bg-surface-low/60 disabled:opacity-50";

/** Mounts `children` (the target body, including every target read and
 *  local action) only when the URL's source assertion is admitted. A legacy
 *  link binds once to the successfully read current host. Navigation, reload
 *  and Back never write the global host selection. */
export function TopologySourceGate({ nav, children }: { nav: TopologyNavigation; children: ReactNode }) {
  const router = useRouter();
  const hosts = useHosts();
  const selectHost = useSelectHost();
  const admission = admitTopologySource(nav.parsed, hosts);

  const bindLegacy = admission.kind === "admitted" && admission.legacy ? admission.sourceHost : null;
  useEffect(() => {
    if (bindLegacy !== null) nav.replace({ sourceHost: bindLegacy });
    // nav.replace is stable per router+scope
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bindLegacy]);

  if (admission.kind === "admitted") return <>{children}</>;

  if (admission.kind === "invalid") {
    return (
      <GateFrame testId="topology-source-gate" state="invalid">
        <div className="mb-2 text-[11px] font-bold uppercase tracking-[0.14em] text-error">This topology link can&apos;t be opened</div>
        <ul className="mb-3 list-disc pl-5 text-on-surface">
          {(admission.issues.length ? admission.issues : [{ field: "location", code: "invalid", blocking: true } as TopologyIssue]).map((issue, i) => (
            <li key={`${issue.field}-${i}`}>{issueText(issue)}.</li>
          ))}
        </ul>
        <p className="text-[10px] text-on-surface-variant">Nothing was read from any host for this address.</p>
        <TopologyLink target={topologyTarget({ scope: { kind: "host" }, sourceHost: null })} from={null} className={cn(gateButton, "mt-3 inline-block")}>
          Open topology
        </TopologyLink>
      </GateFrame>
    );
  }

  if (admission.kind === "resolving") {
    return (
      <GateFrame testId="topology-source-gate" state="resolving">
        <span className="text-on-surface-variant">
          Confirming the selected host{nav.location.sourceHost ? ` for ${nav.location.sourceHost}` : ""}…
        </span>
      </GateFrame>
    );
  }

  if (admission.kind === "unavailable") {
    return (
      <GateFrame testId="topology-source-gate" state="unavailable">
        <div className="mb-2 text-[11px] font-bold uppercase tracking-[0.14em] text-error">Selected host can&apos;t be confirmed</div>
        <p className="mb-1 text-on-surface">
          The host list could not be read ({admission.message}), so this view can&apos;t tell which host its data would come from.
        </p>
        <p className="mb-3 text-[10px] text-on-surface-variant">
          {admission.cachedSelected
            ? `Last confirmed selection: ${admission.cachedSelected} (cached — not current proof).`
            : "No host selection has been confirmed yet."}
          {nav.location.sourceHost ? ` This link is for ${nav.location.sourceHost}.` : ""}
        </p>
        <button type="button" data-testid="topology-source-retry" onClick={() => void hosts.refetch()} className={gateButton}>
          Retry
        </button>
      </GateFrame>
    );
  }

  const { asserted, selected, registered } = admission;
  const awaitingReadback = selectHost.isSuccess && selectHost.variables?.hostId === asserted;
  return (
    <GateFrame testId="topology-source-gate" state="mismatch">
      <div className="mb-2 text-[11px] font-bold uppercase tracking-[0.14em] text-on-surface">Different host</div>
      <p data-testid="topology-source-mismatch" className="mb-1 text-on-surface">
        This link is for host {asserted}; the selected host is {selected}.
      </p>
      <p className="mb-3 text-[10px] text-on-surface-variant">
        {registered
          ? "Nothing from either host is shown until you choose. Selecting a host changes it for this whole app."
          : `${asserted} is not registered on this daemon (removed or renamed), so its topology can't be shown.`}
      </p>
      {selectHost.isError ? (
        <p data-testid="topology-source-select-error" className="mb-2 text-[10px] text-error">
          Could not select {asserted}: {selectHost.error.message}
        </p>
      ) : null}
      {awaitingReadback ? (
        <p role="status" className="mb-2 text-[10px] text-on-surface-variant">Waiting for the daemon to confirm {asserted}…</p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {registered ? (
          <button
            type="button"
            data-testid="topology-source-select"
            disabled={selectHost.isPending || awaitingReadback}
            onClick={() => selectHost.mutate({ hostId: asserted })}
            className={gateButton}
          >
            {selectHost.isPending ? `Selecting ${asserted}…` : `Select ${asserted}`}
          </button>
        ) : null}
        <button
          type="button"
          data-testid="topology-source-view-selected"
          onClick={() => {
            const target = topologyTarget({ scope: { kind: "host" }, sourceHost: selected });
            if (target) navigateTopology(router, null, target);
          }}
          className={cn(gateButton, "border-outline-variant text-on-surface-variant")}
        >
          View {selected}
        </button>
      </div>
    </GateFrame>
  );
}

/** Non-blocking codec notices (invalid optional view/mode/query/selection):
 *  the scope default renders with a small disclosure instead of silently. */
export function TopologyLocationNotices({ nav, className }: { nav: TopologyNavigation; className?: string }) {
  const issues = nav.parsed.issues.filter((i) => !i.blocking);
  if (issues.length === 0) return null;
  return (
    <div
      data-testid="topology-location-notices"
      role="status"
      className={cn("font-mono text-[10px] text-on-surface-variant", className)}
    >
      {issues.map((issue, i) => (
        <div key={`${issue.field}-${i}`} data-field={issue.field}>
          Ignored: {issueText(issue)}
          {issue.field === "view" ? " — showing the default view." : issue.field === "selection" ? " — nothing is selected." : "."}
        </div>
      ))}
    </div>
  );
}
