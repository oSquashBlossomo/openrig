// Pure catalog model for the independent terminal destination. Tokens are built
// exactly as the TUI does (terminals/terminal-model.ts readTerminals): Saved
// `saved:<exact id>` and Derived `rig:<served rig name>`. A display name is never
// turned back into a token, so a saved view and a rig that share a name stay two
// distinct targets.

import type { TerminalViewsResponse, SavedViewMemberDto } from "../../lib/terminal-read.js";
import type { OpenViewResult } from "../topology/TerminalLauncher.js";

export type CatalogKind = "saved" | "derived";

export interface CatalogEntry {
  /** Exact view token sent to preview/open. */
  readonly token: string;
  readonly kind: CatalogKind;
  /** Served display name (saved view name, or rig name for derived). */
  readonly name: string;
  /** Saved membership as served; empty for derived rigs (membership comes from preview). */
  readonly members: readonly SavedViewMemberDto[];
  /** Other catalog entries whose display name is identical. */
  readonly sameNameTokens: readonly string[];
}

export function buildTerminalCatalog(views: TerminalViewsResponse): CatalogEntry[] {
  const rows: Omit<CatalogEntry, "sameNameTokens">[] = [
    ...views.saved.map(saved => ({ token: `saved:${saved.id}`, kind: "saved" as const, name: saved.name, members: saved.members })),
    ...views.rigs.map(name => ({ token: `rig:${name}`, kind: "derived" as const, name, members: [] as SavedViewMemberDto[] })),
  ];
  return rows.map(row => ({ ...row, sameNameTokens: rows.filter(other => other.token !== row.token && other.name === row.name).map(other => other.token) }));
}

/** Filters by name, exact token and saved member seat/label. */
export function filterCatalog(entries: readonly CatalogEntry[], filter: string): CatalogEntry[] {
  const needle = filter.trim().toLowerCase();
  if (!needle) return [...entries];
  return entries.filter(entry => [entry.name, entry.token, ...entry.members.flatMap(member => [member.seat, member.label ?? ""])]
    .some(text => text.toLowerCase().includes(needle)));
}

export const TYPED_VIEW_PREFIXES = ["saved:", "rig:", "pod:", "mission:", "slice:"] as const;
export type TypedViewKind = "saved" | "rig" | "pod" | "mission" | "slice";

/** Accepts only a full typed token. A bare name is refused rather than guessed:
 * the daemon would otherwise resolve it as a rig name, then a saved-view ID. */
export function parseTypedViewToken(input: string): { ok: true; token: string; kind: TypedViewKind } | { ok: false; reason: string } {
  const token = input.trim();
  if (!token) return { ok: false, reason: "Enter a view token." };
  const prefix = TYPED_VIEW_PREFIXES.find(p => token.startsWith(p));
  if (!prefix) {
    return { ok: false, reason: "Use a full typed token: saved:<id>, rig:<name>, pod:<rig>/<pod>, mission:<id> or slice:<name>. Bare names are not resolved here." };
  }
  if (!token.slice(prefix.length).trim()) return { ok: false, reason: `“${prefix}” needs an exact identity after the prefix.` };
  return { ok: true, token, kind: prefix.slice(0, -1) as TypedViewKind };
}

export interface ProviderOption { readonly id: string; readonly label: string; readonly note: string }
/** Herdr is the daemon's default provider. Availability and paging belong to the server's preview. */
export const TERMINAL_PROVIDERS: readonly ProviderOption[] = [
  { id: "herdr", label: "herdr", note: "Default provider. Pages and grid come from the daemon preview." },
  { id: "cmux", label: "cmux", note: "Best-effort provider. Pages and grid come from the daemon preview." },
];
export const DEFAULT_TERMINAL_PROVIDER = "herdr";

const isText = (v: unknown): v is string => typeof v === "string";
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Structural guard for the shared OpenViewResult body (daemon OpenViewResult). */
export function isOpenViewResult(v: unknown): v is OpenViewResult {
  return isObj(v) && isText(v.provider) && typeof v.ok === "boolean" && Array.isArray(v.opened) && v.opened.every(isText)
    && Array.isArray(v.absent) && v.absent.every(a => isObj(a) && isText(a.seat) && (a.host === null || isText(a.host)) && isText(a.reason))
    && Array.isArray(v.degraded) && v.degraded.every(d => isObj(d) && isText(d.seat) && isText(d.host) && isText(d.reason))
    && typeof v.pages === "number" && (v.error === undefined || isText(v.error)) && (v.code === undefined || isText(v.code));
}

/** Seats the preview planned to open that the result did not report opened. */
export function omittedFromOpen(planned: readonly string[], result: OpenViewResult): string[] {
  const opened = new Set(result.opened);
  const named = new Set([...result.absent.map(a => a.seat), ...result.degraded.map(d => d.seat)]);
  return planned.filter(seat => !opened.has(seat) && !named.has(seat));
}
