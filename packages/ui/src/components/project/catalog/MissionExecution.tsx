// One exact mission of one exact catalog project: the execution story.
// NOW / NEXT / PROGRESS / NEEDS-A-DECISION lead; waves carry every slice in
// plan order; workflows, capacity and sources are one tab away. Every fact is
// a served projection value; unknown stays unknown.

import type { ReactNode } from "react";
import type { CanonicalMissionScope, ExecutionDocument, ExecutionView, ProjectSelection } from "../../../lib/project-read.js";
import { LOCAL_OPERATOR_INSTANCE } from "../../../lib/operator-read.js";
import { useExecutionView } from "../../../hooks/useExecutionView.js";
import { cn } from "../../../lib/utils.js";
import { Disclose, displayValue, Field, Fields, listKeyboard, Panel, ReadGate, ReadStatus, TabBar, Tag, Timestamp, type ReadLike } from "./evidence-ui.js";
import {
  declaredStatus, evidenceGaps, missionStory, nextText, outcomeSummary, owners, plannedOwners, problemText,
  sliceState, sliceStateTone, waveGroups, type MissionStory, type SliceRow,
} from "./execution-model.js";
import { LifecycleWorkflows } from "./LifecycleWorkflows.js";
import { MissionOutcomeLine } from "./OutcomeEvidence.js";
import { isMissionView, type MissionView } from "./project-location.js";

const MISSION_TABS: Array<{ id: MissionView; label: string }> = [
  { id: "story", label: "Story" }, { id: "workflows", label: "Workflows" }, { id: "capacity", label: "Capacity & parks" }, { id: "sources", label: "Sources" },
];

function Fact({ label, children, testId, tone }: { label: string; children: ReactNode; testId: string; tone?: "warn" | "muted" }) {
  return (
    <div data-testid={testId} className={cn("grid grid-cols-[6.5rem_1fr] gap-2 border-b border-outline-variant/60 py-1.5 last:border-0", tone === "warn" && "text-warning")}>
      <dt className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-on-surface-variant">{label}</dt>
      <dd className="min-w-0 break-words text-sm">{children}</dd>
    </div>
  );
}

function StoryHeader({ story, doc, onOpenSlice, onOpenPacket }: { story: MissionStory; doc: ExecutionDocument; onOpenSlice: (dir: string) => void; onOpenPacket: (id: string) => void }) {
  const live = story.rows.filter((r) => sliceState(r) === "working").length;
  return (
    <dl data-testid="mission-story-facts" className="mb-4 border border-outline-variant bg-surface-lowest px-3">
      <Fact label="Now" testId="mission-now">
        {story.now.length === 0 ? <span className="text-on-surface-variant">No open slice work in this read.</span> : (
          <ul className="space-y-0.5">
            {story.now.map((row) => (
              <li key={row.dir}>
                <button type="button" className="text-left underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-on-surface" onClick={() => onOpenSlice(row.dir)}>
                  <span className="font-mono text-[12px]">{row.id}</span> · {owners(row).join(", ") || "owner unknown"} · {sliceState(row)}
                </button>
                {problemText(row) ? <span className="ml-1 text-warning">— {problemText(row)}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </Fact>
      <Fact label="Next" testId="mission-next">{story.nextLabel}</Fact>
      <Fact label="Progress" testId="mission-progress">
        {story.accepted}/{story.rows.length} slice outcomes accepted · {live} working
        {story.withoutNativePolicy ? <span className="text-on-surface-variant"> · {story.withoutNativePolicy} without a native outcome policy</span> : null}
      </Fact>
      <Fact label="Lifecycle" testId="mission-lifecycle" tone="muted">{story.lifecycleStatus} · separate from outcomes</Fact>
      {story.needsInput.length || story.gatedPackets.length ? (
        <Fact label="Decision" testId="mission-needs-decision" tone="warn">
          <ul className="space-y-0.5">
            {story.needsInput.map((row) => (
              <li key={row.dir}><button type="button" className="text-left underline-offset-2 hover:underline" onClick={() => onOpenSlice(row.dir)}>⚑ {row.id} · {problemText(row)}</button></li>
            ))}
            {story.gatedPackets.map(({ instance, packet }) => (
              <li key={packet.packet_id}>
                <button type="button" className="text-left underline-offset-2 hover:underline" onClick={() => onOpenPacket(packet.packet_id)}>
                  ⚑ {packet.step_id.replaceAll("-", " ")} waits on gate {displayValue(packet.gate?.target)} · {instance.workflow_name}
                </button>
              </li>
            ))}
          </ul>
        </Fact>
      ) : null}
      <Fact label="Native" testId="mission-native" tone="muted"><MissionOutcomeLine readiness={doc.readiness} testId="mission-native-line" /></Fact>
    </dl>
  );
}

function SliceCard({ row, onOpen }: { row: SliceRow; onOpen: () => void }) {
  const state = sliceState(row);
  const outcome = outcomeSummary(row.readiness);
  const deps = row.sequencing?.depends_on;
  return (
    <li>
      <button type="button" data-nav-item data-testid={`wave-slice-${row.dir}`} onClick={onOpen}
        className="flex h-full w-full flex-col gap-1 border border-outline-variant bg-surface-lowest px-3 py-2 text-left hover:border-on-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-on-surface">
        <span className="flex items-baseline justify-between gap-2">
          <span className="font-mono text-[11px] text-on-surface-variant">{row.id}</span>
          <Tag tone={sliceStateTone(state)} testId={`wave-slice-${row.dir}-state`}>{state}</Tag>
        </span>
        <span className="text-sm font-bold text-on-surface">{row.name}</span>
        <span className="text-xs text-on-surface-variant">Declared: {declaredStatus(row)}{row.scope?.stage ? ` · stage ${row.scope.stage}` : ""}</span>
        <span className="text-xs"><Tag tone={outcome.tone}>{outcome.label}</Tag></span>
        <span className="text-xs text-on-surface-variant">{owners(row).length ? `Owner: ${owners(row).join(", ")}` : `Planned: ${plannedOwners(row).join(", ") || "unknown"}`}</span>
        <span className="text-xs text-on-surface-variant">After: {deps === "INDETERMINATE" ? "unknown" : deps?.length ? deps.join(", ") : row.sequencing ? "none declared" : "not sequenced"}{row.sequencing?.soft_after.length ? ` · soft after ${row.sequencing.soft_after.join(", ")}` : ""}</span>
        {nextText(row) ? <span className="text-xs text-on-surface">{nextText(row)}</span> : null}
      </button>
    </li>
  );
}

function Waves({ doc, story, onOpenSlice }: { doc: ExecutionDocument; story: MissionStory; onOpenSlice: (dir: string) => void }) {
  const groups = waveGroups(story.rows);
  if (!groups.length) return <p className="text-sm text-on-surface-variant">The execution view names no slices for this mission.</p>;
  return (
    <div data-testid="mission-waves" className="space-y-5">
      {groups.map((group) => {
        const guidance = doc.planning_guidance.filter((g) => g.wave === group.wave);
        const care = group.rows.map((r) => r.care).filter(Boolean);
        return (
          <section key={group.wave} data-testid={`wave-${group.wave}`} aria-label={`Wave ${group.wave}`}>
            <h3 className="mb-2 flex flex-wrap items-baseline gap-2 border-b-2 border-on-surface pb-1 font-headline text-sm font-bold uppercase tracking-tight">
              Wave {group.wave}<span className="font-mono text-[10px] font-normal normal-case text-on-surface-variant">{group.rows.length} slice{group.rows.length === 1 ? "" : "s"} · in plan order</span>
            </h3>
            <ul onKeyDown={(e) => listKeyboard(e)} className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {group.rows.map((row) => <SliceCard key={row.dir} row={row} onOpen={() => onOpenSlice(row.dir)} />)}
            </ul>
            {care.length ? (
              <Disclose summary="Care and review planning" testId={`wave-${group.wave}-care`}>
                <ul className="space-y-0.5 text-xs">
                  {group.rows.filter((r) => r.care).map((r) => (
                    <li key={r.dir}><span className="font-mono">{r.id}</span> · review model {r.care!.review_model} · planning dial {r.care!.planning_dial} <span className="text-on-surface-variant">({r.care!.source.dial}; {r.care!.source.arrangement_path ?? r.care!.source.wave_map_row})</span></li>
                  ))}
                </ul>
              </Disclose>
            ) : null}
            {guidance.length ? (
              <div data-testid={`wave-${group.wave}-guidance`} className="mt-2 border-l-2 border-secondary pl-2 text-xs">
                <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-secondary">Authored guidance</span>
                {guidance.map((g) => <p key={`${g.label}:${g.text}`}><b>{g.label}:</b> {g.text} <span className="text-on-surface-variant">({g.source})</span></p>)}
              </div>
            ) : null}
          </section>
        );
      })}
      {doc.planning_guidance.some((g) => g.wave === undefined) ? (
        <div data-testid="mission-guidance" className="border-l-2 border-secondary pl-2 text-xs">
          <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-secondary">Authored mission guidance · decisions guidance, not state</span>
          {doc.planning_guidance.filter((g) => g.wave === undefined).map((g) => <p key={`${g.label}:${g.text}`}><b>{g.label}:</b> {g.text} <span className="text-on-surface-variant">({g.source})</span></p>)}
        </div>
      ) : null}
    </div>
  );
}

function Capacity({ doc, story }: { doc: ExecutionDocument; story: MissionStory }) {
  const p = doc.q6_parallelism;
  const gaps = evidenceGaps(doc, story.rows);
  return (
    <div className="space-y-4">
      <Panel title="Capacity" testId="mission-capacity" note="Lane and seat capacity as served; unknown values remain unknown.">
        <Fields>
          <Field label="Lanes">{p.lanes_live} live of {p.lanes_possible} possible</Field>
          <Field label="Idle seats">{displayValue(p.idle_seats_with_capacity.value)} <span className="text-xs text-on-surface-variant">— {p.idle_seats_with_capacity.basis}</span></Field>
          <Field label="Heavy slot">{p.heavy_slot_holder.value ?? "none"} <span className="text-xs text-on-surface-variant">— {p.heavy_slot_holder.basis}</span></Field>
          <Field label="Disk margin">{p.df_margin.available_kib === "INDETERMINATE" ? "unknown" : `${p.df_margin.available_kib} KiB`}{p.df_margin.path ? ` at ${p.df_margin.path}` : ""} <span className="text-xs text-on-surface-variant">— {p.df_margin.basis}</span></Field>
        </Fields>
      </Panel>
      <Panel title="Active lanes" testId="mission-lanes">
        {doc.q1_lanes.length === 0 ? <p className="text-sm text-on-surface-variant">No claimed lanes.</p> : (
          <ul className="space-y-2">
            {doc.q1_lanes.map((lane) => (
              <li key={lane.qitem_id} data-testid={`lane-${lane.qitem_id}`} className="border border-outline-variant px-3 py-2 text-sm">
                <div className="flex flex-wrap gap-2"><span className="font-mono">{lane.slice}</span> · {lane.seat} · <Tag tone={lane.pickup.state === "working" ? "info" : "warn"}>{lane.pickup.state}</Tag>
                  <Tag tone="muted">{lane.activity.activity}</Tag>{lane.fragile_join ? <Tag tone="warn" testId={`lane-${lane.qitem_id}-fragile`}>fragile join</Tag> : null}</div>
                <p className="mt-0.5 text-xs text-on-surface-variant">Join basis: {lane.join_basis}{"basis" in lane.activity ? ` · activity: ${lane.activity.basis}` : ` · activity decided by ${lane.activity.decided_by ?? "unknown"} at ${lane.activity.changed_at}`}</p>
                <p className="mt-0.5 font-mono text-[10px] text-on-surface-variant">{lane.branch} @ {lane.head_sha} · {lane.worktree_path}</p>
              </li>
            ))}
          </ul>
        )}
      </Panel>
      <Panel title="Parked and waiting" testId="mission-parks" note="A park with a wake is deliberate; a wake is a check, not a delivery guarantee.">
        {doc.q5_park.length === 0 ? <p className="text-sm text-on-surface-variant">No parked rows.</p> : (
          <ul className="space-y-1 text-sm">
            {doc.q5_park.map((park) => (
              <li key={park.qitem_id} data-testid={`park-${park.qitem_id}`}>
                <span className="font-mono text-[11px]">{park.qitem_id}</span> · {park.park_kind} · pickup {park.pickup_state}{park.age_minutes !== null ? ` · ${park.age_minutes} min` : ""}
                {park.wake_target ? <> · wake <span className="font-mono text-[11px]">{park.wake_target}</span></> : " · no wake"}
                <span className="block text-xs text-on-surface-variant">{park.park_kind_basis}{park.pickup_evidence ? ` · ${park.pickup_evidence}` : ""}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
      {gaps.length ? (
        <Panel title="Shared evidence gaps" testId="mission-gaps" note="Where the projection could not determine a fact, grouped by basis.">
          <ul className="space-y-1 text-sm">{gaps.map((g) => <li key={`${g.where}|${g.basis}`}><b>{g.where}</b> undetermined for {g.members.join(", ")} <span className="block text-xs text-on-surface-variant">{g.basis}</span></li>)}</ul>
        </Panel>
      ) : null}
    </div>
  );
}

function Sources({ view }: { view: ExecutionView }) {
  const doc = view.rows[0];
  return (
    <Panel title="Sources and derivation" testId="mission-sources" note={`Derived ${doc.derived_at}; membership: ${doc.membership}.`}>
      <Fields>
        {Object.entries(doc.sources).map(([key, cell]) => (
          <Field key={key} label={key.replaceAll("_", " ")}>
            <span className="text-xs">{Object.entries(cell as Record<string, unknown>).map(([k, v]) => `${k}: ${displayValue(v)}`).join(" · ")}</span>
          </Field>
        ))}
      </Fields>
      {doc.project_readiness ? (
        <Disclose summary={`Project readiness · ${doc.project_readiness.state}`} testId="mission-project-readiness">
          <p className="text-xs">{doc.project_readiness.basis} · revision <span className="font-mono">{doc.project_readiness.revision}</span></p>
          <ul className="mt-1 text-xs">{doc.project_readiness.missions.map((m) => <li key={m.name}>{m.name} · {m.state}</li>)}</ul>
        </Disclose>
      ) : null}
    </Panel>
  );
}

export function MissionExecution({ selection, mission, missionScope, view, packet, onView, onOpenSlice, onSelectPacket }: {
  selection: ProjectSelection; mission: string; missionScope: CanonicalMissionScope | null; view: string | undefined; packet: string | undefined;
  onView: (view: MissionView) => void; onOpenSlice: (dir: string) => void; onSelectPacket: (id: string | undefined) => void;
}) {
  const execution = useExecutionView(LOCAL_OPERATOR_INSTANCE, selection, mission);
  const active: MissionView = packet ? "workflows" : isMissionView(view) ? view : "story";
  return (
    <div data-testid="mission-execution">
      <TabBar tabs={MISSION_TABS} active={active} onSelect={onView} testId="mission-tabs" label="Mission views" />
      <ReadGate query={execution as ReadLike} what="Mission execution" testId="mission-execution-read">
        {() => {
          const view = execution.data!;
          const doc = view.rows[0];
          const story = missionStory(doc, missionScope);
          return (
            <>
              <ReadStatus query={execution as ReadLike} served={{ label: "derived", at: doc.derived_at }} testId="mission-execution-status" />
              {active === "story" ? <><StoryHeader story={story} doc={doc} onOpenSlice={onOpenSlice} onOpenPacket={(id) => onSelectPacket(id)} /><Waves doc={doc} story={story} onOpenSlice={onOpenSlice} /></> : null}
              {active === "workflows" ? <LifecycleWorkflows instances={doc.lifecycle_instances} selection={selection} mission={mission} packetId={packet} onSelectPacket={onSelectPacket} /> : null}
              {active === "capacity" ? <Capacity doc={doc} story={story} /> : null}
              {active === "sources" ? <Sources view={view} /> : null}
              <p className="mt-4 text-[11px] text-on-surface-variant">Execution generated <Timestamp iso={view.generatedAt} /> for project <span className="font-mono">{doc.project}</span>, mission <span className="font-mono">{doc.mission}</span>.</p>
            </>
          );
        }}
      </ReadGate>
    </div>
  );
}
