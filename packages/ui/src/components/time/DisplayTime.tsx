// App-lifetime display-time adoption and the shared <DisplayTime> element.
//
// The provider adopts the connected instance's `ui.timezone` from the
// existing settings read (no new API, no writes). Changing it stays the
// persistent CLI action the TUI documents. Pages render absolute times with
// <DisplayTime iso=…/>: visible text in the adopted zone, the exact served
// ISO in `dateTime`/`title`.

import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useSettings } from "../../hooks/useSettings.js";
import { DEFAULT_TIME_ZONE, exactInstant, formatDisplayTime, resolveDisplayZone, type DisplayZone } from "../../lib/display-time.js";

const FALLBACK: DisplayZone = {
  timeZone: DEFAULT_TIME_ZONE, state: "unavailable", configured: null, source: null,
  note: `Display timezone not adopted on this surface; showing ${DEFAULT_TIME_ZONE} (fallback).`,
};

const DisplayZoneContext = createContext<DisplayZone>(FALLBACK);

export function DisplayTimeProvider({ children }: { children: ReactNode }) {
  const settings = useSettings();
  const setting = (settings.data?.settings as Record<string, { value: unknown; source: "env" | "file" | "default" } | undefined> | undefined)?.["ui.timezone"];
  const readState = settings.error ? (settings.data ? "stale" : "failed") : settings.data ? "ready" : "reading";
  const zone = useMemo(() => resolveDisplayZone({ setting, readState }), [setting, readState]);
  return <DisplayZoneContext.Provider value={zone}>{children}</DisplayZoneContext.Provider>;
}

export function useDisplayZone(): DisplayZone {
  return useContext(DisplayZoneContext);
}

/** Absolute time in the adopted zone; exact served value kept on the element. */
export function DisplayTime({ iso, fallback = "time unknown", testId, className }: { iso: string | null | undefined; fallback?: string; testId?: string; className?: string }) {
  const zone = useDisplayZone();
  const exact = exactInstant(iso);
  if (!iso) return <span data-testid={testId} className={className ?? "text-on-surface-variant"}>{fallback}</span>;
  if (!exact) return <span data-testid={testId} title={iso} className={className ?? "text-on-surface-variant"}>time unknown</span>;
  return (
    <time data-testid={testId} dateTime={exact} title={`${iso} · ${zone.note}`} className={className}>
      {formatDisplayTime(exact, zone.timeZone)}
    </time>
  );
}

/** Visible zone/source disclosure for a page or settings section. */
export function DisplayZoneNote({ testId = "display-zone-note", className }: { testId?: string; className?: string }) {
  const zone = useDisplayZone();
  const warn = zone.state !== "configured";
  return (
    <p data-testid={testId} data-state={zone.state} className={className ?? `font-mono text-[10px] ${warn ? "text-warning" : "text-on-surface-variant"}`}>
      Times: {zone.note}
    </p>
  );
}
