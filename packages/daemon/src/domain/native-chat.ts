import type Database from "better-sqlite3";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { TmuxAdapter, TmuxCursorPosition } from "../adapters/tmux.js";
import type { SessionRegistry } from "./session-registry.js";
import type { ContextUsageStore } from "./context-usage-store.js";
import type { AgentActivityStore } from "./agent-activity-store.js";
import { deriveActiveOccupantsByNode } from "./active-occupant.js";
import { verifyClaudeCurrentSession, readClaudeProcessSession } from "./claude-session-identity.js";
import { verifyCodexPaneProcess, type NativeProcessLister } from "./native-process-lineage.js";
import { CodexThreadIdResolver } from "./codex-thread-id.js";
import { assessNativeResumeProbe } from "./native-resume-probe.js";
import { classifyPaneActivity } from "./session-transport.js";
import { nativeChatTextHash, readNativeChatHistory } from "./native-chat-history.js";

export class NativeChatError extends Error {
  constructor(readonly code: string, message: string, readonly status: 400 | 404 | 409 = 409) { super(message); }
}
type Runtime = "codex" | "claude-code";
export interface NativeChatRequest {
  requestId: string; kind: "message" | "interrupt"; text: string;
  state: "sending" | "submitted" | "observed" | "failed" | "indeterminate";
  detail: string; createdAt: string; updatedAt: string;
}
interface RequestRow {
  request_id: string; node_id: string; owner_key: string; conversation_id: string;
  kind: NativeChatRequest["kind"]; text: string; state: NativeChatRequest["state"]; detail: string;
  effects_started: number; file_key: string | null; history_offset: number | null; created_at: string; updated_at: string;
}
interface Deps {
  db: Database.Database; sessionRegistry: SessionRegistry; tmux: TmuxAdapter;
  contextUsageStore?: ContextUsageStore; agentActivityStore?: AgentActivityStore;
  listProcesses?: NativeProcessLister; codexHome?: string; claudeConfigDir?: string; settleMs?: number;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const publicRequest = (r: RequestRow): NativeChatRequest => ({ requestId: r.request_id, kind: r.kind,
  text: r.text, state: r.state, detail: r.detail, createdAt: r.created_at, updatedAt: r.updated_at });

/** Deliberately narrow composer proof. A footer alone, ghost suggestion, selector,
 * partial/collapsed paste or unfamiliar native layout stays Terminal-only. */
export function nativeChatComposer(pane: string, runtime: Runtime): string | null {
  const lines = pane.split("\n");
  const marker = runtime === "claude-code" ? "❯" : "[›»]";
  let at = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (new RegExp(`^\\s*${marker}(?:\\s|$)`).test(lines[i]!)) { at = i; break; }
  if (at < 0 || /^[❯›»]\s*\d+\./.test(lines[at]!.trim())) return null;
  let end = -1;
  for (let i = at + 1; i < lines.length; i++) {
    if (runtime === "claude-code" ? /^[─═-]{10,}$/.test(lines[i]!.trim()) : /(?:\? for shortcuts|\d+% context left|· Context \[)/.test(lines[i]!)) { end = i; break; }
  }
  if (end < 0) return null;
  if (runtime === "claude-code" && !/(?:shift\+tab to cycle|\? for shortcuts)/i.test(lines.slice(end + 1).join("\n"))) return null;
  const bodyLines = [lines[at]!.trimStart().slice(1).replace(/^ /, ""), ...lines.slice(at + 1, end).map(line => line.replace(/^  /, ""))];
  while (bodyLines.length && bodyLines.at(-1) === "") bodyLines.pop();
  const body = bodyLines.join("\n");
  if (/\[Pasted text|Press up to edit queued messages/i.test(body)) return null;
  return runtime === "codex" && body === "Ask Codex to do anything" ? "" : body;
}

function cursorAtEmptyComposer(pane: string, runtime: Runtime, cursor: TmuxCursorPosition): boolean {
  const marker = runtime === "claude-code" ? "❯" : "[›»]";
  const lines = pane.split("\n");
  const prefix = new RegExp(`^([ ]*${marker}[ \u00a0])`);
  let at = -1, x = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = prefix.exec(lines[i]!);
    if (match) { at = i; x = [...match[1]!].length; break; }
  }
  return at >= 0 && cursor.y === at && cursor.x === x;
}

export class NativeChatService {
  private readonly inFlight = new Set<string>();
  private readonly codexHome: string;
  private readonly codexThreads: CodexThreadIdResolver;
  constructor(private readonly deps: Deps) {
    this.codexHome = deps.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
    this.codexThreads = new CodexThreadIdResolver({ codexHome: this.codexHome });
  }
  private current(nodeId: string) {
    const node = this.deps.db.prepare("SELECT n.id,n.rig_id,n.runtime,n.cwd FROM nodes n JOIN rigs r ON r.id=n.rig_id WHERE n.id=? AND r.archived_at IS NULL").get(nodeId) as { id: string; rig_id: string; runtime: string; cwd: string | null } | undefined;
    if (!node) throw new NativeChatError("node_missing", "This seat is unavailable.", 404);
    if (node.runtime !== "codex" && node.runtime !== "claude-code") throw new NativeChatError("runtime_unsupported", "Use Terminal for this runtime.");
    const sessions = this.deps.sessionRegistry.getSessionsForRig(node.rig_id);
    const occupant = deriveActiveOccupantsByNode(sessions, [nodeId])[nodeId];
    const session = occupant?.kind === "resolved" ? sessions.find(row => row.id === occupant.sessionId) : undefined;
    const binding = this.deps.sessionRegistry.getBindingForNode(nodeId);
    if (!session?.resumeToken || !UUID.test(session.resumeToken) || !binding?.tmuxPane || binding.attachmentType === "external_cli"
      || binding.tmuxSession !== session.sessionName || session.resumeType !== (node.runtime === "codex" ? "codex_id" : "claude_id")) {
      throw new NativeChatError("owner_unverified", "No single current native conversation is verified. Open Terminal.");
    }
    const generation = this.deps.sessionRegistry.currentOccupantTenure(nodeId)?.generationUuid ?? null;
    const stamp = JSON.stringify([node.id, node.runtime, node.cwd, session.id, session.resumeToken, binding.id, binding.tmuxSession, binding.tmuxPane, generation]);
    return { node, session, binding, generation, stamp, runtime: node.runtime as Runtime };
  }
  private async owner(nodeId: string) {
    const current = this.current(nodeId), { session, binding, runtime } = current;
    const panes = await this.deps.tmux.listPanes(session.sessionName);
    if (panes.length !== 1 || panes[0]!.id !== binding.tmuxPane) throw new NativeChatError("owner_unverified", "The current native pane is not unique. Open Terminal.");
    const input = { target: binding.tmuxPane!, tmux: this.deps.tmux, expectedToken: session.resumeToken!, listProcesses: this.deps.listProcesses };
    let native;
    if (runtime === "claude-code") {
      native = await verifyClaudeCurrentSession({ ...input, sessionName: session.sessionName, cwd: current.node.cwd });
      if (native) {
        const pidToken = readClaudeProcessSession({ process: native.process, sessionName: session.sessionName, configDir: this.claudeRoot(current.node.cwd) });
        if (pidToken && pidToken !== session.resumeToken) native = null; // /clear beats the old launch argv
      }
    } else {
      native = await verifyCodexPaneProcess({ ...input, requireResume: true });
      if (native) {
        const currentToken = await this.codexThreads.resolve(native.process.pid, native.process.startedAt!);
        if (currentToken && currentToken !== session.resumeToken) throw new NativeChatError("owner_changed", "The native conversation changed. Refresh before sending.");
      }
      if (!native) {
        native = await verifyCodexPaneProcess({ ...input, requireResume: false });
        if (native && await this.codexThreads.resolve(native.process.pid, native.process.startedAt!) !== session.resumeToken) native = null;
      }
    }
    if (!native || this.current(nodeId).stamp !== current.stamp) throw new NativeChatError("owner_unverified", "The exact native conversation could not be verified. Open Terminal.");
    const after = await this.deps.tmux.listPanes(session.sessionName);
    if (after.length !== 1 || after[0]!.id !== binding.tmuxPane) throw new NativeChatError("owner_changed", "The terminal owner changed. Refresh before sending.");
    return { ...current, native, ownerKey: nativeChatTextHash(`${current.stamp}:${native.fingerprint}`) };
  }
  private claudeRoot(cwd: string | null) { return resolve(cwd ?? process.cwd(), this.deps.claudeConfigDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude")); }
  private history(owner: Awaited<ReturnType<NativeChatService["owner"]>>, before?: string) {
    const { session, runtime } = owner;
    let path: string | null = null;
    if (runtime === "codex") path = this.deps.contextUsageStore?.readCodexTranscriptPath(session.resumeToken!) ?? null;
    else {
      const sidecar = this.deps.contextUsageStore?.readSidecar(session.sessionName, 64 * 1024);
      if (sidecar?.ok && sidecar.data.session_id === session.resumeToken && sidecar.data.session_name === session.sessionName
        && owner.generation && sidecar.data.occupant_generation === owner.generation && typeof sidecar.data.transcript_path === "string") path = sidecar.data.transcript_path;
    }
    if (!path) throw new NativeChatError("history_unavailable", "Verified native history has not been located yet. Open Terminal.");
    return readNativeChatHistory({ path, root: runtime === "codex" ? this.codexHome : join(this.claudeRoot(owner.node.cwd), "projects"),
      conversationId: session.resumeToken!, runtime, before });
  }
  private async readiness(owner: Awaited<ReturnType<NativeChatService["owner"]>>) {
    const observation = await this.deps.tmux.capturePaneObservation(owner.binding.tmuxPane!);
    const pane = observation?.snapshot ?? null;
    const activity = classifyPaneActivity(pane ?? "");
    const probe = assessNativeResumeProbe({ runtime: owner.runtime, paneCommand: owner.runtime === "codex" ? "codex" : "claude", paneContent: pane,
      claudeAutoIdentityVerified: true, claudeResumeIdentityVerified: true });
    const hook = this.deps.agentActivityStore?.getLatestForNode({ nodeId: owner.node.id, sessionName: owner.session.sessionName });
    const guard = this.deps.tmux.deliveryGuard?.preference(owner.node.id);
    const empty = observation !== null && pane !== null && nativeChatComposer(pane, owner.runtime) === ""
      && cursorAtEmptyComposer(pane, owner.runtime, observation.cursor);
    if (!this.deps.tmux.deliveryGuard) return { state: "unavailable" as const, detail: "Guarded native delivery is unavailable. Use Terminal.", canSend: false, canInterrupt: false };
    if (guard?.desired || guard?.effective) return { state: "needs_terminal" as const, detail: "Typing guard is enabled. Use Terminal.", canSend: false, canInterrupt: false };
    if (activity.state === "attention" || hook?.state === "needs_input" || probe.status === "attention_required" || probe.status === "failed") return { state: "needs_terminal" as const, detail: "A draft or native question needs your attention in Terminal.", canSend: false, canInterrupt: false };
    if (activity.state === "agent_active" || hook?.state === "running") return { state: "busy" as const, detail: "The native agent is working. Wait, or interrupt the current turn.", canSend: false, canInterrupt: activity.state === "agent_active" && empty };
    const ready = activity.state === "agent_idle" && empty;
    return { state: ready ? "ready" as const : "needs_terminal" as const,
      detail: ready ? "The verified native conversation has an empty composer." : "The native composer is not positively ready. Open Terminal.", canSend: ready, canInterrupt: false };
  }
  private async assertStaged(owner: Awaited<ReturnType<NativeChatService["owner"]>>, text: string) {
    const observation = await this.deps.tmux.capturePaneObservation(owner.binding.tmuxPane!);
    const pane = observation?.snapshot ?? null;
    const activity = classifyPaneActivity(pane ?? "");
    const probe = assessNativeResumeProbe({ runtime: owner.runtime, paneCommand: owner.runtime === "codex" ? "codex" : "claude", paneContent: pane,
      claudeAutoIdentityVerified: true, claudeResumeIdentityVerified: true });
    const composer = nativeChatComposer(pane ?? "", owner.runtime);
    const hook = this.deps.agentActivityStore?.getLatestForNode({ nodeId: owner.node.id, sessionName: owner.session.sessionName });
    if (composer === null || composer !== text
      || hook?.state === "running" || hook?.state === "needs_input" || probe.status === "attention_required" || probe.status === "failed" || activity.state === "agent_active" || (activity.state === "attention" && activity.reason !== "prompt_draft")) {
      throw new NativeChatError("staged_unverified", "Text may be staged, but its complete native composer could not be verified. Inspect Terminal; no Enter was sent.");
    }
  }
  private receipt(id: string): RequestRow | undefined {
    let row = this.deps.db.prepare("SELECT * FROM native_chat_requests WHERE request_id=?").get(id) as RequestRow | undefined;
    if (row?.state === "sending" && !this.inFlight.has(id)) {
      this.update(id, "indeterminate", "The daemon stopped before confirming delivery. Check native history or Terminal; this request will not be replayed.");
      row = this.deps.db.prepare("SELECT * FROM native_chat_requests WHERE request_id=?").get(id) as RequestRow;
    }
    return row;
  }
  private update(id: string, state: NativeChatRequest["state"], detail: string) {
    this.deps.db.prepare("UPDATE native_chat_requests SET state=?,detail=?,updated_at=? WHERE request_id=?").run(state, detail, new Date().toISOString(), id);
  }
  async read(nodeId: string, before?: string) {
    const owner = await this.owner(nodeId);
    let page: ReturnType<typeof readNativeChatHistory> | undefined;
    try { page = this.history(owner, before); } catch { /* Never expose a filesystem path/error to the browser. */ }
    const rows = this.deps.db.prepare("SELECT * FROM native_chat_requests WHERE node_id=? AND conversation_id=? ORDER BY created_at DESC LIMIT 30").all(nodeId, owner.session.resumeToken) as RequestRow[];
    const requests = rows.map(original => {
      let row = this.receipt(original.request_id)!;
      if (page && row.kind === "message" && (row.state === "submitted" || row.state === "indeterminate") && row.file_key === page.fileKey
        && page.records.some(item => item.message.role === "user" && item.offset >= (row.history_offset ?? Infinity) && item.textHash === nativeChatTextHash(row.text))) {
        this.update(row.request_id, "observed", "A matching later user message is saved in this native conversation. This is not a model-completion receipt."); row = this.receipt(row.request_id)!;
      }
      return publicRequest(row);
    });
    const availability = await this.readiness(owner);
    if (this.current(nodeId).stamp !== owner.stamp) throw new NativeChatError("owner_changed", "The conversation changed. Refresh before sending.");
    return { identity: { nodeId, sessionId: owner.session.id, sessionName: owner.session.sessionName, runtime: owner.runtime, conversationId: owner.session.resumeToken!, ownerKey: owner.ownerKey },
      availability, history: page ? { state: page.state, detail: page.detail, olderCursor: page.olderCursor }
        : { state: "unavailable" as const, detail: "Verified native history is unavailable; use Terminal. No other conversation was substituted.", olderCursor: null },
      messages: page?.messages ?? [], requests };
  }
  async send(nodeId: string, input: { requestId: string; ownerKey: string; text?: string }, kind: NativeChatRequest["kind"] = "message") {
    const text = kind === "interrupt" ? "" : input.text;
    if (!UUID.test(input.requestId ?? "") || typeof input.ownerKey !== "string" || !/^[0-9a-f]{64}$/.test(input.ownerKey)
      || typeof text !== "string" || (kind === "message" && (!text.trim() || Buffer.byteLength(text) > 32 * 1024 || /[\x00-\x09\x0b-\x1f\x7f-\x9f]/.test(text) || /^\s*\//.test(text)))) {
      throw new NativeChatError("invalid_message", "Use 1–32768 bytes of plain text; native commands and control keys belong in Terminal.", 400);
    }
    // This lookup precedes current-owner admission: retries after /clear/restart must
    // read the old durable receipt, never become eligible for a second delivery.
    const old = this.receipt(input.requestId);
    if (old) {
      if (old.node_id !== nodeId || old.owner_key !== input.ownerKey || old.kind !== kind || old.text !== text) throw new NativeChatError("request_conflict", "This request ID conflicts with an earlier request.");
      return publicRequest(old);
    }
    const pending = this.deps.db.prepare("SELECT request_id FROM native_chat_requests WHERE node_id=? AND state='sending' LIMIT 1").get(nodeId) as { request_id: string } | undefined;
    if (pending && this.receipt(pending.request_id)?.state === "sending") throw new NativeChatError("send_in_progress", "A send is already in progress for this seat. Wait for its receipt.");
    const initial = this.current(nodeId);
    const now = new Date().toISOString();
    this.deps.db.prepare("INSERT INTO native_chat_requests(request_id,node_id,owner_key,conversation_id,kind,text,state,detail,created_at,updated_at) VALUES(?,?,?,?,?,?,'sending','Checking native delivery readiness.',?,?)")
      .run(input.requestId, nodeId, input.ownerKey, initial.session.resumeToken, kind, text, now, now);
    this.inFlight.add(input.requestId);
    let effects = false;
    try {
      // Never dispatch without the actual shared lease: it coordinates automatic
      // writers and lifecycle changes. Existing generic transport policy is unchanged.
      if (!this.deps.tmux.deliveryGuard) throw new NativeChatError("guard_unavailable", "Guarded native delivery is unavailable. Open Terminal.");
      await this.deps.tmux.operation(initial.session.sessionName, async () => {
        const owner = await this.owner(nodeId);
        if (owner.ownerKey !== input.ownerKey) throw new NativeChatError("owner_changed", "The native owner changed. Refresh before sending.");
        const ready = await this.readiness(owner);
        if (!(kind === "message" ? ready.canSend : ready.canInterrupt)) throw new NativeChatError("not_ready", ready.detail);
        // A positively identified fresh native conversation may not have emitted
        // its first transcript yet. Sending does not depend on telemetry existence.
        // Without a pre-effect file watermark we keep the receipt submitted, not observed.
        try {
          const history = this.history(owner);
          this.deps.db.prepare("UPDATE native_chat_requests SET file_key=?,history_offset=? WHERE request_id=?").run(history.fileKey, history.endOffset, input.requestId);
        } catch { /* Native identity/readiness remain the dispatch authority. */ }
        let submitting = false;
        const beforeWrite = async () => {
          const boundaryOwner = await this.owner(nodeId);
          if (boundaryOwner.ownerKey !== owner.ownerKey) throw new NativeChatError("owner_changed", "The native owner changed at the input boundary.");
          if (submitting) await this.assertStaged(boundaryOwner, text);
          else {
            const boundary = await this.readiness(boundaryOwner);
            if (!(kind === "message" ? boundary.canSend : boundary.canInterrupt)) throw new NativeChatError("not_ready", boundary.detail);
          }
          if (this.current(nodeId).stamp !== owner.stamp) throw new NativeChatError("owner_changed", "The native owner changed before input.");
          // Commit BEFORE invoking tmux: any later error can include a partial write.
          this.deps.db.prepare("UPDATE native_chat_requests SET effects_started=1 WHERE request_id=?").run(input.requestId); effects = true;
        };
        if (kind === "interrupt") {
          const result = await this.deps.tmux.sendKeys(owner.binding.tmuxPane!, ["Escape"], beforeWrite);
          if (!result.ok) throw new Error("Native key delivery was not confirmed");
          this.update(input.requestId, "submitted", "One interrupt key was sent to the native owner; waiting for native state to confirm it stopped."); return;
        }
        const pasted = await this.deps.tmux.sendText(owner.binding.tmuxPane!, text, beforeWrite);
        if (!pasted.ok) throw new Error("Native paste delivery was not confirmed");
        await new Promise(resolve => setTimeout(resolve, this.deps.settleMs ?? 200));
        await this.assertStaged(owner, text);
        submitting = true;
        const submitted = await this.deps.tmux.sendKeys(owner.binding.tmuxPane!, ["Enter"], beforeWrite);
        if (!submitted.ok) throw new Error("Native submit delivery was not confirmed");
        this.update(input.requestId, "submitted", "Text and Enter were sent to the same native owner. Waiting for a saved native user message; model consumption is not yet confirmed.");
      });
    } catch (error) {
      this.update(input.requestId, effects ? "indeterminate" : "failed", error instanceof NativeChatError ? error.message
        : effects ? "Native delivery could not be confirmed. Check Terminal; this request will not be replayed." : "No native input was written. Delivery prerequisites could not be verified; open Terminal.");
    } finally { this.inFlight.delete(input.requestId); }
    return publicRequest(this.receipt(input.requestId)!);
  }
}
