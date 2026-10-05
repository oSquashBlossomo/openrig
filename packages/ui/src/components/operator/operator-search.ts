// Typed URL state for the connected-instance operator pages.
//
// Selection and filters ride the query string so direct links, reloads and
// Back restore the exact view. Validation keeps only well-formed values and
// never maps an unrelated identifier onto a different entity: an unknown
// value is dropped (filters) or retained verbatim for an explicit
// "unrecognized" notice (selected IDs), never coerced.

const MAX_ID_LENGTH = 512;

function text(value: unknown, max = MAX_ID_LENGTH): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= max ? trimmed : undefined;
}

function member<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
}

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

// ---------------------------------------------------------------- For You

export const FOR_YOU_VIEWS = ["attention", "activity"] as const;
export type ForYouView = (typeof FOR_YOU_VIEWS)[number];
export const ATTENTION_LENSES = ["all", "action", "update", "delivered"] as const;
export interface ForYouSearch {
  view?: ForYouView;
  item?: string;
  /** Attention lens; absent = all. */
  lens?: Exclude<(typeof ATTENTION_LENSES)[number], "all">;
  q?: string;
}

export function validateForYouSearch(search: Record<string, unknown>): ForYouSearch {
  const lens = member(search.lens, ATTENTION_LENSES);
  return compact({ view: member(search.view, FOR_YOU_VIEWS), item: text(search.item), lens: lens === "all" ? undefined : lens, q: text(search.q, 200) });
}

/** Canonical attention identifiers are typed by prefix. A delivered update is
 * resolved only from the delivered-updates dataset; the others are resolved
 * only by the canonical `/api/attention?item=` read. Anything else is an
 * unrecognized link and is not requested. */
export type AttentionIdKind = "queue" | "proof" | "workflow" | "health" | "human-update" | "unrecognized";

export function classifyAttentionId(id: string): AttentionIdKind {
  const match = /^(queue|proof|workflow|health|human-update):(.+)$/.exec(id);
  return match ? (match[1] as AttentionIdKind) : "unrecognized";
}

// ----------------------------------------------------------------- Health

export const HEALTH_SEVERITIES = ["critical", "warning", "info"] as const;
export const HEALTH_STATUSES = ["active", "indeterminate", "cleared"] as const;
export const HEALTH_SCOPE_TYPES = ["instance", "rig", "seat", "mission", "slice"] as const;
export type HealthScopeType = (typeof HEALTH_SCOPE_TYPES)[number];

export interface HealthSearch {
  finding?: string;
  severity?: (typeof HEALTH_SEVERITIES)[number];
  status?: (typeof HEALTH_STATUSES)[number];
  /** Exact canonical scope filter; both must be present (daemon contract). */
  scopeType?: HealthScopeType;
  scopeId?: string;
  q?: string;
}

export function validateHealthSearch(search: Record<string, unknown>): HealthSearch {
  const scopeType = member(search.scopeType, HEALTH_SCOPE_TYPES);
  const scopeId = text(search.scopeId);
  const paired = scopeType !== undefined && scopeId !== undefined;
  return compact({
    finding: text(search.finding),
    severity: member(search.severity, HEALTH_SEVERITIES),
    status: member(search.status, HEALTH_STATUSES),
    scopeType: paired ? scopeType : undefined,
    scopeId: paired ? scopeId : undefined,
    q: text(search.q, 200),
  });
}

// ---------------------------------------------------------- Configuration

export const CONFIGURATION_GROUPS = ["general", "slack", "people", "hosts", "health"] as const;
export type ConfigurationGroup = (typeof CONFIGURATION_GROUPS)[number];

export interface ConfigurationSearch {
  key?: string;
  /** Exact subject for subject-scoped entries; absent for unscoped keys. */
  subject?: string;
  group?: ConfigurationGroup;
  q?: string;
}

export function validateConfigurationSearch(search: Record<string, unknown>): ConfigurationSearch {
  const key = text(search.key);
  return compact({
    key,
    subject: key ? text(search.subject) : undefined,
    group: member(search.group, CONFIGURATION_GROUPS),
    q: text(search.q, 200),
  });
}

// ------------------------------------------------------------ Connections

export interface ConnectionsSearch { human?: string; q?: string }

export function validateConnectionsSearch(search: Record<string, unknown>): ConnectionsSearch {
  return compact({ human: text(search.human), q: text(search.q, 200) });
}
