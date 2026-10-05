// Independent terminal catalog: Saved and Derived views without a rig prop, so it
// works with zero rigs, on small screens and by keyboard. Browsing, paging and
// refreshing only read; nothing opens a provider space until an explicit Open of
// the currently validated preview plan.
//
// Catalog membership is not attachability. Readiness, pages, grids, absent and
// degraded members come only from the selected provider's passive preview.

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useHosts } from "../../hooks/useHosts.js";
import { useTerminalViews } from "../../hooks/useTerminalViews.js";
import { useTerminalPreview } from "../../hooks/useTerminalPreview.js";
import { LOCAL_HOST_ID } from "../../lib/host-param.js";
import { OperatorReadError } from "../../lib/operator-read.js";
import type { TerminalPreviewDto, TerminalPreviewPane } from "../../lib/terminal-read.js";
import { cn } from "../../lib/utils.js";
import { describeOpenResult } from "../topology/TerminalLauncher.js";
import { ActionButton, Badge, Evidence, ExactId, Fact, FactList, Notice, SectionLabel, SurfaceHeader, RecoveryStamp, receiptIso, useRetainedScroll } from "../startup/recovery-primitives.js";
import { DisplayZoneNote } from "../time/DisplayTime.js";
import { buildTerminalCatalog, filterCatalog, omittedFromOpen, parseTypedViewToken, TERMINAL_PROVIDERS, type CatalogEntry } from "./catalog-model.js";
import { useTerminalCatalogStore, type TerminalOpenRecord } from "./TerminalCatalogState.js";
import { admitConnectedLocal } from "../startup/connected-admission.js";
import { useQueryClient } from "@tanstack/react-query";

export interface TerminalCatalogProps {
  /** Exact token from the route (for example `?view=saved:<id>`). `null` shows the catalog.
   * Leave undefined to keep detail selection inside the component. */
  view?: string | null;
  /** Navigate to an exact token's detail, or back to the catalog with `null`. */
  onNavigate?: (view: string | null) => void;
}

type HostScope = { state: "unknown"; message: string } | { state: "remote"; hostId: string } | { state: "local"; stale: boolean; message: string | null };

function useHostScope(): HostScope {
  const hosts = useHosts();
  if (!hosts.data) return { state: "unknown", message: hosts.error ? `Host selection could not be read: ${hosts.error.message}` : "Reading host selection…" };
  if (hosts.data.selected !== LOCAL_HOST_ID) return { state: "remote", hostId: hosts.data.selected };
  return { state: "local", stale: hosts.isError, message: hosts.error?.message ?? null };
}

export function TerminalCatalog({ view, onNavigate }: TerminalCatalogProps) {
  const [internalView, setInternalView] = useState<string | null>(null);
  const current = view !== undefined ? view : internalView;
  const navigate = (next: string | null) => { if (onNavigate) onNavigate(next); else setInternalView(next); };
  return (
    <div data-testid="terminal-catalog" className="mx-auto w-full max-w-5xl px-3 py-4 sm:px-6">
      {current === null ? <CatalogList onSelect={token => navigate(token)} /> : <CatalogDetail token={current} onBack={() => navigate(null)} />}
    </div>
  );
}

function ScopeNotice({ scope, testId }: { scope: HostScope; testId: string }) {
  if (scope.state === "unknown") return <Notice title="Reading host selection" testId={`${testId}-selection-unknown`} live="polite">{scope.message} Terminal views are read only once the selection is known to be local.</Notice>;
  if (scope.state === "remote") {
    return (
      <Notice tone="warning" title="Remote host selected · terminals unavailable here" testId={`${testId}-remote-scope`} live="polite">
        Topology is viewing <ExactId value={scope.hostId} />. Terminal catalog, preview and Open act on the connected instance only and are not forwarded.
        Select the local host to browse; local views are never shown under a remote label.
      </Notice>
    );
  }
  if (scope.stale) {
    return (
      <Notice tone="warning" title="Host selection not re-read" testId={`${testId}-selection-stale`} live="polite">
        The latest host-selection refresh failed{scope.message ? ` (${scope.message})` : ""}. Browsing continues on the last known local selection; Open waits until it reads again.
      </Notice>
    );
  }
  return null;
}

function readErrorCopy(error: unknown): string {
  if (error instanceof OperatorReadError) {
    if (error.code === "network" || error.code === "timeout") return `${error.message} The browser cannot start a stopped daemon; check it on its host with the rig CLI.`;
    if (error.status === 503) return "The connected daemon reports its terminal service unavailable.";
    return error.message;
  }
  return error instanceof Error ? error.message : "The read did not complete.";
}

// ------------------------------------------------------------------- catalog

function CatalogList({ onSelect }: { onSelect: (token: string) => void }) {
  const store = useTerminalCatalogStore();
  const scope = useHostScope();
  const views = useTerminalViews();
  const entries = useMemo(() => views.data ? buildTerminalCatalog(views.data) : null, [views.data]);
  const visible = entries ? filterCatalog(entries, store.ui.filter) : [];
  const saved = visible.filter(entry => entry.kind === "saved");
  const derived = visible.filter(entry => entry.kind === "derived");
  const { ref: scroller, onScroll } = useRetainedScroll<HTMLDivElement>(store.ui.scroll, top => store.updateUi({ scroll: top }), entries ? "catalog" : null);
  const [typed, setTyped] = useState("");
  const [typedError, setTypedError] = useState<string | null>(null);

  // Back returns keyboard focus to the row the operator came from.
  useEffect(() => {
    if (!entries || !store.ui.focusToken || !scroller.current) return;
    const row = [...scroller.current.querySelectorAll<HTMLButtonElement>("button[data-token]")].find(button => button.dataset.token === store.ui.focusToken);
    row?.focus({ preventScroll: true });
  }, [!!entries]); // eslint-disable-line react-hooks/exhaustive-deps

  const select = (token: string) => { store.updateUi({ focusToken: token }); onSelect(token); };
  const submitTyped = (event: FormEvent) => {
    event.preventDefault();
    const parsed = parseTypedViewToken(typed);
    if (!parsed.ok) { setTypedError(parsed.reason); return; }
    setTypedError(null);
    select(parsed.token);
  };

  return (
    <>
      <SurfaceHeader
        testId="terminal-catalog"
        eyebrow="Terminals · connected instance"
        title="Terminal views"
        description={<>Saved views and rig-derived views on the connected daemon. Choosing one reads a passive preview; nothing opens until you press Open.
          Focused terminals on seat pages are unchanged.</>}
      >
        <DisplayZoneNote testId="terminal-catalog-zone-note" />
      </SurfaceHeader>
      <div className="grid gap-4">
        <ScopeNotice scope={scope} testId="terminal-catalog" />
        {scope.state !== "remote" && views.scopeSupported ? (
          <>
            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
              <label className="grid gap-1 text-xs text-on-surface-variant">
                Filter by name, token or member seat
                <input
                  data-testid="terminal-catalog-filter"
                  type="search"
                  value={store.ui.filter}
                  onChange={event => store.updateUi({ filter: event.target.value })}
                  className="min-h-[2rem] border border-outline-variant bg-surface-lowest px-2 py-1 font-mono text-[12px] text-on-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-on-surface"
                />
              </label>
              <div className="flex flex-wrap items-center gap-2">
                <ActionButton variant="quiet" data-testid="terminal-catalog-refresh" disabled={views.isFetching} onClick={() => void views.refetch()}>
                  {views.isFetching ? "Reading…" : "Refresh views"}
                </ActionButton>
                {views.dataUpdatedAt ? <span className="font-mono text-[9px] text-on-surface-variant">read <RecoveryStamp iso={receiptIso(views.dataUpdatedAt)} testId="terminal-catalog-read-at" /></span> : null}
              </div>
            </div>

            {views.isError ? (
              <Notice tone={entries ? "warning" : "error"} title={entries ? "Refresh failed · showing last read" : "Terminal views unavailable"} testId="terminal-catalog-error" live="assertive">
                {readErrorCopy(views.error)}{entries ? " The list below is the last successful read and may be out of date." : " No catalog is inferred."}
              </Notice>
            ) : null}

            {!entries ? (
              views.isError ? null : <p role="status" className="text-sm text-on-surface-variant">Reading terminal views…</p>
            ) : (
              <div ref={scroller} onScroll={onScroll} data-testid="terminal-catalog-scroll" className="grid max-h-[65vh] gap-4 overflow-y-auto pr-1">
                <CatalogGroup id="terminal-saved" title="Saved" total={entries.filter(e => e.kind === "saved").length} rows={saved} filter={store.ui.filter} onSelect={select}
                  empty="No saved views on this instance. Saved views are YAML membership files; they are not created or edited here." />
                <CatalogGroup id="terminal-derived" title="Derived · one per rig" total={entries.filter(e => e.kind === "derived").length} rows={derived} filter={store.ui.filter} onSelect={select}
                  empty="No rigs on this instance, so no derived views." />
              </div>
            )}

            <form onSubmit={submitTyped} data-testid="terminal-typed-form" className="grid gap-2 border border-outline-variant p-3">
              <label className="grid gap-1 text-xs text-on-surface-variant">
                Preview a typed target (pod, mission, slice, saved or rig token)
                <input
                  data-testid="terminal-typed-input"
                  value={typed}
                  onChange={event => setTyped(event.target.value)}
                  placeholder="pod:<rig>/<pod>"
                  aria-invalid={!!typedError}
                  aria-describedby={typedError ? "terminal-typed-error" : undefined}
                  className="min-h-[2rem] border border-outline-variant bg-surface-lowest px-2 py-1 font-mono text-[12px] text-on-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-on-surface"
                />
              </label>
              <div><ActionButton type="submit" data-testid="terminal-typed-submit">Preview target</ActionButton></div>
              {typedError ? <p id="terminal-typed-error" role="alert" className="text-xs text-warning" data-testid="terminal-typed-error">{typedError}</p> : null}
              <p className="text-xs text-on-surface-variant">Mission and slice targets are not listed here; the daemon preview reports whether a typed target exists.</p>
            </form>
          </>
        ) : null}
      </div>
    </>
  );
}

function CatalogGroup({ id, title, total, rows, filter, onSelect, empty }: {
  id: string; title: string; total: number; rows: CatalogEntry[]; filter: string; onSelect: (token: string) => void; empty: string;
}) {
  return (
    <section aria-labelledby={`${id}-label`} data-testid={`${id}-group`} className="grid gap-1.5">
      <SectionLabel id={`${id}-label`}>{title} · {filter.trim() ? `${rows.length} of ${total}` : total}</SectionLabel>
      {total === 0 ? <p className="text-sm text-on-surface-variant" data-testid={`${id}-empty`}>{empty}</p>
        : rows.length === 0 ? <p className="text-sm text-on-surface-variant" data-testid={`${id}-no-match`}>Nothing here matches “{filter}”.</p>
        : (
          <ul className="divide-y divide-outline-variant border border-outline-variant">
            {rows.map(entry => <CatalogRow key={entry.token} entry={entry} onSelect={onSelect} />)}
          </ul>
        )}
    </section>
  );
}

function membershipSummary(entry: CatalogEntry): string {
  if (entry.kind === "derived") return "Members come from the rig at preview time";
  const count = entry.members.length;
  const ro = entry.members.filter(m => m.readOnly === true).length;
  const remote = entry.members.filter(m => !!m.host).length;
  return [`${count} member${count === 1 ? "" : "s"}`, ro ? (ro === count ? "all read-only" : `${ro} read-only`) : null, remote ? `${remote} on other hosts` : null]
    .filter(Boolean).join(" · ");
}

function CatalogRow({ entry, onSelect }: { entry: CatalogEntry; onSelect: (token: string) => void }) {
  const seats = entry.members.slice(0, 6).map(member => member.seat);
  return (
    <li>
      <button
        type="button"
        data-token={entry.token}
        data-testid={`terminal-row-${entry.token}`}
        onClick={() => onSelect(entry.token)}
        className="grid w-full gap-0.5 px-3 py-2 text-left hover:bg-surface-low focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-on-surface"
      >
        <span className="flex flex-wrap items-center gap-2">
          <span className="break-words font-mono text-[12px] text-on-surface">{entry.name || <span className="text-on-surface-variant">unnamed</span>}</span>
          {entry.sameNameTokens.length ? <Badge tone="info">same name as {entry.sameNameTokens.join(", ")}</Badge> : null}
        </span>
        <ExactId value={entry.token} className="text-on-surface-variant" />
        <span className="font-mono text-[10px] text-on-surface-variant">{membershipSummary(entry)} · readiness unverified until preview</span>
        {seats.length ? (
          <span className="break-words font-mono text-[10px] text-on-surface-variant [overflow-wrap:anywhere]">
            {seats.join(" · ")}{entry.members.length > seats.length ? ` · +${entry.members.length - seats.length} more` : ""}
          </span>
        ) : null}
      </button>
    </li>
  );
}

// -------------------------------------------------------------------- detail

function CatalogDetail({ token, onBack }: { token: string; onBack: () => void }) {
  const store = useTerminalCatalogStore();
  const scope = useHostScope();
  const views = useTerminalViews();
  const parsed = parseTypedViewToken(token);
  const exact = parsed.ok ? parsed.token === token : false;
  const entry = views.data && parsed.ok ? buildTerminalCatalog(views.data).find(row => row.token === token) ?? null : null;
  const local = scope.state === "local";
  const provider = store.ui.provider;
  const preview = useTerminalPreview(local ? LOCAL_HOST_ID : scope.state === "remote" ? scope.hostId : "", parsed.ok && exact ? token : undefined, provider, local);
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => { headingRef.current?.focus(); }, [token]);

  return (
    <article aria-labelledby="terminal-detail-title" data-testid="terminal-detail" className="grid gap-4">
      <div><ActionButton variant="quiet" data-testid="terminal-detail-back" onClick={onBack}>← All terminal views</ActionButton></div>
      <header className="grid gap-1 border-b border-outline-variant pb-3">
        <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-on-surface-variant">Terminal view · {entry ? (entry.kind === "saved" ? "saved" : "derived from rig") : parsed.ok ? `typed ${parsed.kind} target` : "invalid"}</p>
        <h1 id="terminal-detail-title" ref={headingRef} tabIndex={-1} className="break-words font-headline text-headline-md font-bold tracking-tight text-on-surface focus:outline-none">
          {entry?.name || <ExactId value={token} className="text-base" />}
        </h1>
        <p className="text-xs text-on-surface-variant">Token <ExactId value={token} testId="terminal-detail-token" /></p>
        <DisplayZoneNote testId="terminal-detail-zone-note" />
        {entry?.sameNameTokens.length ? <p className="text-xs text-on-surface-variant">Another view shares this name: {entry.sameNameTokens.map(t => <ExactId key={t} value={t} className="mr-2" />)}. This page uses only the exact token above.</p> : null}
      </header>

      <ScopeNotice scope={scope} testId="terminal-detail" />
      {!parsed.ok || !exact ? (
        <Notice tone="error" title="Not a typed view token" testId="terminal-detail-invalid">{parsed.ok ? "Surrounding whitespace is not part of a token." : parsed.reason}</Notice>
      ) : local ? (
        <>
          {!entry && views.data ? (
            <Notice title="Not in the current catalog" testId="terminal-detail-uncatalogued">
              This exact token is not a listed saved or derived view. The preview below is the daemon&apos;s answer for it; no similarly named view is substituted.
            </Notice>
          ) : null}
          <ProviderChoice />
          <PreviewPanel token={token} preview={preview} entry={entry} stale={scope.stale} />
        </>
      ) : null}
    </article>
  );
}

function ProviderChoice() {
  const store = useTerminalCatalogStore();
  return (
    <fieldset data-testid="terminal-provider" className="grid gap-2">
      <legend className="mb-1 font-mono text-[10px] uppercase tracking-[0.18em] text-on-surface-variant">Provider</legend>
      <div className="flex flex-wrap gap-2">
        {TERMINAL_PROVIDERS.map(option => (
          <label key={option.id} className={cn("inline-flex min-h-[2rem] cursor-pointer items-center gap-2 border px-3 py-1 font-mono text-[11px] focus-within:outline focus-within:outline-2 focus-within:outline-on-surface",
            store.ui.provider === option.id ? "border-on-surface text-on-surface" : "border-outline-variant text-on-surface-variant")}>
            <input type="radio" name="terminal-provider" value={option.id} data-testid={`terminal-provider-${option.id}`} className="sr-only"
              checked={store.ui.provider === option.id} onChange={() => store.updateUi({ provider: option.id })} />
            {option.label}{option.id === "herdr" ? <span className="text-[9px] uppercase tracking-[0.12em] text-on-surface-variant">default</span> : null}
          </label>
        ))}
      </div>
      <p className="text-xs text-on-surface-variant">{TERMINAL_PROVIDERS.find(p => p.id === store.ui.provider)?.note}</p>
    </fieldset>
  );
}

type PreviewQuery = ReturnType<typeof useTerminalPreview>;

function PreviewPanel({ token, preview, entry, stale }: { token: string; preview: PreviewQuery; entry: CatalogEntry | null; stale: boolean }) {
  const store = useTerminalCatalogStore();
  const data = preview.data;
  const [pageIndex, setPageIndex] = useState(0);
  const pages = data?.composed.pages ?? [];
  // New plan/view/provider starts at page 1; a refreshed plan with fewer pages clamps.
  useEffect(() => { setPageIndex(0); }, [token, store.ui.provider, data?.planId]);
  const page = Math.min(pageIndex, Math.max(0, pages.length - 1));
  const fresh = !!data && !preview.isFetching && !preview.isError;
  const lastOpen = store.lastOpen && store.lastOpen.view === token ? store.lastOpen : null;
  const uncertainHold = !!lastOpen && lastOpen.status === "uncertain" && lastOpen.provider === store.ui.provider
    && (!lastOpen.settledAt || preview.dataUpdatedAt <= lastOpen.settledAt);
  const [refusal, setRefusal] = useState<string | null>(null);
  // Presentation only; the store re-checks provenance against the current cache at invocation.
  const provenance = data ? store.previewProvenance(data) : "unverified";
  const openable = fresh && !stale && provenance === "current" && data!.status.available && data!.composed.opened.length > 0 && !store.openPending && !uncertainHold;
  const holdReason = !data ? null
    : stale ? "Open waits until the host selection reads again."
    : preview.isFetching ? "Reading the latest preview…"
    : preview.isError ? "The last preview read failed; refresh before Open."
    : provenance === "foreign" ? "This preview was read from a different connected instance. Refresh it here before Open."
    : provenance === "unverified" ? "This preview's source instance is not confirmed. Refresh it before Open."
    : !data.status.available ? null
    : !data.composed.opened.length ? null
    : uncertainHold ? "The last Open outcome is unknown. Check the provider, then refresh the preview before deciding to Open again."
    : store.openPending ? "An Open is awaiting its result."
    : null;

  return (
    <section aria-labelledby="terminal-preview-label" data-testid="terminal-preview" className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SectionLabel id="terminal-preview-label">Preview · {store.ui.provider}</SectionLabel>
        <div className="flex flex-wrap items-center gap-2">
          {preview.dataUpdatedAt ? <span className="font-mono text-[9px] text-on-surface-variant">read <RecoveryStamp iso={receiptIso(preview.dataUpdatedAt)} testId="terminal-preview-read-at" /></span> : null}
          <ActionButton variant="quiet" data-testid="terminal-preview-refresh" disabled={preview.isFetching} onClick={() => void preview.refetch()}>
            {preview.isFetching ? "Reading…" : "Refresh preview"}
          </ActionButton>
        </div>
      </div>

      {preview.isError ? (
        <Notice tone={data ? "warning" : "error"} live="assertive" testId="terminal-preview-error"
          title={preview.error instanceof OperatorReadError && preview.error.status === 404 ? "Target unavailable" : data ? "Refresh failed · last preview shown" : "Preview unavailable"}>
          {readErrorCopy(preview.error)}
          {preview.error instanceof OperatorReadError && preview.error.status === 404 ? " The daemon does not resolve this exact token; no other view is tried." : ""}
        </Notice>
      ) : null}
      {!data && !preview.isError ? <p role="status" className="text-sm text-on-surface-variant">Reading the passive preview…</p> : null}

      {data ? <PlanView data={data} page={page} onPage={setPageIndex} /> : null}

      {entry?.kind === "saved" ? <SavedMembership entry={entry} /> : null}

      <div className="grid gap-2 border-t border-outline-variant pt-3" data-testid="terminal-open-area">
        <div className="flex flex-wrap items-center gap-2">
          <ActionButton
            variant="primary"
            data-testid="terminal-open"
            disabled={!openable}
            onClick={() => { if (data && openable) setRefusal(store.open(data, LOCAL_HOST_ID)); }}
          >
            {store.openPending && lastOpen?.status === "pending" ? "Opening…"
              : data ? `Open ${data.composed.opened.length} pane${data.composed.opened.length === 1 ? "" : "s"} in ${data.provider}${pages.length > 1 ? ` · ${pages.length} pages` : ""}` : "Open"}
          </ActionButton>
          <span className="text-xs text-on-surface-variant">Opens exactly the plan shown (plan <ExactId value={data?.planId ?? "not read"} />).</span>
        </div>
        {holdReason ? <p className="text-xs text-warning" data-testid="terminal-open-hold">{holdReason}</p> : null}
        {refusal ? <p className="text-xs text-warning" data-testid="terminal-open-refusal">{refusal}</p> : null}
        {lastOpen ? <OpenResult record={lastOpen} /> : null}
      </div>
    </section>
  );
}

function PlanView({ data, page, onPage }: { data: TerminalPreviewDto; page: number; onPage: (index: number) => void }) {
  const { composed, grids, status } = data;
  const panes = composed.pages[page] ?? [];
  const grid = grids[page];
  return (
    <div className="grid gap-3" data-testid="terminal-plan">
      {!status.available ? (
        <Notice tone="warning" title={`${data.provider} unavailable`} testId="terminal-provider-unavailable">
          The daemon reports {data.provider} unavailable on its host. Start or connect it there, then refresh. Open stays disabled.
        </Notice>
      ) : !composed.opened.length ? (
        <Notice tone="warning" title="Nothing attachable" testId="terminal-nothing-attachable">No member can be attached right now, so Open would create nothing.</Notice>
      ) : null}

      <p className="font-mono text-[11px] text-on-surface" data-testid="terminal-plan-summary">
        {composed.opened.length} attachable · {composed.absent.length} absent · {composed.degraded.length} degraded · {composed.pages.length} page{composed.pages.length === 1 ? "" : "s"}
      </p>

      {composed.absent.length || composed.degraded.length ? (
        <ul className="grid gap-1" data-testid="terminal-unavailable-members" aria-label="Members that will not open">
          {composed.absent.map(a => <li key={`a\u0000${a.host ?? ""}\u0000${a.seat}`} className="break-words text-sm text-warning"><ExactId value={a.seat} />{a.host ? <> on <ExactId value={a.host} /></> : null} — absent: {a.reason}</li>)}
          {composed.degraded.map(d => <li key={`d\u0000${d.host}\u0000${d.seat}`} className="break-words text-sm text-warning"><ExactId value={d.seat} /> on <ExactId value={d.host} /> — degraded: {d.reason}</li>)}
        </ul>
      ) : null}

      {composed.pages.length ? (
        <div className="grid gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-[11px] text-on-surface" data-testid="terminal-page-label">Page {page + 1} of {composed.pages.length}</span>
            {grid ? <span className="font-mono text-[10px] text-on-surface-variant">{grid.columns}×{grid.rows} grid · {panes.length} pane{panes.length === 1 ? "" : "s"} · {grid.blanks} blank</span> : null}
            {composed.pages.length > 1 ? (
              <span className="ml-auto flex gap-2">
                <ActionButton variant="quiet" data-testid="terminal-page-previous" disabled={page === 0} onClick={() => onPage(page - 1)}>Previous page</ActionButton>
                <ActionButton variant="quiet" data-testid="terminal-page-next" disabled={page + 1 >= composed.pages.length} onClick={() => onPage(page + 1)}>Next page</ActionButton>
              </span>
            ) : null}
          </div>
          {grid ? (
            <div aria-hidden="true" data-testid="terminal-grid" className="grid w-fit gap-1 border border-outline-variant bg-surface-low p-1.5"
              style={{ gridTemplateColumns: `repeat(${grid.columns}, 1.25rem)`, gridTemplateRows: `repeat(${grid.rows}, 0.9rem)` }}>
              {Array.from({ length: panes.length + grid.blanks }, (_, i) => (
                <span key={i} className={i < panes.length ? (panes[i]!.readOnly ? "bg-on-surface/40" : "bg-on-surface/80") : "border border-dashed border-outline-variant"} />
              ))}
            </div>
          ) : null}
          <ol data-testid="terminal-page-panes" className="grid gap-1 sm:grid-cols-2" aria-label={`Panes on page ${page + 1}`}>
            {panes.map((pane, index) => <PaneItem key={`${pane.seat}\u0000${index}`} pane={pane} />)}
            {grid?.blanks ? <li className="text-xs text-on-surface-variant">{grid.blanks} blank cell{grid.blanks === 1 ? "" : "s"} fill the rectangle</li> : null}
          </ol>
        </div>
      ) : null}

      <Evidence summary="Source evidence · plan and grids" testId="terminal-plan-evidence">
        <FactList>
          <Fact label="View"><ExactId value={data.view} /></Fact>
          <Fact label="Provider"><ExactId value={data.provider} /></Fact>
          <Fact label="Plan"><ExactId value={data.planId} testId="terminal-plan-id" /></Fact>
          <Fact label="Composed">{composed.id ? <ExactId value={composed.id} /> : "not served"}</Fact>
          <Fact label="Grids">{grids.map((g, i) => `p${i + 1} ${g.columns}×${g.rows}+${g.blanks}`).join(" · ") || "none"}</Fact>
        </FactList>
        <p className="mt-2 text-xs text-on-surface-variant">The provider applies equal cells. Saved views store membership only; geometry and page size are not edited here.</p>
      </Evidence>
    </div>
  );
}

function PaneItem({ pane }: { pane: TerminalPreviewPane }) {
  const ssh = pane.paneCommand.startsWith("ssh ");
  return (
    <li data-testid="terminal-pane" className="grid gap-0.5 border-l-2 border-outline-variant pl-2">
      <span className="break-words font-mono text-[11px] text-on-surface">{pane.label || pane.seat}</span>
      <span className="font-mono text-[10px] text-on-surface-variant [overflow-wrap:anywhere]">
        {pane.seat} · {pane.readOnly ? "read-only" : "interactive"}{ssh ? " · over SSH, login not verified until the pane connects" : ""}
      </span>
    </li>
  );
}

function SavedMembership({ entry }: { entry: CatalogEntry }) {
  return (
    <Evidence summary={`Saved membership · ${entry.members.length} as stored`} testId="terminal-saved-membership">
      {entry.members.length === 0 ? <p className="text-sm text-on-surface-variant">This saved view lists no members.</p> : (
        <ul className="grid gap-1">
          {entry.members.map((member, index) => (
            <li key={`${member.seat}\u0000${index}`} className="break-words font-mono text-[11px] text-on-surface [overflow-wrap:anywhere]">
              {member.seat}{member.label ? ` · “${member.label}”` : ""}{member.host ? ` · host ${member.host}` : ""}{member.tmuxSession ? ` · tmux ${member.tmuxSession}` : ""}
              {" · "}{member.readOnly === true ? "read-only" : member.readOnly === false ? "interactive" : "mode set by daemon"}
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-xs text-on-surface-variant">Stored membership is not readiness. The preview above is what Open would use.</p>
    </Evidence>
  );
}

function OpenResult({ record }: { record: TerminalOpenRecord }) {
  const current = admitConnectedLocal(useQueryClient());
  const elsewhere = !current.ok || current.connectionKey !== record.connectionKey;
  const label = (
    <span className="font-mono text-[10px] text-on-surface-variant">
      {record.provider} · plan <ExactId value={record.planId} /> · sent <RecoveryStamp iso={receiptIso(record.submittedAt)} testId="terminal-open-sent-at" />
      {elsewhere ? <span className="block text-warning" data-testid="terminal-open-original-connection">Sent to <ExactId value={record.connectionKey} />, not the instance shown now.</span> : null}
    </span>
  );
  if (record.status === "pending") return <Notice tone="info" title="Opening · sent once" testId="terminal-open-pending" live="polite">{label}<span className="block">Leaving this page does not cancel it; the result is kept here.</span></Notice>;
  if (record.status === "plan_changed") {
    return (
      <Notice tone="warning" title="Plan changed · nothing opened" testId="terminal-open-plan-changed" live="assertive">
        {label}<span className="block">Membership or layout changed after this preview. The preview was refreshed; review it and Open again if it is still what you want.</span>
      </Notice>
    );
  }
  if (record.status === "rejected") return <Notice tone="warning" title="Open refused" testId="terminal-open-rejected" live="assertive">{label}<span className="block">{record.message}{record.httpStatus ? ` (HTTP ${record.httpStatus})` : ""}</span></Notice>;
  if (record.status === "uncertain") {
    return (
      <Notice tone="error" title="Open outcome unknown" testId="terminal-open-uncertain" live="assertive">
        {label}<span className="block">{record.message} Panes may already be open in {record.provider}. Check the provider, refresh the preview, then decide; nothing is resent automatically.</span>
      </Notice>
    );
  }
  const result = record.result!;
  const described = describeOpenResult(result);
  const omitted = omittedFromOpen(record.planned, result);
  const served: unknown = (result as { notes?: unknown }).notes;
  const notes = Array.isArray(served) ? served.filter((n): n is string => typeof n === "string") : [];
  return (
    <Notice tone={!described.ok ? "error" : described.disclosure || omitted.length ? "warning" : "success"} live="polite"
      title={described.ok ? (described.disclosure || omitted.length ? "Opened · partial" : "Opened") : "Open failed · nothing opened"}
      testId={described.ok ? "terminal-open-result" : "terminal-open-zero"}>
      {label}
      <span className="block">{described.headline}</span>
      {described.disclosure ? <span className="block text-warning" data-testid="terminal-open-disclosure">{described.disclosure}</span> : null}
      {omitted.length ? <span className="block text-warning" data-testid="terminal-open-omitted">Planned but not reported opened: {omitted.join(" · ")}</span> : null}
      {notes.map(note => <span key={note} className="block text-on-surface-variant">{note}</span>)}
    </Notice>
  );
}
