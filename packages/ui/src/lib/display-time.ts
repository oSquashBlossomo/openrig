// Display-time contract shared by GUI pages (mirrors packages/tui/src/time.ts).
//
// Presentation only: callers keep the served ISO string (for `dateTime`,
// copy and ordering) and their own relative ages. An absolute time always
// carries its date and zone abbreviation; daylight saving follows the
// named IANA zone. Zone-less or malformed stamps are "time unknown", never
// reinterpreted as browser-local.

export const DEFAULT_TIME_ZONE = "America/Los_Angeles";

export function validTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || !value || /^[+-]/.test(value)) return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone: value }); return true; } catch { return false; }
}

/** Normalizes a served stamp to a parseable ISO string, or null when it is
 * not an exact, zone-qualified timestamp. SQLite `datetime('now')` output
 * ("YYYY-MM-DD HH:MM:SS") is UTC by daemon convention. */
export function exactInstant(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const stamp = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value) ? value.replace(" ", "T") + "Z" : value;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/.test(stamp)) return null;
  const calendarDay = new Date(stamp.slice(0, 10) + "T00:00:00Z");
  if (!Number.isFinite(calendarDay.getTime()) || calendarDay.toISOString().slice(0, 10) !== stamp.slice(0, 10)
    || Number(stamp.slice(11, 13)) > 23) return null;
  return Number.isFinite(new Date(stamp).getTime()) ? stamp : null;
}

/** "YYYY-MM-DD HH:MM:SS ZZZ" in `timeZone` (falls back to the default zone
 * with an explicit marker when the zone is invalid). */
export function formatDisplayTime(value: unknown, timeZone: string = DEFAULT_TIME_ZONE): string {
  const stamp = exactInstant(value);
  if (stamp === null) return "time unknown";
  const zone = validTimeZone(timeZone) ? timeZone : DEFAULT_TIME_ZONE;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", timeZoneName: "short",
  }).formatToParts(new Date(stamp));
  const p = (name: string) => parts.find((part) => part.type === name)?.value ?? "?";
  return `${p("year")}-${p("month")}-${p("day")} ${p("hour")}:${p("minute")}:${p("second")} ${p("timeZoneName")}${zone !== timeZone ? " (timezone fallback)" : ""}`;
}

export type DisplayZoneState = "configured" | "stale" | "invalid" | "unavailable" | "reading";

/** Which zone this browser displays, and why. The connected instance's
 * `ui.timezone` is configuration; this page adopting it is a separate,
 * client-side fact reported here. */
export interface DisplayZone {
  timeZone: string;
  state: DisplayZoneState;
  /** Raw configured value as served (may be invalid), or null when unread. */
  configured: string | null;
  /** Served source of the configured value (env/file/default), when read. */
  source: "env" | "file" | "default" | null;
  /** Human sentence: what is displayed and why. */
  note: string;
}

export function resolveDisplayZone(input: {
  setting: { value: unknown; source: "env" | "file" | "default" } | undefined;
  readState: "reading" | "ready" | "failed" | "stale";
}): DisplayZone {
  const { setting, readState } = input;
  if (readState === "reading" && !setting) {
    return { timeZone: DEFAULT_TIME_ZONE, state: "reading", configured: null, source: null, note: `Reading ui.timezone; showing ${DEFAULT_TIME_ZONE} meanwhile.` };
  }
  if (!setting) {
    const why = readState === "failed" ? "Settings could not be read" : "The connected instance does not report ui.timezone";
    return { timeZone: DEFAULT_TIME_ZONE, state: "unavailable", configured: null, source: null, note: `${why}; showing ${DEFAULT_TIME_ZONE} (fallback).` };
  }
  const configured = typeof setting.value === "string" ? setting.value : String(setting.value);
  if (!validTimeZone(setting.value)) {
    return { timeZone: DEFAULT_TIME_ZONE, state: "invalid", configured, source: setting.source, note: `ui.timezone "${configured}" is not a valid IANA zone; showing ${DEFAULT_TIME_ZONE} (fallback).` };
  }
  if (readState === "stale") {
    return { timeZone: setting.value, state: "stale", configured, source: setting.source, note: `Showing ${setting.value} from the last successful settings read; the latest refresh failed.` };
  }
  return { timeZone: setting.value, state: "configured", configured, source: setting.source, note: `Showing ${setting.value} (ui.timezone · ${setting.source}).` };
}
