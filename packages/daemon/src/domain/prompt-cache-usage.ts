import type { Database } from "better-sqlite3";
import type { ContextUsageStore } from "./context-usage-store.js";
import type { ContextUsage } from "./types.js";
import { deriveActiveOccupantsByNode } from "./active-occupant.js";

type RecordValue = Record<string, unknown>;
const object = (value: unknown): RecordValue | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : null;
const count = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
const identifier = (value: unknown): string | null => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value) ? value : null;
const ratio = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
const sum = (...values: Array<number | null>): number | null => values.every((v) => v !== null) ? count(values.reduce<number>((a, b) => a + b!, 0)) : null;
const CAUSES = new Set(["tools_changed", "system_prompt_changed", "ttl_expired_5m", "ttl_expired_1h", "likely_server_side"]);

function isoSeconds(value: unknown): string | null {
  const seconds = typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
  if (seconds === null) return null;
  const date = new Date(seconds * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function missCause(value: unknown) {
  const raw = object(value);
  if (!raw) return null;
  const causes = Array.isArray(raw.causes) ? [...new Set(raw.causes.filter((c): c is string => typeof c === "string" && CAUSES.has(c)))] : [];
  return {
    causes,
    toolsAdded: count(raw.tools_added), toolsRemoved: count(raw.tools_removed),
    systemCharDelta: typeof raw.system_char_delta === "number" && Number.isSafeInteger(raw.system_char_delta) ? raw.system_char_delta : null,
  };
}

function mainConversation(raw: RecordValue | null) {
  if (!raw) return null;
  const causes = object(raw.miss_causes);
  return {
    scope: "native_main_conversation" as const,
    requests: count(raw.requests), misses: count(raw.misses), expectedRebuilds: count(raw.expected_rebuilds),
    cacheReadRatio: ratio(raw.hit_ratio), cacheWriteTokens: count(raw.cache_write_tokens),
    missRecacheTokens: count(raw.miss_recache_tokens), recacheTokensIfCold: count(raw.recache_tokens_if_cold),
    cachingObserved: typeof raw.caching_observed === "boolean" ? raw.caching_observed : null,
    lastMissAt: isoSeconds(raw.last_miss_at), lastMissCause: missCause(raw.last_miss_cause),
    missCauses: causes ? Object.fromEntries([...CAUSES].filter((key) => count(causes[key]) !== null).map((key) => [key, count(causes[key])])) : null,
  };
}

function lastRequest(raw: RecordValue | null, runtime: string | null) {
  if (!raw) return null;
  const codex = runtime === "codex";
  const input = count(raw.input_tokens);
  let read = count(codex ? raw.cached_input_tokens : raw.cache_read_input_tokens);
  // Codex input already includes cached input; a contradictory subset isn't a measurement.
  if (codex && input !== null && read !== null && read > input) read = null;
  const write = codex ? null : count(raw.cache_creation_input_tokens);
  const total = codex ? input : sum(input, read, write);
  const output = count(raw.output_tokens);
  let reasoning = codex ? count(raw.reasoning_output_tokens) : null;
  if (output !== null && reasoning !== null && reasoning > output) reasoning = null;
  return {
    inputTokens: total,
    uncachedInputTokens: codex ? (input !== null && read !== null ? input - read : null) : input,
    cacheReadTokens: read, cacheWriteTokens: write, outputTokens: output, reasoningOutputTokens: reasoning,
    cacheReadRatio: total !== null && total > 0 && read !== null ? read / total : null,
    // Sidecar collection / token_count event time is not the native request start time.
    requestedAt: null,
  };
}

function retention(raw: RecordValue | null, runtime: string | null, version: string | null, nowIso: string) {
  const ttl = raw?.ttl === "1h" ? 3600 : raw?.ttl === "5m" ? 300 : null;
  const expiresAt = isoSeconds(raw?.expires_at);
  const parts = version?.match(/^(\d+)\.(\d+)\.(\d+)$/)?.slice(1).map(Number);
  const supported = runtime === "claude-code" && parts && (parts[0]! > 2 || parts[0] === 2 && (parts[1]! > 1 || parts[1] === 1 && parts[2]! >= 242));
  return {
    support: supported ? "documented_native_settings" : "unknown",
    source: ttl !== null ? "native_report" : "unknown",
    ttlSeconds: ttl, expiresAt,
    state: ttl !== null && expiresAt && raw?.caching_observed === true && raw.warm === true
      ? Date.parse(expiresAt) > Date.parse(nowIso) ? "warm_estimate" : "expired_estimate"
      : "unknown",
    // Neither reading native settings nor assuming the subscription billing bucket establishes
    // effective TTL: environment/managed settings and native server policy can take precedence.
    configuredTtlSeconds: null,
  };
}

interface SeatRow {
  nodeId: string; rigId: string; logicalId: string; runtime: string | null; configuredModel: string | null;
  bindingName: string | null; attachmentType: string | null;
}
interface SessionRow {
  id: string; nodeId: string; status: string; sessionName: string; resumeToken: string | null; resumeType: string | null;
}

/** A point-in-time projection over already collected telemetry. Never touches native files,
 * providers, terminals or settings; never aggregates polls or native subagent usage. */
export function queryPromptCacheUsage(db: Database, store: Pick<ContextUsageStore, "getForNodes">, nowIso: string, filter: { nodeId?: string; rigId?: string } = {}) {
  const seats = db.prepare(`SELECT n.id AS nodeId, n.rig_id AS rigId, n.logical_id AS logicalId,
    n.runtime, n.model AS configuredModel, b.tmux_session AS bindingName, b.attachment_type AS attachmentType
    FROM nodes n LEFT JOIN bindings b ON b.node_id=n.id
    WHERE (? IS NULL OR n.id=?) AND (? IS NULL OR n.rig_id=?) ORDER BY n.id`)
    .all(filter.nodeId ?? null, filter.nodeId ?? null, filter.rigId ?? null, filter.rigId ?? null) as SeatRow[];
  const sessions = db.prepare(`SELECT id, node_id AS nodeId, status, session_name AS sessionName,
    resume_token AS resumeToken, resume_type AS resumeType FROM sessions WHERE status='running'`).all() as SessionRow[];
  const occupants = deriveActiveOccupantsByNode(sessions, seats.map((s) => s.nodeId));
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const current = new Map(seats.map((seat) => {
    const occupant = occupants[seat.nodeId]!;
    return [seat.nodeId, occupant.kind === "resolved" ? byId.get(occupant.sessionId)! : null];
  }));
  const samples = store.getForNodes(seats.map((seat) => ({ nodeId: seat.nodeId, currentSessionName: current.get(seat.nodeId)?.sessionName ?? null })));
  const rows = seats.map((seat) => {
    const session = current.get(seat.nodeId);
    const sample = samples.get(seat.nodeId);
    let reason: string | null = null;
    if (seat.runtime !== "claude-code" && seat.runtime !== "codex") reason = "unsupported_runtime";
    else if (occupants[seat.nodeId]!.kind === "ambiguous") reason = "ambiguous_session";
    else if (!session) reason = "no_running_session";
    else if (seat.attachmentType === "external_cli") reason = "not_managed";
    else if (seat.bindingName && seat.bindingName !== session.sessionName) reason = "session_mismatch";
    else if (!session.resumeToken || session.resumeType !== (seat.runtime === "codex" ? "codex_id" : "claude_id")) reason = "native_identity_unknown";
    else if (!sample || sample.availability !== "known") reason = sample?.reason ?? "no_data";
    else if (sample.sessionId !== session.resumeToken || sample.sessionName !== session.sessionName) reason = "session_mismatch";
    else if (sample.source !== (seat.runtime === "codex" ? "codex_token_count_jsonl" : "claude_statusline_json")) reason = "source_mismatch";
    else if (!sample.fresh) reason = "stale_sample";
    return projectSeat(seat, reason ? null : sample!, reason, nowIso);
  });
  return {
    observedAt: nowIso,
    cacheKind: "provider_prompt_cache",
    aggregation: "none",
    subscriptionSavings: { status: "unknown", reason: "native_telemetry_does_not_report_subscription_savings" },
    rows,
  };
}

function projectSeat(seat: SeatRow, sample: ContextUsage | null, reason: string | null, nowIso: string) {
  let raw: RecordValue | null = null;
  try { raw = sample?.currentUsage ? object(JSON.parse(sample.currentUsage)) : null; } catch { /* unknown legacy/malformed sample */ }
  if (sample && !raw) reason = "cache_fields_unavailable";
  const metadata = seat.runtime === "claude-code" ? object(raw?.cache_metadata) : null;
  const cache = object(metadata?.prompt_cache);
  const runtimeVersion = identifier(metadata?.runtime_version);
  const request = lastRequest(seat.runtime === "codex" ? object(raw?.last_token_usage) : raw, seat.runtime);
  const cumulative = mainConversation(cache);
  if (!reason && request?.cacheReadTokens == null && request?.cacheWriteTokens == null
    && cumulative?.requests == null && cumulative?.cacheWriteTokens == null && cumulative?.cacheReadRatio == null) {
    reason = "cache_fields_unavailable";
  }
  return {
    nodeId: seat.nodeId, rigId: seat.rigId, logicalId: seat.logicalId, runtime: seat.runtime,
    configuredModel: seat.configuredModel, observedModel: identifier(metadata?.model_id), runtimeVersion,
    // A native client/runtime does not establish its API endpoint or per-request billing bucket.
    providerIdentity: null, billingMode: "unknown",
    availability: reason ? "unknown" : "known", reason,
    source: sample?.source ?? null, sampledAt: sample?.sampledAt ?? null,
    scope: "openrig_seat_main_conversation", nativeSubagents: "not_collected",
    lastRequest: request,
    cumulative,
    retention: retention(cache, seat.runtime, runtimeVersion, nowIso),
  };
}
