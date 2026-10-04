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
  spatialScopeKey,
  tallySeatStatuses,
  type SpatialScope,
  type SpatialSeatStatus,
  type SpatialTone,
} from "../../../lib/spatial-topology.js";
import { cn } from "../../../lib/utils.js";
import { useTheme } from "../../ThemeProvider.js";
import { ErrorBoundary } from "../../ui/ErrorBoundary.js";
import { SpatialInspector } from "./SpatialInspector.js";
import { SpatialNodeList } from "./SpatialNodeList.js";
import { hslCss, readSpatialPalette, type SpatialPalette } from "./spatial-palette.js";
import { SPATIAL_SCENE_BUDGET, sceneBudgetVerdict, type SpatialBudgetVerdict } from "./spatial-view-math.js";
import type { SpatialCameraController, SpatialRendererFailure, SpatialRendererProps } from "./SpatialRenderer.js";
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

/** Re-keys the stateful body on host + scope so selection, search, camera and
 *  fallback state never leak from one host/rig/pod into another. */
export default function SpatialTopologyView({ scope, loadRenderer = loadSpatialRenderer }: SpatialTopologyViewProps) {
  const hostId = useSelectedHostId();
  return (
    <SpatialTopologyBody
      key={`${hostId}|${spatialScopeKey(scope)}`}
      scope={scope}
      hostId={hostId}
      loadRenderer={loadRenderer}
    />
  );
}

function scopeTitle(scope: SpatialScope, rigName: string | null): string {
  if (scope.kind === "host") return "All rigs";
  if (scope.kind === "rig") return rigName ?? scope.rigId;
  return `${rigName ?? scope.rigId} / ${scope.podName}`;
}

function SpatialTopologyBody({ scope, hostId, loadRenderer }: { scope: SpatialScope; hostId: string; loadRenderer: SpatialRendererLoader }) {
  const data = useSpatialTopology(scope);
  const { resolved: theme } = useTheme();
  const palette = useMemo<SpatialPalette>(() => readSpatialPalette(theme), [theme]);
  const reducedMotion = usePrefersReducedMotion();
  const { isWideLayout } = useShellViewport();

  const [mode, setMode] = useState<"scene" | "list">("scene");
  const [query, setQuery] = useState("");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
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

  // Selection follows current data: a seat that vanished on refresh drops out.
  const selectedAgent = selectedKey && model ? model.agentsByKey.get(selectedKey) ?? null : null;
  useEffect(() => {
    if (selectedKey && model && !model.agentsByKey.has(selectedKey)) setSelectedKey(null);
    if (hoveredKey && model && !model.agentsByKey.has(hoveredKey)) setHoveredKey(null);
  }, [model, selectedKey, hoveredKey]);

  const sceneActive = mode === "scene" && failure === null && !overBudget && model !== null && layout !== null && model.counts.rigs > 0;
  useEffect(() => {
    if (!sceneActive) setRendererReady(false);
  }, [sceneActive]);

  const selectFromIndex = useCallback((key: string) => {
    setSelectedKey(key);
    if (sceneActive) controllerRef.current?.focus(key);
  }, [sceneActive]);

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
    setMode("scene");
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
      setQuery("");
      return;
    }
    if (e.key === "Enter" && matchKeys && matchKeys.size > 0) {
      const first = model?.rigs.flatMap((r) => r.agents).find((a) => matchKeys.has(a.key));
      if (first) selectFromIndex(first.key);
    }
  };

  const isRemote = hostId !== LOCAL_HOST_ID;
  const rigName = scope.kind !== "host" ? model?.rigs[0]?.rigName ?? null : null;
  const counts = model?.counts;

  return (
    <div
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
              data-testid="spatial-search"
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onSearchKeyDown}
              placeholder="Search seats, pods, runtimes…"
              className="min-w-0 flex-1 bg-transparent font-mono text-[11px] text-on-surface outline-none placeholder:text-on-surface-variant"
            />
            {query ? (
              <button type="button" aria-label="Clear search" onClick={() => setQuery("")} className="text-on-surface-variant hover:text-on-surface">
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
                <SpatialInspector
                  model={model}
                  agent={selectedAgent}
                  status={selectedAgent ? statusByKey.get(selectedAgent.key) ?? null : null}
                  palette={palette}
                  canFocus={sceneActive && rendererReady}
                  onSelect={selectFromIndex}
                  onFocus={(key) => controllerRef.current?.focus(key)}
                />
              </div>
              {mode === "scene" ? (
                <div
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
