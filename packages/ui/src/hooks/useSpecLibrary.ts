import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { boundedJsonRead } from "../lib/bounded-json-read.js";
import { readLibraryEntries, readLibraryReview } from "../lib/node-library-reads.js";
import { OperatorReadError } from "../lib/operator-read.js";
import { isHostsResponse } from "../lib/hosts-read.js";
import { LOCAL_HOST_ID } from "../lib/host-param.js";
import { useSelectedHostId } from "./useHosts.js";
import type { RigSpecReview, AgentSpecReview } from "./useSpecReview.js";

export type SpecLibraryKind = "rig" | "agent" | "workflow";

export interface SpecLibraryEntry {
  id: string;
  kind: SpecLibraryKind;
  name: string;
  version: string;
  sourceType: "builtin" | "user_file";
  sourcePath: string;
  relativePath: string;
  resolvedSourcePath?: string | null;
  updatedAt: string;
  summary?: string;
  hasServices?: boolean;
  // Workflows in Spec Library v0 — workflow-only metadata.
  isBuiltIn?: boolean;
  rolesCount?: number;
  stepsCount?: number;
  terminalTurnRule?: string;
  targetRig?: string | null;
  // Slice 11 (workflow-spec-folder-discovery) — diagnostic state for
  // workflow rows surfaced by the operator's specs/workflows folder.
  status?: "valid" | "error";
  errorMessage?: string | null;
}

export interface LibraryReview {
  libraryEntryId: string;
  sourcePath: string;
  sourceState: "library_item";
}

export type LibraryRigReview = RigSpecReview & LibraryReview;
export type LibraryAgentReview = AgentSpecReview & LibraryReview;

// Workflows in Spec Library v0 — workflow review payload shape.
export interface LibraryWorkflowReview {
  kind: "workflow";
  libraryEntryId: string;
  name: string;
  version: string;
  purpose: string | null;
  targetRig: string | null;
  terminalTurnRule: string;
  rolesCount: number;
  stepsCount: number;
  isBuiltIn: boolean;
  sourcePath: string;
  cachedAt: string;
  topology: {
    nodes: Array<{
      stepId: string;
      role: string;
      objective: string | null;
      preferredTarget: string | null;
      isEntry: boolean;
      isTerminal: boolean;
      // OPR.0.4.6.WF4 (C1, arch Q1) — the WF-2 node fields the shipped
      // scanner predated. Optional + omit-when-absent: pre-WF-2 specs project
      // WITHOUT these keys (byte-identical). Shapes mirror the daemon exactly
      // (spec-library-workflow-scanner.ts / workflow-types.ts): harness =
      // WorkflowAgentHarness, gate = WorkflowGateSpec {target,summary?,evidence_ref?}.
      harness?: "claude-code" | "codex";
      host?: string;
      gate?: { target: string; summary?: string; evidence_ref?: string };
    }>;
    edges: Array<{
      fromStepId: string;
      toStepId: string;
      // OPR.0.4.6.WF4 (C1) — "branch" = a next_hop.on conditional edge (the
      // shipped scanner dropped these entirely). branchOn = the triggering
      // recorded exit (WorkflowExitKind); absent on direct edges.
      routingType: "direct" | "branch";
      branchOn?: "handoff" | "waiting" | "done" | "failed";
    }>;
  };
  steps: Array<{
    stepId: string;
    role: string;
    objective: string | null;
    allowedExits: string[];
    allowedNextSteps: Array<{ stepId: string; role: string }>;
  }>;
}

export interface SpecLibraryReadOptions {
  /** Undefined follows the selected host; an explicit host pins the read to
   * that origin. Null means unknown: no read or cached evidence is exposed. */
  sourceHostId?: string | null;
}

function requireReadOrigin(sourceHostId: string | null): string {
  if (sourceHostId === null) throw new OperatorReadError("invalid_request", "Choose a known spec-library read origin before reading.");
  return sourceHostId;
}

export function useSpecLibrary(kind?: SpecLibraryKind, options: SpecLibraryReadOptions = {}) {
  const selectedHostId = useSelectedHostId();
  const sourceHostId = options.sourceHostId === undefined ? selectedHostId : options.sourceHostId;
  const query = useQuery({
    queryKey: ["spec-library", kind ?? "all", sourceHostId],
    queryFn: ({ signal }) => readLibraryEntries(kind, requireReadOrigin(sourceHostId), { signal }),
    enabled: sourceHostId !== null,
    placeholderData: undefined,
    retry: false,
  });
  return { ...query, data: sourceHostId === null ? undefined : query.data, sourceHostId };
}

export function useLibraryReview(id: string | null, options: SpecLibraryReadOptions = {}) {
  const selectedHostId = useSelectedHostId();
  const sourceHostId = options.sourceHostId === undefined ? selectedHostId : options.sourceHostId;
  const query = useQuery({
    queryKey: ["spec-library", "review", id, sourceHostId],
    queryFn: ({ signal }) => readLibraryReview(id, requireReadOrigin(sourceHostId), { signal }),
    enabled: !!id && sourceHostId !== null,
    placeholderData: undefined,
    retry: false,
  });
  return { ...query, data: sourceHostId === null ? undefined : query.data, sourceHostId };
}

// NOTE (MH-2): active-lens deliberately does NOT retarget — it is a local
// operator preference with write verbs, excluded from the read allowlist.

// --- Workflows in Spec Library v0: active lens hook ---

export interface ActiveLensPayload {
  specName: string;
  specVersion: string;
  activatedAt: string;
}

async function fetchActiveLens(signal?: AbortSignal): Promise<ActiveLensPayload | null> {
  const body = await boundedJsonRead<{ activeLens: ActiveLensPayload | null }>("/api/specs/library/active-lens", { signal });
  return body.activeLens ?? null;
}

export function useActiveLens() {
  return useQuery({
    queryKey: ["spec-library", "active-lens"],
    queryFn: ({ signal }) => fetchActiveLens(signal),
    staleTime: 0,
  });
}

async function postActiveLens(specName: string, specVersion: string): Promise<ActiveLensPayload | null> {
  const res = await fetch("/api/specs/library/active-lens", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ specName, specVersion }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { activeLens: ActiveLensPayload | null };
  return body.activeLens ?? null;
}

async function deleteActiveLens(): Promise<void> {
  const res = await fetch("/api/specs/library/active-lens", { method: "DELETE" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

export interface ActiveLensOrigin {
  /** Origin of the same library-review query that supplied the rendered
   * review. Never replace a retained review's origin with the new selection. */
  originHostId: string | null;
}

export interface SetActiveLensInput extends ActiveLensOrigin {
  specName: string;
  specVersion: string;
}

/** Active lens is a connected-instance preference. Both the original review
 * and the CURRENT known selection must be local at invocation. Checking the
 * owning cache here protects retained callbacks across host switches/errors;
 * useSelectedHostId's initial-local fallback cannot authorize this write. */
export function useActiveLensActions() {
  const qc = useQueryClient();
  const admit = useCallback((originHostId: string | null) => {
    if (originHostId !== LOCAL_HOST_ID) {
      throw new Error("Active lens requires a review from the connected local instance; its original source is remote or unknown.");
    }
    const selection = qc.getQueryState(["hosts"]);
    if (!selection || selection.status !== "success" || selection.error !== null || !isHostsResponse(selection.data)) {
      throw new Error("Active lens requires a successful known host selection; read the host selection again before changing it.");
    }
    if (selection.data.selected !== LOCAL_HOST_ID) {
      throw new Error("Active lens is a connected-instance preference; select the local host before changing it.");
    }
  }, [qc]);
  const invalidate = useCallback(async () => {
    await qc.invalidateQueries({ queryKey: ["spec-library", "active-lens"] });
    await qc.invalidateQueries({ queryKey: ["slices"] });
  }, [qc]);
  const setActiveLens = useCallback(async ({ originHostId, specName, specVersion }: SetActiveLensInput): Promise<ActiveLensPayload | null> => {
    admit(originHostId);
    const result = await postActiveLens(specName, specVersion);
    await invalidate();
    return result;
  }, [admit, invalidate]);
  const clearActiveLens = useCallback(async ({ originHostId }: ActiveLensOrigin): Promise<void> => {
    admit(originHostId);
    await deleteActiveLens();
    await invalidate();
  }, [admit, invalidate]);
  return { setActiveLens, clearActiveLens };
}
