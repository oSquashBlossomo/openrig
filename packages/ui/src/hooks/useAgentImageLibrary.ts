// Fork Primitive + Starter Agent Images v0 (PL-016) — UI hooks for the
// agent_images library + preview + lifecycle verbs. Mirrors
// useContextPackLibrary (PL-014) shape.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { readAgentImages, readAgentImagePreview } from "../lib/agent-image-reads.js";

export interface AgentImageEntry {
  id: string;
  kind: "agent-image";
  name: string;
  version: string;
  runtime: "claude-code" | "codex";
  sourceSeat: string;
  sourceSessionId: string;
  /** Source seat's cwd at snapshot time. null when the manifest predates
   *  source_cwd support (back-compat). The Use-as-starter
   *  snippet emits `cwd: <sourceCwd>` when this is non-null. */
  sourceCwd?: string | null;
  notes: string | null;
  createdAt: string;
  sourceType: "user_file" | "workspace" | "builtin";
  sourcePath: string;
  relativePath: string;
  updatedAt: string;
  manifestEstimatedTokens: number | null;
  derivedEstimatedTokens: number;
  files: Array<{
    path: string;
    role: string;
    summary: string | null;
    absolutePath: string | null;
    bytes: number | null;
    estimatedTokens: number | null;
  }>;
  /** Always "(redacted)" over the wire — UI never sees real tokens. */
  sourceResumeToken: string;
  stats: {
    forkCount: number;
    lastUsedAt: string | null;
    estimatedSizeBytes: number;
    lineage: string[];
  };
  lineage: string[];
  pinned: boolean;
}

export interface AgentImagePreview {
  id: string;
  name: string;
  version: string;
  runtime: "claude-code" | "codex";
  sourceSeat: string;
  manifestEstimatedTokens: number | null;
  derivedEstimatedTokens: number;
  stats: AgentImageEntry["stats"];
  lineage: string[];
  pinned: boolean;
  notes: string | null;
  files: AgentImageEntry["files"];
  starterSnippet: string;
}

export function useAgentImageLibrary() {
  return useQuery({
    queryKey: ["agent-images", "library"],
    queryFn: ({ signal }) => readAgentImages(signal),
    staleTime: 30_000,
    retry: false,
    placeholderData: undefined,
  });
}

export function useAgentImagePreview(id: string | null) {
  return useQuery({
    queryKey: ["agent-images", "preview", id],
    queryFn: ({ signal }) => readAgentImagePreview(id, signal),
    enabled: !!id,
    staleTime: 30_000,
    retry: false,
    placeholderData: undefined,
  });
}

export function useAgentImagePin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; pin: boolean }) => {
      const verb = input.pin ? "pin" : "unpin";
      const res = await fetch(`/api/agent-images/library/${encodeURIComponent(input.id)}/${verb}`, { method: "POST" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<{ ok: boolean; pinned: boolean }>;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["agent-images"] });
    },
  });
}
