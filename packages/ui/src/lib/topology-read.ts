import { withHostParam } from "./host-param.js";

export const TOPOLOGY_READ_TIMEOUT_MS = 5_000;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate the fields consumed by topology without dropping additive daemon
 * fields. Older partial summaries may omit enrichment; present values must
 * have the served DTO types. Null names are unavailable enrichment supported
 * by existing inventory consumers, which fall back to identity. Every row
 * must still have a usable rig identity. */
export function isTopologyRigSummary(value: unknown): value is Array<{ id: string; name?: string | null; nodeCount?: number }> {
  return Array.isArray(value) && value.every(row => record(row)
    && typeof row.id === "string" && row.id.length > 0
    && (row.name === undefined || row.name === null || typeof row.name === "string")
    && (row.nodeCount === undefined || (typeof row.nodeCount === "number" && Number.isSafeInteger(row.nodeCount) && row.nodeCount >= 0))
    && (row.latestSnapshotAt === undefined || row.latestSnapshotAt === null || typeof row.latestSnapshotAt === "string")
    && (row.latestSnapshotId === undefined || row.latestSnapshotId === null || typeof row.latestSnapshotId === "string")
    && (row.hasServices === undefined || typeof row.hasServices === "boolean"));
}

export function isTopologyGraph(value: unknown): value is { nodes: unknown[]; edges: unknown[] } {
  // Entry-level defects remain the spatial parser's explicit partial issues.
  // Missing/wrong containers are an unavailable graph, never a successful empty rig.
  return record(value) && Array.isArray(value.nodes) && Array.isArray(value.edges);
}

export class TopologyReadError extends Error {
  constructor(readonly code: "cancelled" | "timeout" | "invalid_contract", message?: string) {
    super(message ?? (code === "timeout" ? "Topology read timed out after 5 seconds." : "Topology read cancelled."));
    this.name = "TopologyReadError";
  }
}

/** Host-forwarded topology GET with one deadline covering headers and JSON.
 * The independent cancellation promise also bounds fetch/body implementations
 * that ignore AbortSignal. Shared graph/summary query payloads stay unchanged. */
export async function topologyRead<T>(path: string, hostId: string, signal?: AbortSignal, validate?: (value: unknown) => boolean): Promise<T> {
  if (signal?.aborted) throw new TopologyReadError("cancelled");
  const controller = new AbortController();
  let response: Response | undefined;
  let abortError: TopologyReadError | undefined;
  let rejectAbort!: (error: TopologyReadError) => void;
  const cancelled = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const cancelBody = () => { void response?.body?.cancel().catch(() => {}); };
  const abort = (code: "cancelled" | "timeout") => {
    if (abortError) return;
    abortError = new TopologyReadError(code);
    rejectAbort(abortError);
    controller.abort();
    cancelBody();
  };
  const onCallerAbort = () => abort("cancelled");
  signal?.addEventListener("abort", onCallerAbort, { once: true });
  const timer = setTimeout(() => abort("timeout"), TOPOLOGY_READ_TIMEOUT_MS);
  const request = (async () => {
    try {
      response = await fetch(withHostParam(path, hostId), {
        method: "GET", headers: { Accept: "application/json" }, signal: controller.signal,
      });
      if (abortError) { cancelBody(); throw abortError; }
      if (!response.ok) { cancelBody(); throw new Error(`HTTP ${response.status}`); }
      const value: unknown = await response.json();
      if (validate && !validate(value)) throw new TopologyReadError("invalid_contract",
        path === "/api/rigs/summary" ? "Invalid topology rig summary payload." : "Invalid topology graph payload.");
      return value as T;
    } catch (error) {
      throw abortError ?? error;
    }
  })();
  try { return await Promise.race([request, cancelled]); }
  finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onCallerAbort);
  }
}
