// UI Enhancement Pack v0 — files browser + write hooks.
//
// Wraps:
//   - GET /api/files/roots → useFilesRoots
//   - GET /api/files/list?root=&path= → useFilesList
//   - GET /api/files/read?root=&path= → useFilesRead
//   - POST /api/files/write → useFilesWrite (mutation)
//
// All read hooks surface daemon 503 / 4xx as structured errors via
// the `unavailable` shape so the UI renders a setup hint when no
// allowlist is configured.

import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { HostsResponse } from "./useHosts.js";
import { readHosts } from "../lib/hosts-read.js";
import { filesReadScope, readFilesRoots, readFilesList, readFilesFile } from "../lib/files-read.js";
export { FilesReadError } from "../lib/files-read.js";

function confirmedFilesHost(qc: QueryClient): string | undefined {
  const state = qc.getQueryState<HostsResponse>(["hosts"]);
  // A failed refresh retains data, but no longer confirms its authority.
  // A normal background poll keeps success until it actually fails.
  return state?.status === "success" ? state.data?.selected : undefined;
}

/** Current Files authority on the shared host query, with no fetching of its own. */
export function useConfirmedFilesHost(): string | undefined {
  // Subscribe to status as well as data: a failed refresh can keep exactly
  // the same local payload. This observer adds no hosts fetch or polling.
  const { data, status } = useQuery<HostsResponse>({
    queryKey: ["hosts"], queryFn: ({ signal }) => readHosts({ signal }),
    enabled: false, retry: false, placeholderData: undefined,
  });
  return status === "success" ? data?.selected : undefined;
}

function useFilesReadScope(enabled = true) {
  const qc = useQueryClient();
  const selectedHostId = useConfirmedFilesHost();
  const selectionKnown = selectedHostId !== undefined;
  const scope = filesReadScope(selectedHostId);
  // Re-check at invocation too, including retained/manual refetch callbacks
  // invoked before a host-state change has reached React's next render.
  const admittedHost = () => {
    const current = confirmedFilesHost(qc);
    if (current === selectedHostId || scope.scopeSupported) return current;
    // A disabled scope must not fill its distinct cache key with local bytes
    // if authority recovers before this observer has rendered again.
    return undefined;
  };
  return { ...scope, selectedHostId, selectionKnown, readEnabled: enabled && scope.scopeSupported, admittedHost };
}

export interface FilesUnavailable {
  unavailable: true;
  error: string;
  hint?: string;
}

export interface AllowlistRoot {
  name: string;
  path: string;
}

export interface FilesRootsResponse {
  roots: AllowlistRoot[];
  hint?: string;
}

export function useFilesRoots(opts?: { enabled?: boolean }) {
  const scope = useFilesReadScope(opts?.enabled ?? true);
  const query = useQuery({
    // Preserve exact local keys: the editor reads its newest cache snapshot
    // synchronously before Save. Disabled scopes use separate identities.
    queryKey: scope.scopeSupported ? ["files", "roots"] : ["files", "roots", "scope", scope.selectedHostId ?? null],
    queryFn: ({ signal }) => readFilesRoots(scope.admittedHost(), { signal, enabled: opts?.enabled }),
    staleTime: 60_000, enabled: scope.readEnabled, retry: false, placeholderData: undefined,
  });
  return { ...query, ...scope, data: scope.readEnabled ? query.data : undefined };
}

// --- list ---

export interface FileEntry {
  name: string;
  type: "dir" | "file" | "other";
  size: number | null;
  mtime: string | null;
}

export interface FilesListResponse {
  root: string;
  path: string;
  entries: FileEntry[];
}

export function useFilesList(root: string | null, path: string | null, opts?: { enabled?: boolean }) {
  const scope = useFilesReadScope(opts?.enabled ?? true);
  const readEnabled = scope.readEnabled && !!root;
  const query = useQuery({
    queryKey: scope.scopeSupported ? ["files", "list", root, path] : ["files", "list", root, path, "scope", scope.selectedHostId ?? null],
    queryFn: ({ signal }) => readFilesList(scope.admittedHost(), root, path ?? "", { signal, enabled: opts?.enabled }),
    enabled: readEnabled, staleTime: 15_000,
    // Preserve Explorer's refocus refresh even within the stale-time window.
    refetchOnWindowFocus: "always", retry: false, placeholderData: undefined,
  });
  return { ...query, ...scope, readEnabled, data: readEnabled ? query.data : undefined };
}

// --- read ---

export interface FilesReadResponse {
  root: string;
  path: string;
  absolutePath: string;
  /** Canonical root-relative target; may differ from the authored path. */
  resolvedPath?: string;
  content: string;
  mtime: string;
  contentHash: string;
  size: number;
  /** True when the full file bytes contain NUL or are not valid UTF-8, so
   *  `content` is a lossy text decode (daemon `readAllowedFile`). */
  binary?: boolean;
  /** Operator Surface Reconciliation v0 item 5: present when the
   *  daemon truncated the returned content (file > 1 MB cap). */
  truncated?: boolean;
  truncatedAtBytes?: number | null;
  totalBytes?: number;
}

export function useFilesRead(root: string | null, path: string | null, opts?: { enabled?: boolean }) {
  const scope = useFilesReadScope(opts?.enabled ?? true);
  const readEnabled = scope.readEnabled && !!root && !!path;
  const query = useQuery({
    queryKey: scope.scopeSupported ? ["files", "read", root, path] : ["files", "read", root, path, "scope", scope.selectedHostId ?? null],
    queryFn: ({ signal }) => readFilesFile(scope.admittedHost(), root, path, { signal, enabled: opts?.enabled }),
    enabled: readEnabled,
    staleTime: 0, // always re-read for edit-mode mtime/contentHash freshness
    retry: false, placeholderData: undefined,
  });
  return { ...query, ...scope, readEnabled, data: readEnabled ? query.data : undefined };
}

// --- write (item 4) ---

export interface FileWriteRequest {
  root: string;
  path: string;
  content: string;
  expectedMtime: string;
  expectedContentHash: string;
  actor: string;
}

export interface FileWriteSuccess {
  root: string;
  path: string;
  absolutePath: string;
  newMtime: string;
  newContentHash: string;
  byteCountDelta: number;
}

export interface FileWriteConflict {
  conflict: true;
  currentMtime: string;
  currentContentHash: string;
  message: string;
}

export type FileWriteResult = FileWriteSuccess | FileWriteConflict;

async function postWrite(req: FileWriteRequest): Promise<FileWriteResult> {
  const res = await fetch("/api/files/write", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  if (res.status === 409) {
    const body = (await res.json()) as { currentMtime: string; currentContentHash: string; message?: string };
    return {
      conflict: true,
      currentMtime: body.currentMtime,
      currentContentHash: body.currentContentHash,
      message: body.message ?? "file changed externally",
    };
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    throw new Error(body.message ?? body.error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as FileWriteSuccess;
}

export function useFilesWrite(opts: { mutationKey?: readonly unknown[] } = {}) {
  const qc = useQueryClient();
  return useMutation({
    ...(opts.mutationKey ? { mutationKey: opts.mutationKey } : {}),
    mutationFn: (req: FileWriteRequest) => {
      // Retained editors can outlive a host switch. Read current authority at
      // admission, not a host captured when this hook/component mounted.
      const selected = confirmedFilesHost(qc);
      const error = filesReadScope(selected).scopeError;
      if (error) throw error;
      return postWrite(req);
    },
    onSuccess: (result, vars) => {
      // Only invalidate when the write actually landed. On a 409
      // conflict we MUST keep the read query stable so the editor's
      // last-known mtime/contentHash + the operator's draft survive
      // long enough for the conflict banner to render. Invalidating
      // here would refetch the read, the editor's useEffect would
      // fire on the new read, and both the draft and the conflict
      // banner would get wiped silently — losing the operator's
      // edits and the conflict signal.
      if ("conflict" in result) return;
      qc.invalidateQueries({ queryKey: ["files", "read", vars.root, vars.path] });
      qc.invalidateQueries({ queryKey: ["files", "list", vars.root] });
    },
  });
}

export function fileAssetUrl(root: string, path: string): string {
  return `/api/files/asset?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`;
}
