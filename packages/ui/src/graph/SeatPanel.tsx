import type { GNode, Message } from "./model.js";
import { seatStatusLabel, shortModel, timeAgo } from "../model.js";
import { Dot, Link, Pill, Ring } from "../components/bits.js";
import { Composer } from "../pages/Seat.js";
import { seatPath } from "../router.js";

type Props = { node: GNode; color: string; messages: Message[]; local: boolean; onClose: () => void; onSelect: (id: string) => void };

export function SeatPanel({ node, color, messages, local, onClose, onSelect }: Props) {
  const seat = node.seat;
  const mine = messages.filter((m) => m.from === node.id || m.to === node.id).slice(-8).reverse();
  return (
    <aside className="gpanel" aria-label={`${node.id} details`}>
      <header>
        <Dot tone={node.working ? "busy" : node.tone} />
        <div className="gpanel-title">
          <div className="mono">{seat.logicalId}<span className="muted">@{node.rigName}</span></div>
          <div className="meta" style={{ color }}>{node.rigName}</div>
        </div>
        <button type="button" className="linkish" onClick={onClose} aria-label="close">✕</button>
      </header>
      <div className="gpanel-pills">
        <Pill tone={node.working ? "busy" : node.tone}>{node.working ? "working" : seatStatusLabel(seat)}</Pill>
        {node.needsInput && <Pill tone="warn">needs input</Pill>}
        {node.inProgress > 0 && <Pill>{node.inProgress} in progress</Pill>}
        {node.pending > 0 && <Pill>{node.pending} pending</Pill>}
        {node.blocked > 0 && <Pill tone="bad">{node.blocked} blocked</Pill>}
      </div>
      {node.activity && <div className="gpanel-activity">{node.activity}</div>}
      <div className="gpanel-facts">
        <Ring percent={node.ctx} />
        <div>
          <div>{seat.runtime ?? "agent"}{seat.model ? ` · ${shortModel(seat.model)}` : ""}{seat.effort ? ` · ${seat.effort}` : ""}</div>
          <div className="meta">{seat.lastActivityAt ? `active ${timeAgo(seat.lastActivityAt)} ago` : "no activity recorded"}{node.ctx !== null ? ` · context ${node.ctx}%` : ""}</div>
        </div>
      </div>
      {seat.latestError && <div className="note note-bad">{seat.latestError}</div>}
      {node.qitems.length > 0 && (
        <section>
          <h4>Current work</h4>
          <ul className="gpanel-list">
            {node.qitems.map((q) => <li key={q.qitemId}><span className="mono muted">{q.qitemId.replace(/^qitem-/, "").slice(0, 28)}</span><div>{q.bodyExcerpt}</div></li>)}
          </ul>
        </section>
      )}
      <section>
        <h4>Messages</h4>
        {mine.length === 0 ? <div className="meta">None in the last 30 minutes.</div> : (
          <ul className="gpanel-list">
            {mine.map((m) => {
              const out = m.from === node.id;
              const other = out ? m.to : m.from;
              return (
                <li key={m.seq}>
                  <span className={`arrow ${out ? "out" : "in"}`}>{out ? "→" : "←"}</span>
                  <button type="button" className="linkish mono" onClick={() => onSelect(other)}>{other}</button>
                  <span className="meta"> {m.kind} · {timeAgo(new Date(m.at).toISOString())} ago</span>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      <div className="gpanel-actions">
        <Link href={seatPath(node.id)} className="button">Open terminal</Link>
      </div>
      {local && <Composer session={node.id} />}
    </aside>
  );
}
