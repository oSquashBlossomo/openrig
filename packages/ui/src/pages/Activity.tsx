import { useMemo, useState } from "react";
import { usePs } from "../api.js";
import { useEvents, type RigEvent } from "../events.js";
import { timeAgo } from "../model.js";
import { Empty, Link } from "../components/bits.js";
import { seatPath } from "../router.js";

function detail(ev: RigEvent): string {
  const skip = new Set(["type", "rigId", "seq", "createdAt", "timestamp", "at"]);
  return Object.entries(ev)
    .filter(([k, v]) => !skip.has(k) && v !== null && v !== undefined && typeof v !== "object")
    .map(([k, v]) => `${k}=${String(v)}`)
    .join("  ");
}

function sessionOf(ev: RigEvent): string | null {
  for (const k of ["sessionName", "session", "canonicalSessionName"]) {
    const v = ev[k];
    if (typeof v === "string" && v.includes("@")) return v;
  }
  return null;
}

export function ActivityPage({ hostId }: { hostId: string }) {
  const { events, connected } = useEvents();
  const ps = usePs(hostId);
  const [filter, setFilter] = useState("");
  const rigName = useMemo(() => new Map((ps.data ?? []).map((r) => [r.rigId, r.name])), [ps.data]);
  const list = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const rows = [...events].reverse();
    if (!q) return rows;
    return rows.filter((ev) => `${ev.type} ${rigName.get(ev.rigId ?? "") ?? ""} ${detail(ev)}`.toLowerCase().includes(q));
  }, [events, filter, rigName]);
  return (
    <div className="page">
      <div className="toolbar">
        <input type="search" placeholder="filter events" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <span className={`live ${connected ? "live-on" : "live-off"}`}>{connected ? "live" : "not connected"}</span>
      </div>
      {list.length === 0 ? <Empty>{events.length === 0 ? "Waiting for events…" : "No events match."}</Empty> : (
        <ul className="events">
          {list.map((ev) => {
            const s = sessionOf(ev);
            const at = (ev.createdAt ?? ev.timestamp ?? ev.at) as string | undefined;
            return (
              <li key={ev.seq}>
                <span className="ev-time">{at ? timeAgo(at) : ""}</span>
                <span className="ev-type">{ev.type}</span>
                <span className="ev-rig">{rigName.get(ev.rigId ?? "") ?? ""}</span>
                <span className="ev-detail">{s ? <Link href={seatPath(s)}>{s}</Link> : null} {detail(ev)}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
