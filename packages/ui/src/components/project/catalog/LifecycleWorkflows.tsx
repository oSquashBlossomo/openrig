// Mission-bound workflow lifecycles from the exact execution read: current
// frontier packets, waits and wakes, failure occurrences, boundary receipts and
// authored/running reconciliation. Lifecycle state is not product acceptance;
// a recorded receipt is not adjudicated acceptance; a wake is a check, not a
// delivery guarantee. Actions are copied, never executed from here.

import { Link } from "@tanstack/react-router";
import type { ProjectSelection } from "../../../lib/project-read.js";
import type { WorkflowLifecycleExecution, WorkflowLifecyclePacket } from "../../../lib/workflow-contracts.js";
import { cn } from "../../../lib/utils.js";
import { Disclose, displayValue, ExactText, Field, Fields, listKeyboard, Panel, RecordFields, Tag, Timestamp } from "./evidence-ui.js";
import { lifecycleTone, packetTone } from "./execution-model.js";

const words = (value: string | null | undefined) => (value ? value.replaceAll("-", " ") : "unbound step");

function identityMismatch(instance: WorkflowLifecycleExecution, selection: ProjectSelection, mission: string): string | null {
  const project = instance.identity.project;
  const boundMission = instance.identity.mission;
  if (typeof project === "string" && project !== selection.id) return `bound to project ${project}`;
  if (typeof boundMission === "string" && boundMission !== mission) return `bound to mission ${boundMission}`;
  return null;
}

export function WakeFacts({ packet, testId }: { packet: WorkflowLifecyclePacket; testId: string }) {
  const wake = packet.wake;
  return (
    <div data-testid={testId}>
      <Fields>
        <Field label="Wake">
          {wake ? (
            <span className="flex flex-wrap items-center gap-1.5">
              <Tag tone="muted">{wake.kind}</Tag><Tag tone={wake.phase === "fired" ? "info" : "muted"}>{wake.phase}</Tag>
              <Tag tone={wake.live ? "neutral" : "muted"}>{wake.live ? "live" : "not live"}</Tag>
              {wake.unconsumed ? <Tag tone="warn" testId={`${testId}-unconsumed`}>fired without pickup</Tag> : null}
            </span>
          ) : "none recorded"}
        </Field>
        {wake ? <Field label="Wake ref"><span className="font-mono text-[11px]">{wake.ref}</span></Field> : null}
        {wake ? <Field label="Delivery">{wake.deliveryStatus ?? "not recorded"}</Field> : null}
        {wake?.expiresAt ? <Field label="Due"><Timestamp iso={wake.expiresAt} /></Field> : null}
        {wake?.recoveryOwner ? <Field label="Recovery owner"><span className="font-mono text-[11px]">{wake.recoveryOwner}</span></Field> : null}
        {packet.wake_schedule ? (
          <Field label="Schedule">
            {packet.wake_schedule.policy} · every {packet.wake_schedule.interval_seconds}s · last check <Timestamp iso={packet.wake_schedule.last_evaluation_at} />
          </Field>
        ) : null}
      </Fields>
      <p className="mt-1 text-xs text-on-surface-variant">A wake or schedule is a check that something will be re-presented. It does not guarantee delivery or pickup.</p>
    </div>
  );
}

export function LifecyclePacketDetail({ instance, packet, testId = "lifecycle-packet" }: { instance: WorkflowLifecycleExecution; packet: WorkflowLifecyclePacket; testId?: string }) {
  const transition = packet.latest_transition;
  return (
    <section data-testid={testId} aria-label={`Work packet ${packet.packet_id}`} className="space-y-3 border border-on-surface bg-surface-lowest px-3 py-3">
      <div className="flex flex-wrap items-baseline gap-2">
        <h4 className="font-headline text-sm font-bold uppercase tracking-tight">{words(packet.step_id)}</h4>
        <Tag tone={packetTone(packet)}>{packet.queue_state}</Tag>
        <span className="font-mono text-[11px] text-on-surface-variant">{packet.packet_id}</span>
      </div>
      <Fields>
        <Field label="Purpose">{packet.objective ?? "not recorded"}</Field>
        <Field label="Summary">{packet.summary ?? "not recorded"}</Field>
        <Field label="Owner"><span className="font-mono text-[12px]">{packet.owner}</span></Field>
        <Field label="Workflow">{instance.workflow_name} v{instance.workflow_version} · <span className="font-mono text-[11px]">{instance.instance_id}</span></Field>
        <Field label="Depends on">{packet.depends_on.length ? packet.depends_on.map(words).join(", ") : "nothing declared"}</Field>
        <Field label="Evidence">{packet.evidence_ref ? <span className="font-mono text-[11px]">{packet.evidence_ref}</span> : "not recorded"}</Field>
      </Fields>
      <Panel title="Waiting and continuation">
        <Fields>
          <Field label="Last change">{transition ? <>{transition.state} · {transition.transition_note ?? "no note"} · by <span className="font-mono text-[11px]">{transition.actor_session}</span> · <Timestamp iso={transition.ts} /></> : "no transition recorded"}</Field>
          {packet.blocked_on ? <Field label="Blocked on"><span className="font-mono text-[11px]">{packet.blocked_on}</span></Field> : null}
        </Fields>
        {packet.blocker ? <Disclose summary="Blocker record" defaultOpen testId={`${testId}-blocker`}><RecordFields value={packet.blocker} /></Disclose> : null}
        <div className="mt-2"><WakeFacts packet={packet} testId={`${testId}-wake`} /></div>
      </Panel>
      <Panel title="Next action" note="The served command, byte for byte. Nothing runs from this page.">
        <ExactText value={packet.targeted_action} testId={`${testId}-action`} copyLabel="Copy command" />
        {packet.gate ? <Disclose summary="Gate" defaultOpen testId={`${testId}-gate`}><RecordFields value={packet.gate} /></Disclose> : null}
        {packet.acceptance ? <Disclose summary="Acceptance decision requested" defaultOpen testId={`${testId}-acceptance`}><RecordFields value={packet.acceptance} /></Disclose> : null}
      </Panel>
    </section>
  );
}

function InstanceCard({ instance, selection, mission, packetId, onSelectPacket }: {
  instance: WorkflowLifecycleExecution; selection: ProjectSelection; mission: string; packetId: string | undefined; onSelectPacket: (id: string | undefined) => void;
}) {
  const mismatch = identityMismatch(instance, selection, mission);
  const unresolved = instance.failure_occurrences.filter((f) => f.status === "unresolved");
  const selected = instance.frontier_packets.find((p) => p.packet_id === packetId);
  const testId = `lifecycle-${instance.instance_id}`;
  return (
    <li data-testid={testId} className="border border-outline-variant bg-surface-lowest px-3 py-3">
      <div className="flex flex-wrap items-baseline gap-2">
        <h4 className="font-headline text-sm font-bold uppercase tracking-tight">{instance.description ?? instance.workflow_name}</h4>
        <Tag tone={lifecycleTone(instance.status)} testId={`${testId}-status`}>{instance.status}</Tag>
        <span className="font-mono text-[11px] text-on-surface-variant">{instance.workflow_name} v{instance.workflow_version}</span>
        <Link to="/workflow/instance/$instanceId" params={{ instanceId: instance.instance_id }} data-testid={`${testId}-open`}
          className="ml-auto font-mono text-[10px] uppercase tracking-[0.1em] underline-offset-2 hover:underline">Open instance →</Link>
      </div>
      <p className="mt-0.5 font-mono text-[10px] text-on-surface-variant">{instance.instance_id}{instance.operation_key ? ` · operation ${instance.operation_key}` : ""}</p>
      {mismatch ? <p role="alert" data-testid={`${testId}-identity-mismatch`} className="mt-1 text-xs text-tertiary">Identity mismatch: this lifecycle is {mismatch}. Its facts are not attributed to the selected mission.</p> : null}
      {unresolved.length ? (
        <div data-testid={`${testId}-failures`} className="mt-2 border-l-2 border-tertiary pl-2 text-sm">
          {unresolved.length} unresolved failure occurrence{unresolved.length === 1 ? "" : "s"}:
          <ul className="mt-0.5 space-y-0.5 text-xs">
            {unresolved.map((f) => <li key={f.occurrence_id}><span className="font-mono text-[11px]">{f.occurrence_id}</span> at {words(f.step_id)} · {f.failure_reason ?? "reason not recorded"}</li>)}
          </ul>
          <p className="mt-0.5 text-xs text-on-surface-variant">Choose the exact occurrence to resume on the instance page; nothing is resumed implicitly.</p>
        </div>
      ) : null}
      <div className="mt-2">
        <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-on-surface-variant">Current work</div>
        {instance.frontier_packets.length === 0 ? (
          <p data-testid={`${testId}-no-frontier`} className="mt-1 text-xs text-on-surface-variant">No current work packet · lifecycle {instance.status}. Lifecycle state is not product acceptance.</p>
        ) : (
          <ul role="listbox" aria-label="Current work packets" onKeyDown={(e) => listKeyboard(e)} className="mt-1 divide-y divide-outline-variant/60 border border-outline-variant">
            {instance.frontier_packets.map((packet) => (
              <li key={packet.packet_id}>
                <button type="button" data-nav-item role="option" aria-selected={packet.packet_id === packetId}
                  data-testid={`lifecycle-packet-row-${packet.packet_id}`}
                  onClick={() => onSelectPacket(packet.packet_id === packetId ? undefined : packet.packet_id)}
                  className={cn("flex w-full flex-wrap items-center gap-2 px-2 py-1.5 text-left text-sm hover:bg-surface-low focus-visible:outline focus-visible:outline-2 focus-visible:outline-on-surface",
                    packet.packet_id === packetId && "bg-surface-low")}>
                  <Tag tone={packetTone(packet)}>{packet.queue_state}</Tag>
                  <span className="min-w-0 flex-1">{words(packet.step_id)}<span className="text-on-surface-variant"> · {packet.owner}</span></span>
                  {packet.queue_state === "blocked" ? <span className="text-xs text-warning">waits: {displayValue(packet.blocker?.summary ?? packet.latest_transition?.transition_note ?? packet.blocked_on)}</span> : null}
                  {packet.wake?.unconsumed ? <Tag tone="warn">wake unconsumed</Tag> : null}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {selected ? <div className="mt-2"><LifecyclePacketDetail instance={instance} packet={selected} /></div> : null}
      <Disclose summary={`Obligations and receipts (${instance.boundary_obligations.length})`} testId={`${testId}-obligations`}>
        <p className="mb-1 text-xs text-on-surface-variant">A recorded receipt means an attributed evidence reference was filed. It does not establish acceptance.</p>
        <ul className="space-y-1 text-sm">
          {instance.boundary_obligations.map((o) => (
            <li key={o.stepId} data-testid={`${testId}-obligation-${o.stepId}`}>
              {words(o.stepId)} · {o.required ? "required" : "extension"} · {o.state} · <Tag tone={o.receiptState === "missing" && o.required ? "warn" : "muted"}>receipt {o.receiptState}</Tag>
              {o.receipt ? <span className="ml-1 text-xs text-on-surface-variant"><span className="font-mono">{o.receipt.evidenceRef}</span> by {o.receipt.actorSession} · <Timestamp iso={o.receipt.closedAt} /></span> : null}
            </li>
          ))}
        </ul>
      </Disclose>
      <Disclose summary={`Authored vs running plan · ${instance.reconciliation.status}`} testId={`${testId}-reconciliation`}>
        <Fields>
          <Field label="Bound input"><span className="font-mono text-[11px]">{instance.reconciliation.boundDigest ?? "unbound"} (v{instance.reconciliation.boundVersion})</span></Field>
          <Field label="Authored input"><span className="font-mono text-[11px]">{instance.reconciliation.proposedDigest ?? "not compiled"}{instance.reconciliation.proposedVersion ? ` (v${instance.reconciliation.proposedVersion})` : ""}</span></Field>
          <Field label="Composition">{instance.reconciliation.composition.explanation}</Field>
          {instance.reconciliation.reasons.length ? <Field label="Reasons">{instance.reconciliation.reasons.join("; ")}</Field> : null}
        </Fields>
        {instance.reconciliation.status === "source-only" ? <p className="mt-1 text-xs text-on-surface-variant">Source bytes changed; executable steps and policy are unchanged. Completed work is not replayed.</p> : null}
        <div className="mt-1"><ExactText value={instance.reconciliation.nextAction} copyLabel="Copy" /></div>
        <p className="mt-1 text-xs text-on-surface-variant">Inspect and apply revisions on the instance page, which retains the exact operation key.</p>
      </Disclose>
      <Disclose summary="Bound graph and sources" testId={`${testId}-sources`}>
        <Fields>
          <Field label="Input digest"><span className="font-mono text-[11px]">{instance.compiled_input_digest ?? "not recorded"}</span></Field>
          <Field label="Identity"><span className="font-mono text-[11px]">{displayValue(instance.identity)}</span></Field>
          <Field label="Graph"><span className="font-mono text-[11px]">{displayValue(instance.graph_source)}</span></Field>
        </Fields>
        <ul className="mt-1 space-y-0.5 font-mono text-[11px]">
          {instance.sources.map((s, i) => <li key={i}>{displayValue(s)}</li>)}
        </ul>
        {instance.dependencies.length ? <ul className="mt-1 space-y-0.5 text-xs">{instance.dependencies.map((d, i) => <li key={i}>{displayValue(d)}</li>)}</ul> : null}
      </Disclose>
      {instance.unknowns.length ? (
        <ul data-testid={`${testId}-unknowns`} className="mt-2 space-y-0.5 text-xs text-warning">
          {instance.unknowns.map((u) => <li key={u}>Unknown: {u}</li>)}
        </ul>
      ) : null}
    </li>
  );
}

export function LifecycleWorkflows({ instances, selection, mission, packetId, onSelectPacket, testId = "mission-lifecycles" }: {
  instances: readonly WorkflowLifecycleExecution[]; selection: ProjectSelection; mission: string; packetId: string | undefined;
  onSelectPacket: (id: string | undefined) => void; testId?: string;
}) {
  const ordered = [...instances].sort((a, b) => Number(["completed", "aborted"].includes(a.status)) - Number(["completed", "aborted"].includes(b.status)));
  return (
    <Panel title="Workflows bound to this mission" testId={testId}
      note="Lifecycle instances the daemon joined to this exact project and mission. Workflow completion is separate from product outcome acceptance.">
      {ordered.length === 0 ? <p data-testid={`${testId}-empty`} className="text-sm text-on-surface-variant">No workflow is bound to this mission.</p> : (
        <ul className="space-y-3">
          {ordered.map((instance) => (
            <InstanceCard key={instance.instance_id} instance={instance} selection={selection} mission={mission} packetId={packetId} onSelectPacket={onSelectPacket} />
          ))}
        </ul>
      )}
    </Panel>
  );
}
