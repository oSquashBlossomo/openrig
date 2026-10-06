// Pure presentation model for canonical Attention plus delivered human updates.
//
// The daemon composes the canonical action/update set (`/api/attention`).
// Delivered human updates are a separate bounded projection
// (`/api/queue/human-updates`) and stay a separate lens: they are never
// promoted to actions and never resolved through canonical attention detail.

import type { AttentionItem, AttentionRead, DeliveredHumanUpdate, DeliveredHumanUpdates } from "../../hooks/useCanonicalAttention.js";

export const HUMAN_UPDATE_PREFIX = "human-update:";

export interface AttentionRow {
  item: AttentionItem;
  /** Set when this row was carried over from an earlier read because the
   * source it depends on is unavailable now. Never shown as current. */
  retainedFrom?: string;
}

export function humanUpdateId(qitemId: string): string {
  return `${HUMAN_UPDATE_PREFIX}${qitemId}`;
}

export function deliveredUpdateSummary(update: DeliveredHumanUpdate): string {
  return update.summary || update.body.trim().split(/\r?\n/).find(Boolean) || "Delivered update";
}

/** Project tags are a queue annotation, not catalog identity: name them as such. */
export function deliveredUpdateScope(update: DeliveredHumanUpdate): string {
  const projects = [...new Set((update.tags ?? []).filter((tag) => tag.startsWith("project:")).map((tag) => tag.slice(8)))];
  return projects.length === 1 ? `project ${projects[0]} (queue tag)` : "instance · project unknown";
}

export function findDeliveredUpdate(updates: DeliveredHumanUpdates | undefined, id: string): DeliveredHumanUpdate | undefined {
  if (!id.startsWith(HUMAN_UPDATE_PREFIX)) return undefined;
  const qitemId = id.slice(HUMAN_UPDATE_PREFIX.length);
  return updates?.items.find((update) => update.qitemId === qitemId);
}

/** The aggregate's declared source dependencies (mirrors the TUI continuity rule). */
export function itemDependsOnSource(item: AttentionItem, source: string): boolean {
  if (source === "queue") return item.id.startsWith("queue:");
  if (source === "health") return item.id.startsWith("health:");
  if (source === "mission outcomes") return item.id.startsWith("workflow:");
  if (source === "project catalog") return item.id.startsWith("proof:") || item.id.startsWith("workflow:");
  if (!item.id.startsWith("proof:") || !item.project) return false;
  const project = `proof: project ${item.project.id}`;
  if (source === project) return true;
  if (!source.startsWith(project + "/")) return false;
  const [mission, slice] = source.slice(project.length + 1).split("/");
  return item.id.startsWith(`proof:${item.project.id}:${mission}/${slice ? `slices/${slice}:` : ""}`);
}

export interface PriorAttention { readAt: string; rows: AttentionRow[] }

/** Merge only rows whose source is unavailable now. A successful empty or
 * bounded window is a new answer and removes old rows. A retained row keeps
 * the read time it was last actually served at across repeated failures. */
export function attentionRows(read: AttentionRead, prior: PriorAttention | null): AttentionRow[] {
  const rows: AttentionRow[] = read.items.map((item) => ({ item }));
  if (!prior || prior.readAt === read.readAt) return rows;
  const failed = read.sources.filter((source) => source.state === "unavailable");
  if (!failed.length) return rows;
  const current = new Set(read.items.map((item) => item.id));
  for (const row of prior.rows) {
    if (current.has(row.item.id)) continue;
    if (failed.some((source) => itemDependsOnSource(row.item, source.source))) rows.push({ item: row.item, retainedFrom: row.retainedFrom ?? prior.readAt });
  }
  return rows;
}

export type AttentionLens = "all" | "action" | "update" | "delivered";

export function matchesQuery(fields: Array<string | null | undefined>, query: string): boolean {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const haystack = fields.filter(Boolean).join(" ").toLocaleLowerCase();
  return words.every((word) => haystack.includes(word));
}

export function filterAttentionRows(rows: AttentionRow[], kind: "action" | "update", query: string): AttentionRow[] {
  return rows.filter(({ item }) => item.kind === kind
    && matchesQuery([item.summary, item.scope, item.recipient, item.id, item.unblocks, item.urgency], query));
}

export function filterDeliveredUpdates(updates: DeliveredHumanUpdate[], query: string): DeliveredHumanUpdate[] {
  return updates.filter((update) => matchesQuery([deliveredUpdateSummary(update), update.body, update.humanDetail,
    update.destinationSession, update.sourceSession, update.qitemId, ...(update.tags ?? [])], query));
}

/** Split an attention detail file path into a readable absolute path and anchor. */
export function splitFileAnchor(path: string): { file: string; anchor: string | null } {
  const hash = path.indexOf("#");
  return hash < 0 ? { file: path, anchor: null } : { file: path.slice(0, hash), anchor: path.slice(hash + 1) || null };
}
