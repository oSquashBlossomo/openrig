import { useEffect, useMemo, useRef, useState } from "react";
import { useFleet, useRigGraphs } from "../api.js";
import { useEvents } from "../events.js";
import { curve, layoutFleet, messageOf, workingSession } from "../graph.js";
import { seatStatusLabel, seatTone } from "../model.js";
import { Empty } from "../components/bits.js";
import { navigate, seatPath } from "../router.js";

const PULSE_MS = 1600;
const TRAFFIC_MS = 90_000;
const WORKING_MS = 20_000;

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

/** Re-render while something is animating so finished pulses drop out. */
function useClock(active: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 400);
    return () => clearInterval(t);
  }, [active]);
  return active ? now : Date.now();
}

export function GraphPage({ hostId }: { hostId: string }) {
  const fleet = useFleet(hostId);
  const graphs = useRigGraphs(fleet.rigs.map((r) => r.rigId), hostId);
  const { events } = useEvents();
  const [ref, width] = useWidth<HTMLDivElement>();

  const layout = useMemo(() => layoutFleet(
    fleet.rigs.map((r) => ({ rigId: r.rigId, name: r.name, seats: fleet.byRig.get(r.rigId) ?? [] })),
    Math.max(320, width - 2),
  ), [fleet.rigs, fleet.byRig, width]);

  // Delegation edges from the rig graphs, by session name.
  const staticEdges = useMemo(() => {
    const byNodeId = new Map<string, string>();
    for (const seats of fleet.byRig.values()) for (const s of seats) byNodeId.set(s.nodeId, s.canonicalSessionName);
    const out: { from: string; to: string; label: string }[] = [];
    for (const g of graphs) for (const e of g?.edges ?? []) {
      const from = byNodeId.get(e.source), to = byNodeId.get(e.target);
      if (from && to) out.push({ from, to, label: e.label });
    }
    return out;
  }, [graphs, fleet.byRig]);

  const recent = useMemo(() => events.filter((e) => e.seenAt > Date.now() - TRAFFIC_MS), [events]);
  const now = useClock(recent.some((e) => e.seenAt > Date.now() - PULSE_MS));
  const pulses = recent.filter((e) => e.seenAt > now - PULSE_MS).map((e) => ({ e, m: messageOf(e) })).filter((p) => p.m);
  const traffic = new Map<string, number>();
  for (const e of recent) { const m = messageOf(e); if (m) traffic.set(`${m.from}→${m.to}`, (traffic.get(`${m.from}→${m.to}`) ?? 0) + 1); }
  const working = new Set(recent.filter((e) => e.seenAt > now - WORKING_MS).map(workingSession).filter(Boolean) as string[]);

  const unknownEnds = pulses.filter((p) => !layout.nodes.has(p.m!.from) || !layout.nodes.has(p.m!.to)).length;

  return (
    <div className="page">
      <div className="toolbar graph-legend">
        <span><i className="dot dot-busy" /> working</span>
        <span><i className="dot dot-warn" /> needs you</span>
        <span><i className="swatch swatch-edge" /> delegates to</span>
        <span><i className="swatch swatch-msg" /> messages (last 90 s)</span>
      </div>
      <div className="graph" ref={ref}>
        {fleet.isLoading && <Empty>Loading fleet…</Empty>}
        {width > 0 && layout.clusters.length > 0 && (
          <svg width={layout.width} height={layout.height + 4} viewBox={`0 0 ${layout.width} ${layout.height + 4}`} role="img" aria-label="fleet graph">
            {layout.clusters.map((c) => (
              <g key={c.rigId} className="cluster">
                <rect x={c.x + 0.5} y={c.y + 0.5} width={c.w - 1} height={c.h - 1} rx="10" />
                <text x={c.x + 12} y={c.y + 18}>{c.name}</text>
              </g>
            ))}
            {staticEdges.map((e, i) => {
              const a = layout.nodes.get(e.from), b = layout.nodes.get(e.to);
              return a && b ? <path key={`s${i}`} className="gedge" d={curve(a, b)} /> : null;
            })}
            {[...traffic.entries()].map(([key, count]) => {
              const [from, to] = key.split("→");
              const a = layout.nodes.get(from!), b = layout.nodes.get(to!);
              return a && b ? <path key={key} className="gtraffic" d={curve(a, b)} strokeWidth={Math.min(4, 1 + count)}><title>{`${from} → ${to}: ${count} in the last 90 s`}</title></path> : null;
            })}
            {pulses.map(({ e, m }) => {
              const a = layout.nodes.get(m!.from), b = layout.nodes.get(m!.to);
              if (!a || !b) return null;
              return (
                <g key={e.seq}>
                  <path className="gpulse-edge" d={curve(a, b)} />
                  <circle className="gpulse" r="5">
                    <animateMotion dur={`${PULSE_MS / 1000}s`} fill="freeze" path={curve(a, b)} />
                  </circle>
                </g>
              );
            })}
            {[...layout.nodes.entries()].map(([session, n]) => {
              const tone = working.has(session) ? "busy" : seatTone(n.seat);
              return (
                <g key={session} className={`gnode gnode-${tone}`} transform={`translate(${n.x} ${n.y})`} onClick={() => navigate(seatPath(session))} role="link" tabIndex={0}
                  onKeyDown={(ev) => { if (ev.key === "Enter") navigate(seatPath(session)); }}>
                  <title>{`${session} · ${seatStatusLabel(n.seat)}`}</title>
                  {tone === "busy" && <circle className="ghalo" r="14" />}
                  <circle r="11" />
                  <text y="25">{n.seat.logicalId}</text>
                </g>
              );
            })}
          </svg>
        )}
      </div>
      {unknownEnds > 0 && <div className="meta">{unknownEnds} message{unknownEnds > 1 ? "s" : ""} involve a seat not on this host.</div>}
    </div>
  );
}
