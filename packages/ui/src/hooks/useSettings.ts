// User Settings v0 — UI hooks for the daemon /api/config route.
//
// Consumed by the System drawer Settings tab. Bypasses CLI shell-out
// because the CLI remains the canonical agent-edit path while UI reads
// and writes settings through the daemon HTTP route directly.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { boundedJsonRead } from "../lib/bounded-json-read.js";
import { OperatorReadError } from "../lib/operator-read.js";

export type SettingSource = "env" | "file" | "default";

export interface ResolvedSetting {
  value: string | number | boolean;
  source: SettingSource;
  defaultValue: string | number | boolean;
}

export type SettingsKey =
  | "daemon.port" | "daemon.host" | "db.path"
  | "transcripts.enabled" | "transcripts.path"
  | "workspace.root" | "workspace.slices_root" | "workspace.steering_path"
  | "workspace.specs_root" | "workspace.projects_root" | "workspace.catalog_path"
  | "files.allowlist" | "progress.scan_roots"
  // Preview Terminal v0 (PL-018) keys.
  | "ui.preview.refresh_interval_seconds"
  | "ui.preview.max_pins"
  | "ui.preview.default_lines"
  // OPR.0.4.0.1 — global cap on simultaneously-live terminals (default 2).
  | "ui.terminal.max_live_terminals"
  // V1 Phase 4 ConfigStore allowlist exception (advisor/operator seats).
  | "agents.advisor_session" | "agents.operator_session"
  // V1 Phase 5 P5-3 ConfigStore allowlist exception (For You feed
  // subscription toggles per for-you-feed.md L144-L151). Same SC-29
  // exception scope as Phase 4 (allowlist-only; no schema migrations
  // / new endpoints / event types).
  | "feed.subscriptions.action_required"
  | "feed.subscriptions.approvals"
  | "feed.subscriptions.shipped"
  | "feed.subscriptions.progress"
  | "feed.subscriptions.audit_log"
  // Slice 27 — Claude auto-compaction policy keys (SC-29 EXCEPTION #10).
  | "policies.claude_compaction.enabled"
  | "policies.claude_compaction.threshold_percent"
  | "policies.claude_compaction.pre_compact_instruction"
  | "policies.claude_compaction.compact_instruction"
  | "policies.claude_compaction.message_inline"
  | "policies.claude_compaction.message_file_path"
  | "policies.claude_compaction.post_restore_audit_instruction"
  // OPR.0.4.4.15 (G15-P1) — the ONE registered dynamic key class:
  // per-host feed subscriptions. v1 per-host key set is CLOSED to
  // {enabled}; hostId segment [A-Za-z0-9_-]+, reserved toggle names
  // excluded daemon-side.
  | `feed.subscriptions.${string}.enabled`;

export interface SettingsResponse {
  settings: Record<SettingsKey, ResolvedSetting>;
  /** OPR.0.4.4.15 — additive dynamic-class enumeration: persisted per-host
   *  feed subscriptions. Absent on pre-slice daemons (defensive-optional). */
  feedHostSubscriptions?: Array<{ hostId: string; enabled: boolean }>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSettingValue(value: unknown): value is ResolvedSetting["value"] {
  return typeof value === "string" || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value));
}

function isSettingsResponse(value: unknown): value is SettingsResponse {
  if (!isObject(value) || !isObject(value.settings)) return false;
  if (!Object.values(value.settings).every(setting => isObject(setting)
    && isSettingValue(setting.value) && isSettingValue(setting.defaultValue)
    && (setting.source === "env" || setting.source === "file" || setting.source === "default"))) return false;
  return value.feedHostSubscriptions === undefined || (Array.isArray(value.feedHostSubscriptions)
    && value.feedHostSubscriptions.every(host => isObject(host)
      && typeof host.hostId === "string" && typeof host.enabled === "boolean"));
}

async function fetchSettings(signal?: AbortSignal): Promise<SettingsResponse> {
  return boundedJsonRead("/api/config", {
    signal,
    readResponse: async res => {
      if (!res.ok) {
        const body: unknown = await res.json().catch(() => ({}));
        throw new Error(isObject(body) && typeof body.error === "string" ? body.error : `HTTP ${res.status}`);
      }
      const body: unknown = await res.json();
      if (!isSettingsResponse(body)) throw new OperatorReadError("invalid_contract", "Invalid settings response.");
      return body;
    },
  });
}

export function useSettings() {
  return useQuery({
    queryKey: ["settings", "all"],
    queryFn: ({ signal }) => fetchSettings(signal),
    retry: false,
    staleTime: 0,
  });
}

export function useSetSetting() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { key: SettingsKey; value: string }) => {
      const res = await fetch(`/api/config/${encodeURIComponent(input.key)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: input.value }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      return res.json() as Promise<{ ok: boolean; resolved: ResolvedSetting }>;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["settings"] });
    },
  });
}

export function useResetSetting() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (key: SettingsKey) => {
      const res = await fetch(`/api/config/${encodeURIComponent(key)}`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      return res.json() as Promise<{ ok: boolean; resolved: ResolvedSetting }>;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["settings"] });
    },
  });
}

export interface InitWorkspaceResponse {
  root: string;
  rootCreated: boolean;
  subdirs: Array<{ name: string; path: string; created: boolean }>;
  files: Array<{ relPath: string; absPath: string; created: boolean; skipped: "exists" | null }>;
  dryRun: boolean;
}

export function useInitWorkspace() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { root?: string; force?: boolean; dryRun?: boolean }) => {
      const res = await fetch("/api/config/init-workspace", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      return res.json() as Promise<InitWorkspaceResponse>;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["settings"] });
    },
  });
}
