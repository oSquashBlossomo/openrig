// Truthful route-level fallbacks for lazily loaded operator page modules.
// Eagerly bundled and intentionally tiny: these render while (or when) a
// page chunk loads, so they must not import the page code they stand in for.

import type { ErrorComponentProps } from "@tanstack/react-router";

export function OperatorRoutePending({ label }: { label: string }) {
  return (
    <div role="status" aria-live="polite" data-testid="operator-route-pending" className="mx-auto w-full max-w-[1200px] px-6 py-8 font-mono text-[11px] uppercase tracking-[0.12em] text-on-surface-variant">
      <span className="animate-pulse">Loading {label}…</span>
    </div>
  );
}

export function OperatorRouteError({ error, label }: ErrorComponentProps & { label: string }) {
  return (
    <div role="alert" data-testid="operator-route-error" className="mx-auto w-full max-w-[1200px] px-6 py-8">
      <div className="border border-tertiary bg-surface-lowest px-4 py-3">
        <p className="font-mono text-[11px] uppercase tracking-[0.12em] text-tertiary">{label} could not be displayed</p>
        <p className="mt-1 break-words text-sm text-on-surface">{error instanceof Error ? error.message : String(error)}</p>
        <p className="mt-1 text-xs text-on-surface-variant">If the page module failed to load (for example after an update), reloading fetches it again. No data was changed.</p>
        <button type="button" onClick={() => window.location.reload()} className="mt-2 border border-on-surface px-2 py-0.5 font-mono text-[10px] uppercase hover:bg-surface-low">
          Reload page
        </button>
      </div>
    </div>
  );
}
