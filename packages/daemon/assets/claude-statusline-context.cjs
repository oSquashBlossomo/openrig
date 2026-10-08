#!/usr/bin/env node
// OpenRig Claude Status Line Context Collector
// Reads Claude status line JSON from stdin, extracts context window data,
// and writes atomically to a sidecar file.
//
// Usage: node claude-statusline-context.js <context-output-path-or-dir> [provider-usage-dir]

const fs = require("fs");
const path = require("path");

const outputTarget = process.argv[2];
const providerUsageTarget = process.argv[3];
if (!outputTarget) {
  process.exit(0); // No output path — silently exit
}

function logFailure(message, error) {
  const suffix = error && error.message ? `: ${error.message}` : "";
  console.error(`[openrig][collector] ${message}${suffix}`);
}

let input = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  try {
    const raw = JSON.parse(input);
    const contextWindow = raw.context_window;
    if (!contextWindow) {
      logFailure("missing context_window in Claude status line payload");
      process.exit(0);
    }

    const sample = {
      context_window: {
        context_window_size: contextWindow.context_window_size ?? null,
        used_percentage: contextWindow.used_percentage ?? null,
        remaining_percentage: contextWindow.remaining_percentage ?? null,
        total_input_tokens: contextWindow.total_input_tokens ?? null,
        total_output_tokens: contextWindow.total_output_tokens ?? null,
        current_usage: contextWindow.current_usage ?? null,
      },
      cache_metadata: cacheMetadata(raw),
      session_id: raw.session_id ?? null,
      session_name: raw.session_name ?? null,
      occupant_generation: process.env.OPENRIG_OCCUPANT_GENERATION || process.env.RIGGED_OCCUPANT_GENERATION || null,
      transcript_path: raw.transcript_path ?? null,
      sampled_at: new Date().toISOString(),
    };

    const outputPath = resolveOutputPath(outputTarget, raw);
    if (!outputPath) {
      logFailure("could not resolve output path from Claude status line payload");
      process.exit(0);
    }

    writeJsonAtomic(outputPath, sample);

    if (providerUsageTarget) {
      const providerUsagePath = resolveOutputPath(providerUsageTarget, raw);
      if (!providerUsagePath) {
        logFailure("could not resolve provider_usage output path from Claude status line payload");
        process.exit(0);
      }
      const rateLimits = normalizeRateLimits(raw.rate_limits);
      const providerUsage = {
        seatSession: raw.session_name || raw.session_id,
        asOf: new Date().toISOString(),
        ...(rateLimits ? { accountKind: "subscription", rateLimits } : {}),
      };
      writeJsonAtomic(providerUsagePath, providerUsage);
    }
  } catch (error) {
    logFailure("failed to collect Claude context status line", error);
    process.exit(0);
  }
});

// Only native cache facts, never arbitrary statusline payloads or prompt content.
// https://code.claude.com/docs/en/statusline#prompt-cache-fields
function cacheMetadata(raw) {
  const result = {};
  const identifier = (v) => typeof v === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(v);
  if (identifier(raw.version)) result.runtime_version = raw.version;
  if (identifier(raw.model?.id)) result.model_id = raw.model.id;
  const cache = raw.prompt_cache;
  if (cache && typeof cache === "object" && !Array.isArray(cache)) {
    const out = {};
    for (const key of ["warm", "caching_observed"]) if (typeof cache[key] === "boolean") out[key] = cache[key];
    if (cache.ttl === "5m" || cache.ttl === "1h") out.ttl = cache.ttl;
    for (const key of ["expires_at", "requests", "misses", "expected_rebuilds", "hit_ratio", "cache_write_tokens", "miss_recache_tokens", "last_miss_at", "recache_tokens_if_cold"]) {
      if (cache[key] === null || typeof cache[key] === "number" && Number.isFinite(cache[key]) && cache[key] >= 0) out[key] = cache[key];
    }
    const causes = ["tools_changed", "system_prompt_changed", "ttl_expired_5m", "ttl_expired_1h", "likely_server_side"];
    if (cache.last_miss_cause === null) out.last_miss_cause = null;
    else if (cache.last_miss_cause && typeof cache.last_miss_cause === "object") {
      const cause = cache.last_miss_cause;
      out.last_miss_cause = { causes: Array.isArray(cause.causes) ? cause.causes.filter((c) => causes.includes(c)) : [] };
      for (const key of ["tools_added", "tools_removed", "system_char_delta"]) {
        if (Number.isSafeInteger(cause[key]) && (key === "system_char_delta" || cause[key] >= 0)) out.last_miss_cause[key] = cause[key];
      }
    }
    if (cache.miss_causes && typeof cache.miss_causes === "object") {
      out.miss_causes = Object.fromEntries(causes.filter((c) => Number.isSafeInteger(cache.miss_causes[c]) && cache.miss_causes[c] >= 0).map((c) => [c, cache.miss_causes[c]]));
    }
    result.prompt_cache = out;
  }
  return result;
}

function resolveOutputPath(target, raw) {
  if (target.endsWith(".json")) {
    return target;
  }

  const sessionKey = raw.session_name || raw.session_id;
  if (!sessionKey) {
    return null;
  }

  const safe = String(sessionKey).replace(/[^a-zA-Z0-9@._-]/g, "_");
  return path.join(target, safe + ".json");
}

function normalizeRateLimits(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = {};
  for (const key of ["five_hour", "seven_day"]) {
    const window = value[key];
    if (!window || typeof window !== "object" || Array.isArray(window)) continue;
    const resetsAt = typeof window.resets_at === "number"
      ? unixSecondsToIso(window.resets_at)
      : window.resets_at;
    if (typeof window.used_percentage !== "number" || !Number.isFinite(window.used_percentage)
      || typeof resetsAt !== "string") continue;
    result[key] = { usedPercent: window.used_percentage, resetsAt };
  }
  return result.five_hour || result.seven_day ? result : null;
}

function unixSecondsToIso(value) {
  if (!Number.isFinite(value)) return null;
  const date = new Date(value * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function writeJsonAtomic(outputPath, value) {
  const tmpPath = outputPath + ".tmp";
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(tmpPath, JSON.stringify(value), "utf-8");
  fs.renameSync(tmpPath, outputPath);
}
