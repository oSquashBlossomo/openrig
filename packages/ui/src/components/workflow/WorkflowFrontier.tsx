// Rich workflow-route facts: current frontier packets with their waiting view,
// deadline evidence and backstops; boundary obligations and receipts; served
// unknowns; and the lifecycle identity this instance is bound to.

import { useNavigate } from "@tanstack/react-router";
import type { WorkflowBackstop, WorkflowBoundaryObligation, WorkflowFrontierPacket, WorkflowInstanceWithDeadline } from "../../lib/workflow-contracts.js";
import { catalogHref } from "../project/catalog/project-location.js";
import { Disclose, displayValue, Field, Fields, Panel, RecordFields, Tag, Timestamp } from "../project/catalog/evidence-ui.js";

function Backstop({ label, backstop }: { label: string; backstop: WorkflowBackstop }) {
  return (
    <Field label={label}>
      {backstop.mechanism} · owner <span className="font-mono text-[11px]">{backstop.owner}</span>
      {backstop.dueAt ? <> · due <Timestamp iso={backstop.dueAt} /></> : null}
      {backstop.intervalSeconds !== null ? ` · every ${backstop.intervalSeconds}s` : ""}
      {backstop.suspendedUntil ? <> · suspended until <Timestamp iso={backstop.suspendedUntil} /></> : null}
      {backstop.recovery ? ` · recovery ${backstop.recovery.qitemId} (${backstop.recovery.state})` : ""}
      {backstop.note ? <span className="block text-xs text-on-surface-variant">{backstop.note}</span> : null}
    </Field>
  );
}

function PacketCard({ packet }: { packet: WorkflowFrontierPacket }) {
  const w = packet.waiting;
  return (
    <li data-testid={`workflow-frontier-${packet.packetId}`} className="border border-outline-variant bg-surface-lowest px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-bold">{packet.stepId ?? "unbound step"}</span>
        <Tag tone={packet.queueState === "blocked" ? "warn" : "muted"}>{packet.queueState ?? "state not recorded"}</Tag>
        {packet.deadline.state !== "healthy" ? <Tag tone="bad">{packet.deadline.state}</Tag> : null}
        <Tag tone="muted" title="Served coarse next-action verb">{packet.targetedAction}</Tag>
        <span className="font-mono text-[11px] text-on-surface-variant">{packet.packetId}</span>
      </div>
      <Fields>
        <Field label="Owner"><span className="font-mono text-[11px]">{packet.ownerSession ?? "unresolved"}</span></Field>
        {packet.blockedOn ? <Field label="Blocked on"><span className="font-mono text-[11px]">{packet.blockedOn}</span></Field> : null}
        <Field label="Depends on">{packet.dependsOn.join(", ") || "nothing declared"}</Field>
        <Field label="Receipt">{packet.receiptRequired ? "required at close" : "not required"}</Field>
        {packet.deadline.evidence ? (
          <Field label="Deadline">{packet.deadline.evidence.overdueBySeconds}s past {packet.deadline.evidence.anchor} (<Timestamp iso={packet.deadline.evidence.anchorAt} />)</Field>
        ) : null}
      </Fields>
      {w ? (
        <Disclose summary={`Waiting · ${w.obligation} · ${w.state}`} testId={`workflow-frontier-${packet.packetId}-waiting`} defaultOpen>
          <Fields>
            <Field label="Owner"><span className="font-mono text-[11px]">{w.owner}</span></Field>
            <Field label="Actionable since"><Timestamp iso={w.actionableSince} /></Field>
            {w.blocker ? <Field label="Blocker">{w.blocker.ref}{w.blocker.owner ? ` · ${w.blocker.owner}` : ""}{w.blocker.state ? ` · ${w.blocker.state}` : ""}</Field> : null}
            <Field label="Liveness">{w.liveness.subject} · {w.liveness.activity} · confidence {w.liveness.confidence}{w.liveness.needsInput.count ? ` · needs input: ${w.liveness.needsInput.reason ?? w.liveness.needsInput.count}` : ""}</Field>
            <Field label="Last change">{w.lastMeaningfulChange ? <>#{w.lastMeaningfulChange.id} · <Timestamp iso={w.lastMeaningfulChange.at} /></> : "not recorded"}</Field>
            <Backstop label="Next backstop" backstop={w.nextBackstop} />
            {w.laterBackstop ? <Backstop label="Later backstop" backstop={w.laterBackstop} /> : null}
            {w.deadlineAt ? <Field label="Deadline at"><Timestamp iso={w.deadlineAt} /></Field> : null}
          </Fields>
          <p className="mt-1 text-xs text-on-surface-variant">Backstops are scheduled checks, not delivery guarantees.</p>
        </Disclose>
      ) : null}
      {packet.gate ? <Disclose summary="Gate"><RecordFields value={packet.gate} /></Disclose> : null}
      {packet.acceptance ? <Disclose summary="Acceptance requested"><RecordFields value={packet.acceptance} /></Disclose> : null}
    </li>
  );
}

export function WorkflowFrontierPanel({ packets }: { packets: WorkflowFrontierPacket[] | undefined }) {
  return (
    <Panel title="Current work packets" testId="workflow-frontier"
      note="The packets on this workflow's frontier right now. A packet being worked or closed is lifecycle progress, not an accepted outcome.">
      {packets === undefined ? <p data-testid="workflow-frontier-unavailable" className="text-sm text-on-surface-variant">Frontier packets are not served for this instance.</p>
        : packets.length === 0 ? <p data-testid="workflow-frontier-empty" className="text-sm text-on-surface-variant">No current work packet.</p>
        : <ul className="space-y-2">{packets.map((p) => <PacketCard key={p.packetId} packet={p} />)}</ul>}
    </Panel>
  );
}

export function WorkflowObligationsPanel({ obligations, unknowns }: { obligations: WorkflowBoundaryObligation[] | undefined; unknowns: string[] | undefined }) {
  if (obligations === undefined && !unknowns?.length) return null;
  return (
    <Panel title="Obligations and receipts" testId="workflow-obligations"
      note="A recorded receipt means an attributed evidence reference was filed. It does not establish acceptance.">
      {obligations?.length ? (
        <ul className="space-y-1 text-sm">
          {obligations.map((o) => (
            <li key={o.stepId} data-testid={`workflow-obligation-${o.stepId}`}>
              {o.stepId} · {o.required ? "required" : "extension"} · {o.state} · <Tag tone={o.receiptState === "missing" && o.required ? "warn" : "muted"}>receipt {o.receiptState}</Tag>
              {o.receipt ? <span className="ml-1 text-xs text-on-surface-variant"><span className="font-mono">{o.receipt.evidenceRef}</span> by {o.receipt.actorSession} · <Timestamp iso={o.receipt.closedAt} /></span> : null}
            </li>
          ))}
        </ul>
      ) : obligations ? <p className="text-sm text-on-surface-variant">No boundary obligations.</p> : null}
      {unknowns?.length ? <ul data-testid="workflow-unknowns" className="mt-2 space-y-0.5 text-xs text-warning">{unknowns.map((u) => <li key={u}>Unknown: {u}</li>)}</ul> : null}
    </Panel>
  );
}

export function WorkflowBindingPanel({ instance }: { instance: WorkflowInstanceWithDeadline }) {
  const navigate = useNavigate();
  const binding = instance.lifecycleBinding;
  if (binding === undefined && instance.boundRig === undefined) return null;
  const identity = binding && typeof binding.identity === "object" && binding.identity !== null ? binding.identity as Record<string, unknown> : null;
  return (
    <Panel title="Lifecycle binding" testId="workflow-binding"
      note="The project and mission this workflow was compiled for. The binding names a project ID, not a root; choose the project from the catalog to browse it.">
      <Fields>
        <Field label="Project">{identity ? displayValue(identity.project) : "not bound"}</Field>
        <Field label="Mission">{identity ? displayValue(identity.mission) : "not bound"}</Field>
        {identity?.lifecycleProfile ? <Field label="Profile">{displayValue(identity.lifecycleProfile)}</Field> : null}
        <Field label="Bound rig"><span className="font-mono text-[11px]">{instance.boundRig ?? "none"}</span></Field>
        <Field label="Operation key"><span className="font-mono text-[11px]">{instance.lifecycleOperationKey ?? "none"}</span></Field>
        <Field label="Input digest"><span className="font-mono text-[11px]">{instance.compiledInputDigest ?? "none"}</span></Field>
      </Fields>
      {identity ? (
        <button type="button" data-testid="workflow-binding-projects" onClick={() => void navigate({ href: catalogHref({}) })}
          className="mt-1 text-xs underline underline-offset-2">Choose this project from the catalog</button>
      ) : null}
      {binding ? <Disclose summary="Full binding record"><RecordFields value={binding} /></Disclose> : null}
    </Panel>
  );
}
