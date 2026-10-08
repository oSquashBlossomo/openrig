# Prompt cache observations

`GET /api/telemetry/usage/cache` reads telemetry already collected by OpenRig.
Optional `nodeId` and `rigId` query parameters select exact IDs. This backend
surface describes provider prompt caching, separately from context-window
utilization, OpenRig context loading and host subscription-limit telemetry.

Each row identifies the OpenRig seat and runtime. `configuredModel` is the node's
selection; `observedModel` and `runtimeVersion` require native telemetry. The
provider endpoint and billing bucket stay unknown: a Claude Code or Codex process
can use different providers or billing arrangements. No account identifiers,
native conversation IDs, transcript paths or prompt content are returned.

## Reading the result

- `lastRequest` contains the native **last reported request**, not a user turn.
  A turn may make several requests. Claude uncached input, cache reads and cache
  writes form total input; Codex cached input is already part of total input.
  Missing fields are null, including Codex cache writes and Claude reasoning
  output. A zero counter remains zero. `requestedAt` is unknown.
- `cumulative` is Claude's reported main-conversation snapshot, never a sum of
  statusline polls. It is separate from last-request tokens. Native subagents
  are excluded; each OpenRig worker CLI is a separate seat, not a native subagent.
  A later read may contain an older or lower native snapshot; the endpoint shows
  its timestamp and values without asserting a reset or calculating deltas.
- `sampledAt` is observation time, not a provider request timestamp. Reads do not
  extend expiry. `warm_estimate` and `expired_estimate` describe a reported TTL;
  an expired estimate is not an observed miss. Native miss causes are hypotheses;
  unrecognized categories are omitted, never replaced with prompt text.
- `availability: unknown` carries a reason for missing, stale, malformed,
  unsupported or unattributable evidence. The existing ten-minute telemetry
  freshness threshold is not the cache TTL. Attribution requires one running
  occupant, the saved exact native ID, matching sidecar identity/source and the
  existing generation guard. Stopped or ambiguous seats do not inherit old data.
- `subscriptionSavings` remains unknown. Token hit ratios are not quota credits,
  dollars saved, or proof of more completed work. No fleet-wide benefit is pooled.

## Native support and retention assessment

| Native source | Read-only evidence | Retention assessment |
|---|---|---|
| Claude Code statusline | Last-request cache counters; `prompt_cache` main-conversation statistics from 2.1.251, miss causes from 2.1.260 | Reported TTL and expiry are estimates. Native settings support is documented from 2.1.242; this endpoint does not read effective settings. |
| Codex rollout `token_count` | `last_token_usage.cached_input_tokens` and other reported last-request counters | TTL, native retention control, cache writes and cumulative cache statistics remain unknown here. API retention options are not treated as native subscription controls. |
| Other runtimes / older collectors | Explicit unknown or available legacy counters | No assumed default or provider fallback. |

Claude documents `promptCacheTtl` for the main conversation and
`subagentPromptCacheTtl` for other requests, with `5m`/`1h` choices and environment
precedence. Included-plan defaults differ by bucket (main one hour, other requests
five minutes); credit/API billing can differ. OpenRig does not infer a billing
bucket from these defaults or change them. See the native
[cache documentation](https://code.claude.com/docs/en/prompt-caching) and
[statusline schema](https://code.claude.com/docs/en/statusline#prompt-cache-fields).

The existing managed Claude collector preserves the new fields when native
statusline payloads supply them. Older saved samples continue to work with their
available counters. No schema migration, new provider poll or telemetry upload
is involved. A native statusline snapshot can follow compact/restart; OpenRig
makes no universal claim that either resets every native cumulative field.

This slice performs no warming, settings writes, synthetic turns, compact,
clear, fork, restart or API-credit fallback. Opening a terminal, polling this
endpoint or reading tmux does not refresh a provider cache. Review stable prefix
changes and ordinary work batching before considering a separately authorized
experiment; native evidence alone cannot quantify subscription benefit.
