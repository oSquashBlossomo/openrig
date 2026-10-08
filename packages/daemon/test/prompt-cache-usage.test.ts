import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { ContextUsageStore } from "../src/domain/context-usage-store.js";
import type { queryPromptCacheUsage } from "../src/domain/prompt-cache-usage.js";
import { telemetryRoutes } from "../src/routes/telemetry.js";

const NOW = "2026-10-07T12:00:00.000Z";
const nativeCache = {
  warm: true, caching_observed: true, ttl: "1h", expires_at: Date.parse(NOW) / 1000 + 1200,
  requests: 14, misses: 2, expected_rebuilds: 1, hit_ratio: 0.91,
  cache_write_tokens: 352000, miss_recache_tokens: 310200, last_miss_at: Date.parse(NOW) / 1000 - 100,
  last_miss_cause: { causes: ["tools_changed"], tools_added: 2, tools_removed: 0, private_prompt: "PRIVATE" },
  miss_causes: { tools_changed: 2 }, recache_tokens_if_cold: 45000, private_prompt: "PRIVATE",
};

describe("prompt cache telemetry (saved observations only)", () => {
  let db: ReturnType<typeof createDb>;
  let store: ContextUsageStore;
  let repo: RigRepository;
  let sessions: SessionRegistry;
  let app: Hono;
  beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(NOW);
    db = createDb(); migrate(db, ALL_MIGRATIONS);
    repo = new RigRepository(db); sessions = new SessionRegistry(db);
    store = new ContextUsageStore(db, { stateDir: "/unused-cache-fixture", resolveOccupantBootAt: () => "2026-10-07 11:00:00" });
    app = new Hono().route("/api/telemetry", telemetryRoutes({ db: () => db, contextUsageStore: store, nowIso: () => new Date().toISOString() }));
  });
  afterEach(() => { db.close(); vi.useRealTimers(); });
  function seed(runtime = "claude-code", key = "main") {
    const rig = repo.createRig(`cache-${key}`);
    const node = repo.addNode(rig.id, `dev.${key}`, { runtime, model: "configured-model" });
    const name = `dev-${key}@cache-${key}`;
    const session = sessions.registerSession(node.id, name);
    db.prepare("UPDATE sessions SET status = 'running', resume_type = ?, resume_token = ? WHERE id = ?")
      .run(runtime === "codex" ? "codex_id" : "claude_id", `native-${key}`, session.id);
    sessions.updateBinding(node.id, { tmuxSession: name, tmuxPane: "%1" });
    const raw = {
      context_window: { used_percentage: 20, current_usage: { input_tokens: 100, cache_creation_input_tokens: 400, cache_read_input_tokens: 500, output_tokens: 40 } },
      session_id: `native-${key}`, session_name: name, sampled_at: NOW,
      transcript_path: "/private/transcripts/PRIVATE", cache_metadata: { runtime_version: "2.1.293", model_id: "claude-opus-5-5", prompt_cache: nativeCache },
    };
    store.persist(node.id, store.normalizeSample(raw));
    return { node, session, name, raw };
  }
  async function read(query = "") {
    const response = await app.request(`/api/telemetry/usage/cache${query}`);
    expect(response.status).toBe(200);
    return await response.json() as ReturnType<typeof queryPromptCacheUsage>;
  }

  it("separates last-request tokens from native cumulative statistics and unknown subscription savings", async () => {
    seed(); const body = await read(); const row = body.rows[0]!;
    expect(row.availability).toBe("known");
    expect(row.runtime).toBe("claude-code");
    expect(row.runtimeVersion).toBe("2.1.293");
    expect(row.observedModel).toBe("claude-opus-5-5");
    expect(row.configuredModel).toBe("configured-model");
    expect(row.providerIdentity).toBeNull();
    expect(row.billingMode).toBe("unknown");
    expect(row.lastRequest).toEqual({ inputTokens: 1000, uncachedInputTokens: 100, cacheReadTokens: 500, cacheWriteTokens: 400, outputTokens: 40, reasoningOutputTokens: null, cacheReadRatio: 0.5, requestedAt: null });
    expect(row.cumulative).toMatchObject({ scope: "native_main_conversation", requests: 14, misses: 2, expectedRebuilds: 1, cacheReadRatio: 0.91, cacheWriteTokens: 352000 });
    expect(row.retention).toMatchObject({ ttlSeconds: 3600, state: "warm_estimate", source: "native_report", configuredTtlSeconds: null });
    expect(body.subscriptionSavings).toEqual({ status: "unknown", reason: "native_telemetry_does_not_report_subscription_savings" });
    expect(JSON.stringify(body)).not.toMatch(/PRIVATE|transcript|native-main/);
    expect(row.cumulative!.lastMissCause).toEqual({ causes: ["tools_changed"], toolsAdded: 2, toolsRemoved: 0, systemCharDelta: null });
  });

  it("reads repeatedly without writing, summing cumulative samples or moving cache expiry", async () => {
    seed(); const before = db.serialize(); const first = await read();
    vi.setSystemTime(Date.parse(NOW) + 30_000); const second = await read();
    expect(second.rows[0]!.cumulative).toEqual(first.rows[0]!.cumulative);
    expect(second.rows[0]!.retention).toEqual(first.rows[0]!.retention);
    expect(db.serialize()).toEqual(before);
  });

  it("TTL expiry is an estimate, never a newly observed miss or a poll refresh", async () => {
    const { node, raw } = seed(); raw.cache_metadata.prompt_cache = { ...nativeCache, expires_at: Date.parse(NOW) / 1000 + 60 };
    store.persist(node.id, store.normalizeSample(raw));
    vi.setSystemTime(Date.parse(NOW) + 61_000);
    const row = (await read()).rows[0]!;
    expect(row.retention.state).toBe("expired_estimate");
    expect(row.cumulative!.misses).toBe(2);
  });

  it.each([
    ["native token changed", "UPDATE sessions SET resume_token = 'replacement'", "session_mismatch"],
    ["token unknown", "UPDATE sessions SET resume_token = NULL", "native_identity_unknown"],
    ["name-only resume", "UPDATE sessions SET resume_type = 'claude_name'", "native_identity_unknown"],
    ["binding moved", "UPDATE bindings SET tmux_session = 'somewhere-else'", "session_mismatch"],
    ["stopped seat", "UPDATE sessions SET status = 'exited'", "no_running_session"],
  ])("does not attribute old evidence when %s", async (_label, sql, reason) => {
    seed(); db.exec(sql); const row = (await read()).rows[0]!;
    expect(row.availability).toBe("unknown"); expect(row.reason).toBe(reason);
    expect(row.lastRequest).toBeNull(); expect(row.cumulative).toBeNull();
  });

  it("rejects two running occupants rather than choosing the newest", async () => {
    const { node, name } = seed(); const second = sessions.registerSession(node.id, name);
    db.prepare("UPDATE sessions SET status='running' WHERE id=?").run(second.id);
    expect((await read()).rows[0]!.reason).toBe("ambiguous_session");
  });

  it.each(["stale", "future", "invalid", "prior_generation"])("keeps %s timestamps unknown", async (kind) => {
    const { node } = seed();
    const stamp = kind === "stale" ? "2026-10-07T11:45:00Z" : kind === "future" ? "2026-10-07T12:01:00Z" : kind === "prior_generation" ? "2026-10-07T10:59:59Z" : "bad";
    db.prepare("UPDATE context_usage SET sampled_at=? WHERE node_id=?").run(stamp, node.id);
    const row = (await read()).rows[0]!;
    expect(row.availability).toBe("unknown"); expect(row.lastRequest).toBeNull();
  });

  it("keeps missing fields unknown; zero observed tokens are not missing or cache misses", async () => {
    const { node, raw } = seed();
    store.persist(node.id, store.normalizeSample({ ...raw, cache_metadata: undefined, context_window: { used_percentage: 0, current_usage: { input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 } } }));
    const row = (await read()).rows[0]!;
    expect(row.lastRequest!.cacheReadTokens).toBe(0);
    expect(row.lastRequest!.cacheWriteTokens).toBeNull();
    expect(row.lastRequest!.inputTokens).toBeNull();
    expect(row.lastRequest!.cacheReadRatio).toBeNull();
    expect(row.cumulative).toBeNull(); expect(row.runtimeVersion).toBeNull();
    expect(row.retention.state).toBe("unknown");
  });

  it("drops malformed, negative, unsafe and infinite counters instead of publishing invented measurements", async () => {
    const { node } = seed();
    db.prepare("UPDATE context_usage SET current_usage=? WHERE node_id=?").run('{"input_tokens":-1,"cache_read_input_tokens":1e999,"cache_creation_input_tokens":2,"output_tokens":"20","cache_metadata":{"prompt_cache":{"requests":9007199254740992,"hit_ratio":2,"misses":-1,"ttl":"forever","expires_at":1e999}}}', node.id);
    const row = (await read()).rows[0]!;
    expect(row.lastRequest!.inputTokens).toBeNull(); expect(row.lastRequest!.cacheReadTokens).toBeNull();
    expect(row.lastRequest!.outputTokens).toBeNull(); expect(row.cumulative!.requests).toBeNull();
    expect(row.cumulative!.cacheReadRatio).toBeNull(); expect(row.cumulative!.misses).toBeNull();
    expect(row.retention.state).toBe("unknown");
  });

  it("Codex cached-input is a subset of input, and absent write/TTL/provider evidence stays unknown", async () => {
    const { node, name } = seed("codex");
    store.persist(node.id, { availability: "known", reason: null, source: "codex_token_count_jsonl", usedPercentage: 1, remainingPercentage: 99, contextWindowSize: 200000, totalInputTokens: 1000, totalOutputTokens: 40, currentUsage: JSON.stringify({ last_token_usage: { input_tokens: 1000, cached_input_tokens: 700, output_tokens: 40, reasoning_output_tokens: 10 }, total_token_usage: { input_tokens: 9000, cached_input_tokens: 8000 } }), transcriptPath: "/PRIVATE", sessionId: "native-main", sessionName: name, sampledAt: NOW, fresh: true });
    const row = (await read()).rows[0]!;
    expect(row.lastRequest).toEqual({ inputTokens: 1000, uncachedInputTokens: 300, cacheReadTokens: 700, cacheWriteTokens: null, outputTokens: 40, reasoningOutputTokens: 10, cacheReadRatio: 0.7, requestedAt: null });
    expect(row.cumulative).toBeNull(); expect(row.runtimeVersion).toBeNull(); expect(row.observedModel).toBeNull();
    expect(row.retention.state).toBe("unknown"); expect(row.retention.support).toBe("unknown");
  });

  it("rejects telemetry from a different runtime and malformed legacy payloads", async () => {
    const { node } = seed();
    db.prepare("UPDATE context_usage SET source='codex_token_count_jsonl' WHERE node_id=?").run(node.id);
    expect((await read()).rows[0]!.reason).toBe("source_mismatch");
    db.prepare("UPDATE context_usage SET source='claude_statusline_json', current_usage='[broken' WHERE node_id=?").run(node.id);
    const row = (await read()).rows[0]!;
    expect(row.reason).toBe("cache_fields_unavailable"); expect(row.lastRequest).toBeNull();
  });

  it("does not sum a lower or older cumulative snapshot, or treat it as a newly observed reset", async () => {
    const { node, raw } = seed(); await read();
    store.persist(node.id, store.normalizeSample({ ...raw, sampled_at: "2026-10-07T11:59:00Z", cache_metadata: { ...raw.cache_metadata, prompt_cache: { ...nativeCache, requests: 1, misses: 0, cache_write_tokens: 400 } } }));
    const row = (await read()).rows[0]!;
    expect(row.sampledAt).toBe("2026-10-07T11:59:00Z");
    expect(row.cumulative).toMatchObject({ requests: 1, misses: 0, cacheWriteTokens: 400 });
  });

  it("does not call runtime metadata alone cache evidence", async () => {
    const { node, raw } = seed();
    store.persist(node.id, store.normalizeSample({ ...raw, context_window: { used_percentage: 0, current_usage: null }, cache_metadata: { runtime_version: "2.1.293" } }));
    const row = (await read()).rows[0]!;
    expect(row.availability).toBe("unknown"); expect(row.reason).toBe("cache_fields_unavailable");
    expect(row.retention.state).toBe("unknown"); expect(row.cumulative).toBeNull();
    expect(row.lastRequest).toBeNull();
    expect(row.runtimeVersion).toBe("2.1.293");
  });

  it("retains cumulative cache evidence without claiming a last request when native current_usage is null", async () => {
    const { node, raw } = seed();
    store.persist(node.id, store.normalizeSample({ ...raw, context_window: { used_percentage: 0, current_usage: null } }));
    const row = (await read()).rows[0]!;
    expect(row.lastRequest).toBeNull();
    expect(row.availability).toBe("known");
    expect(row.cumulative).toMatchObject({ requests: 14, cacheWriteTokens: 352000 });
    expect(row.retention).toMatchObject({ ttlSeconds: 3600, state: "warm_estimate" });
  });

  it("hides even an unexpired one-hour estimate once its sample reaches ten minutes", async () => {
    seed();
    vi.setSystemTime(Date.parse(NOW) + 599_999);
    expect((await read()).rows[0]!.retention.state).toBe("warm_estimate");
    vi.setSystemTime(Date.parse(NOW) + 600_000);
    const row = (await read()).rows[0]!;
    expect(row.reason).toBe("stale_sample");
    expect(row.lastRequest).toBeNull(); expect(row.cumulative).toBeNull();
    expect(row.retention).toMatchObject({ state: "unknown", ttlSeconds: null, expiresAt: null });
  });

  it("preserves legacy Claude cache counters without inventing native cumulative or TTL data", async () => {
    const { node, raw } = seed();
    store.persist(node.id, store.normalizeSample({ ...raw, cache_metadata: undefined }));
    const row = (await read()).rows[0]!;
    expect(row.lastRequest?.cacheReadRatio).toBe(0.5);
    expect(row.cumulative).toBeNull(); expect(row.retention.ttlSeconds).toBeNull();
  });

  it("filters exact node ids, and unsupported runtimes remain visible as unknown", async () => {
    seed(); const other = seed("pi", "other");
    const body = await read(`?nodeId=${other.node.id}`);
    expect(body.rows).toHaveLength(1); expect(body.rows[0]!.reason).toBe("unsupported_runtime");
  });

  it("contains read failures without SQL or private paths", async () => {
    db.exec("DROP TABLE context_usage");
    const response = await app.request("/api/telemetry/usage/cache");
    // Seed a node to require a store lookup, without touching the missing table.
    expect(response.status).toBe(200);
    const rig = repo.createRig("failure"); repo.addNode(rig.id, "dev.failure", { runtime: "codex" });
    const failed = await app.request("/api/telemetry/usage/cache");
    expect(failed.status).toBe(503); expect(await failed.text()).not.toMatch(/SQL|context_usage|\/private/);
  });
});
