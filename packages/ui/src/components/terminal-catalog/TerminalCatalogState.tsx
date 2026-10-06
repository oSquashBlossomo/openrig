// App-lifetime state for the independent terminal catalog. Mount once above the
// route Outlet (next to RecoveryOperationsProvider). It keeps catalog filter,
// selected token, list scroll and provider choice across detail/Back and route
// changes, and owns the single Open lane so an Open that is in flight when the
// operator navigates away still lands somewhere inspectable.
//
// Open is never repeated automatically: a changed plan refreshes the passive
// preview only, and a lost response stays "uncertain" until a newer preview has
// been read and the operator chooses Open again.
//
// Connection provenance: a cached preview is evidence only for the connected
// instance (browser origin + daemon ownName, see connected-admission.ts) it was
// actually READ from. The store records, per preview query, the connection that
// was current when each fetch started; the result is certified for that
// connection only if it is still current when the fetch succeeds and no other
// connection was observed in between. Manually set or pre-subscription data is
// never certified. Open admits only a preview certified for the CURRENT
// connection, so an A preview cannot open on B, and only a genuinely new
// successful read on B can authorize Open on B.

import { createContext, useCallback, useContext, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useQueryClient, type QueryClient, type QueryKey } from "@tanstack/react-query";
import { terminalAuthHeaders } from "../mission-control/missionControlAuth.js";
import type { TerminalPreviewDto } from "../../lib/terminal-read.js";
import type { OpenViewResult } from "../topology/TerminalLauncher.js";
import { LOCAL_HOST_ID } from "../../lib/host-param.js";
import { admitConnectedLocal } from "../startup/connected-admission.js";
import { DEFAULT_TERMINAL_PROVIDER, isOpenViewResult } from "./catalog-model.js";

export interface TerminalOpenRecord {
  readonly id: number;
  /** Original target, retained exactly so the result is never shown against another view. */
  readonly view: string;
  readonly provider: string;
  readonly planId: string;
  /** Seats the validated preview planned to open (in plan order). */
  readonly planned: readonly string[];
  readonly hostId: string;
  /** Connected instance the validated preview was read from and the Open was admitted for. */
  readonly connectionKey: string;
  readonly submittedAt: number;
  readonly settledAt?: number;
  readonly status: "pending" | "settled" | "plan_changed" | "rejected" | "uncertain";
  readonly result?: OpenViewResult;
  readonly httpStatus?: number;
  readonly message?: string;
}

export interface CatalogUiState {
  filter: string;
  /** Token of the row last focused/selected in the list; restored on Back. */
  focusToken: string | null;
  scroll: number;
  provider: string;
}

/** Per preview-query provenance. `started` is the connection current when the
 * in-flight read began (null: not admitted, or tainted by a connection change);
 * `data`/`connectionKey` certify the last successful read. */
interface PreviewProvenance { started?: string | null; data?: unknown; connectionKey: string | null }
export type PreviewProvenanceState = "current" | "foreign" | "unverified";

const isPreviewKey = (key: QueryKey) => key[0] === "terminal" && key[1] === "preview";
const isHostsKey = (key: QueryKey) => key.length === 1 && key[0] === "hosts";
const previewKey = (preview: TerminalPreviewDto) => ["terminal", "preview", LOCAL_HOST_ID, preview.view, preview.provider] as const;

function provenanceOf(client: QueryClient, ledger: Map<string, PreviewProvenance>, preview: TerminalPreviewDto, current: string | null): PreviewProvenanceState {
  const query = client.getQueryCache().find({ queryKey: previewKey(preview), exact: true });
  const entry = query ? ledger.get(query.queryHash) : undefined;
  if (!entry || entry.data !== preview || !entry.connectionKey) return "unverified";
  return entry.connectionKey === current ? "current" : "foreign";
}

const OPEN_DEADLINE_MS = 60_000;
const KNOWN_REFUSAL = new Set([400, 401, 403, 404, 503]);

/** Why this exact preview may not be opened right now, or null when admitted.
 * Checked at invocation against the CURRENT host cache and the CURRENT cached
 * preview entry, so neither a retained object nor a stale render authorizes Open. */
function admitOpen(client: QueryClient, ledger: Map<string, PreviewProvenance>, preview: TerminalPreviewDto, hostId: string,
  last: TerminalOpenRecord | null): { ok: true; connectionKey: string } | { ok: false; reason: string } {
  const refuse = (reason: string) => ({ ok: false as const, reason });
  if (hostId !== LOCAL_HOST_ID) return refuse("Terminal Open acts only on the connected local instance.");
  const host = admitConnectedLocal(client);
  if (!host.ok) return refuse(host.reason);
  const state = client.getQueryState<TerminalPreviewDto>(previewKey(preview));
  if (!state || state.data !== preview || state.status !== "success" || state.fetchStatus !== "idle" || state.isInvalidated) {
    return refuse("This preview is no longer the current validated plan. Refresh the preview, review it, then Open.");
  }
  const provenance = provenanceOf(client, ledger, preview, host.connectionKey);
  if (provenance !== "current") {
    return refuse(provenance === "foreign"
      ? "This preview was read from a different connected instance. Refresh it on the current instance, review it, then Open."
      : "This preview's source instance could not be confirmed. Refresh it on the current instance, review it, then Open.");
  }
  if (!preview.status.available) return refuse(`${preview.provider} is unavailable on the daemon host.`);
  if (!preview.composed.opened.length) return refuse("Nothing in this plan is attachable.");
  if (last && last.status === "uncertain" && last.view === preview.view && last.provider === preview.provider
    && (!last.settledAt || state.dataUpdatedAt <= last.settledAt)) {
    return refuse("The last Open outcome is unknown. Check the provider, then refresh the preview before deciding to Open again.");
  }
  return { ok: true, connectionKey: host.connectionKey };
}

/** Records which connected instance each preview result was actually read from.
 * Layout effect: subscribes before any child observer's passive subscription can
 * start a preview fetch. Listeners run synchronously inside QueryCache dispatch. */
function usePreviewProvenance(client: QueryClient) {
  const ledger = useRef(new Map<string, PreviewProvenance>());
  useLayoutEffect(() => client.getQueryCache().subscribe(event => {
    const map = ledger.current;
    if (event.type === "removed") { if (isPreviewKey(event.query.queryKey)) map.delete(event.query.queryHash); return; }
    if (event.type !== "updated") return;
    if (isHostsKey(event.query.queryKey)) {
      // Any observed connection change taints reads that began elsewhere.
      const now = admitConnectedLocal(client);
      for (const entry of map.values()) {
        if (entry.started !== undefined && (!now.ok || now.connectionKey !== entry.started)) entry.started = null;
      }
      return;
    }
    if (!isPreviewKey(event.query.queryKey)) return;
    const entry = map.get(event.query.queryHash) ?? { connectionKey: null };
    const action = event.action;
    if (action.type === "fetch") {
      const now = admitConnectedLocal(client);
      entry.started = now.ok ? now.connectionKey : null;
    } else if (action.type === "success") {
      const now = admitConnectedLocal(client);
      const certified = !action.manual && entry.started && now.ok && now.connectionKey === entry.started ? entry.started : null;
      entry.data = event.query.state.data;
      entry.connectionKey = certified;
      entry.started = undefined;
    } else if (action.type === "error") {
      entry.started = undefined;
    }
    map.set(event.query.queryHash, entry);
  }), [client]);
  return ledger.current;
}

function useCatalogValue() {
  const client = useQueryClient();
  const [ui, setUi] = useState<CatalogUiState>({ filter: "", focusToken: null, scroll: 0, provider: DEFAULT_TERMINAL_PROVIDER });
  const [lastOpen, setLastOpenState] = useState<TerminalOpenRecord | null>(null);
  // Mirror for invocation-time checks and settlement; render state follows it.
  const lastOpenRef = useRef<TerminalOpenRecord | null>(null);
  const writeLastOpen = useCallback((next: TerminalOpenRecord | null) => { lastOpenRef.current = next; setLastOpenState(next); }, []);
  const inflight = useRef(false);
  const seq = useRef(0);
  const updateUi = useCallback((patch: Partial<CatalogUiState>) => setUi(previous => ({ ...previous, ...patch })), []);
  const ledger = usePreviewProvenance(client);

  /** Read-only provenance of a preview relative to the current connection (for presentation). */
  const previewProvenance = useCallback((preview: TerminalPreviewDto): PreviewProvenanceState => {
    const host = admitConnectedLocal(client);
    return provenanceOf(client, ledger, preview, host.ok ? host.connectionKey : null);
  }, [client, ledger]);

  /** Open exactly this validated preview. Returns a refusal reason, or null when sent. */
  const open = useCallback((preview: TerminalPreviewDto, hostId: string): string | null => {
    if (inflight.current) return "An Open is still awaiting its result.";
    const admission = admitOpen(client, ledger, preview, hostId, lastOpenRef.current);
    if (!admission.ok) return admission.reason;
    inflight.current = true;
    const id = ++seq.current;
    writeLastOpen({ id, view: preview.view, provider: preview.provider, planId: preview.planId, hostId, connectionKey: admission.connectionKey,
      planned: preview.composed.opened.map(pane => pane.seat), submittedAt: Date.now(), status: "pending" });

    // Exactly one settlement per attempt. The total deadline covers headers AND
    // body decoding independently of whether the transport honours abort; a late
    // response after settlement is disposed and never overwrites the outcome.
    let finished = false;
    let response: Response | undefined;
    const dispose = () => { void response?.body?.cancel().catch(() => {}); };
    const finish = (patch: Partial<TerminalOpenRecord>) => {
      if (finished) return false;
      finished = true;
      clearTimeout(timer);
      inflight.current = false;
      const current = lastOpenRef.current;
      if (current?.id === id) writeLastOpen({ ...current, ...patch, settledAt: Date.now() });
      return true;
    };
    const controller = new AbortController();
    const timer = setTimeout(() => {
      if (finish({ status: "uncertain", message: `No complete response within ${OPEN_DEADLINE_MS / 1000} seconds.` })) { controller.abort(); dispose(); }
    }, OPEN_DEADLINE_MS);

    void (async () => {
      try {
        response = await fetch("/api/terminal/open", {
          method: "POST", signal: controller.signal,
          headers: { "Content-Type": "application/json", Accept: "application/json", ...terminalAuthHeaders() },
          body: JSON.stringify({ provider: preview.provider, view: preview.view, expectedPlan: preview.planId }),
        });
      } catch {
        finish({ status: "uncertain", message: "The response was lost." });
        return;
      }
      if (finished) { dispose(); return; }
      let body: unknown;
      try { body = await response.json(); } catch { body = undefined; }
      if (finished) return;
      const code = body && typeof body === "object" && typeof (body as { code?: unknown }).code === "string" ? (body as { code: string }).code : undefined;
      const error = body && typeof body === "object" ? (body as { error?: unknown }).error : undefined;
      if (response.status === 409 && code === "preview_changed") {
        // Refresh the passive preview only; the operator must review it and Open again.
        void client.invalidateQueries({ queryKey: ["terminal", "preview", hostId, preview.view, preview.provider] });
        finish({ status: "plan_changed", httpStatus: 409, message: typeof error === "string" ? error : undefined });
        return;
      }
      if (!response.ok) {
        const message = typeof error === "string" ? error : code ?? `HTTP ${response.status}`;
        finish({ status: KNOWN_REFUSAL.has(response.status) ? "rejected" : "uncertain", httpStatus: response.status, message });
        return;
      }
      if (!isOpenViewResult(body)) {
        finish({ status: "uncertain", httpStatus: response.status, message: "The Open response could not be verified." });
        return;
      }
      // The result is provider-bound; another provider's result cannot verify this attempt.
      if (body.provider !== preview.provider) {
        finish({ status: "uncertain", httpStatus: response.status,
          message: `The response describes provider “${body.provider}”, not the requested “${preview.provider}”, so this Open cannot be verified.` });
        return;
      }
      finish({ status: "settled", httpStatus: response.status, result: body });
    })().catch(() => { finish({ status: "uncertain", message: "The response could not be processed." }); });
    return null;
  }, [client, ledger, writeLastOpen]);

  const clearLastOpen = useCallback(() => { if (!inflight.current) writeLastOpen(null); }, [writeLastOpen]);

  return { ui, updateUi, lastOpen, openPending: lastOpen?.status === "pending", open, clearLastOpen, previewProvenance };
}

export type TerminalCatalogStore = ReturnType<typeof useCatalogValue>;
const CatalogContext = createContext<TerminalCatalogStore | null>(null);

export function TerminalCatalogStateProvider({ children }: { children: ReactNode }) {
  const value = useCatalogValue();
  return <CatalogContext.Provider value={value}>{children}</CatalogContext.Provider>;
}

export function useTerminalCatalogStore(): TerminalCatalogStore {
  const value = useContext(CatalogContext);
  if (!value) throw new Error("TerminalCatalogStateProvider must wrap the route Outlet so catalog context and Open results outlive the page.");
  return value;
}
