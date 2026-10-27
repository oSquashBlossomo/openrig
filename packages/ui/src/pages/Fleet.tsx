import { useState } from "react";
import { useAttention, useFleet, type PsEntry, type SeatNode } from "../api.js";
import { contextPercent, resolveIds, seatStatusLabel, seatTone, shortModel, sortAttention, timeAgo, type Tone } from "../model.js";
import { Dot, Empty, ErrorNote, Link, Pill, Ring } from "../components/bits.js";
import { seatPath } from "../router.js";

const ATTENTION_PREVIEW = 4;

function urgencyTone(u: string): Tone {
  return u === "critical" || u === "urgent" ? "bad" : u === "warning" ? "warn" : "ok";
}

export function AttentionStrip({ nodes }: { nodes: SeatNode[] }) {
  const q = useAttention();
  const [all, setAll] = useState(false);
  const items = sortAttention(q.data ?? []);
  if (q.error) return <ErrorNote error={q.error} />;
  if (items.length === 0) return <div className="attention attention-quiet">Nothing needs you.</div>;
  const shown = all ? items : items.slice(0, ATTENTION_PREVIEW);
  return (
    <section className="attention" aria-label="needs attention">
      <header>
        <h2>Needs you <span className="count">{items.length}</span></h2>
        {items.length > ATTENTION_PREVIEW && (
          <button type="button" className="linkish" onClick={() => setAll(!all)}>{all ? "fewer" : `all ${items.length}`}</button>
        )}
      </header>
      <ul>
        {shown.map((it) => (
          <li key={it.id}>
            <Dot tone={urgencyTone(it.urgency)} title={it.urgency} />
            <div>
              <div className="attention-summary">{it.summary}</div>
              <div className="meta">{resolveIds(it.scope ?? it.kind, nodes)}{it.at ? ` · ${timeAgo(it.at)} ago` : ""}</div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function rigTone(r: PsEntry): Tone {
  if (r.status !== "running") return "off";
  if (r.lifecycleState === "attention_required" || r.attentionCount > 0) return "warn";
  return r.activeCount > 0 ? "busy" : "ok";
}

function SeatRow({ n }: { n: SeatNode }) {
  const tone = seatTone(n);
  const input = n.activityState?.needsInput.count ?? 0;
  return (
    <Link href={seatPath(n.canonicalSessionName)} className={`seat seat-${tone}`}>
      <Dot tone={tone} title={seatStatusLabel(n)} />
      <span className="seat-name">{n.logicalId}</span>
      <span className="seat-facts">
        <span>{n.runtime ?? n.nodeKind}</span>
        {n.model && <span className="muted">{shortModel(n.model)}</span>}
        {n.effort && <span className="muted">{n.effort}</span>}
      </span>
      <span className="seat-state">
        {input > 0 && <Pill tone="warn">input {input}</Pill>}
        {n.assignedWorkCount > 0 && <Pill>work {n.assignedWorkCount}</Pill>}
        <span className="muted">{seatStatusLabel(n)}</span>
      </span>
      <Ring percent={contextPercent(n)} />
    </Link>
  );
}

function RigCard({ rig, seats }: { rig: PsEntry; seats: SeatNode[] }) {
  const tone = rigTone(rig);
  return (
    <section className={`rig rig-${tone}`}>
      <header>
        <Dot tone={tone} title={rig.lifecycleState} />
        <h3>{rig.name}</h3>
        <span className="rig-facts">
          <span>{rig.runningCount}/{rig.nodeCount} up</span>
          {rig.activeCount > 0 && <span>{rig.activeCount} active</span>}
          {rig.hasWorkCount > 0 && <span>{rig.hasWorkCount} with work</span>}
          {rig.uptime && <span className="muted">{rig.uptime}</span>}
        </span>
      </header>
      <div className="seats">
        {seats.length === 0 ? <div className="meta pad">loading seats…</div> : seats.map((n) => <SeatRow key={n.nodeId} n={n} />)}
      </div>
    </section>
  );
}

export function FleetPage({ hostId }: { hostId: string }) {
  const fleet = useFleet(hostId);
  return (
    <div className="page">
      {hostId === "local" && <AttentionStrip nodes={[...fleet.byRig.values()].flat()} />}
      <ErrorNote error={fleet.error} />
      {fleet.isLoading && <Empty>Loading rigs…</Empty>}
      {!fleet.isLoading && fleet.rigs.length === 0 && <Empty>No rigs on this host.</Empty>}
      <div className="rigs">
        {fleet.rigs.map((rig) => <RigCard key={rig.rigId} rig={rig} seats={fleet.byRig.get(rig.rigId) ?? []} />)}
      </div>
    </div>
  );
}
