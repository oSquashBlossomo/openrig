// Shared chrome for the connected-instance operator pages (Health, Attention,
// Configuration, Connections).
//
// Every canonical projection here describes the CONNECTED instance — the
// daemon this browser is served by. The topology host selection does not
// retarget these reads (they are not forwardable) and must not relabel them.

import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "../../lib/utils.js";
import { copyText } from "../../lib/copy-text.js";
import { useHosts } from "../../hooks/useHosts.js";
import { LOCAL_HOST_ID } from "../../lib/host-param.js";
import type { OperatorReadError } from "../../lib/operator-read.js";
import { SectionHeader } from "../ui/section-header.js";
import { DisplayTime, DisplayZoneNote } from "../time/DisplayTime.js";

// ------------------------------------------------------------------ time

/** Absolute times use the shared display-time contract: the connected
 * instance's ui.timezone (visible zone), the exact served ISO kept on the
 * element, and "time unknown" for malformed or zone-less stamps. */
export function Timestamp({ iso, testId, fallback = "unknown" }: { iso: string | null | undefined; testId?: string; fallback?: string }) {
  return <DisplayTime iso={iso} testId={testId} fallback={fallback} />;
}

export function formatAgeSeconds(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return "unknown";
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

// --------------------------------------------------------------- instance

export interface ConnectedInstance {
  /** Daemon-reported instance display name, when the hosts read has landed. */
  name: string | null;
  /** Why `name` is null: still reading, read failed, or daemon reported none. */
  nameState: "reported" | "reading" | "unavailable" | "unreported";
  /** Remote topology host currently selected, or null when local/unknown. */
  remoteSelection: string | null;
}

export function useConnectedInstance(): ConnectedInstance {
  const { data, error } = useHosts();
  const ownName = data?.ownName && data.ownName.trim() !== "" ? data.ownName.trim() : null;
  const selected = data?.selected ?? LOCAL_HOST_ID;
  const nameState = ownName ? "reported" : data ? "unreported" : error ? "unavailable" : "reading";
  return { name: ownName, nameState, remoteSelection: selected !== LOCAL_HOST_ID ? selected : null };
}

/** "Connected instance · <name>" without guessing a name that was not read. */
export function connectedInstanceLabel(instance: ConnectedInstance): string {
  const name = instance.name ?? (instance.nameState === "reading" ? "name loading…" : instance.nameState === "unavailable" ? "name unavailable" : "name not reported");
  return `Connected instance · ${name}`;
}

export function OperatorPageHeader({ title, description, testId, actions }: { title: string; description: ReactNode; testId: string; actions?: ReactNode }) {
  const instance = useConnectedInstance();
  return (
    <header className="mb-4 border-b border-outline-variant pb-4" data-testid={`${testId}-header`}>
      <SectionHeader tone="muted">System · connected instance</SectionHeader>
      <div className="mt-1 flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="font-headline text-headline-md font-bold uppercase tracking-tight text-on-surface">{title}</h1>
        {actions}
      </div>
      <p className="mt-1 max-w-[72ch] text-sm text-on-surface-variant">{description}</p>
      <p data-testid="operator-instance-label" className="mt-2 font-mono text-[10px] uppercase tracking-[0.14em] text-on-surface">
        {connectedInstanceLabel(instance)}
      </p>
      <DisplayZoneNote testId={`${testId}-display-zone`} className="mt-1 font-mono text-[10px] text-on-surface-variant" />
      {instance.remoteSelection ? (
        <p
          data-testid="operator-remote-context"
          role="note"
          className="mt-2 max-w-[72ch] border-l-2 border-warning pl-2 text-xs text-on-surface-variant"
        >
          Topology is viewing <span className="font-mono text-on-surface">{instance.remoteSelection}</span>. This page still
          describes the connected instance{instance.name ? <> (<span className="font-mono">{instance.name}</span>)</> : null}; the remote
          host&apos;s {title.toLowerCase()} is not served here.
        </p>
      ) : null}
    </header>
  );
}

// ------------------------------------------------------------- read state

export interface OperatorQueryLike {
  data: unknown;
  error: OperatorReadError | null;
  isPending: boolean;
  isFetching: boolean;
  dataUpdatedAt: number;
  refetch: () => unknown;
  scopeSupported?: boolean;
  scopeError?: OperatorReadError | null;
}

export function LoadingBlock({ label, testId }: { label: string; testId?: string }) {
  return (
    <div role="status" aria-live="polite" data-testid={testId} className="border border-dashed border-outline-variant px-4 py-6 font-mono text-[11px] uppercase tracking-[0.12em] text-on-surface-variant">
      <span className="animate-pulse">Reading {label} from the connected instance…</span>
      <span className="mt-1 block normal-case tracking-normal">Reads time out after 5 seconds; nothing is assumed meanwhile.</span>
    </div>
  );
}

export function ReadFailure({ error, onRetry, what, testId }: { error: OperatorReadError | null; onRetry?: () => void; what: string; testId?: string }) {
  return (
    <div role="alert" data-testid={testId} className="border border-tertiary bg-surface-lowest px-4 py-3">
      <div className="font-mono text-[11px] uppercase tracking-[0.12em] text-tertiary">{what} unavailable</div>
      <p className="mt-1 break-words text-sm text-on-surface">{error?.message ?? "The read did not complete."}</p>
      {error?.code ? <p className="mt-1 font-mono text-[10px] text-on-surface-variant">code {error.code}{error.status ? ` · HTTP ${error.status}` : ""}{error.serverCode ? ` · ${error.serverCode}` : ""}</p> : null}
      <p className="mt-1 text-xs text-on-surface-variant">No state is inferred from a failed read.</p>
      {onRetry ? <RetryButton onClick={onRetry} /> : null}
    </div>
  );
}

function RetryButton({ onClick, label = "Retry" }: { onClick: () => void; label?: string }) {
  return (
    <button type="button" onClick={onClick} className="mt-2 border border-on-surface px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.1em] hover:bg-surface-low focus-visible:outline focus-visible:outline-2 focus-visible:outline-on-surface">
      {label}
    </button>
  );
}

/**
 * Read status for a query that already has data. A refetch failure never
 * presents the retained payload as current: it is labeled with its own read
 * time and the failure stays visible until a later read succeeds.
 */
export function ReadStatusBar({ query, servedAt, servedLabel = "served", testId, what }: { query: OperatorQueryLike; servedAt?: string | null; servedLabel?: string; testId: string; what?: string }) {
  const readAt = query.dataUpdatedAt ? new Date(query.dataUpdatedAt).toISOString() : null;
  const stale = query.error !== null && query.data !== undefined;
  return (
    <div data-testid={testId} data-stale={stale ? "true" : "false"} className="mb-3">
      {stale ? (
        <div role="alert" data-testid={`${testId}-stale`} className="mb-2 border border-warning bg-surface-lowest px-3 py-2 text-sm">
          <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-warning">{what ? `${what} refresh failed` : "Refresh failed"} · showing last successful read</span>
          <p className="mt-1 break-words text-on-surface">{query.error?.message}</p>
          <p className="mt-1 text-xs text-on-surface-variant">
            The facts below were read at <Timestamp iso={readAt} /> and may no longer be current.
          </p>
          <RetryButton onClick={() => void query.refetch()} />
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] uppercase tracking-[0.1em] text-on-surface-variant">
        <span>Read <Timestamp iso={readAt} testId={`${testId}-read-at`} /></span>
        {servedAt !== undefined ? <span>{servedLabel} <Timestamp iso={servedAt} /></span> : null}
        {query.isFetching ? <span aria-live="polite" className="animate-pulse text-on-surface">Refreshing…</span> : null}
        <button
          type="button"
          data-testid={`${testId}-refresh`}
          onClick={() => void query.refetch()}
          className="border border-outline-variant px-2 py-0.5 hover:bg-surface-low focus-visible:outline focus-visible:outline-2 focus-visible:outline-on-surface"
        >
          Refresh
        </button>
      </div>
    </div>
  );
}

/** Gate a page body on a canonical read: loading → failure → content. */
export function OperatorReadGate({ query, what, testId, children }: { query: OperatorQueryLike; what: string; testId: string; children: () => ReactNode }) {
  if (query.scopeSupported === false) return <ReadFailure error={query.scopeError ?? null} what={what} testId={`${testId}-unsupported`} />;
  if (query.data === undefined) {
    if (query.error) return <ReadFailure error={query.error} what={what} onRetry={() => void query.refetch()} testId={`${testId}-error`} />;
    return <LoadingBlock label={what.toLowerCase()} testId={`${testId}-loading`} />;
  }
  return <>{children()}</>;
}

// ---------------------------------------------------------------- pieces

export type Tone = "neutral" | "good" | "warn" | "bad" | "info" | "muted";

const toneClass: Record<Tone, string> = {
  neutral: "border-outline text-on-surface",
  good: "border-success text-success",
  warn: "border-warning text-warning",
  bad: "border-tertiary text-tertiary",
  info: "border-secondary text-secondary",
  muted: "border-outline-variant text-on-surface-variant",
};

export function Tag({ tone = "neutral", children, testId, title }: { tone?: Tone; children: ReactNode; testId?: string; title?: string }) {
  return (
    <span data-testid={testId} title={title} className={cn("inline-flex shrink-0 items-center border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.08em]", toneClass[tone])}>
      {children}
    </span>
  );
}

export function CopyButton({ value, label = "Copy", testId }: { value: string; label?: string; testId?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const onCopy = useCallback(async () => {
    const ok = await copyText(value);
    setState(ok ? "copied" : "failed");
    setTimeout(() => setState("idle"), 1500);
  }, [value]);
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={() => void onCopy()}
      aria-label={`${label}: ${value}`}
      className="shrink-0 border border-outline-variant px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.08em] text-on-surface-variant hover:bg-surface-low focus-visible:outline focus-visible:outline-2 focus-visible:outline-on-surface"
    >
      {state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : label}
    </button>
  );
}

export function Fields({ children, testId }: { children: ReactNode; testId?: string }) {
  return <dl data-testid={testId} className="grid grid-cols-1 gap-x-4 gap-y-1.5 sm:grid-cols-[minmax(8rem,12rem)_1fr]">{children}</dl>;
}

export function Field({ label, children, testId, copy }: { label: string; children: ReactNode; testId?: string; copy?: string }) {
  return (
    <>
      <dt className="font-mono text-[10px] uppercase tracking-[0.1em] text-on-surface-variant sm:pt-0.5">{label}</dt>
      <dd data-testid={testId} className="flex min-w-0 items-start gap-2 break-words text-sm text-on-surface [overflow-wrap:anywhere]">
        <span className="min-w-0 flex-1">{children}</span>
        {copy ? <CopyButton value={copy} /> : null}
      </dd>
    </>
  );
}

export function DetailSection({ title, children, testId, note }: { title: string; children: ReactNode; testId?: string; note?: ReactNode }) {
  return (
    <section data-testid={testId} className="border-t border-outline-variant pt-3">
      <h3 className="mb-2 font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-on-surface">{title}</h3>
      {note ? <p className="mb-2 text-xs text-on-surface-variant">{note}</p> : null}
      {children}
    </section>
  );
}

/** Expandable full payload. Never the primary interface; for technical detail only. */
export function TechnicalDetails({ value, summary = "Technical detail (served JSON)", testId }: { value: unknown; summary?: string; testId?: string }) {
  return (
    <details data-testid={testId} className="border-t border-outline-variant pt-3">
      <summary className="cursor-pointer font-mono text-[10px] uppercase tracking-[0.12em] text-on-surface-variant hover:text-on-surface">{summary}</summary>
      <pre className="mt-2 max-h-[28rem] overflow-auto whitespace-pre-wrap break-words bg-surface-low p-2 font-mono text-[11px] text-on-surface [overflow-wrap:anywhere]">
        {JSON.stringify(value, null, 2)}
      </pre>
    </details>
  );
}

export function displayScalar(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (Array.isArray(value)) return value.length ? value.map(displayScalar).join(", ") : "none";
  if (typeof value === "object") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

/** Moves focus between `[data-list-item]` buttons with Arrow/Home/End keys.
 * Selection itself stays explicit (Enter/click) so browsing does not churn history. */
export function listKeyboardHandler(event: KeyboardEvent<HTMLElement>) {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("[data-list-item]"));
  if (!items.length) return;
  const index = items.indexOf(document.activeElement as HTMLElement);
  const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
    : event.key === "ArrowDown" ? Math.min(items.length - 1, index + 1) : Math.max(0, index < 0 ? 0 : index - 1);
  event.preventDefault();
  items[next]?.focus();
}

/** Maximum search text carried in the URL (mirrors the `q` validators). */
export const SEARCH_TEXT_MAX = 200;

/**
 * Local text for a URL-backed search field. Keystrokes stay responsive in
 * local state and are written to the URL; any URL value this component did
 * not write itself (Back/Forward, a link, same-route navigation) replaces
 * the local text, so the field and the filtered rows always follow the URL.
 */
export function useUrlSyncedText(urlValue: string | undefined, write: (value: string | undefined) => void): [string, (value: string) => void] {
  const [text, setText] = useState(urlValue ?? "");
  // URL values written by this field and not yet observed back.
  const pending = useRef<Array<string | undefined>>([]);
  useEffect(() => {
    const index = pending.current.indexOf(urlValue);
    if (index >= 0) {
      pending.current = pending.current.slice(index + 1);
      return;
    }
    pending.current = [];
    setText(urlValue ?? "");
  }, [urlValue]);
  const update = useCallback((value: string) => {
    setText(value);
    const next = value.trim() || undefined;
    if (pending.current[pending.current.length - 1] !== next) pending.current.push(next);
    write(next);
  }, [write]);
  return [text, update];
}

export function SearchInput({ value, onChange, label, placeholder, testId, maxLength = SEARCH_TEXT_MAX }: { value: string; onChange: (value: string) => void; label: string; placeholder?: string; testId?: string; maxLength?: number }) {
  return (
    <label className="flex min-w-[12rem] flex-1 items-center gap-2 border border-outline-variant bg-surface-lowest px-2 py-1 focus-within:border-on-surface">
      <span className="sr-only">{label}</span>
      <span aria-hidden className="font-mono text-[10px] uppercase text-on-surface-variant">Find</span>
      <input
        type="search"
        data-testid={testId}
        value={value}
        maxLength={maxLength}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="min-w-0 flex-1 bg-transparent text-sm text-on-surface outline-none placeholder:text-on-surface-variant"
      />
    </label>
  );
}

export function ChipGroup<T extends string>({ label, value, options, onChange, testId }: {
  label: string; value: T; options: Array<{ id: T; label: string; count?: number }>; onChange: (value: T) => void; testId: string;
}) {
  return (
    <div role="group" aria-label={label} data-testid={testId} className="flex flex-wrap items-center gap-1">
      <span className="mr-1 font-mono text-[9px] uppercase tracking-[0.12em] text-on-surface-variant">{label}</span>
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          aria-pressed={value === option.id}
          data-testid={`${testId}-${option.id}`}
          onClick={() => onChange(option.id)}
          className={cn(
            "border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.06em] focus-visible:outline focus-visible:outline-2 focus-visible:outline-on-surface",
            value === option.id ? "border-on-surface bg-inverse-surface text-background" : "border-outline-variant text-on-surface hover:bg-surface-low",
          )}
        >
          {option.label}{option.count !== undefined ? ` ${option.count}` : ""}
        </button>
      ))}
    </div>
  );
}

/** Responsive list/detail. On narrow screens a selection shows the detail
 * first with an explicit return to the list; nothing essential is hidden. */
export function ListDetailLayout({ list, detail, hasSelection, onClearSelection, listLabel, testId }: {
  list: ReactNode; detail: ReactNode; hasSelection: boolean; onClearSelection: () => void; listLabel: string; testId: string;
}) {
  return (
    <div data-testid={testId} className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(18rem,26rem)_1fr]">
      <div className={cn("min-w-0", hasSelection && "hidden lg:block")}>{list}</div>
      <div className={cn("min-w-0", !hasSelection && "hidden lg:block")}>
        {hasSelection ? (
          <button
            type="button"
            onClick={onClearSelection}
            data-testid={`${testId}-back`}
            className="mb-2 font-mono text-[10px] uppercase tracking-[0.12em] text-on-surface-variant hover:text-on-surface lg:hidden"
          >
            ← {listLabel}
          </button>
        ) : null}
        {detail}
      </div>
    </div>
  );
}
