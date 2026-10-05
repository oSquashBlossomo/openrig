// Small presentation primitives for exact project and workflow evidence.
// Vellum tokens only. Nothing here infers state: tones are chosen by callers
// from served facts, and "unknown" never renders as success.

import { useCallback, useState, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "../../../lib/utils.js";
import { copyText } from "../../../lib/copy-text.js";
import type { OperatorReadError } from "../../../lib/operator-read.js";
import { useHosts } from "../../../hooks/useHosts.js";
import { LOCAL_HOST_ID } from "../../../lib/host-param.js";
import { DisplayTime } from "../../time/DisplayTime.js";

export type Tone = "neutral" | "good" | "warn" | "bad" | "info" | "muted";

const toneClass: Record<Tone, string> = {
  neutral: "border-outline text-on-surface",
  good: "border-success text-success",
  warn: "border-warning text-warning",
  bad: "border-tertiary text-tertiary",
  info: "border-secondary text-secondary",
  muted: "border-outline-variant text-on-surface-variant",
};

/** Absolute time in the connected instance's configured display zone
 * (`ui.timezone`, via the shared DisplayTime provider). The exact served
 * instant stays in `dateTime`/`title`; missing is "not recorded" and a
 * malformed stamp is "time unknown", never reinterpreted. */
export function Timestamp({ iso, testId, fallback = "not recorded" }: { iso: string | null | undefined; testId?: string; fallback?: string }) {
  return <DisplayTime iso={iso} fallback={fallback} testId={testId} />;
}

export function Tag({ tone = "neutral", children, testId, title }: { tone?: Tone; children: ReactNode; testId?: string; title?: string }) {
  return (
    <span data-testid={testId} data-tone={tone} title={title}
      className={cn("inline-flex shrink-0 items-center border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.08em]", toneClass[tone])}>
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
    <button type="button" data-testid={testId} onClick={() => void onCopy()} aria-label={`${label}: ${value}`}
      className="shrink-0 border border-outline-variant px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.08em] text-on-surface-variant hover:bg-surface-low focus-visible:outline focus-visible:outline-2 focus-visible:outline-on-surface">
      {state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : label}
    </button>
  );
}

/** A served command/string kept byte-for-byte, wrapping instead of truncating. */
export function ExactText({ value, testId, copyLabel = "Copy" }: { value: string; testId?: string; copyLabel?: string }) {
  return (
    <div className="flex min-w-0 items-start gap-2">
      <code data-testid={testId} className="min-w-0 flex-1 whitespace-pre-wrap break-all bg-surface-low px-1.5 py-1 font-mono text-[11px] text-on-surface">{value}</code>
      <CopyButton value={value} label={copyLabel} />
    </div>
  );
}

export function Fields({ children, testId }: { children: ReactNode; testId?: string }) {
  return <dl data-testid={testId} className="grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-[minmax(7rem,11rem)_1fr]">{children}</dl>;
}

export function Field({ label, children, testId }: { label: string; children: ReactNode; testId?: string }) {
  return (
    <>
      <dt className="font-mono text-[10px] uppercase tracking-[0.1em] text-on-surface-variant sm:pt-0.5">{label}</dt>
      <dd data-testid={testId} className="min-w-0 break-words text-sm text-on-surface [overflow-wrap:anywhere]">{children}</dd>
    </>
  );
}

export function Panel({ title, note, children, testId, right }: { title: string; note?: ReactNode; children: ReactNode; testId?: string; right?: ReactNode }) {
  return (
    <section data-testid={testId} className="border-t border-outline-variant pt-3">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-on-surface">{title}</h3>
        {right}
      </div>
      {note ? <p className="mb-2 max-w-[80ch] text-xs text-on-surface-variant">{note}</p> : null}
      {children}
    </section>
  );
}

/** Progressive disclosure for source/basis/technical detail. */
export function Disclose({ summary, children, testId, defaultOpen = false }: { summary: ReactNode; children: ReactNode; testId?: string; defaultOpen?: boolean }) {
  return (
    <details data-testid={testId} open={defaultOpen} className="group mt-1">
      <summary className="cursor-pointer list-none font-mono text-[10px] uppercase tracking-[0.1em] text-on-surface-variant hover:text-on-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-on-surface">
        <span aria-hidden className="mr-1 inline-block transition-transform group-open:rotate-90">▸</span>{summary}
      </summary>
      <div className="mt-1.5 border-l border-outline-variant pl-3">{children}</div>
    </details>
  );
}

export function displayValue(value: unknown): string {
  if (value === null || value === undefined) return "not recorded";
  if (typeof value === "string") return value === "" ? "empty" : value;
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.length ? value.map(displayValue).join(", ") : "none";
  return JSON.stringify(value);
}

/** Record fields as label/value rows, preserving the served bytes. */
export function RecordFields({ value, testId }: { value: Record<string, unknown> | null | undefined; testId?: string }) {
  if (!value) return <p data-testid={testId} className="text-xs text-on-surface-variant">Not recorded.</p>;
  const entries = Object.entries(value);
  if (!entries.length) return <p data-testid={testId} className="text-xs text-on-surface-variant">Empty record.</p>;
  return (
    <Fields testId={testId}>
      {entries.map(([key, v]) => <Field key={key} label={key.replaceAll("_", " ")}><span className="font-mono text-[11px]">{displayValue(v)}</span></Field>)}
    </Fields>
  );
}

// ---------------------------------------------------------------- reads

export interface ReadLike {
  data: unknown;
  error: OperatorReadError | null;
  isFetching: boolean;
  dataUpdatedAt: number;
  refetch: () => unknown;
  scopeSupported?: boolean;
  scopeError?: OperatorReadError | null;
}

function Retry({ onClick, label = "Retry", testId }: { onClick: () => void; label?: string; testId?: string }) {
  return (
    <button type="button" data-testid={testId} onClick={onClick}
      className="mt-2 border border-on-surface px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.1em] hover:bg-surface-low focus-visible:outline focus-visible:outline-2 focus-visible:outline-on-surface">
      {label}
    </button>
  );
}

export function Loading({ what, testId }: { what: string; testId?: string }) {
  return (
    <div role="status" aria-live="polite" data-testid={testId}
      className="border border-dashed border-outline-variant px-4 py-5 font-mono text-[11px] uppercase tracking-[0.12em] text-on-surface-variant">
      <span className="animate-pulse">Reading {what}…</span>
      <span className="mt-1 block normal-case tracking-normal">Nothing is assumed while the read is pending.</span>
    </div>
  );
}

export function ReadError({ error, what, onRetry, testId, children }: { error: OperatorReadError | null; what: string; onRetry?: () => void; testId?: string; children?: ReactNode }) {
  return (
    <div role="alert" data-testid={testId} className="border border-tertiary bg-surface-lowest px-4 py-3">
      <div className="font-mono text-[11px] uppercase tracking-[0.12em] text-tertiary">{what} unavailable</div>
      <p className="mt-1 break-words text-sm text-on-surface">{error?.message ?? "The read did not complete."}</p>
      {error ? (
        <p data-testid={testId ? `${testId}-code` : undefined} className="mt-1 font-mono text-[10px] text-on-surface-variant">
          {error.code}{error.status ? ` · HTTP ${error.status}` : ""}{error.serverCode ? ` · ${error.serverCode}` : ""}
        </p>
      ) : null}
      {children}
      <p className="mt-1 text-xs text-on-surface-variant">Nothing is inferred from a failed read.</p>
      {onRetry ? <Retry onClick={onRetry} testId={testId ? `${testId}-retry` : undefined} /> : null}
    </div>
  );
}

/** Read freshness. A failed refresh never presents retained facts as current. */
export function ReadStatus({ query, served, testId }: { query: ReadLike; served?: { label: string; at: string | null }; testId: string }) {
  const readAt = query.dataUpdatedAt ? new Date(query.dataUpdatedAt).toISOString() : null;
  const stale = query.error !== null && query.data !== undefined;
  return (
    <div data-testid={testId} data-stale={stale ? "true" : "false"} className="mb-3">
      {stale ? (
        <div role="alert" data-testid={`${testId}-stale`} className="mb-2 border border-warning bg-surface-lowest px-3 py-2 text-sm">
          <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-warning">Refresh failed · showing the last successful read</span>
          <p className="mt-1 break-words text-on-surface">{query.error?.message}</p>
          <p className="mt-1 text-xs text-on-surface-variant">These facts were read at <Timestamp iso={readAt} /> and may no longer be current.</p>
          <Retry onClick={() => void query.refetch()} />
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] uppercase tracking-[0.1em] text-on-surface-variant">
        <span>Read <Timestamp iso={readAt} testId={`${testId}-read-at`} /></span>
        {served ? <span>{served.label} <Timestamp iso={served.at} /></span> : null}
        {query.isFetching ? <span aria-live="polite" className="animate-pulse text-on-surface">Refreshing…</span> : null}
        <button type="button" data-testid={`${testId}-refresh`} onClick={() => void query.refetch()}
          className="border border-outline-variant px-2 py-0.5 hover:bg-surface-low focus-visible:outline focus-visible:outline-2 focus-visible:outline-on-surface">
          Refresh
        </button>
      </div>
    </div>
  );
}

/** loading → error → content; a remote/unsupported scope never issues a read. */
export function ReadGate({ query, what, testId, children, errorExtra }: { query: ReadLike; what: string; testId: string; children: () => ReactNode; errorExtra?: (error: OperatorReadError | null) => ReactNode }) {
  if (query.scopeSupported === false) return <ReadError error={query.scopeError ?? null} what={what} testId={`${testId}-unsupported`} />;
  if (query.data === undefined) {
    if (query.error) return <ReadError error={query.error} what={what} onRetry={() => void query.refetch()} testId={`${testId}-error`}>{errorExtra?.(query.error)}</ReadError>;
    return <Loading what={what.toLowerCase()} testId={`${testId}-loading`} />;
  }
  return <>{children()}</>;
}

// --------------------------------------------------------------- scope

/** Canonical project/workflow reads describe the connected instance only. */
export function ConnectedInstanceNote({ subject, testId = "connected-instance-note" }: { subject: string; testId?: string }) {
  const { data, error } = useHosts();
  const selected = data?.selected ?? null;
  const name = data?.ownName?.trim() || null;
  return (
    <div data-testid={testId} className="text-xs text-on-surface-variant">
      <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-on-surface">Connected instance{name ? ` · ${name}` : ""}</span>
      {selected !== null && selected !== LOCAL_HOST_ID ? (
        <p role="note" data-testid={`${testId}-remote`} className="mt-1 max-w-[72ch] border-l-2 border-warning pl-2">
          Topology is viewing <span className="font-mono text-on-surface">{selected}</span>. {subject} still come from this
          browser&apos;s connected instance; they are not forwarded to the remote host.
        </p>
      ) : null}
      {selected === null && error ? (
        <p role="note" data-testid={`${testId}-unknown`} className="mt-1 max-w-[72ch]">
          The topology host selection could not be read. {subject} come from this browser&apos;s connected instance regardless.
        </p>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------ keyboard

/** Arrow/Home/End focus movement across `[data-nav-item]` controls. Selection
 * stays explicit (Enter/Space/click) so browsing does not churn history. */
export function listKeyboard(event: KeyboardEvent<HTMLElement>, orientation: "vertical" | "horizontal" = "vertical") {
  const next = orientation === "vertical" ? "ArrowDown" : "ArrowRight";
  const prev = orientation === "vertical" ? "ArrowUp" : "ArrowLeft";
  if (![next, prev, "Home", "End"].includes(event.key)) return;
  const items = [...event.currentTarget.querySelectorAll<HTMLElement>("[data-nav-item]")].filter((el) => !el.hasAttribute("disabled"));
  if (!items.length) return;
  const index = items.indexOf(document.activeElement as HTMLElement);
  const target = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
    : event.key === next ? Math.min(items.length - 1, index + 1) : Math.max(0, index - 1);
  event.preventDefault();
  items[target]?.focus();
}

export function TabBar<T extends string>({ tabs, active, onSelect, testId, label }: { tabs: ReadonlyArray<{ id: T; label: string; count?: number }>; active: T; onSelect: (id: T) => void; testId: string; label: string }) {
  return (
    <div role="tablist" aria-label={label} data-testid={testId} onKeyDown={(e) => listKeyboard(e, "horizontal")}
      className="mb-4 flex gap-1 overflow-x-auto border-b border-outline-variant">
      {tabs.map((tab) => (
        <button key={tab.id} type="button" role="tab" data-nav-item aria-selected={active === tab.id} tabIndex={active === tab.id ? 0 : -1}
          data-testid={`${testId}-${tab.id}`} onClick={() => onSelect(tab.id)}
          className={cn("-mb-px shrink-0 border-b-2 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.16em] focus-visible:outline focus-visible:outline-2 focus-visible:outline-on-surface",
            active === tab.id ? "border-on-surface text-on-surface" : "border-transparent text-on-surface-variant hover:text-on-surface")}>
          {tab.label}{tab.count !== undefined ? <span className="ml-1 text-on-surface-variant">{tab.count}</span> : null}
        </button>
      ))}
    </div>
  );
}
