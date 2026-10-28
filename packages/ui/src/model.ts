// Pure helpers over daemon payloads: no fetching, no React.
import type { AttentionItem, SeatNode } from "./api.js";

export type Tone = "ok" | "busy" | "warn" | "bad" | "off";

/** One dot per seat: what an operator wants to know at a glance. */
export function seatTone(n: SeatNode): Tone {
  if (n.sessionStatus !== "running") return n.intentionallyStopped ? "off" : "bad";
  if (n.activityState?.needsInput.count) return "warn";
  if (n.needsAttention || n.lifecycleState === "attention_required") return "warn";
  if (n.activityState?.display === "active" || n.activityState?.activity === "working") return "busy";
  return "ok";
}

const humanize = (s: string) => s.replace(/[_-]+/g, " ");

export function seatStatusLabel(n: SeatNode): string {
  if (n.sessionStatus !== "running") return n.intentionallyStopped ? "stopped" : humanize(n.sessionStatus);
  if (n.activityState?.needsInput.count) return "needs input";
  if (n.startupStatus && n.startupStatus !== "ready") return humanize(n.startupStatus);
  if (n.needsAttention || n.lifecycleState === "attention_required") return "needs attention";
  return humanize(n.activityState?.display ?? "running");
}

/** Attention scopes name rigs and seats by ULID; swap in the names the fleet knows. */
export function resolveIds(text: string, nodes: Iterable<SeatNode>): string {
  let out = text;
  const seen = new Set<string>();
  for (const n of nodes) {
    if (!seen.has(n.rigId)) { seen.add(n.rigId); out = out.split(n.rigId).join(n.rigName); }
    out = out.split(n.nodeId).join(n.canonicalSessionName);
  }
  return out;
}

export function contextPercent(n: SeatNode): number | null {
  const c = n.contextUsage;
  if (!c || c.availability !== "known" || typeof c.usedPercentage !== "number") return null;
  return Math.max(0, Math.min(100, Math.round(c.usedPercentage)));
}

export function shortModel(model: string | null): string {
  if (!model) return "";
  return model.replace(/^claude-/, "").replace(/^gpt-/, "gpt-");
}

const URGENCY_RANK: Record<string, number> = { critical: 0, urgent: 1, warning: 2, info: 3 };

export function sortAttention(items: AttentionItem[]): AttentionItem[] {
  return [...items].sort((a, b) => {
    const ra = URGENCY_RANK[a.urgency] ?? 9;
    const rb = URGENCY_RANK[b.urgency] ?? 9;
    if (ra !== rb) return ra - rb;
    return (b.at ?? "").localeCompare(a.at ?? "");
  });
}

/** "member@rig" from an attention scope like "instance health · seat / <rigId> / <seatId>" is not
 *  derivable; the seat page link comes from the item's source path when it names a session. */
export function timeAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "";
  const t = Date.parse(iso.includes("T") ? iso : iso.replace(" ", "T") + "Z");
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

export function sessionParts(session: string): { member: string; rig: string } {
  const i = session.indexOf("@");
  return i < 0 ? { member: session, rig: "" } : { member: session.slice(0, i), rig: session.slice(i + 1) };
}
