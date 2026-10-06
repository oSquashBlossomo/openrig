// Phase 3a slice 3.3 — UI client for the plugin discovery API.
//
// Wraps GET /api/plugins, GET /api/plugins/:id, GET /api/plugins/:id/used-by
// in @tanstack/react-query hooks for consumption by Library Explorer
// (plugins category) + PluginDetailPage + AgentSpec plugin sections.
//
// Types mirror the daemon's PluginEntry / PluginDetail / AgentReference
// shapes from packages/daemon/src/domain/plugin-discovery-service.ts.
// Kept in lockstep at v0; if the daemon shapes evolve, update both sides.

import { useQuery } from "@tanstack/react-query";
import { boundedJsonRead } from "../lib/bounded-json-read.js";
import { OperatorReadError } from "../lib/operator-read.js";

export type PluginRuntime = "claude" | "codex";
export type PluginSourceKind = "vendored" | "claude-cache" | "codex-cache";

export interface PluginEntry {
  id: string;
  name: string;
  version: string;
  description: string | null;
  source: PluginSourceKind;
  sourceLabel: string;
  runtimes: PluginRuntime[];
  path: string;
  lastSeenAt: string | null;
  /** Slice 28 — subdirectory count under <plugin>/skills/. Populated by
   *  daemon detectPlugin via readdir of skills/ (SC-29 EXCEPTION #11). */
  skillCount: number;
}

export interface PluginManifestSummary {
  raw: Record<string, unknown>;
  name: string | null;
  version: string | null;
  description: string | null;
  homepage: string | null;
  repository: string | null;
  license: string | null;
}

export interface PluginSkillSummary {
  name: string;
  relativePath: string;
}

export interface PluginHookSummary {
  runtime: PluginRuntime;
  relativePath: string;
  events: string[];
}

// Slice 3.3 fix-A — MCP server summary mirrors daemon shape.
export interface PluginMcpServerSummary {
  runtime: PluginRuntime;
  name: string;
  command: string | null;
  transport: string | null;
}

export interface PluginDetail {
  entry: PluginEntry;
  claudeManifest: PluginManifestSummary | null;
  codexManifest: PluginManifestSummary | null;
  skills: PluginSkillSummary[];
  hooks: PluginHookSummary[];
  /** Slice 3.3 fix-A — MCP servers declared in manifest(s). */
  mcpServers: PluginMcpServerSummary[];
}

export interface PluginAgentReference {
  agentName: string;
  sourcePath: string;
  profiles: string[];
}

export interface UsePluginsOpts {
  runtime?: PluginRuntime;
  source?: PluginSourceKind;
}

function buildListUrl(opts: UsePluginsOpts | undefined): string {
  const params = new URLSearchParams();
  if (opts?.runtime) params.append("runtime", opts.runtime);
  if (opts?.source) params.append("source", opts.source);
  const qs = params.toString();
  return qs.length === 0 ? "/api/plugins" : `/api/plugins?${qs}`;
}

async function fetchPlugins(opts: UsePluginsOpts | undefined, signal?: AbortSignal): Promise<PluginEntry[]> {
  return boundedJsonRead<PluginEntry[]>(buildListUrl(opts), { signal });
}

function exactPluginTarget(id: string | null): string {
  if (typeof id !== "string" || id.length === 0) {
    throw new OperatorReadError("invalid_request", "Choose an exact plugin before reading.");
  }
  return id;
}

async function fetchPlugin(id: string | null, signal?: AbortSignal): Promise<PluginDetail> {
  return boundedJsonRead<PluginDetail>(`/api/plugins/${encodeURIComponent(exactPluginTarget(id))}`, { signal });
}

async function fetchPluginUsedBy(id: string | null, signal?: AbortSignal): Promise<PluginAgentReference[]> {
  return boundedJsonRead<PluginAgentReference[]>(`/api/plugins/${encodeURIComponent(exactPluginTarget(id))}/used-by`, { signal });
}

export function usePlugins(opts: UsePluginsOpts = {}) {
  return useQuery<PluginEntry[]>({
    queryKey: ["plugins", "list", opts.runtime ?? "all", opts.source ?? "all"],
    queryFn: ({ signal }) => fetchPlugins(opts, signal),
    staleTime: 30_000,
  });
}

export function usePlugin(id: string | null) {
  return useQuery<PluginDetail>({
    queryKey: ["plugins", "detail", id],
    queryFn: ({ signal }) => fetchPlugin(id, signal),
    enabled: id !== null && id.length > 0,
    staleTime: 30_000,
  });
}

export function usePluginUsedBy(id: string | null) {
  return useQuery<PluginAgentReference[]>({
    queryKey: ["plugins", "used-by", id],
    queryFn: ({ signal }) => fetchPluginUsedBy(id, signal),
    enabled: id !== null && id.length > 0,
    staleTime: 30_000,
  });
}
