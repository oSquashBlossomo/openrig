// Live-terminal admission for the selected 3D seat
// (docs/plans/spatial-redesign-terminal-contract.md).
//
// A selected seat may open ONE live viewer only when a CURRENT node-detail
// read for that exact graph entry confirms the same host, rig, graph node,
// logical id and canonical session, the seat has an actual tmux attachment on
// that session with a registered pane, and no CURRENT native identity check
// for that session/pane reports a mismatch or a missing pane. The admitted
// pane is pinned: a later read reporting another pane is an observed change
// that refuses the old viewer (an explicit operator retry may then admit the
// current seat — the accepted current-seat contract, not native-conversation
// pinning). Known startup/trust/login/attention prompts are NOT a refusal. The terminal endpoint is addressed by session
// name, so nothing here derives a session from a label, role, model, working
// directory or native history id. A registered remote source is read-only:
// its terminal is never opened (and never substituted with a local one).
// Every refusal carries an operator-readable reason; nothing is silently
// downgraded.

import type { SpatialAgent } from "../../../lib/spatial-topology.js";

/** The exact identity a live viewer was admitted for. */
export interface AdmittedSeat {
  hostId: string;
  rigId: string;
  nodeId: string;
  logicalId: string;
  session: string;
  /** tmux pane registered for the session when admitted (e.g. "%1"). */
  pane: string;
}

export type AdmissionRefusal =
  | "remote"
  | "no-logical-id"
  | "no-session"
  | "identity-mismatch"
  | "not-tmux"
  | "no-pane"
  | "native-identity"
  | "changed"
  | "unreadable";

export type AdmissionVerdict =
  | { ok: true; seat: AdmittedSeat }
  | { ok: false; kind: AdmissionRefusal; reason: string };

/** Key for the shared live-viewer cap slot of a selected seat. The pinned
 *  pane is compared separately (sameAdmittedSeat): a pane change is an
 *  observed change that refuses, never a silent remount under a new key. */
export function admittedSeatKey(seat: AdmittedSeat): string {
  return ["spatial", seat.hostId, seat.rigId, seat.nodeId, seat.session].map(encodeURIComponent).join(":");
}

/** Exactly the same attachment, pane included. */
export function sameAdmittedSeat(a: AdmittedSeat, b: AdmittedSeat): boolean {
  return admittedSeatKey(a) === admittedSeatKey(b) && a.pane === b.pane;
}

/** An observed change after admission: refuse until the operator retries. */
export function changedSeatRefusal(pinned: AdmittedSeat, current: AdmittedSeat): Extract<AdmissionVerdict, { ok: false }> {
  return {
    ok: false,
    kind: "changed",
    reason: current.pane !== pinned.pane
      ? `The seat's tmux pane changed (${pinned.pane} → ${current.pane}); this viewer was closed. Retry to attach to the current pane.`
      : "The seat's attachment changed; this viewer was closed. Retry to attach to the current seat.",
  };
}

/** What can be decided from the selected graph entry alone, before any read. */
export function precheckSeat(agent: SpatialAgent, hostId: string, isRemote: boolean): AdmissionVerdict | null {
  if (agent.hostId !== hostId) {
    return { ok: false, kind: "identity-mismatch", reason: `This seat was read from ${agent.hostId}, not the selected host ${hostId}; no terminal is opened.` };
  }
  if (isRemote) {
    return {
      ok: false,
      kind: "remote",
      reason: `${hostId} is a registered remote source: its seats are read through as details only. Live terminals are not streamed from remote hosts, and no local session is substituted.`,
    };
  }
  if (!agent.logicalId) {
    return { ok: false, kind: "no-logical-id", reason: "The graph entry has no logical id, so the seat's identity cannot be verified for a live terminal." };
  }
  if (!agent.canonicalSessionName) {
    return { ok: false, kind: "no-session", reason: "No canonical session is recorded for this seat, so there is no terminal to attach to." };
  }
  return null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Compare a current node-detail payload with the selected graph entry. The
 *  detail DTO keeps binding facts the narrow UI type omits; they are read
 *  defensively here rather than trusted. */
export function verifySeatDetail(agent: SpatialAgent, hostId: string, detail: unknown): AdmissionVerdict {
  const pre = precheckSeat(agent, hostId, false);
  if (pre) return pre;
  const logicalId = agent.logicalId!;
  const session = agent.canonicalSessionName!;
  if (!isRecord(detail)) return { ok: false, kind: "unreadable", reason: "The seat detail response was not readable." };
  const mismatch = (what: string, served: unknown, selected: string): AdmissionVerdict => ({
    ok: false,
    kind: "identity-mismatch",
    reason: `Seat identity changed: the current detail reports ${what} ${served === null || served === undefined ? "none" : String(served)}, but the selected graph entry has ${selected}. Select the seat again from the refreshed graph.`,
  });
  if (detail.rigId !== agent.rigId) return mismatch("rig", detail.rigId, agent.rigId);
  if (detail.logicalId !== logicalId) return mismatch("logical id", detail.logicalId, logicalId);
  const nodeId = text(detail.nodeId);
  if (nodeId === null) {
    return { ok: false, kind: "identity-mismatch", reason: "The current seat detail does not report its node id, so it cannot be matched to the selected graph node." };
  }
  if (nodeId !== agent.nodeId) return mismatch("node", nodeId, agent.nodeId);
  if (detail.canonicalSessionName !== session) return mismatch("session", detail.canonicalSessionName, session);

  const binding = isRecord(detail.binding) ? detail.binding : null;
  const attachment = text(binding?.attachmentType) ?? text(detail.attachmentType) ?? (binding ? "tmux" : null);
  if (!binding || attachment !== "tmux") {
    return {
      ok: false,
      kind: "not-tmux",
      reason: binding
        ? `This seat is attached as ${attachment ?? "an unknown kind"}, not a tmux pane, so there is no live terminal to mirror.`
        : "This seat has no recorded attachment, so there is no live terminal to mirror.",
    };
  }
  const tmuxSession = text(binding.tmuxSession);
  if (tmuxSession !== session) {
    return {
      ok: false,
      kind: "identity-mismatch",
      reason: `The seat's tmux attachment (${tmuxSession ?? "none"}) does not match its canonical session ${session}; the terminal is not opened.`,
    };
  }
  const pane = text(binding.tmuxPane);
  if (pane === null) {
    return { ok: false, kind: "no-pane", reason: `No tmux pane is registered for ${session}, so there is no current attachment to mirror.` };
  }
  const native = applicableIdentityFailure(detail.identityVerdict, session, pane);
  if (native) return { ok: false, kind: "native-identity", reason: native };
  return { ok: true, seat: { hostId, rigId: agent.rigId, nodeId, logicalId, session, pane } };
}

/** A served native identity verdict that applies to THIS session and pane
 *  and says the pane is not this seat (mismatch) or is gone (pane_missing).
 *  The daemon already withholds verdicts computed against an older binding;
 *  a verdict naming another session/pane is still treated as not applicable.
 *  Missing, verified and tmux_unavailable verdicts are not evidence of a wrong
 *  identity and never block (attention/trust/login prompts stay reachable). */
function applicableIdentityFailure(value: unknown, session: string, pane: string): string | null {
  if (!isRecord(value)) return null;
  const verdict = value.verdict;
  if (verdict !== "mismatch" && verdict !== "pane_missing") return null;
  const verdictSession = text(value.sessionName);
  if (verdictSession !== null && verdictSession !== session) return null;
  const evidence = isRecord(value.evidence) ? value.evidence : null;
  const verdictPane = text(evidence?.registeredPane) ?? text(value.registeredPane);
  if (verdictPane !== null && verdictPane !== pane) return null;
  const why = text(value.reason);
  const what = verdict === "pane_missing"
    ? `The registered tmux pane ${pane} for ${session} is missing`
    : `The process in tmux pane ${pane} is not the registered seat for ${session}`;
  return `${what}${why ? ` (${why})` : ""}; the terminal is not opened.`;
}

/** Reconnect revalidation: the fresh detail must still describe exactly the
 *  admitted seat. */
export function revalidateAdmittedSeat(seat: AdmittedSeat, agent: SpatialAgent, detail: unknown): true | { refuse: string } {
  const verdict = verifySeatDetail(agent, seat.hostId, detail);
  if (!verdict.ok) return { refuse: verdict.reason };
  if (!sameAdmittedSeat(verdict.seat, seat)) {
    return { refuse: changedSeatRefusal(seat, verdict.seat).reason };
  }
  return true;
}
