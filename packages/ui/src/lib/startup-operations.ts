import { terminalAuthHeaders } from "../components/mission-control/missionControlAuth.js";
import { hasShape, isObject, isText, operatorRead, operatorScopeState, OperatorReadError,
  type OperatorInstanceScope, type OperatorReadOptions } from "./operator-read.js";
import { exactText, isStartupPrerequisites, isStartupRig, isStartupResult, isStartupSelection, sameStartupSelection, matchesStartupResult,
  isFleetRestoreKickoff, isFleetRestoreStatus, isFleetRestoreHandle,
  type StartupAction, type StartupSelection, type StartupFreshConsent, type StartupRig, type StartupResult,
  type FleetRestoreHandle, type FleetRestoreKickoff } from "./startup-contracts.js";
export * from "./startup-contracts.js";

export type StartupOperationErrorCode = "unsupported_scope" | "invalid_request" | "cancelled" | "operation_in_progress" | "rejected" | "outcome_unknown";
export interface StartupOperationAttempt {
  readonly kind: "seat" | "terminal" | "kernel" | "fleet-kickoff" | "fleet-cancel";
  readonly payload: Readonly<Record<string, unknown>>; readonly selection?: StartupSelection; readonly consent?: StartupFreshConsent;
  readonly connectionKey?: string; readonly handle?: FleetRestoreHandle;
}
export class StartupOperationError extends Error {
  constructor(readonly code: StartupOperationErrorCode, message: string, readonly attempt?: StartupOperationAttempt,
    readonly status?: number, readonly serverCode?: string, readonly details?: unknown) { super(message); this.name = "StartupOperationError"; }
}
export interface StartupOperationOptions { signal?: AbortSignal }
export interface StartupActionInput { selection: StartupSelection; action: StartupAction; consent?: StartupFreshConsent }
export interface StartupOperationReceipt<T> { attempt: StartupOperationAttempt; result: T; status: number }

function scopeWrite(scope: OperatorInstanceScope) {
  const error = operatorScopeState(scope).scopeError;
  if (error) throw new StartupOperationError("unsupported_scope", error.message);
}
function encoded(id: string): string {
  if (!exactText(id)) throw new OperatorReadError("invalid_request", "An exact non-empty ID is required.");
  return encodeURIComponent(id);
}
function snapshot(selection: StartupSelection): StartupSelection {
  if (!isStartupSelection(selection)) throw new StartupOperationError("invalid_request", "Select the exact served seat and revision first.");
  const { rigId, nodeId, logicalId, runtime, revision, sessionName } = selection;
  return Object.freeze({ rigId, nodeId, logicalId, runtime, revision, sessionName });
}
export function selectStartupSeat(rig: StartupRig, nodeId: string): StartupSelection {
  if (!isStartupRig(rig)) throw new StartupOperationError("invalid_request", "A validated startup rig is required.");
  const seat = rig.seats.find(row => row.nodeId === nodeId);
  if (!seat) throw new StartupOperationError("invalid_request", "The selected node is absent from this rig.");
  if (!exactText(seat.runtime))
    throw new StartupOperationError("invalid_request", "This seat has no configured startup runtime; its inventory facts remain available.");
  return snapshot({ rigId: rig.rigId, nodeId: seat.nodeId, logicalId: seat.logicalId, runtime: seat.runtime, revision: seat.revision, sessionName: seat.observed.sessionName });
}
/** Call when the operator explicitly chooses fresh; no fresh eligibility is
 * inferred here. Daemon collision/prerequisite/continuity checks remain owners. */
export function consentToFreshStartup(selection: StartupSelection): StartupFreshConsent { return Object.freeze({ action: "fresh", selection: snapshot(selection) }); }
export function readStartupPrerequisites(scope: OperatorInstanceScope, options: OperatorReadOptions = {}) {
  return operatorRead(scope, "/api/startup/prerequisites", isStartupPrerequisites, { ...options, headers: { ...options.headers, ...terminalAuthHeaders() } });
}
export function readStartupRig(scope: OperatorInstanceScope, rigId: string, options: OperatorReadOptions = {}) {
  return operatorRead(scope, `/api/startup/${encoded(rigId)}`, (v): v is StartupRig => isStartupRig(v) && v.rigId === rigId,
    { ...options, headers: { ...options.headers, ...terminalAuthHeaders() } });
}
export async function reconcileStartupAttempt(scope: OperatorInstanceScope, attempt: StartupOperationAttempt, options: OperatorReadOptions = {}) {
  if (attempt.kind !== "seat" || !isStartupSelection(attempt.selection)) throw new OperatorReadError("invalid_request", "Readback requires the retained seat attempt.");
  const selection = attempt.selection;
  const rig = await readStartupRig(scope, selection.rigId, options);
  const seat = rig.seats.find(s => s.nodeId === selection.nodeId) ?? null;
  // A changed runtime can become null/unknown. Preserve that observation instead
  // of failing readback through the stricter action-selection boundary.
  return { rig, seat, selectionChanged: !seat || seat.logicalId !== selection.logicalId || seat.runtime !== selection.runtime
    || seat.revision !== selection.revision || seat.observed.sessionName !== selection.sessionName };
}

// Only codes known to precede effects establish a refusal. Native attention,
// startup failure and arbitrary 409/500 bodies may follow process/context effects.
const preEffectStatus: Readonly<Record<string, number>> = {
  terminal_auth_unavailable: 401, selection_changed: 409, operation_in_progress: 409, provider_prerequisite: 409,
  history_present: 409, resume_unavailable: 409, startup_source_unavailable: 409,
  unverified: 409, transport_unavailable: 409, continuation_unavailable: 409, binding_changed: 409,
  startup_context_missing: 409, startup_context_malformed: 409, startup_context_runtime_mismatch: 409,
  runtime_adapter_missing: 409, launch_unavailable: 409,
};
async function postOnce<T>(route: string, attempt: StartupOperationAttempt, validate: (value: unknown) => value is T,
  expectedStatus: number, options: StartupOperationOptions, startup = false): Promise<StartupOperationReceipt<T>> {
  if (options.signal?.aborted) throw new StartupOperationError("cancelled", "Cancelled before submission.", attempt);
  const controller = new AbortController(); let response: Response | undefined;
  const unknown = (message: string, serverCode?: string, details?: unknown) => new StartupOperationError("outcome_unknown",
    `${message} The operation may have taken effect. ${attempt.kind === "fleet-kickoff" ? "A lost kickoff handle cannot be recovered through this API; do not automatically start another restore." : "Read back the retained exact seat or fleet attempt before another action."}`,
    attempt, response?.status, serverCode, details);
  let rejectAbort!: (error: StartupOperationError) => void;
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const abort = () => { rejectAbort(unknown("Response interrupted after submission.")); controller.abort(); void response?.body?.cancel().catch(() => {}); };
  options.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, startup ? 120_000 : 5_000);
  const request = (async () => {
    try {
      response = await fetch(route, { method: "POST", headers: { ...(startup ? terminalAuthHeaders() : {}), Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify(attempt.payload), signal: controller.signal });
      if (controller.signal.aborted) { void response.body?.cancel().catch(() => {}); throw unknown("Response interrupted after submission."); }
      let value: unknown;
      try { value = await response.json(); } catch { throw unknown("Response was not valid JSON."); }
      const serverCode = isObject(value) ? isText(value.code) ? value.code : isText(value.error) ? value.error : undefined : undefined;
      const detail = isObject(value) && isText(value.message) ? value.message : "Operation response could not confirm its outcome.";
      if (attempt.selection && isStartupResult(value) && !matchesStartupResult(value, attempt.selection))
        throw unknown("Response described a different seat.", serverCode, value);
      if (!response.ok || (isObject(value) && value.ok === false)) {
        const known = startup ? serverCode && Object.hasOwn(preEffectStatus, serverCode) && preEffectStatus[serverCode] === response.status
          : attempt.kind === "fleet-cancel" && response.status === 404 && serverCode === "unknown fleet restore attempt";
        if (known) throw new StartupOperationError("rejected", detail, attempt, response.status, serverCode, value);
        throw unknown(detail, serverCode, value);
      }
      if (response.status !== expectedStatus || !validate(value)) throw unknown("Response identity or contract did not match the submitted operation.", serverCode, value);
      return { attempt, result: value, status: response.status };
    } catch (error) {
      if (error instanceof StartupOperationError) throw error;
      throw unknown("Response could not be read.");
    }
  })();
  try { return await Promise.race([request, aborted]); }
  finally { clearTimeout(timer); options.signal?.removeEventListener("abort", abort); }
}

export function startupActionAttempt(input: StartupActionInput): StartupOperationAttempt {
  if (!input || !["resume", "start", "fresh", "continue"].includes(input.action)) throw new StartupOperationError("invalid_request", "Choose a named startup action.");
  const selection = snapshot(input.selection);
  let consent: StartupFreshConsent | undefined;
  if (input.action === "fresh") {
    if (!input.consent || input.consent.action !== "fresh" || !isStartupSelection(input.consent.selection) || !sameStartupSelection(selection, input.consent.selection))
      throw new StartupOperationError("invalid_request", "Fresh consent must match the exact selected seat and revision.");
    consent = consentToFreshStartup(input.consent.selection);
  }
  return Object.freeze({ kind: "seat", selection, ...(consent ? { consent } : {}), payload: Object.freeze({ action: input.action, revision: selection.revision }) });
}
export async function performStartupAction(scope: OperatorInstanceScope, input: StartupActionInput, options: StartupOperationOptions = {}) {
  scopeWrite(scope); const attempt = startupActionAttempt(input); const selection = attempt.selection!;
  return postOnce(`/api/startup/${encodeURIComponent(selection.rigId)}/${encodeURIComponent(selection.logicalId)}`, attempt,
    (v): v is StartupResult => isStartupResult(v) && v.ok && matchesStartupResult(v, selection), 200, options, true);
}
export async function startStartupTerminal(scope: OperatorInstanceScope, options: StartupOperationOptions = {}) {
  scopeWrite(scope); const attempt = Object.freeze({ kind: "terminal" as const, payload: Object.freeze({}) });
  return postOnce("/api/startup/terminal", attempt, (v): v is StartupResult => isStartupResult(v) && v.ok, 200, options, true);
}
export async function prepareStartupKernel(scope: OperatorInstanceScope, runtime: "codex" | "claude-code", options: StartupOperationOptions = {}) {
  scopeWrite(scope);
  if (runtime !== "codex" && runtime !== "claude-code") throw new StartupOperationError("invalid_request", "Choose the configured kernel runtime.");
  const attempt = Object.freeze({ kind: "kernel" as const, payload: Object.freeze({ runtime }) });
  return postOnce("/api/startup/kernel", attempt, (v): v is StartupResult & { rigId: string } => isStartupResult(v) && v.ok && exactText(v.rigId), 200, options, true);
}

function retainedHandle(connectionKey: string, handle: FleetRestoreHandle): FleetRestoreHandle {
  if (!exactText(connectionKey) || !isFleetRestoreHandle(handle) || handle.connectionKey !== connectionKey)
    throw new StartupOperationError("invalid_request", "Use the exact restore handle retained for this connected instance.");
  return Object.freeze({ connectionKey, fleetAttemptId: handle.fleetAttemptId });
}
export async function kickoffFleetRestore(scope: OperatorInstanceScope, connectionKey: string, options: StartupOperationOptions = {}) {
  scopeWrite(scope);
  if (!exactText(connectionKey)) throw new StartupOperationError("invalid_request", "Name the connected instance before retaining a restore attempt.");
  const attempt = Object.freeze({ kind: "fleet-kickoff" as const, connectionKey, payload: Object.freeze({}) });
  const receipt = await postOnce("/api/crash-cart/restore-fleet", attempt, isFleetRestoreKickoff, 202, options);
  return { ...receipt, handle: Object.freeze({ connectionKey, fleetAttemptId: (receipt.result as FleetRestoreKickoff).fleetAttemptId }) };
}
export function readFleetRestoreStatus(scope: OperatorInstanceScope, connectionKey: string, handle: FleetRestoreHandle, options: OperatorReadOptions = {}) {
  const retained = retainedHandle(connectionKey, handle);
  return operatorRead(scope, `/api/crash-cart/restore-fleet/${encodeURIComponent(retained.fleetAttemptId)}`, isFleetRestoreStatus, options);
}
export async function cancelFleetRestore(scope: OperatorInstanceScope, connectionKey: string, handle: FleetRestoreHandle, options: StartupOperationOptions = {}) {
  scopeWrite(scope); const retained = retainedHandle(connectionKey, handle);
  const attempt = Object.freeze({ kind: "fleet-cancel" as const, connectionKey, handle: retained, payload: Object.freeze({}) });
  return postOnce(`/api/crash-cart/restore-fleet/${encodeURIComponent(retained.fleetAttemptId)}/cancel`, attempt,
    (v): v is { ok: true; cancelled: true } => hasShape(v, { ok: x => x === true, cancelled: x => x === true }), 200, options);
}
