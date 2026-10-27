// The daemon contracts this UI reads. Shapes are the daemon's own; only the
// fields the pages use are typed.
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";

export const LOCAL_HOST = "local";

export type PsEntry = {
  rigId: string;
  name: string;
  nodeCount: number;
  runningCount: number;
  activeCount: number;
  hasWorkCount: number;
  status: string;
  lifecycleState: string;
  uptime: string | null;
  latestSnapshot: string | null;
  isArchived: boolean;
  attentionCount: number;
};

export type SeatNode = {
  nodeId: string;
  rigId: string;
  rigName: string;
  logicalId: string;
  podNamespace: string | null;
  canonicalSessionName: string;
  nodeKind: string;
  runtime: string | null;
  model: string | null;
  effort: string | null;
  cwd: string | null;
  sessionStatus: string;
  startupStatus: string | null;
  lifecycleState: string;
  intentionallyStopped: boolean;
  needsAttention: boolean;
  hasAssignedWork: boolean;
  assignedWorkCount: number;
  lastActivityAt: string | null;
  latestError: string | null;
  recoveryGuidance: string | null;
  tmuxAttachCommand: string | null;
  resumeCommand: string | null;
  activityState: { activity: string; display: string; needsInput: { count: number; reason: string | null } } | null;
  contextUsage: { availability: string; usedPercentage: number | null; contextWindowSize: number | null; sampledAt: string | null } | null;
  identityVerdict: { verdict: string; reason: string | null } | null;
};

export type AttentionItem = {
  id: string;
  kind: string;
  summary: string;
  urgency: "critical" | "urgent" | "warning" | "info" | string;
  at: string | null;
  scope: string | null;
  unblocks: string | null;
  source: string | null;
};

export type Host = {
  id: string;
  transport: string;
  url?: string;
  target?: string;
  selected: boolean;
  status: string;
};

export type SendResult = {
  ok?: boolean;
  sent?: boolean;
  verified?: boolean;
  outcome?: string;
  reason?: string;
  error?: string;
  sessionName?: string;
  notice?: string;
};

export function withHost(path: string, hostId: string): string {
  if (!hostId || hostId === LOCAL_HOST) return path;
  return `${path}${path.includes("?") ? "&" : "?"}host=${encodeURIComponent(hostId)}`;
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly body: unknown) {
    super(message);
  }
}

export async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { Accept: "application/json" } });
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = (body as { error?: string; message?: string } | null)?.message
      ?? (body as { error?: string } | null)?.error ?? `HTTP ${res.status}`;
    throw new ApiError(msg, res.status, body);
  }
  return body as T;
}

export async function postJson<T>(path: string, data: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(data),
  });
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok && !(body && typeof body === "object")) throw new ApiError(`HTTP ${res.status}`, res.status, body);
  return body as T;
}

const LIVE_INTERVAL_MS = 15_000;

export function usePs(hostId: string) {
  return useQuery({
    queryKey: ["ps", hostId],
    queryFn: () => getJson<PsEntry[]>(withHost("/api/ps", hostId)),
    refetchInterval: LIVE_INTERVAL_MS,
  });
}

export function useNodes(rigId: string | undefined, hostId: string) {
  return useQuery({
    queryKey: ["nodes", hostId, rigId],
    queryFn: () => getJson<SeatNode[]>(withHost(`/api/rigs/${encodeURIComponent(rigId!)}/nodes`, hostId)),
    enabled: !!rigId,
    refetchInterval: LIVE_INTERVAL_MS,
  });
}

/** Every seat on the selected host, rig by rig, in `ps` order. */
export function useFleet(hostId: string) {
  const ps = usePs(hostId);
  const rigs = ps.data ?? [];
  const nodeQueries = useQueries({
    queries: rigs.map((rig) => ({
      queryKey: ["nodes", hostId, rig.rigId],
      queryFn: () => getJson<SeatNode[]>(withHost(`/api/rigs/${encodeURIComponent(rig.rigId)}/nodes`, hostId)),
      refetchInterval: LIVE_INTERVAL_MS,
    })),
  });
  const byRig = new Map<string, SeatNode[]>();
  rigs.forEach((rig, i) => byRig.set(rig.rigId, nodeQueries[i]?.data ?? []));
  return {
    rigs,
    byRig,
    isLoading: ps.isLoading,
    error: ps.error,
    nodesPending: nodeQueries.some((q) => q.isLoading),
  };
}

export type RigGraph = { nodes: { id: string; type: string }[]; edges: { id: string; source: string; target: string; label: string }[] };

/** The delegation edges of each rig, keyed in `rigIds` order. */
export function useRigGraphs(rigIds: string[], hostId: string): (RigGraph | undefined)[] {
  return useQueries({
    queries: rigIds.map((rigId) => ({
      queryKey: ["graph", hostId, rigId],
      queryFn: () => getJson<RigGraph>(withHost(`/api/rigs/${encodeURIComponent(rigId)}/graph`, hostId)),
      staleTime: 60_000,
    })),
    combine: (results) => results.map((r) => r.data),
  });
}

export function useAttention() {
  return useQuery({
    queryKey: ["attention"],
    queryFn: () => getJson<{ items: AttentionItem[] }>("/api/attention"),
    refetchInterval: LIVE_INTERVAL_MS,
    select: (d) => d.items ?? [],
  });
}

export function useHosts() {
  return useQuery({
    queryKey: ["hosts"],
    queryFn: () => getJson<{ ownName: string; hosts: Host[] }>("/api/hosts"),
    refetchInterval: 60_000,
  });
}

export function useSend() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { session: string; text: string }) =>
      postJson<SendResult>("/api/transport/send", { session: vars.session, text: vars.text, verify: true }),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["nodes"] }),
  });
}
