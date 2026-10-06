// Rig Context / Composable Context Injection v0 (PL-014) — UI hooks
// for the context_packs library + review + send.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { boundedJsonRead } from "../lib/bounded-json-read.js";
import { arrayOf, hasShape, isNumber, isText, nullable, oneOf, optional, OperatorReadError } from "../lib/operator-read.js";

export interface ContextPackEntryFile {
  path: string;
  role: string;
  summary: string | null;
  absolutePath: string | null;
  bytes: number | null;
  estimatedTokens: number | null;
}

export interface ContextPackEntry {
  id: string;
  kind: "context-pack";
  name: string;
  version: string;
  /** Display-only metadata may be absent in compatible catalog projections. */
  purpose?: string | null;
  sourceType: "builtin" | "user_file" | "workspace";
  sourcePath: string;
  relativePath: string;
  updatedAt: string;
  manifestEstimatedTokens: number | null;
  derivedEstimatedTokens: number;
  files: ContextPackEntryFile[];
}

export interface ContextPackPreview {
  id: string;
  name: string;
  version: string;
  bundleText: string;
  bundleBytes: number;
  estimatedTokens: number;
  files: Array<{ path: string; role: string; bytes: number; estimatedTokens: number }>;
  missingFiles: Array<{ path: string; role: string }>;
}

function isContextPackEntry(value: unknown): value is ContextPackEntry {
  return hasShape(value, {
    id: value => isText(value) && value.length > 0, kind: oneOf("context-pack"), name: isText, version: isText,
    purpose: optional(nullable(isText)), sourceType: oneOf("builtin", "user_file", "workspace"),
    sourcePath: isText, relativePath: isText, updatedAt: isText,
    manifestEstimatedTokens: nullable(isNumber), derivedEstimatedTokens: isNumber,
    files: arrayOf(file => hasShape(file, {
      path: isText, role: isText, summary: nullable(isText), absolutePath: nullable(isText),
      bytes: nullable(isNumber), estimatedTokens: nullable(isNumber),
    })),
  });
}

async function fetchContextPacks(signal?: AbortSignal): Promise<ContextPackEntry[]> {
  // Connected-instance discovery, independent of the selected topology host.
  // An unavailable/old unsupported endpoint is not evidence of an empty list.
  const body = await boundedJsonRead<unknown>("/api/context-packs/library", { signal });
  if (!Array.isArray(body) || !body.every(isContextPackEntry)) {
    throw new OperatorReadError("invalid_contract", "Context pack library returned an invalid catalog.");
  }
  return body;
}

export function useContextPackLibrary() {
  return useQuery({
    queryKey: ["context-packs", "library"],
    queryFn: ({ signal }) => fetchContextPacks(signal),
    staleTime: 30_000,
    retry: false,
    placeholderData: undefined,
  });
}

// Slice-03 Atom 5: preview addresses by the pack's path-like ref.
async function fetchContextPackPreview(ref: string | null, signal?: AbortSignal): Promise<ContextPackPreview> {
  if (typeof ref !== "string" || ref.length === 0) {
    throw new OperatorReadError("invalid_request", "Choose an exact context pack ref before reading its preview.");
  }
  const body = await boundedJsonRead<unknown>(`/api/context-packs/library/by-ref/preview?ref=${encodeURIComponent(ref)}`, { signal });
  // The by-ref producer echoes context-pack:<ref>, not a name/version ID.
  // Keep the raw ref exact; path safety remains the daemon's existing policy.
  if (!hasShape(body, {
    id: isText, name: isText, version: isText, bundleText: isText, bundleBytes: isNumber, estimatedTokens: isNumber,
    files: arrayOf(file => hasShape(file, { path: isText, role: isText, bytes: isNumber, estimatedTokens: isNumber })),
    missingFiles: arrayOf(file => hasShape(file, { path: isText, role: isText })),
  }) || body.id !== `context-pack:${ref}`) {
    throw new OperatorReadError("invalid_contract", "Context pack preview did not match the requested ref or its served contract.");
  }
  return body as unknown as ContextPackPreview;
}

export function useContextPackPreview(ref: string | null) {
  return useQuery({
    queryKey: ["context-packs", "preview", ref],
    queryFn: ({ signal }) => fetchContextPackPreview(ref, signal),
    enabled: !!ref,
    staleTime: 30_000,
    retry: false,
    placeholderData: undefined,
  });
}

export function useContextPackSync() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/context-packs/library/sync", { method: "POST" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<{ count: number; entries: ContextPackEntry[] }>;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["context-packs"] });
    },
  });
}
