// Preview Terminal v0 (PL-018) — UI hook for live terminal preview.
//
// Polls /api/rigs/:rigId/nodes/:logicalId/preview at the operator-
// configured interval (`ui.preview.refresh_interval_seconds`, default
// 3s; read from /api/config). Honest fallback when the daemon doesn't
// have the new route (cross-CLI-version drift): consumers see
// `unavailable: true` instead of an exception.

import { useQuery } from "@tanstack/react-query";
import { useSettings } from "./useSettings.js";
import { terminalAuthHeaders } from "../components/mission-control/missionControlAuth.js";
import { boundedJsonRead } from "../lib/bounded-json-read.js";
import { isObject, isText, isInteger, OperatorReadError } from "../lib/operator-read.js";

export interface NodePreviewResponse {
  content: string;
  lines: number;
  sessionName: string;
  capturedAt: string;
}

export interface NodePreviewUnavailable {
  unavailable: true;
  reason: string;
  hint?: string;
}

const exactIdentity = (value: unknown): value is string => isText(value) && !!value.trim();
function requireIdentity(value: unknown) {
  if (!exactIdentity(value)) throw new OperatorReadError("invalid_request", "Choose an exact terminal preview identity before fetching.");
}
async function readPreview(url: string, signal: AbortSignal | undefined, sessionName?: string): Promise<NodePreviewResponse | NodePreviewUnavailable> {
  return boundedJsonRead(url, { signal, headers: terminalAuthHeaders(), readResponse: async response => {
    const unavailable = response.status === 404 || response.status === 502 || response.status === 503
      || (sessionName === undefined && response.status === 409);
    if (unavailable) {
      const value: unknown = await response.json().catch(() => ({}));
      const body = isObject(value) ? value : {};
      const fallback = sessionName === undefined && response.status === 409 ? "session_unbound"
        : sessionName === undefined && response.status === 502 ? "capture_failed" : "preview_unavailable";
      const result: NodePreviewUnavailable = { unavailable: true, reason: isText(body.error) ? body.error : fallback };
      if (response.status !== 404 && isText(body.hint)) result.hint = body.hint;
      return result;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const value: unknown = await response.json();
    // Node previews serve the native binding, without rig/seat echo fields.
    // Only the session-addressed route can verify an exact session echo.
    if (!isObject(value) || !isText(value.content) || !isInteger(value.lines) || !exactIdentity(value.sessionName)
      || !isText(value.capturedAt) || (sessionName !== undefined && value.sessionName !== sessionName))
      throw new OperatorReadError("invalid_contract", "Terminal preview response could not be verified for this selection.");
    return value as unknown as NodePreviewResponse;
  } });
}

export async function fetchNodePreview(
  rigId: string, logicalId: string, lines: number, signal?: AbortSignal,
): Promise<NodePreviewResponse | NodePreviewUnavailable> {
  requireIdentity(rigId); requireIdentity(logicalId);
  return readPreview(`/api/rigs/${encodeURIComponent(rigId)}/nodes/${encodeURIComponent(logicalId)}/preview?lines=${lines}`, signal);
}

export interface UseNodePreviewOpts {
  rigId: string | null;
  logicalId: string | null;
  /** Override line count; defaults to ui.preview.default_lines. */
  lines?: number;
  /** Pause polling (e.g., when the drawer is collapsed). */
  paused?: boolean;
}

export function useNodePreview(opts: UseNodePreviewOpts) {
  const { data: settings } = useSettings();
  const intervalSeconds = settings?.settings?.["ui.preview.refresh_interval_seconds"]?.value as number | undefined;
  const defaultLines = settings?.settings?.["ui.preview.default_lines"]?.value as number | undefined;
  const lines = opts.lines ?? defaultLines ?? 50;
  const refetchInterval = opts.paused ? false : ((intervalSeconds ?? 3) * 1000);

  const query = useQuery({
    queryKey: ["node-preview", opts.rigId, opts.logicalId, lines],
    queryFn: ({ signal }) => fetchNodePreview(opts.rigId!, opts.logicalId!, lines, signal),
    retry: false,
    placeholderData: undefined,
    enabled: exactIdentity(opts.rigId) && exactIdentity(opts.logicalId) && !opts.paused,
    refetchInterval,
    refetchIntervalInBackground: false,
    staleTime: 0,
  });
  return { ...query, data: exactIdentity(opts.rigId) && exactIdentity(opts.logicalId) ? query.data : undefined };
}

export function isNodePreviewUnavailable(
  data: NodePreviewResponse | NodePreviewUnavailable | undefined,
): data is NodePreviewUnavailable {
  return isObject(data) && data.unavailable === true;
}

// --- Session-keyed preview (composes with surfaces that have a session
// name but no rigId/logicalId — Loop State panel, Slice Story View
// Topology tab). Same shape; different route. ---

export async function fetchSessionPreview(
  sessionName: string, lines: number, signal?: AbortSignal,
): Promise<NodePreviewResponse | NodePreviewUnavailable> {
  requireIdentity(sessionName);
  return readPreview(`/api/sessions/${encodeURIComponent(sessionName)}/preview?lines=${lines}`, signal, sessionName);
}

export function useSessionPreview(opts: {
  sessionName: string | null;
  lines?: number;
  paused?: boolean;
}) {
  const { data: settings } = useSettings();
  const intervalSeconds = settings?.settings?.["ui.preview.refresh_interval_seconds"]?.value as number | undefined;
  const defaultLines = settings?.settings?.["ui.preview.default_lines"]?.value as number | undefined;
  const lines = opts.lines ?? defaultLines ?? 50;
  const refetchInterval = opts.paused ? false : ((intervalSeconds ?? 3) * 1000);

  const query = useQuery({
    queryKey: ["session-preview", opts.sessionName, lines],
    queryFn: ({ signal }) => fetchSessionPreview(opts.sessionName!, lines, signal),
    retry: false,
    placeholderData: undefined,
    enabled: exactIdentity(opts.sessionName) && !opts.paused,
    refetchInterval,
    refetchIntervalInBackground: false,
    staleTime: 0,
  });
  return { ...query, data: exactIdentity(opts.sessionName) ? query.data : undefined };
}
