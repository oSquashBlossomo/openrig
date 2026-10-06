// Terminal view catalog and passive daemon preview. Open submits the exact
// preview fingerprint so changed membership or layout requires another preview.
// The daemon owns attachability, read-only policy, paging and provider geometry.

import { useEffect, useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Terminal, ChevronDown, Bookmark, Layers, GitBranch, Server, Eye, Plus } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "../ui/dialog.js";
import { StatusPip } from "../ui/status-pip.js";
import { cn } from "../../lib/utils.js";
import { withHostParam } from "../../lib/host-param.js";
import { useHostSelection, useSelectedHostId } from "../../hooks/useHosts.js";
import { useNodeInventory, type NodeInventoryEntry } from "../../hooks/useNodeInventory.js";
import { useSlices } from "../../hooks/useSlices.js";
import { useTerminalViews } from "../../hooks/useTerminalViews.js";
import { useTerminalPreview, type TerminalPreviewDto } from "../../hooks/useTerminalPreview.js";
import { terminalAuthHeaders } from "../mission-control/missionControlAuth.js";

type ProviderId = "herdr" | "cmux";

export interface Seat {
  session: string;
  activity: "active" | "idle";
}

export type ViewKind = "rig" | "pod" | "mission" | "slice" | "saved";

export interface LauncherView {
  id: string;
  kind: ViewKind;
  label: string;
  sub: string;
  /** Catalog membership only. Readiness is resolved by the daemon preview. */
  seats: Seat[] | null;
  /** spans another rig / all-read-only ⇒ read-only by construction (tmux attach -r). */
  crossRig?: boolean;
}

// ── The one shared open-result shape (mirrors the daemon OpenViewResult) ──
export interface OpenViewResult {
  provider: string;
  ok: boolean;
  opened: string[];
  absent: { seat: string; host: string | null; reason: string }[];
  degraded: { seat: string; host: string; reason: string }[];
  pages: number;
  error?: string;
  code?: string;
}

/**
 * PURE result classifier (Guard G2). The daemon returns HTTP 200 with a
 * TRUTHFUL body for provider-unavailable / layout-unsupported / honest-partial
 * outcomes, so the UI must NOT read "200" as success. A result is a success
 * ONLY when it actually opened a pane (`opened.length > 0`) — matching the CLI's
 * zero-pane-is-failure rule. Zero-pane / provider-failure surfaces `code`/`error`
 * and the AUTHORITATIVE absent+degraded seats NAMED (not a bare count).
 */
export function describeOpenResult(r: OpenViewResult): { ok: boolean; headline: string; disclosure: string } {
  const disclosure = [
    ...r.absent.map((a) => `${a.seat}: ${a.reason}`),
    ...r.degraded.map((d) => `${d.seat} (${d.host}): ${d.reason}`),
  ].join(" · ");
  if (r.opened.length > 0) {
    return { ok: true, headline: `Opened ${r.opened.length} in ${r.provider}`, disclosure };
  }
  const why = r.error ? `${r.code ? `${r.code}: ` : ""}${r.error}` : (r.code ?? "no tiles opened");
  return { ok: false, headline: `No tiles opened in ${r.provider} — ${why}`, disclosure };
}

const PROVIDERS: { id: ProviderId; label: string; note: string; badge: string }[] = [
  { id: "herdr", label: "herdr", note: "Single cross-platform binary · atomic layout apply", badge: "PRIMARY" },
  { id: "cmux", label: "cmux", note: "Best-effort · adds a browser pane + ssh + remote-tmux", badge: "BEST-EFFORT" },
];

const KIND_ICON: Record<ViewKind, typeof Server> = {
  rig: Server,
  pod: Layers,
  mission: GitBranch,
  slice: GitBranch,
  saved: Bookmark,
};

const KIND_GROUP: { heading: string; kinds: ViewKind[] }[] = [
  { heading: "This rig", kinds: ["rig"] },
  { heading: "By pod", kinds: ["pod"] },
  { heading: "Mission · slice", kinds: ["mission", "slice"] },
  { heading: "Saved views", kinds: ["saved"] },
];

const RIG_NAME_UNAVAILABLE = "Rig name unavailable";

export function resolveLauncherRigName(input: {
  nodes: NodeInventoryEntry[] | undefined;
  rigId: string;
  rigName?: string | null;
}): string {
  const explicitName = input.rigName?.trim();
  if (explicitName) return explicitName;
  const nodeName = input.nodes
    ?.find((node) => node.rigId === input.rigId && typeof node.rigName === "string" && node.rigName.trim())
    ?.rigName.trim();
  return nodeName || RIG_NAME_UNAVAILABLE;
}

// Boot open/provider/view from the URL — the ratified deep-link capture method
// (a capture is an honest deep link ?launcher=open&provider=cmux&view=…,
// deterministic, no click scripts; also exactly what addressable UI state wants).
function readParams() {
  if (typeof window === "undefined") return { open: false, provider: "herdr" as ProviderId, view: "" };
  const p = new URLSearchParams(window.location.search);
  const provider = p.get("provider") === "cmux" ? "cmux" : "herdr";
  return { open: p.get("launcher") === "open", provider: provider as ProviderId, view: p.get("view") ?? "" };
}

export function nodeToSeat(n: NodeInventoryEntry): Seat {
  const act = n.agentActivity?.state;
  return {
    session: n.canonicalSessionName ?? n.logicalId,
    activity: act === "running" || act === "needs_input" ? "active" : "idle",
  };
}

/**
 * PURE view-library builder — the launcher's catalog metadata, extracted so it
 * is unit-testable without rendering the (Radix) dialog. Order = the founder's
 * "choose what to open": this rig → a pod → a mission/slice → a saved view.
 * Inventory supplies rig/pod catalog membership only. The canonical terminal
 * preview resolves readiness for every selected view, including saved membership.
 */
export function buildLauncherViews(input: {
  nodes: NodeInventoryEntry[] | undefined;
  rigId: string;
  rigName?: string | null;
  slices: { name: string; missionId: string | null; displayName: string }[];
  savedViews: { id: string; name: string; members: { seat: string; readOnly?: boolean }[] }[];
}): LauncherView[] {
  const { nodes, rigId, rigName, slices, savedViews } = input;
  const out: LauncherView[] = [];
  const agents = (nodes ?? []).filter((n) => n.nodeKind === "agent");
  const resolvedRigName = resolveLauncherRigName({ nodes, rigId, rigName });

  // Rig catalog membership; attachability is supplied by preview.
  out.push({
    id: `rig:${rigId}`,
    kind: "rig",
    label: resolvedRigName,
    sub: "Agents in this rig · preview readiness",
    seats: agents.map(nodeToSeat),
  });

  // By pod — group the rig's agents by pod namespace.
  const pods = new Map<string, NodeInventoryEntry[]>();
  for (const n of agents) {
    const ns = n.podNamespace;
    if (!ns) continue;
    const arr = pods.get(ns);
    if (arr) arr.push(n);
    else pods.set(ns, [n]);
  }
  for (const [ns, members] of pods) {
    out.push({
      id: `pod:${rigId}/${ns}`,
      kind: "pod",
      label: `${ns} pod`,
      sub: `${members.length} agent${members.length === 1 ? "" : "s"} · this rig`,
      seats: members.map(nodeToSeat),
    });
  }

  // Mission · slice — derived targets; the roster resolves live at open.
  const missionIds = [...new Set(slices.map((s) => s.missionId).filter((m): m is string => !!m))];
  for (const mid of missionIds) {
    out.push({ id: `mission:${mid}`, kind: "mission", label: mid, sub: "Agents working this mission — derived live", seats: null, crossRig: true });
  }
  for (const s of slices) {
    out.push({ id: `slice:${s.name}`, kind: "slice", label: s.displayName || s.name, sub: `slice ${s.name} — derived live`, seats: null, crossRig: true });
  }

  // Saved views — provider-agnostic; read-only when every member is read-only.
  for (const sv of savedViews) {
    out.push({
      id: `saved:${sv.id}`,
      kind: "saved",
      label: sv.name,
      sub: `${sv.members.length} agent${sv.members.length === 1 ? "" : "s"} · saved`,
      seats: null,
      crossRig: sv.members.length > 0 && sv.members.every((m) => m.readOnly === true),
    });
  }
  return out;
}

interface TerminalLauncherProps {
  rigId: string;
  /** The rig's human name (falls back to the id when unknown). */
  rigName?: string | null;
}

export function TerminalLauncher({ rigId, rigName }: TerminalLauncherProps) {
  const boot = readParams();
  const [open, setOpen] = useState(boot.open);
  const [provider, setProvider] = useState<ProviderId>(boot.provider);
  const [selectedId, setSelectedId] = useState<string>(boot.view || `rig:${rigId}`);

  const hostId = useSelectedHostId();
  const { known, isLocal } = useHostSelection();
  const launchAllowed = known && isLocal;
  const [pageIndex, setPageIndex] = useState(0);
  const { data: nodes } = useNodeInventory(rigId);
  const { data: slicesData } = useSlices("active");
  const { data: viewsData } = useTerminalViews();

  // ── Build the view library from live seams (replaces the twin's DEMO roster) ──
  const views = useMemo<LauncherView[]>(
    () =>
      buildLauncherViews({
        nodes,
        rigId,
        rigName,
        // useSlices returns SliceListResponse | SlicesUnavailable — narrow the
        // unavailable arm (shipped Feed.tsx / ProjectTreeView.tsx discriminant).
        slices: slicesData && "slices" in slicesData ? slicesData.slices : [],
        savedViews: viewsData?.saved ?? [],
      }),
    [nodes, rigId, rigName, slicesData, viewsData],
  );

  const selected = views.find((v) => v.id === selectedId || (v.kind === "saved" && v.id === `saved:${selectedId}`));
  const resolvedRigName = views.find((view) => view.kind === "rig")?.label ?? RIG_NAME_UNAVAILABLE;

  const previewQuery = useTerminalPreview(hostId, selected?.id, provider, open && launchAllowed);
  const preview = launchAllowed && !previewQuery.isError && !previewQuery.isFetching ? previewQuery.data : undefined;
  const plan = preview?.composed;
  const page = plan?.pages[pageIndex] ?? [];
  const grid = preview?.grids[pageIndex];
  const readOnly = !!plan?.opened.length && plan.opened.every((pane) => pane.readOnly);
  const providerLabel = PROVIDERS.find((p) => p.id === provider)!.label;
  const canOpen = !!preview?.status.available && !!plan?.opened.length;

  useEffect(() => { setPageIndex(0); }, [hostId, selected?.id, provider, preview?.planId]);

  const openMut = useMutation({
    mutationFn: async (validated: TerminalPreviewDto): Promise<OpenViewResult> => {
      if (!launchAllowed || !canOpen || validated !== preview) throw new Error("Refresh the terminal preview before Open.");
      const res = await fetch(withHostParam("/api/terminal/open", hostId), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...terminalAuthHeaders() },
        body: JSON.stringify({ provider: validated.provider, view: validated.view, expectedPlan: validated.planId }),
      });
      const body = (await res.json().catch(() => null)) as OpenViewResult | null;
      if (body?.code === "preview_changed") void previewQuery.refetch();
      if (!res.ok || !body) throw new Error(body?.error ?? `HTTP ${res.status}`);
      return body;
    },
  });
  useEffect(() => { openMut.reset(); }, [hostId, selected?.id, provider]);

  return (
    <div data-testid="terminal-launcher-wrapper" className="hidden lg:inline-flex items-center ml-auto">
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <button
            type="button"
            data-testid="terminal-launcher-button"
            className="inline-flex items-center gap-2 border border-stone-700 bg-white px-3 py-2 font-mono text-[10px] uppercase tracking-[0.18em] text-stone-900 hover:bg-stone-100 focus:outline-none focus:ring-1 focus:ring-stone-400 dark:bg-transparent dark:text-on-surface dark:border-outline"
          >
            <Terminal className="h-3.5 w-3.5" aria-hidden="true" />
            Open in terminal
            <ChevronDown className="h-3 w-3 opacity-60" aria-hidden="true" />
          </button>
        </DialogTrigger>

        <DialogContent
          hideCloseButton
          data-testid="terminal-launcher-dialog"
          className="w-[calc(100vw-2rem)] max-w-xl max-h-[calc(100vh-2rem)] gap-0 p-0 overflow-y-auto"
        >
          {/* Radix a11y: a Dialog needs an accessible title + description; the
              twin's visible header is a styled div, so these are sr-only —
              screen-reader-visible, pixel-identical to the locked frames. */}
          <DialogTitle className="sr-only">Open terminal view</DialogTitle>
          <DialogDescription className="sr-only">
            Pick a provider and a view target, then open the view as terminal tiles.
          </DialogDescription>
          {/* Header */}
          <div className="bg-stone-900 text-white px-5 py-3 flex items-baseline justify-between">
            <div className="flex items-baseline gap-2">
              <Terminal className="h-3.5 w-3.5 translate-y-0.5 text-stone-300" aria-hidden="true" />
              <span className="font-mono text-[11px] uppercase tracking-[0.18em]">Open terminal view</span>
            </div>
            <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-stone-400">
              {resolvedRigName.replace(/^rig_/, "")} · topology
            </span>
          </div>

          <div className="p-5 grid gap-5">
            {/* ── PROVIDER ── */}
            <section data-testid="launcher-provider">
              <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-on-surface-variant mb-2">Provider</div>
              <div role="tablist" className="flex gap-6 items-center border-b border-outline-variant">
                {PROVIDERS.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    role="tab"
                    aria-selected={provider === p.id}
                    data-testid={`launcher-provider-${p.id}`}
                    onClick={() => setProvider(p.id)}
                    className={cn(
                      "-mb-px py-2 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.18em] border-b-2",
                      provider === p.id
                        ? "border-on-surface text-on-surface"
                        : "border-transparent text-on-surface-variant hover:text-on-surface",
                    )}
                  >
                    {p.label}
                    <span
                      className={cn(
                        "px-1 py-0.5 text-[8px] tracking-[0.12em] border",
                        p.id === "herdr" ? "border-success/60 text-success" : "border-outline text-on-surface-variant",
                      )}
                    >
                      {p.badge}
                    </span>
                  </button>
                ))}
              </div>
              <p className="mt-2 font-mono text-[9px] text-on-surface-variant leading-relaxed">
                {PROVIDERS.find((p) => p.id === provider)!.note}
              </p>
            </section>

            {/* ── VIEW ── */}
            <section data-testid="launcher-view">
              <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-on-surface-variant mb-2">View</div>
              <div className="max-h-[236px] overflow-y-auto border border-outline-variant divide-y divide-outline-variant">
                {views.length === 0 ? (
                  <div className="px-3 py-4 font-mono text-[9px] text-on-surface-variant">Loading views…</div>
                ) : null}
                {KIND_GROUP.map((group) => {
                  const groupViews = views.filter((v) => group.kinds.includes(v.kind));
                  if (groupViews.length === 0) return null;
                  return (
                    <div key={group.heading}>
                      <div className="px-3 pt-2 pb-1 font-mono text-[8px] uppercase tracking-[0.2em] text-on-surface-variant/70 bg-surface-low">
                        {group.heading}
                      </div>
                      {groupViews.map((v) => {
                        const Icon = KIND_ICON[v.kind];
                        const vlive = v.id === selected?.id && plan ? plan.opened.length : null;
                        const vabsent = v.id === selected?.id && plan ? plan.absent.length + plan.degraded.length : 0;
                        const isSel = v.id === selected?.id;
                        return (
                          <button
                            key={v.id}
                            type="button"
                            data-testid={`launcher-view-${v.id}`}
                            aria-pressed={isSel}
                            onClick={() => setSelectedId(v.id)}
                            className={cn(
                              "w-full text-left px-3 py-2 flex items-center gap-3 transition-colors",
                              isSel
                                ? "bg-inverse-surface/[0.06] border-l-2 border-l-on-surface"
                                : "border-l-2 border-l-transparent hover:bg-surface-low",
                            )}
                          >
                            <Icon className="h-3.5 w-3.5 shrink-0 text-on-surface-variant" aria-hidden="true" />
                            <span className="flex-1 min-w-0">
                              <span className="flex items-center gap-2">
                                <span className="font-mono text-[11px] text-on-surface truncate">{v.label}</span>
                                {v.crossRig ? (
                                  <span className="inline-flex items-center gap-1 px-1 py-0.5 text-[8px] font-mono uppercase tracking-[0.12em] border border-outline text-on-surface-variant">
                                    <Eye className="h-2.5 w-2.5" aria-hidden="true" /> read-only
                                  </span>
                                ) : null}
                              </span>
                              <span className="block font-mono text-[9px] text-on-surface-variant truncate">{v.sub}</span>
                            </span>
                            <span className="shrink-0 text-right">
                              {vlive === null ? (
                                <span className="block font-mono text-[9px] text-on-surface-variant">Preview readiness</span>
                              ) : (
                                <>
                                  <span className="block font-mono text-[10px] text-on-surface">{vlive} attachable</span>
                                  {vabsent > 0 ? (
                                    <span className="block font-mono text-[8px] text-warning">{vabsent} unavailable</span>
                                  ) : null}
                                </>
                              )}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  );
                })}
                {/* Save-this-view affordance — roadmap seam, honestly stubbed (v1 = hand-authored YAML). */}
                <button
                  type="button"
                  disabled
                  data-testid="launcher-save-view"
                  className="w-full text-left px-3 py-2 flex items-center gap-2 font-mono text-[9px] uppercase tracking-[0.16em] text-on-surface-variant/60 hover:bg-surface-low disabled:cursor-default"
                >
                  <Plus className="h-3 w-3" aria-hidden="true" /> Save current arrangement as a view…
                </button>
              </div>
            </section>

            {/* The daemon preview supplies every page and filler cell. */}
            <section data-testid="launcher-layout" className="grid gap-2 font-mono text-[11px]">
              <div className="text-[10px] uppercase tracking-[0.18em] text-on-surface-variant">Layout</div>
              {!launchAllowed ? <p>{known ? "Terminal launch is available on the local host. Select local to continue." : "Reading host selection…"}</p>
                : !selected ? <p>Select an available view to preview.</p>
                : previewQuery.isError ? <p role="alert">{previewQuery.error.message}</p>
                : !preview ? <p>Reading terminal preview…</p>
                : <>
                    <p>Page {plan!.pages.length ? pageIndex + 1 : 0}/{plan!.pages.length}{grid ? ` · Auto grid · ${grid.columns}×${grid.rows} · ${page.length} pane${page.length === 1 ? "" : "s"} · ${grid.blanks} filler cells` : ""}</p>
                    {grid ? <div aria-hidden="true" className="grid gap-1 p-1.5 border border-outline-variant bg-surface-low w-fit"
                      style={{ gridTemplateColumns: `repeat(${grid.columns}, 14px)`, gridTemplateRows: `repeat(${grid.rows}, 12px)` }}>
                      {Array.from({ length: page.length + grid.blanks }, (_, i) => <span key={i} className={i < page.length ? "bg-on-surface/70" : "border border-outline-variant"} />)}
                    </div> : null}
                    {page.map((pane) => <p key={pane.seat}>{pane.label} · {pane.seat} · {pane.readOnly ? "read-only" : "interactive"}{pane.paneCommand.startsWith("ssh ") ? " · SSH login unverified; opened pane will attempt connection" : ""}</p>)}
                    {plan!.pages.length > 1 ? <div className="flex gap-3">
                      <button type="button" data-testid="launcher-previous-page" disabled={pageIndex === 0} onClick={() => setPageIndex((n) => n - 1)}>Previous page</button>
                      <button type="button" data-testid="launcher-next-page" disabled={pageIndex + 1 >= plan!.pages.length} onClick={() => setPageIndex((n) => n + 1)}>Next page</button>
                    </div> : null}
                    <p className="text-[9px] text-on-surface-variant">Provider auto-layout uses equal cells. Saved views store membership; blank cells fill incomplete rectangles.</p>
                    {!preview.status.available ? <p className="text-warning">{providerLabel} unavailable on the local daemon host. Start/connect it there, then refresh the preview.</p> : !plan!.opened.length ? <p>Nothing attachable; no space will be opened.</p> : null}
                  </>}
              <button type="button" data-testid="launcher-refresh-preview" disabled={!launchAllowed || !selected || previewQuery.isFetching} onClick={() => void previewQuery.refetch()}>Refresh preview</button>
            </section>

            {/* ── FOOTER ── */}
            <div className="flex items-center justify-between gap-3 pt-1 border-t border-outline-variant">
              <div className="min-w-0">
                <StatusPip
                  status={readOnly ? "info" : "active"}
                  variant="pill"
                  label={plan ? (readOnly ? "read-only" : "interactive") : "readiness unverified"}
                  testId="launcher-mode-pip"
                />
                <div className="mt-1.5 font-mono text-[9px] text-on-surface-variant leading-relaxed">
                  {plan ? <>
                    {plan.opened.length} attachable · {plan.absent.length} absent · {plan.degraded.length} degraded
                    {[...plan.absent, ...plan.degraded].map((seat) => <span className="block text-warning" key={`${seat.host}:${seat.seat}`} data-testid="launcher-honest-partial">
                      {seat.seat}{seat.host ? ` (${seat.host})` : ""}: {seat.reason}
                    </span>)}
                  </> : "Preview readiness before Open."}
                </div>
                {openMut.data
                  ? (() => {
                      // Guard G2: a 200 body is authoritative, not automatically green —
                      // opened.length === 0 is a failure disclosure, never "Opened 0".
                      const d = describeOpenResult(openMut.data);
                      return (
                        <div
                          className={cn("mt-1 font-mono text-[9px]", d.ok ? "text-success" : "text-error")}
                          data-testid={d.ok ? "launcher-open-result" : "launcher-open-zero"}
                        >
                          {d.headline}
                          {d.disclosure ? <span className="block text-warning">{d.disclosure}</span> : null}
                        </div>
                      );
                    })()
                  : openMut.isError ? (
                      <div className="mt-1 font-mono text-[9px] text-error" data-testid="launcher-open-error">
                        {(openMut.error as Error).message}
                      </div>
                    ) : null}
              </div>
              <button
                type="button"
                data-testid="launcher-open"
                disabled={openMut.isPending || !canOpen}
                onClick={() => { if (preview) openMut.mutate(preview); }}
                className="shrink-0 inline-flex items-center gap-2 bg-inverse-surface text-background px-4 py-2.5 font-headline font-bold uppercase tracking-widest text-[11px] hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 disabled:opacity-60"
              >
                <Terminal className="h-3.5 w-3.5" aria-hidden="true" />
                {openMut.isPending ? "Opening…" : `Open in ${providerLabel}${plan?.pages.length ? ` · all ${plan.pages.length} pages` : ""}`}
              </button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
