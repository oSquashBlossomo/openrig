// Small Vellum primitives shared by the startup chooser, connected fleet
// restore and the independent terminal catalog. Long identities wrap instead
// of truncating: an exact ID is only useful if it can be read and copied whole.

import { useEffect, useLayoutEffect, useRef, type ButtonHTMLAttributes, type ReactNode, type UIEvent } from "react";
import { cn } from "../../lib/utils.js";
import { DisplayTime } from "../time/DisplayTime.js";

export type RecoveryTone = "neutral" | "success" | "warning" | "error" | "info";

const toneBorder: Record<RecoveryTone, string> = {
  neutral: "border-outline-variant",
  success: "border-success",
  warning: "border-warning",
  error: "border-tertiary",
  info: "border-secondary",
};
const toneText: Record<RecoveryTone, string> = {
  neutral: "text-on-surface-variant",
  success: "text-success",
  warning: "text-warning",
  error: "text-tertiary",
  info: "text-secondary",
};

export function SurfaceHeader({ eyebrow, title, description, testId, children }: {
  eyebrow: string; title: string; description: ReactNode; testId: string; children?: ReactNode;
}) {
  return (
    <header data-testid={`${testId}-header`} className="mb-4 border-b border-outline-variant pb-4">
      <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-on-surface-variant">{eyebrow}</p>
      <h1 className="mt-1 font-headline text-headline-md font-bold uppercase tracking-tight text-on-surface">{title}</h1>
      <div className="mt-1 max-w-[72ch] text-sm text-on-surface-variant">{description}</div>
      {children}
    </header>
  );
}

export function SectionLabel({ children, id }: { children: ReactNode; id?: string }) {
  return <h2 id={id} className="font-mono text-[10px] uppercase tracking-[0.18em] text-on-surface-variant">{children}</h2>;
}

export function Notice({ tone = "neutral", title, children, testId, live }: {
  tone?: RecoveryTone; title: ReactNode; children?: ReactNode; testId?: string; live?: "polite" | "assertive";
}) {
  const role = live === "assertive" ? "alert" : live === "polite" ? "status" : undefined;
  return (
    <div role={role} data-testid={testId} className={cn("border-l-2 bg-surface-lowest px-3 py-2", toneBorder[tone])}>
      <p className={cn("font-mono text-[10px] uppercase tracking-[0.14em]", toneText[tone])}>{title}</p>
      {children ? <div className="mt-1 break-words text-sm text-on-surface">{children}</div> : null}
    </div>
  );
}

export function Badge({ tone = "neutral", children, testId }: { tone?: RecoveryTone; children: ReactNode; testId?: string }) {
  return (
    <span data-testid={testId} className={cn("inline-flex items-center border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.12em]", toneBorder[tone], toneText[tone])}>
      {children}
    </span>
  );
}

/** Exact identity: never truncated, wraps anywhere, copyable as text. */
export function ExactId({ value, testId, className }: { value: string; testId?: string; className?: string }) {
  return <code data-testid={testId} className={cn("font-mono text-[11px] text-on-surface [overflow-wrap:anywhere]", className)}>{value}</code>;
}

export function FactList({ children, testId }: { children: ReactNode; testId?: string }) {
  return <dl data-testid={testId} className="grid grid-cols-1 gap-x-4 gap-y-1.5 sm:grid-cols-[minmax(9rem,max-content)_1fr]">{children}</dl>;
}

export function Fact({ label, children, testId }: { label: string; children: ReactNode; testId?: string }) {
  return (
    <>
      <dt className="font-mono text-[10px] uppercase tracking-[0.12em] text-on-surface-variant">{label}</dt>
      <dd data-testid={testId} className="min-w-0 break-words text-sm text-on-surface">{children}</dd>
    </>
  );
}

/** Progressive disclosure for source evidence that dense rows should not repeat. */
export function Evidence({ summary, children, testId }: { summary: ReactNode; children: ReactNode; testId?: string }) {
  return (
    <details data-testid={testId} className="border border-outline-variant bg-surface-lowest">
      <summary className="cursor-pointer px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-on-surface-variant focus-visible:outline focus-visible:outline-2 focus-visible:outline-on-surface">
        {summary}
      </summary>
      <div className="border-t border-outline-variant px-3 py-2">{children}</div>
    </details>
  );
}

const buttonVariant = {
  primary: "bg-inverse-surface text-background border-inverse-surface hover:opacity-90",
  secondary: "bg-surface-lowest text-on-surface border-on-surface hover:bg-surface-low",
  danger: "bg-surface-lowest text-tertiary border-tertiary hover:bg-surface-low",
  quiet: "bg-transparent text-on-surface border-outline-variant hover:bg-surface-low",
} as const;

export function ActionButton({ variant = "secondary", className, type = "button", ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: keyof typeof buttonVariant }) {
  return (
    <button
      type={type}
      className={cn(
        // 44px touch target on phones, dense 32px from sm up.
        "inline-flex min-h-[2.75rem] items-center justify-center gap-1.5 border px-3 py-1 font-mono text-[10px] uppercase tracking-[0.14em] sm:min-h-[2rem]",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-on-surface",
        "disabled:cursor-not-allowed disabled:opacity-50",
        buttonVariant[variant],
        className,
      )}
      {...rest}
    />
  );
}

/** Absolute receipt/read stamp in the connected instance's adopted display zone
 * (shared DisplayTimeProvider). The exact original ISO stays on the element;
 * absent → "unknown", malformed/zone-less → "time unknown". Never browser-local. */
export function RecoveryStamp({ iso, testId }: { iso: string | null | undefined; testId?: string }) {
  return <DisplayTime iso={iso} fallback="unknown" testId={testId} className="whitespace-nowrap" />;
}

/** Exact ISO for a client-observed millisecond receipt (e.g. query dataUpdatedAt);
 * null when the receipt does not exist yet. */
export function receiptIso(ms: number | null | undefined): string | null {
  return typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
}

/** Restore a retained scroll offset once content for `restoreKey` is present,
 * track it while scrolling, and hand the latest offset back on unmount (route
 * change or detail view). A key change (another rig) resets tracking to the
 * retained value for that key instead of carrying the old list's offset. */
export function useRetainedScroll<T extends HTMLElement>(retained: number, save: (top: number) => void, restoreKey: string | null) {
  const ref = useRef<T>(null);
  const latest = useRef(retained);
  const saveRef = useRef(save); saveRef.current = save;
  useLayoutEffect(() => {
    latest.current = retained;
    if (restoreKey !== null && ref.current) ref.current.scrollTop = retained;
  }, [restoreKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => saveRef.current(latest.current), []);
  return { ref, onScroll: (event: UIEvent<T>) => { latest.current = event.currentTarget.scrollTop; } };
}
