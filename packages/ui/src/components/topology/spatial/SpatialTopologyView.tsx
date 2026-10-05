// Topology observatory — the "3D" view-mode for host / rig / pod scopes.
//
// Composition: an instrument header (scope, real counts, status tally,
// search, Scene/List switch), the spatial stage (lazy three.js renderer with
// camera HUD + legend), and a side column holding the selected-seat
// inspector over the keyboard-accessible seat index. Everything the stage
// shows is also readable without a GPU: the index and the List mode render
// the same model, and any renderer failure falls back to them.
//
// This module is itself lazy-loaded by ScopePages; the three.js renderer is a
// second lazy chunk, so neither the 3D code nor three.js touches the initial
// payload, and List mode never downloads three at all.
//
// Navigation state: Scene/List, the search text and the selected seat live in
// the URL (topology-navigation.tsx); this view reads them and emits intent.
// Only hover, the search input draft, renderer readiness and GPU failure are
// local. Camera pose, scroll offsets and focus are per-visit snapshots
// (spatial-visit-store.ts) restored once when the visit's content is ready.
// A selection names an exact graph node; when that node is filtered out,
// temporarily unreadable or gone, the intent stays and the inspector says so.

import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type ErrorInfo,
  type KeyboardEvent,
  type LazyExoticComponent,
} from "react";
import { useRouter } from "@tanstack/react-router";
import { Box, Crosshair, Expand, List as ListIcon, Minus, Plus, RotateCcw, Search, SquareDashed, X } from "lucide-react";
import { useSelectedHostId } from "../../../hooks/useHosts.js";
import { usePrefersReducedMotion } from "../../../hooks/usePrefersReducedMotion.js";
import { useShellViewport } from "../../../hooks/useShellViewport.js";
import { useSpatialTopology } from "../../../hooks/useSpatialTopology.js";
import { LOCAL_HOST_ID } from "../../../lib/host-param.js";
import {
  agentMatchesQuery,
  deriveSeatStatus,
  layoutSpatialModel,
  normalizeSpatialQuery,
  spatialKey,
  spatialScopeKey,
  tallySeatStatuses,
  type SpatialAgent,
  type SpatialScope,
  type SpatialSeatStatus,
  type SpatialTone,
} from "../../../lib/spatial-topology.js";
import { topologySelectionMatches, type TopologyScope, type TopologySelection } from "../../../lib/topology-location.js";
import {
  readTopologyVisitId,
  topologyTarget,
  useKnownSelectedHost,
  useTopologyLocation,
  useTopologyParticipant,
  TopologyLink,
  type TopologyNavigation,
} from "../topology-navigation.js";
import { cn } from "../../../lib/utils.js";
import { useTheme } from "../../ThemeProvider.js";
import { ErrorBoundary } from "../../ui/ErrorBoundary.js";
import { SpatialInspector } from "./SpatialInspector.js";
import { SpatialNodeList } from "./SpatialNodeList.js";
import { hslCss, readSpatialPalette, type SpatialPalette } from "./spatial-palette.js";
import { SPATIAL_SCENE_BUDGET, sceneBudgetVerdict, type SpatialBudgetVerdict } from "./spatial-view-math.js";
import type { SpatialCameraController, SpatialRendererFailure, SpatialRendererProps } from "./SpatialRenderer.js";
import {
  sameVisitScope,
  spatialVisitStore,
  type SpatialCameraSnapshot,
  type SpatialVisitScope,
  type SpatialVisitSnapshot,
} from "./spatial-visit-store.js";
import "./spatial.css";

type RendererComponent = ComponentType<SpatialRendererProps>;

/** Loads the renderer chunk. Injectable so tests can fail the first import. */
export type SpatialRendererLoader = () => Promise<{ default: RendererComponent }>;

const loadSpatialRenderer: SpatialRendererLoader = () => import("./SpatialRenderer.js");

/** A rejected renderer chunk import, as opposed to a renderer that loaded and
 *  then threw. Lets the fallback say which one happened. */
class SpatialRendererLoadError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "SpatialRendererLoadError";
  }
}

interface RendererSlot {
  component: LazyExoticComponent<RendererComponent>;
  importFailed: boolean;
}

// React.lazy caches its first settlement forever, including a rejection, so a
// transient chunk failure (flaky network, a deploy that replaced the chunk)
// would otherwise poison every later mount and every Retry. Each loader keeps
// one slot that is shared while its import is pending or loaded — remounts on
// scope changes and GPU-constructor retries reuse the loaded chunk without a
// loading flash — and is replaced by a fresh lazy (a real second import())
// only once its import has rejected. Nothing is imported until a scene mounts.
const rendererSlots = new WeakMap<SpatialRendererLoader, RendererSlot>();

function acquireRenderer(load: SpatialRendererLoader): LazyExoticComponent<RendererComponent> {
  const current = rendererSlots.get(load);
  if (current && !current.importFailed) return current.component;
  const slot: RendererSlot = {
    importFailed: false,
    component: lazy(() =>
      load().catch((error: unknown) => {
        slot.importFailed = true;
        throw new SpatialRendererLoadError(error);
      }),
    ),
  };
  rendererSlots.set(load, slot);
  return slot.component;
}

type SpatialViewFailure = SpatialRendererFailure | "load-error";

const FAILURE_COPY: Record<SpatialViewFailure, string> = {
  unsupported: "WebGL isn't available in this browser session, so the 3D scene can't start.",
  "context-lost": "The GPU context was lost (a driver reset or too many 3D views open at once).",
  "init-error": "The 3D renderer failed to start.",
  "load-error": "The 3D renderer's code could not be downloaded (a network error, or the app was updated since this page loaded).",
};

const LEGEND: Array<{ tone: SpatialTone; label: string }> = [
  { tone: "active", label: "running" },
  { tone: "needs_input", label: "needs input" },
  { tone: "blocked", label: "blocked" },
  { tone: "idle", label: "idle" },
  { tone: "unknown", label: "no signal" },
];

export interface SpatialTopologyViewProps {
  scope: SpatialScope;
  /** Renderer chunk loader; defaults to the real lazy import. Test seam. */
  loadRenderer?: SpatialRendererLoader;
}

/** Trailing delay before a typed search is written to the URL. Enter, mode
 *  and tab changes, drills and Back all flush or cancel it explicitly. */
export const SPATIAL_SEARCH_WRITE_MS = 150;
const SCROLL_CAPTURE_MS = 250;

function toTopologyScope(scope: SpatialScope): TopologyScope {
  return scope.kind === "host" ? { kind: "host" } : scope.kind === "rig" ? { kind: "rig", rigId: scope.rigId } : { kind: "pod", rigId: scope.rigId, podName: scope.podName };
}

/** Re-keys the stateful body on host + scope so hover, drafts, camera and
 *  fallback state never leak from one host/rig/pod into another. */
export default function SpatialTopologyView({ scope, loadRenderer = loadSpatialRenderer }: SpatialTopologyViewProps) {
  const hostId = useSelectedHostId();
  const nav = useTopologyLocation(toTopologyScope(scope));
  // Defense in depth behind the scope page's source gate: a URL asserting
  // another host never resolves its selection against this host's data.
  const asserted = nav.location.sourceHost;
  if (asserted !== undefined && asserted !== hostId) {
    return (
      <div data-testid="spatial-source-gated" role="status" className="px-6 py-10 font-mono text-[11px] text-on-surface-variant">
        This view is for host {asserted}; the selected host is {hostId}. Nothing from {hostId} is shown here.
      </div>
    );
  }
  return (
    <SpatialTopologyBody
      key={`${hostId}|${spatialScopeKey(scope)}`}
      scope={scope}
      hostId={hostId}
      nav={nav}
      loadRenderer={loadRenderer}
    />
  );
}

type SelectionView =
  | { kind: "none" }
  | { kind: "ok"; agent: SpatialAgent; outsideFilter: boolean }
  | { kind: "pending" | "unreadable" | "not-loaded" | "absent" | "not-in-inventory"; selection: TopologySelection; skipped: number };

type FocusRegion = NonNullable<SpatialVisitSnapshot["focus"]>["region"];

function scopeTitle(scope: SpatialScope, rigName: string | null): string {
  if (scope.kind === "host") return "All rigs";
  if (scope.kind === "rig") return rigName ?? scope.rigId;
  return `${rigName ?? scope.rigId} / ${scope.podName}`;
}

function SpatialTopologyBody({ scope, hostId, nav, loadRenderer }: { scope: SpatialScope; hostId: string; nav: TopologyNavigation; loadRenderer: SpatialRendererLoader }) {
  const router = useRouter();
  const data = useSpatialTopology(scope);
  const { resolved: theme } = useTheme();
  const palette = useMemo<SpatialPalette>(() => readSpatialPalette(theme), [theme]);
  const reducedMotion = usePrefersReducedMotion();
  const { isWideLayout } = useShellViewport();

  const mode = nav.location.spatialMode;
  const setMode = useCallback((next: "scene" | "list") => nav.replace({ spatialMode: next }), [nav]);
  const selection = nav.location.selection ?? null;
  const knownHost = useKnownSelectedHost();
  const linkSource = nav.location.sourceHost ?? knownHost;
  const fromScope = nav.scope;

  // --- Search: a local draft for smooth typing, written to the URL on a short
  // trailing delay. A queued write is bound to the history entry it was typed
  // in: Back/Forward (or any other entry change) cancels it so it can never
  // overwrite the entry the operator returned to.
  const urlQuery = nav.location.spatialQuery;
  const [query, setQuery] = useState(urlQuery);
  const writtenQueryRef = useRef(urlQuery);
  const pendingQueryRef = useRef<{ value: string; timer: ReturnType<typeof setTimeout>; entry: string } | null>(null);
  const cancelPendingQuery = useCallback(() => {
    if (pendingQueryRef.current) clearTimeout(pendingQueryRef.current.timer);
    pendingQueryRef.current = null;
  }, []);
  const takeQueryDraft = useCallback(() => {
    const pending = pendingQueryRef.current;
    if (!pending) return null;
    cancelPendingQuery();
    if (!sameHistoryEntry(pending.entry, historyEntryOf(router))) return null;
    writtenQueryRef.current = pending.value;
    return { spatialQuery: pending.value };
  }, [cancelPendingQuery, router]);
  useEffect(() => {
    if (urlQuery === writtenQueryRef.current) return;
    // Another writer (Back/Forward, a link, a tab change) moved the URL.
    writtenQueryRef.current = urlQuery;
    cancelPendingQuery();
    setQuery(urlQuery);
  }, [urlQuery, cancelPendingQuery]);
  useEffect(() => cancelPendingQuery, [cancelPendingQuery]);
  const editQuery = (value: string) => {
    setQuery(value);
    cancelPendingQuery();
    const timer = setTimeout(() => {
      const draft = takeQueryDraft();
      if (draft) nav.replace(draft);
    }, SPATIAL_SEARCH_WRITE_MS);
    pendingQueryRef.current = { value, timer, entry: historyEntryOf(router) };
  };
  const clearQuery = () => {
    cancelPendingQuery();
    setQuery("");
    writtenQueryRef.current = "";
    nav.replace({ spatialQuery: "" });
  };

  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const [failure, setFailure] = useState<SpatialViewFailure | null>(null);
  const [rendererEpoch, setRendererEpoch] = useState(0);
  // Re-acquired per Retry: a fresh lazy (second import) only after the import
  // itself rejected; otherwise the loaded chunk, re-keyed by rendererEpoch so
  // the GPU constructor runs again.
  const SpatialRenderer = useMemo(() => acquireRenderer(loadRenderer), [loadRenderer, rendererEpoch]);
  const [rendererReady, setRendererReady] = useState(false);
  const controllerRef = useRef<SpatialCameraController | null>(null);

  const model = data.model;
  const layout = useMemo(() => (model ? layoutSpatialModel(model) : null), [model]);
  const statusByKey = useMemo(() => {
    const map = new Map<string, SpatialSeatStatus>();
    if (model) for (const agent of model.agentsByKey.values()) map.set(agent.key, deriveSeatStatus(agent));
    return map;
  }, [model]);
  const tally = useMemo(() => (model ? tallySeatStatuses(model.agentsByKey.values()) : null), [model]);
  const budget = useMemo(() => (model ? sceneBudgetVerdict(model.counts) : null), [model]);
  const overBudget = budget !== null && !budget.withinBudget;

  const tokens = useMemo(() => normalizeSpatialQuery(query), [query]);
  const matchKeys = useMemo<ReadonlySet<string> | null>(() => {
    if (!model || tokens.length === 0) return null;
    const keys = new Set<string>();
    for (const agent of model.agentsByKey.values()) if (agentMatchesQuery(agent, tokens)) keys.add(agent.key);
    return keys;
  }, [model, tokens]);

  // Selection is exact intent from the URL. It renders as current only when
  // the current served graph contains that node; otherwise the intent stays
  // and the inspector explains why (never a same-label substitute).
  const selectionView = useMemo<SelectionView>(() => {
    if (!selection) return { kind: "none" };
    const skipped = model?.issues.filter((i) => i.rigId === selection.rigId).length ?? 0;
    const at = (kind: Exclude<SelectionView["kind"], "none" | "ok">): SelectionView => ({ kind, selection, skipped });
    if (data.status === "loading") return at("pending");
    if (data.status === "error") return at("unreadable");
    const agent = model?.agentsByKey.get(spatialKey(hostId, selection.rigId, "agent", selection.nodeId)) ?? null;
    if (agent && topologySelectionMatches(fromScope, hostId, selection, agent)) {
      return { kind: "ok", agent, outsideFilter: matchKeys !== null && !matchKeys.has(agent.key) };
    }
    if (data.rigErrors.some((e) => e.rigId === selection.rigId)) return at("unreadable");
    if (data.loadingRigIds.includes(selection.rigId)) return at("pending");
    if (model?.rigs.some((r) => r.rigId === selection.rigId)) return at("absent");
    if (scope.kind === "host" && data.truncatedRigCount > 0) return at("not-loaded");
    return at("not-in-inventory");
  }, [selection, model, data.status, data.rigErrors, data.loadingRigIds, data.truncatedRigCount, hostId, fromScope, matchKeys, scope.kind]);
  const selectedAgent = selectionView.kind === "ok" ? selectionView.agent : null;
  useEffect(() => {
    if (hoveredKey && model && !model.agentsByKey.has(hoveredKey)) setHoveredKey(null);
  }, [model, hoveredKey]);

  const setSelectedKey = useCallback((key: string | null) => {
    const agent = key ? model?.agentsByKey.get(key) ?? null : null;
    if (key && !agent) return;
    nav.replace({ selection: agent ? { rigId: agent.rigId, nodeId: agent.nodeId } : null });
  }, [model, nav]);

  const sceneActive = mode === "scene" && failure === null && !overBudget && model !== null && layout !== null && model.counts.rigs > 0;
  useEffect(() => {
    if (!sceneActive) setRendererReady(false);
  }, [sceneActive]);

  // setSelectedKey closes over the current model and navigation; without it
  // here, a rig graph arriving later would leave index clicks using an older
  // model that cannot resolve the new rig's seats.
  const selectFromIndex = useCallback((key: string) => {
    setSelectedKey(key);
    if (sceneActive) controllerRef.current?.focus(key);
  }, [sceneActive, setSelectedKey]);

  const onRendererFailure = useCallback((reason: SpatialViewFailure) => {
    controllerRef.current = null;
    setRendererReady(false);
    setFailure(reason);
  }, []);

  const onRendererError = useCallback(
    (error: Error, _info: ErrorInfo) => onRendererFailure(error instanceof SpatialRendererLoadError ? "load-error" : "init-error"),
    [onRendererFailure],
  );

  const retryRenderer = () => {
    setFailure(null);
    setRendererEpoch((n) => n + 1);
    if (mode !== "scene") setMode("scene");
  };

  const onStageKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    const c = controllerRef.current;
    if (!c) return;
    const step = Math.PI / 12;
    const handled: Record<string, () => void> = {
      ArrowLeft: () => c.orbit(-step, 0),
      ArrowRight: () => c.orbit(step, 0),
      ArrowUp: () => c.orbit(0, -step / 1.5),
      ArrowDown: () => c.orbit(0, step / 1.5),
      "+": () => c.zoom(0.8),
      "=": () => c.zoom(0.8),
      "-": () => c.zoom(1.25),
      f: () => c.fit(),
      t: () => c.preset("top"),
      i: () => c.preset("iso"),
      r: () => c.reset(),
      Escape: () => setSelectedKey(null),
    };
    const action = handled[e.key] ?? handled[e.key.toLowerCase()];
    if (!action) return;
    e.preventDefault();
    action();
  };

  const onSearchKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      clearQuery();
      return;
    }
    if (e.key === "Enter") {
      // One write: the exact typed text plus (when there is a match) the
      // first match in index order. The camera moves only for this action.
      cancelPendingQuery();
      writtenQueryRef.current = query;
      const first = matchKeys && matchKeys.size > 0 ? model?.rigs.flatMap((r) => r.agents).find((a) => matchKeys.has(a.key)) : undefined;
      nav.replace({ spatialQuery: query, ...(first ? { selection: { rigId: first.rigId, nodeId: first.nodeId } } : {}) });
      if (first && sceneActive) controllerRef.current?.focus(first.key);
    }
  };

  // --- Per-visit camera / scroll / focus ------------------------------------
  // Values are tracked in refs as they change (DOM refs are already detached
  // when an unmount cleanup runs) and written to the bounded store on settle,
  // throttled scroll, pagehide, before a drill and on unmount.
  const visitScope = useMemo<SpatialVisitScope>(
    () => (scope.kind === "host" ? { host: hostId, kind: "host" } : scope.kind === "rig" ? { host: hostId, kind: "rig", rig: scope.rigId } : { host: hostId, kind: "pod", rig: scope.rigId, pod: scope.podName }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hostId, data.scopeKey],
  );
  const savedFor = (visitId: string | null): SpatialVisitSnapshot | null => {
    const saved = visitId ? spatialVisitStore.get(visitId) : null;
    return saved && sameVisitScope(saved.scope, visitScope) ? saved : null;
  };
  const visitIdRef = useRef(nav.visitId);
  const [initialSaved] = useState(() => savedFor(nav.visitId));
  const cameraRef = useRef<SpatialCameraSnapshot | null>(initialSaved?.camera ?? null);
  const scrollRef = useRef<SpatialVisitSnapshot["scroll"]>(initialSaved?.scroll ?? { main: 0, index: 0, inspector: 0, list: 0 });
  const focusRef = useRef<SpatialVisitSnapshot["focus"]>(undefined);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const indexRegionRef = useRef<HTMLDivElement | null>(null);
  const inspectorRegionRef = useRef<HTMLDivElement | null>(null);
  const listRegionRef = useRef<HTMLDivElement | null>(null);
  const captureTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const writeSnapshot = useCallback((visitId: string | null = visitIdRef.current) => {
    if (captureTimerRef.current) clearTimeout(captureTimerRef.current);
    captureTimerRef.current = null;
    if (!visitId) return;
    spatialVisitStore.put(visitId, {
      v: 1,
      scope: visitScope,
      ...(cameraRef.current ? { camera: cameraRef.current } : {}),
      scroll: { ...scrollRef.current },
      ...(focusRef.current ? { focus: focusRef.current } : {}),
    });
  }, [visitScope]);
  const scheduleSnapshot = useCallback(() => {
    if (captureTimerRef.current) return;
    captureTimerRef.current = setTimeout(() => writeSnapshot(), SCROLL_CAPTURE_MS);
  }, [writeSnapshot]);
  const onRegionScroll = (region: "index" | "inspector" | "list") => (e: React.UIEvent<HTMLElement>) => {
    scrollRef.current = { ...scrollRef.current, [region]: e.currentTarget.scrollTop };
    scheduleSnapshot();
  };
  const onCameraSettle = useCallback((snapshot: SpatialCameraSnapshot) => {
    cameraRef.current = snapshot;
    scheduleSnapshot();
  }, [scheduleSnapshot]);

  useTopologyParticipant({
    takeDraft: takeQueryDraft,
    capture: () => writeSnapshot(),
  });

  // Page scroll (AppShell's <main> scrolls, not window), focus tracking,
  // pagehide and unmount capture.
  useEffect(() => {
    const root = rootRef.current;
    const main = root?.closest<HTMLElement>("[data-testid='content-area']") ?? null;
    const onMainScroll = () => {
      if (main) scrollRef.current = { ...scrollRef.current, main: main.scrollTop };
      scheduleSnapshot();
    };
    const onFocusIn = (e: FocusEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      let region: FocusRegion | null = null;
      if (target === searchRef.current) region = "search";
      else if (target === stageRef.current) region = "stage";
      else if (inspectorRegionRef.current?.contains(target)) region = "inspector";
      else if (indexRegionRef.current?.contains(target) || listRegionRef.current?.contains(target)) region = "index";
      if (!region) return;
      const node = region === "index" ? target.getAttribute("data-spatial-key") ?? undefined : undefined;
      focusRef.current = node ? { region, node } : { region };
    };
    const onPageHide = () => writeSnapshot();
    main?.addEventListener("scroll", onMainScroll, { passive: true });
    root?.addEventListener("focusin", onFocusIn);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      main?.removeEventListener("scroll", onMainScroll);
      root?.removeEventListener("focusin", onFocusIn);
      window.removeEventListener("pagehide", onPageHide);
      writeSnapshot();
    };
  }, [scheduleSnapshot, writeSnapshot]);

  // Restore once per visit, after the URL selection resolved and the current
  // model's containers exist. Missing snapshot = a normal fitted start.
  const modelReady = data.status === "ready" && model !== null && model.counts.rigs > 0;
  const restoredVisitRef = useRef<string | null>(null);
  // Set when this body (reused across same-scope history entries) moved to
  // another visit: the destination's regions start from its own snapshot, or
  // from the top when it has none, never from the departing visit's offsets.
  const reusedVisitRef = useRef(false);
  useEffect(() => {
    const previous = visitIdRef.current;
    const current = nav.visitId;
    if (previous !== current) {
      visitIdRef.current = current;
      if (previous !== null) {
        // Same-scope Back/Forward or a pushed same-scope visit reuses this
        // body and its renderer. Store the departing visit (its live pose
        // included) under ITS id, then adopt the destination's saved state,
        // or a fresh fitted start when it has none.
        const departing = controllerRef.current?.snapshot() ?? null;
        if (departing) cameraRef.current = departing;
        writeSnapshot(previous);
        const saved = savedFor(current);
        focusRef.current = undefined;
        scrollRef.current = saved?.scroll ?? { main: 0, index: 0, inspector: 0, list: 0 };
        if (saved?.camera && (!controllerRef.current || controllerRef.current.restore(saved.camera))) {
          cameraRef.current = saved.camera;
        } else {
          // No (usable) destination pose: Reset hands the reused camera back
          // to auto-fit, and a later renderer mount must not inherit it.
          cameraRef.current = null;
          controllerRef.current?.reset();
        }
        reusedVisitRef.current = true;
        restoredVisitRef.current = null;
      } else {
        // The current entry just received its id: same visit, nothing to restore.
        restoredVisitRef.current = current;
        writeSnapshot(current);
      }
    }
    if (!modelReady || current === null || restoredVisitRef.current === current) return;
    restoredVisitRef.current = current;
    const reused = reusedVisitRef.current;
    reusedVisitRef.current = false;
    const saved = savedFor(current);
    if (!saved && !reused) return;
    // Zero is a real position: a reused container is actively set to the
    // saved (or fresh-visit top) offset, clamped to its current extent.
    const restoreScroll = (el: HTMLElement | null | undefined, top: number) => {
      if (!el || !Number.isFinite(top) || top < 0) return;
      el.scrollTop = Math.min(top, Math.max(0, el.scrollHeight - el.clientHeight));
    };
    const scroll = saved?.scroll ?? { main: 0, index: 0, inspector: 0, list: 0 };
    restoreScroll(indexRegionRef.current, scroll.index);
    restoreScroll(inspectorRegionRef.current, scroll.inspector);
    restoreScroll(listRegionRef.current, scroll.list);
    // A fresh pushed visit leaves the page scroller to the router's own
    // entry-change scroll handling; a saved visit restores it explicitly.
    if (saved) restoreScroll(rootRef.current?.closest<HTMLElement>("[data-testid='content-area']"), scroll.main);
    // Focus only when nothing else holds it, and without scrolling it again.
    const active = document.activeElement;
    if (saved?.focus && (!active || active === document.body)) {
      let target: HTMLElement | null = null;
      if (saved.focus.region === "search") target = searchRef.current;
      else if (saved.focus.region === "stage") target = stageRef.current;
      else if (saved.focus.region === "inspector") {
        const region = inspectorRegionRef.current;
        target = region?.querySelector<HTMLElement>("[data-testid='spatial-open-seat']") ?? region?.querySelector<HTMLElement>("a, button") ?? null;
      } else {
        const rows = Array.from((listRegionRef.current ?? indexRegionRef.current)?.querySelectorAll<HTMLElement>("[data-spatial-agent-row]") ?? []);
        target = rows.find((row) => row.getAttribute("data-spatial-key") === saved.focus?.node) ?? null;
      }
      target?.focus({ preventScroll: true });
    }
    // savedFor reads the store; visitScope is folded into writeSnapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nav.visitId, modelReady, writeSnapshot]);

  const isRemote = hostId !== LOCAL_HOST_ID;
  const rigName = scope.kind !== "host" ? model?.rigs[0]?.rigName ?? null : null;
  const counts = model?.counts;

  return (
    <div
      ref={rootRef}
      data-testid="spatial-topology-view"
      data-scope={data.scopeKey}
      className="spatial-frame flex min-h-0 flex-1 flex-col px-4 pb-4 pt-3 lg:px-6"
    >
      {/* Instrument header */}
      <div className="flex flex-wrap items-end gap-x-6 gap-y-3 border-b border-on-surface pb-3">
        <div className="min-w-0">
          <div className="font-mono text-[9px] uppercase tracking-[0.2em] text-on-surface-variant">
            Spatial topology · {scope.kind}
            {isRemote ? <span data-testid="spatial-remote-host"> · host {hostId} · read-only</span> : null}
          </div>
          <div className="mt-0.5 truncate font-headline text-lg font-bold tracking-tight text-on-surface">
            {scopeTitle(scope, rigName)}
          </div>
          {counts ? (
            <div data-testid="spatial-counts" className="mt-0.5 font-mono text-[10px] text-on-surface-variant">
              {counts.rigs} rig{counts.rigs === 1 ? "" : "s"} · {counts.pods} pod{counts.pods === 1 ? "" : "s"} ·{" "}
              {counts.agents} seat{counts.agents === 1 ? "" : "s"} · {counts.edges} link{counts.edges === 1 ? "" : "s"}
            </div>
          ) : null}
        </div>

        {tally && counts && counts.agents > 0 ? (
          <dl data-testid="spatial-tally" className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[10px]">
            {(["active", "needs_input", "blocked", "idle"] as const).map((tone) => (
              <div key={tone} className="flex items-center gap-1.5">
                <span aria-hidden="true" className="spatial-dot" style={{ "--spatial-tone": hslCss(palette.tones[tone]) } as React.CSSProperties} />
                <dt className="text-on-surface-variant">{LEGEND.find((l) => l.tone === tone)?.label}</dt>
                <dd className="text-on-surface">{tally[tone]}</dd>
              </div>
            ))}
            {tally.stale > 0 ? (
              <div className="flex items-center gap-1.5">
                <span aria-hidden="true" className="spatial-dot is-stale" style={{ "--spatial-tone": hslCss(palette.inkMuted) } as React.CSSProperties} />
                <dt className="text-on-surface-variant">stale sample</dt>
                <dd className="text-on-surface">{tally.stale}</dd>
              </div>
            ) : null}
            {tally.problems > 0 ? (
              <div className="flex items-center gap-1.5 text-tertiary">
                <dt>attention</dt>
                <dd>{tally.problems}</dd>
              </div>
            ) : null}
          </dl>
        ) : null}

        <div className="ml-auto flex w-full min-w-0 flex-wrap items-center gap-2 sm:w-auto">
          <label className="flex h-8 min-w-0 flex-1 items-center gap-2 border border-outline-variant bg-background px-2 focus-within:border-on-surface sm:w-64 sm:flex-none">
            <Search aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-on-surface-variant" />
            <span className="sr-only">Search seats</span>
            <input
              ref={searchRef}
              data-testid="spatial-search"
              type="search"
              value={query}
              onChange={(e) => editQuery(e.target.value)}
              onKeyDown={onSearchKeyDown}
              placeholder="Search seats, pods, runtimes…"
              className="min-w-0 flex-1 bg-transparent font-mono text-[11px] text-on-surface outline-none placeholder:text-on-surface-variant"
            />
            {query ? (
              <button type="button" aria-label="Clear search" onClick={clearQuery} className="text-on-surface-variant hover:text-on-surface">
                <X aria-hidden="true" className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </label>
          <div role="group" aria-label="Spatial view mode" className="flex">
            <button
              type="button"
              data-testid="spatial-mode-scene"
              aria-pressed={mode === "scene"}
              onClick={() => (failure ? retryRenderer() : setMode("scene"))}
              className="spatial-hud-button"
            >
              <Box aria-hidden="true" className="h-3.5 w-3.5" /> Scene
            </button>
            <button
              type="button"
              data-testid="spatial-mode-list"
              aria-pressed={mode === "list"}
              onClick={() => setMode("list")}
              className="spatial-hud-button -ml-px"
            >
              <ListIcon aria-hidden="true" className="h-3.5 w-3.5" /> List
            </button>
          </div>
        </div>
      </div>

      <SpatialNotices data={data} />

      {data.status === "loading" ? (
        <div data-testid="spatial-loading" role="status" className="flex flex-1 items-center justify-center py-16 font-mono text-[11px] text-on-surface-variant">
          Reading rig graphs{isRemote ? ` from ${hostId}` : ""}…
        </div>
      ) : data.status === "error" ? (
        <div data-testid="spatial-error" role="alert" className="my-6 max-w-xl border-l-2 border-error bg-surface-low px-4 py-3 font-mono text-[11px]">
          <div className="font-bold uppercase tracking-[0.14em] text-error">Topology unavailable</div>
          <p className="mt-1 text-on-surface">The graph could not be read: {data.errorMessage ?? "unknown error"}.</p>
          <button type="button" onClick={data.refetch} className="spatial-hud-button mt-3">Retry</button>
        </div>
      ) : data.podMissing ? (
        <div data-testid="spatial-pod-missing" className="py-12 text-center font-mono text-[11px] text-on-surface-variant">
          Pod “{scope.kind === "pod" ? scope.podName : ""}” is not in this rig&apos;s current graph.
        </div>
      ) : !model || model.counts.rigs === 0 ? (
        <div data-testid="spatial-empty" className="py-12 text-center font-mono text-[11px] text-on-surface-variant">
          No rigs on this host yet. Run <code className="text-on-surface">rig up</code> to start one.
        </div>
      ) : (
        <div
          data-testid="spatial-body"
          data-layout={isWideLayout ? "bounded" : "stacked"}
          className={cn("mt-3", isWideLayout && "relative min-h-[20rem] min-w-0 flex-1")}
        >
          {/* Wide: the body takes exactly the page height left under the
              header (flex-1 of the frame) and the grid is positioned inside it
              out of flow, so the seat index can never grow the page. The
              AppShell route wrapper sizes to its content (it has no min-h-0),
              so an in-flow grid's intrinsic height — the full index — would
              otherwise stretch the stage far below the fold. The 20rem floor
              only applies on very short windows; the page then scrolls.
              Narrow: stage, inspector and index stack and the page scrolls. */}
          <div
            data-testid="spatial-grid"
            className={cn(
              "grid gap-0 border border-outline-variant",
              isWideLayout
                ? "absolute inset-0 grid-cols-[minmax(0,1fr)_20rem] grid-rows-[minmax(0,1fr)] 2xl:grid-cols-[minmax(0,1fr)_22rem]"
                : "grid-cols-1",
            )}
          >
            {mode === "scene" ? (
              <div
                ref={stageRef}
                data-testid="spatial-stage"
                tabIndex={0}
                role="group"
                aria-roledescription="3D topology scene"
                aria-label={`3D topology: ${model.counts.rigs} rigs, ${model.counts.pods} pods, ${model.counts.agents} seats, ${model.counts.edges} links. Arrow keys orbit, plus and minus zoom, F fits, T top view, I isometric, R resets. Use the seat index to select seats.`}
                onKeyDown={onStageKeyDown}
                className={cn(
                  "spatial-stage relative min-h-0 min-w-0 overflow-hidden",
                  !isWideLayout && "h-[56vh] min-h-[18rem]",
                )}
              >
                {overBudget && budget ? (
                  <SpatialBudgetNotice budget={budget} scopeKind={scope.kind} onList={() => setMode("list")} />
                ) : failure ? (
                  <SpatialFallback failure={failure} onRetry={retryRenderer} onList={() => setMode("list")} />
                ) : (
                  <ErrorBoundary
                    label="3D renderer"
                    onError={onRendererError}
                    fallback={<SpatialFallback failure="init-error" onRetry={retryRenderer} onList={() => setMode("list")} />}
                  >
                    <Suspense
                      fallback={
                        <div data-testid="spatial-renderer-loading" role="status" className="absolute inset-0 flex items-center justify-center font-mono text-[11px] text-on-surface-variant">
                          Loading 3D renderer…
                        </div>
                      }
                    >
                      {layout ? (
                        <SpatialRenderer
                          key={rendererEpoch}
                          model={model}
                          layout={layout}
                          palette={palette}
                          selectedKey={selectedAgent?.key ?? null}
                          hoveredKey={hoveredKey}
                          matchKeys={matchKeys}
                          reducedMotion={reducedMotion}
                          controllerRef={controllerRef}
                          onSelect={setSelectedKey}
                          onHover={setHoveredKey}
                          onFailure={onRendererFailure}
                          onReady={() => setRendererReady(true)}
                          initialCamera={cameraRef.current}
                          onCameraSettle={onCameraSettle}
                        />
                      ) : null}
                    </Suspense>
                  </ErrorBoundary>
                )}
                {!failure && !overBudget ? (
                  <>
                    <CameraHud controllerRef={controllerRef} ready={rendererReady} />
                    <Legend palette={palette} />
                    {isWideLayout ? (
                      <div aria-hidden="true" className="pointer-events-none absolute bottom-3 right-3 z-10 font-mono text-[9px] text-on-surface-variant">
                        drag orbit · right-drag pan · scroll zoom · double-click focus
                      </div>
                    ) : null}
                  </>
                ) : null}
              </div>
            ) : (
              <div
                ref={listRegionRef}
                onScroll={onRegionScroll("list")}
                data-testid="spatial-list-mode"
                className={cn("min-h-0 min-w-0 overflow-auto", isWideLayout ? "border-r border-outline-variant" : "border-b border-outline-variant")}
              >
                <SpatialNodeList
                  model={model}
                  statusByKey={statusByKey}
                  palette={palette}
                  selectedKey={selectedAgent?.key ?? null}
                  matchKeys={matchKeys}
                  variant="table"
                  onSelect={setSelectedKey}
                  onHover={setHoveredKey}
                  linkSource={linkSource}
                  from={fromScope}
                  spatialMode={mode}
                />
              </div>
            )}

            <aside
              aria-label="Seat inspector and index"
              data-testid="spatial-side"
              className={cn(
                "flex min-h-0 min-w-0 flex-col bg-surface-lowest",
                isWideLayout ? "border-l border-outline-variant" : "border-t border-outline-variant",
              )}
            >
              {/* Wide: inspector and index scroll independently inside the
                  bounded column. The inspector keeps at most 55% of it while
                  the index is shown, so a long inspector never hides the index
                  and selecting a deep row never scrolls the inspector away. */}
              <div
                ref={inspectorRegionRef}
                onScroll={onRegionScroll("inspector")}
                data-testid="spatial-inspector-region"
                className={cn(
                  "border-b border-outline-variant",
                  isWideLayout
                    ? mode === "scene"
                      ? "max-h-[55%] shrink-0 overflow-auto"
                      : "min-h-0 flex-1 overflow-auto"
                    : "shrink-0",
                )}
              >
                {selectionView.kind === "ok" && selectionView.outsideFilter ? (
                  <div
                    data-testid="spatial-selection-outside-filter"
                    role="status"
                    className="flex items-center justify-between gap-2 border-b border-outline-variant px-4 py-2 font-mono text-[10px] text-on-surface-variant"
                  >
                    <span>Selected seat is outside the filter.</span>
                    <button type="button" onClick={clearQuery} className="underline hover:text-on-surface">Clear search</button>
                  </div>
                ) : null}
                {selectionView.kind === "none" || selectionView.kind === "ok" ? (
                  <SpatialInspector
                    model={model}
                    agent={selectedAgent}
                    status={selectedAgent ? statusByKey.get(selectedAgent.key) ?? null : null}
                    palette={palette}
                    canFocus={sceneActive && rendererReady}
                    onSelect={selectFromIndex}
                    onFocus={(key) => controllerRef.current?.focus(key)}
                    linkSource={linkSource}
                    from={fromScope}
                  />
                ) : (
                  <SelectionNotice
                    view={selectionView}
                    hostLabel={hostId}
                    from={fromScope}
                    linkSource={linkSource}
                    mode={mode}
                    onClear={() => setSelectedKey(null)}
                    onRetry={data.refetch}
                  />
                )}
              </div>
              {mode === "scene" ? (
                <div
                  ref={indexRegionRef}
                  onScroll={onRegionScroll("index")}
                  data-testid="spatial-index-region"
                  className={cn("min-h-0 overflow-auto", isWideLayout ? "flex-1" : "max-h-[70vh]")}
                >
                  <div className="sticky top-0 z-10 border-b border-outline-variant bg-surface-lowest px-3 py-2 font-mono text-[9px] uppercase tracking-[0.16em] text-on-surface-variant">
                    Seat index
                  </div>
                  <SpatialNodeList
                    model={model}
                    statusByKey={statusByKey}
                    palette={palette}
                    selectedKey={selectedAgent?.key ?? null}
                    matchKeys={matchKeys}
                    variant="compact"
                    onSelect={selectFromIndex}
                    onHover={setHoveredKey}
                    linkSource={linkSource}
                    from={fromScope}
                    spatialMode={mode}
                  />
                </div>
              ) : null}
            </aside>
          </div>
        </div>
      )}
    </div>
  );
}

const SELECTION_COPY: Record<Exclude<SelectionView["kind"], "none" | "ok">, (rig: string, node: string) => string> = {
  pending: (rig) => `Reading rig ${rig}'s graph…`,
  unreadable: (rig) => `Selection unavailable while rig ${rig}'s graph cannot be read.`,
  "not-loaded": (rig) => `Rig ${rig} is not loaded in this host view (it is beyond the rigs read here). Open the rig to see it.`,
  absent: (rig, node) => `Graph node ${node} is not in rig ${rig}'s current graph.`,
  "not-in-inventory": (rig) => `Rig ${rig} is not in this host's current inventory.`,
};

/** The selection named in the URL that is not (currently) a served node.
 *  The intent stays in the URL; nothing cached is shown as current. */
function SelectionNotice({
  view,
  hostLabel,
  from,
  linkSource,
  mode,
  onClear,
  onRetry,
}: {
  view: Extract<SelectionView, { selection: TopologySelection }>;
  hostLabel: string;
  from: TopologyScope;
  linkSource: string | null;
  mode: "scene" | "list";
  onClear: () => void;
  onRetry: () => void;
}) {
  const { rigId, nodeId } = view.selection;
  const rigTarget = view.kind === "not-loaded"
    ? topologyTarget({ scope: { kind: "rig", rigId }, sourceHost: linkSource, view: "spatial", spatialMode: mode })
    : null;
  return (
    <section data-testid="spatial-selection-notice" data-state={view.kind} aria-label="Selected seat" className="px-4 py-4">
      <div className="font-mono text-[9px] uppercase tracking-[0.16em] text-on-surface-variant">Selected seat · {hostLabel}</div>
      <p className="mt-2 break-words font-mono text-[11px] leading-relaxed text-on-surface" role={view.kind === "pending" ? "status" : undefined}>
        {SELECTION_COPY[view.kind](rigId, nodeId)}
      </p>
      {view.kind === "absent" && view.skipped > 0 ? (
        <p className="mt-1 font-mono text-[10px] text-on-surface-variant">
          {view.skipped} malformed entr{view.skipped === 1 ? "y was" : "ies were"} skipped in that graph.
        </p>
      ) : null}
      <p className="mt-1 break-all font-mono text-[10px] text-on-surface-variant">rig {rigId} · node {nodeId}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {view.kind === "unreadable" ? (
          <button type="button" onClick={onRetry} className="spatial-hud-button !h-8 !px-3">Retry</button>
        ) : null}
        {rigTarget ? (
          <TopologyLink target={rigTarget} from={from} className="spatial-hud-button !h-8 !px-3">Open rig</TopologyLink>
        ) : null}
        <button type="button" data-testid="spatial-selection-clear" onClick={onClear} className="spatial-hud-button !h-8 !px-3">
          Clear selection
        </button>
      </div>
    </section>
  );
}

/** The history entry a draft was typed in: stack position + visit id. */
function historyEntryOf(router: ReturnType<typeof useRouter>): string {
  return `${String(router.history.location.state.__TSR_index)}|${readTopologyVisitId(router.history.location.state) ?? ""}`;
}

/** An id assigned to the same entry after typing began is still that entry. */
function sameHistoryEntry(typedIn: string, now: string): boolean {
  if (typedIn === now) return true;
  const [typedIndex, typedVisit] = typedIn.split("|");
  const [nowIndex] = now.split("|");
  return typedVisit === "" && typedIndex === nowIndex;
}

function SpatialNotices({ data }: { data: ReturnType<typeof useSpatialTopology> }) {
  const issues = data.model?.issues ?? [];
  if (data.rigErrors.length === 0 && data.loadingRigIds.length === 0 && data.truncatedRigCount === 0 && issues.length === 0) {
    return null;
  }
  return (
    <div data-testid="spatial-notices" className="mt-2 space-y-1 font-mono text-[10px] text-on-surface-variant">
      {data.loadingRigIds.length > 0 && data.status === "ready" ? (
        <div role="status">Still reading {data.loadingRigIds.length} rig graph{data.loadingRigIds.length === 1 ? "" : "s"}…</div>
      ) : null}
      {data.rigErrors.length > 0 ? (
        <div data-testid="spatial-rig-errors" role="alert" className="text-error">
          {data.rigErrors.length} rig graph{data.rigErrors.length === 1 ? "" : "s"} unavailable:{" "}
          {data.rigErrors.map((e) => `${e.rigName} (${e.message})`).join(", ")}.{" "}
          <button type="button" onClick={data.refetch} className="underline">Retry</button>
        </div>
      ) : null}
      {data.truncatedRigCount > 0 ? (
        <div data-testid="spatial-truncated">
          Showing the first {data.model?.counts.rigs ?? 0} rigs; {data.truncatedRigCount} more are not loaded here. Open a rig for its full view.
        </div>
      ) : null}
      {issues.length > 0 ? (
        <details data-testid="spatial-issues">
          <summary className="cursor-pointer">
            {issues.length} graph entr{issues.length === 1 ? "y" : "ies"} skipped (malformed or dangling)
          </summary>
          <ul className="mt-1 list-disc pl-5">
            {issues.slice(0, 12).map((issue, i) => (
              <li key={`${issue.rigId}-${i}`}>{issue.detail}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

function SpatialBudgetNotice({ budget, scopeKind, onList }: { budget: SpatialBudgetVerdict; scopeKind: SpatialScope["kind"]; onList: () => void }) {
  return (
    <div data-testid="spatial-budget" role="status" className="absolute inset-0 flex items-center justify-center p-6">
      <div className="max-w-md border-l-2 border-on-surface bg-background/90 px-4 py-3 font-mono text-[11px]">
        <div className="font-bold uppercase tracking-[0.14em] text-on-surface">Too large for one 3D scene</div>
        <p className="mt-1 text-on-surface">
          {budget.seats} seats and {budget.links} links exceed the scene budget of {SPATIAL_SCENE_BUDGET.seats} seats /{" "}
          {SPATIAL_SCENE_BUDGET.links} links, so the scene is not drawn here.
        </p>
        <p className="mt-1 text-on-surface-variant">
          Nothing is omitted: every seat is in the index, search covers all of them, and selecting one opens its inspector.
          {scopeKind === "host" ? " Open a rig from the index for its own 3D scene." : ""}
        </p>
        <div className="mt-3 flex gap-2">
          <button type="button" onClick={onList} className="spatial-hud-button">
            <ListIcon aria-hidden="true" className="h-3.5 w-3.5" /> List view
          </button>
        </div>
      </div>
    </div>
  );
}

function SpatialFallback({ failure, onRetry, onList }: { failure: SpatialViewFailure; onRetry: () => void; onList: () => void }) {
  return (
    <div data-testid="spatial-fallback" data-failure={failure} role="alert" className="absolute inset-0 flex items-center justify-center p-6">
      <div className="max-w-md border-l-2 border-on-surface bg-background/90 px-4 py-3 font-mono text-[11px]">
        <div className="font-bold uppercase tracking-[0.14em] text-on-surface">3D view unavailable</div>
        <p className="mt-1 text-on-surface">{FAILURE_COPY[failure]}</p>
        <p className="mt-1 text-on-surface-variant">The seat index lists the same topology and stays fully usable.</p>
        <div className="mt-3 flex gap-2">
          <button type="button" data-testid="spatial-retry-renderer" onClick={onRetry} className="spatial-hud-button">
            <RotateCcw aria-hidden="true" className="h-3.5 w-3.5" /> Retry 3D
          </button>
          <button type="button" onClick={onList} className="spatial-hud-button">
            <ListIcon aria-hidden="true" className="h-3.5 w-3.5" /> List view
          </button>
        </div>
      </div>
    </div>
  );
}

function CameraHud({ controllerRef, ready }: { controllerRef: React.MutableRefObject<SpatialCameraController | null>; ready: boolean }) {
  const run = (fn: (c: SpatialCameraController) => void) => () => {
    const c = controllerRef.current;
    if (c) fn(c);
  };
  const buttons: Array<{ id: string; label: string; icon: React.ReactNode; onClick: () => void }> = [
    { id: "fit", label: "Fit topology", icon: <Expand aria-hidden="true" className="h-3.5 w-3.5" />, onClick: run((c) => c.fit()) },
    { id: "iso", label: "Isometric view", icon: <Box aria-hidden="true" className="h-3.5 w-3.5" />, onClick: run((c) => c.preset("iso")) },
    { id: "top", label: "Top view", icon: <SquareDashed aria-hidden="true" className="h-3.5 w-3.5" />, onClick: run((c) => c.preset("top")) },
    { id: "zoom-in", label: "Zoom in", icon: <Plus aria-hidden="true" className="h-3.5 w-3.5" />, onClick: run((c) => c.zoom(0.8)) },
    { id: "zoom-out", label: "Zoom out", icon: <Minus aria-hidden="true" className="h-3.5 w-3.5" />, onClick: run((c) => c.zoom(1.25)) },
    { id: "reset", label: "Reset camera", icon: <Crosshair aria-hidden="true" className="h-3.5 w-3.5" />, onClick: run((c) => c.reset()) },
  ];
  return (
    <div role="toolbar" aria-label="Camera" data-testid="spatial-camera-hud" data-spatial-occluder="" className="absolute right-3 top-3 z-10 flex flex-col">
      {buttons.map((b, i) => (
        <button
          key={b.id}
          type="button"
          data-testid={`spatial-camera-${b.id}`}
          aria-label={b.label}
          title={b.label}
          disabled={!ready}
          onClick={b.onClick}
          className={cn("spatial-hud-button !w-8 !px-0", i > 0 && "-mt-px")}
        >
          {b.icon}
        </button>
      ))}
    </div>
  );
}

function Legend({ palette }: { palette: SpatialPalette }) {
  return (
    <div
      data-testid="spatial-legend"
      data-spatial-occluder=""
      className="absolute bottom-3 left-3 z-10 border border-outline-variant bg-background/85 px-2.5 py-2 font-mono text-[9px] text-on-surface-variant backdrop-blur-sm"
    >
      <div className="mb-1 uppercase tracking-[0.16em]">Legend</div>
      <ul className="grid grid-cols-2 gap-x-3 gap-y-0.5">
        {LEGEND.map((item) => (
          <li key={item.tone} className="flex items-center gap-1.5">
            <span aria-hidden="true" className="spatial-dot" style={{ "--spatial-tone": hslCss(palette.tones[item.tone]) } as React.CSSProperties} />
            {item.label}
          </li>
        ))}
        <li className="flex items-center gap-1.5">
          <span aria-hidden="true" className="spatial-dot is-stale" style={{ "--spatial-tone": hslCss(palette.inkMuted) } as React.CSSProperties} />
          stale sample
        </li>
      </ul>
      <div className="mt-1 border-t border-outline-variant pt-1">raised platform = pod · dashed link = cross-pod</div>
    </div>
  );
}
