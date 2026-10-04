// V0.3.1 slice 12 walk-item 1 — mission scope data hook.
//
// Wraps GET /api/missions/:missionId, the aggregated mission metadata
// route that returns missionPath + filtered SliceListEntry[]. Pairs
// with useScopeMarkdown for README / PROGRESS content via
// /api/files/read.

import { useQuery } from "@tanstack/react-query";
import { withHostParam } from "../lib/host-param.js";
import { useSelectedHostId } from "./useHosts.js";
import { boundedJsonRead } from "../lib/bounded-json-read.js";
import { isObject, isText, OperatorReadError } from "../lib/operator-read.js";
import type { SliceListEntry, ProofReadiness } from "./useSlices.js";
import type { SpecGraphPayload } from "./useSlices.js";

/** V0.3.1 slice 13 walk-item 7 — mission frontmatter `workflow_spec`
 *  declaration. Parsed by the missions route from
 *  `<missionPath>/README.md` frontmatter; null when absent. */
export interface MissionWorkflowSpecRef {
  name: string;
  version: string;
}

/** V0.3.1 slice 13 walk-item 7 — projected mission topology. Envelope
 *  is null when no `workflow_spec` is declared. Inside the envelope
 *  `specGraph` is null when the declaration is present but the spec
 *  isn't yet in the cache (declared-but-unshipped). */
export interface MissionTopology {
  specGraph: SpecGraphPayload | null;
}

export interface MissionDataResponse {
  missionId: string;
  /** Additive authored/native facts returned by current daemons. */
  readiness?: ProofReadiness;
  status?: string | null;
  /** Absolute filesystem path of the mission folder. */
  missionPath: string;
  /** Slices in this mission (SliceListEntry[] filtered). */
  slices: SliceListEntry[];
  /** V0.3.1 slice 13 — workflow_spec frontmatter declaration. */
  workflow_spec: MissionWorkflowSpecRef | null;
  /** V0.3.1 slice 13 — projected mission topology (specGraph). */
  topology: MissionTopology | null;
}

export interface MissionUnavailable {
  unavailable: true;
  error: string;
  hint?: string;
}

export async function readMission(missionId: string | null, hostId: string, signal?: AbortSignal): Promise<MissionDataResponse | MissionUnavailable> {
  if (!isText(missionId) || !missionId.trim()) throw new OperatorReadError("invalid_request", "Choose an exact mission before fetching.");
  return boundedJsonRead(withHostParam(`/api/missions/${encodeURIComponent(missionId)}`, hostId), { signal, readResponse: async res => {
    if (res.status === 503) {
      const body: unknown = await res.json().catch(() => ({}));
      return { unavailable: true, error: isObject(body) && isText(body.error) ? body.error : "missions_route_unavailable",
        hint: isObject(body) && isText(body.hint) ? body.hint : undefined };
    }
    if (res.status === 404) { return { unavailable: true, error: "mission_not_found" }; }
    if (!res.ok) { throw new Error(`HTTP ${res.status}`); }
    const value = await res.json() as MissionDataResponse;
    if (!isObject(value) || value.missionId !== missionId || !isText(value.missionPath) || !Array.isArray(value.slices))
      throw new OperatorReadError("invalid_contract", "Mission response identity could not be verified for this selection.");
    return value;
  } });
}

export function useMission(missionId: string | null) {
  const hostId = useSelectedHostId();
  const query = useQuery({
    queryKey: ["mission", "detail", missionId, hostId],
    queryFn: ({ signal }) => readMission(missionId, hostId, signal),
    enabled: !!missionId?.trim(),
    placeholderData: undefined,
    retry: false,
    staleTime: 30_000,
    refetchInterval: 30_000,
    // V0.3.1 slice 17 workspace-state-correctness pattern: refetch on
    // window focus so the operator who creates a slice folder + comes
    // back to the tab sees the new slice without a manual refresh.
    refetchOnWindowFocus: true,
  });
  return { ...query, data: missionId?.trim() ? query.data : undefined };
}
