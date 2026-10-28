import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useFleet, useRigGraphs } from "../api.js";
import { useEvents } from "../events.js";
import { Empty, ErrorNote } from "../components/bits.js";
import { buildModel, histogram, messageOf, type GNode, type Message, type Model } from "../graph/model.js";
import { applyModel, createSim, reanchor } from "../graph/sim.js";
import { GraphView, type Signals } from "../graph/GraphView.js";
import { Timeline, WINDOW_MS } from "../graph/Timeline.js";
import { SeatPanel } from "../graph/SeatPanel.js";

const EMPTY: Model = { rigs: [], nodes: [], links: [] };
const REPLAY_SPEED = 12;

function signature(m: Model): string {
  return m.nodes.map((n) => n.id).join("|") + "#" + m.links.map((l) => `${typeof l.source === "string" ? l.source : l.source.id}>${typeof l.target === "string" ? l.target : l.target.id}:${l.kind}`).join("|");
}

export function GraphPage({ hostId }: { hostId: string }) {
  const fleet = useFleet(hostId);
  const graphs = useRigGraphs(fleet.rigs.map((r) => r.rigId), hostId);
  const { events, connected } = useEvents();
  const [selected, setSelected] = useState<string | null>(null);
  const [fitToken, setFitToken] = useState(0);
  const [focusRig, setFocusRig] = useState<{ token: number; nodeIds: string[] } | null>(null);
  const [mode, setMode] = useState<"live" | "replay">("live");
  const [cursor, setCursor] = useState(Date.now());
  const [playing, setPlaying] = useState(false);
  const [clock, setClock] = useState(Date.now());
  const [aspect, setAspect] = useState(1);

  const simRef = useRef(createSim());
  const modelRef = useRef<Model>(EMPTY);
  const sigRef = useRef("");
  const anchorSigRef = useRef("");
  const signalsRef = useRef<Signals>({ messages: [], now: () => Date.now() });

  // Rebuild the model when the fleet or its graphs change; keep positions and
  // only restart the physics when a seat or link appears or disappears.
  const activityEpoch = useMemo(() => {
    let last = 0;
    for (const e of events) if (e.type === "agent.activity") last = e.seq;
    return last;
  }, [events]);
  const model = useMemo(() => {
    const prev = new Map(modelRef.current.nodes.map((n) => [n.id, n]));
    return buildModel(fleet.rigs, fleet.byRig, graphs, events, prev, Date.now(), aspect);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fleet.rigs, fleet.byRig, graphs, activityEpoch, clock, aspect]);
  useEffect(() => {
    const sig = signature(model);
    const anchorSig = model.rigs.map((r) => `${r.rigId}:${Math.round(r.anchor.x)},${Math.round(r.anchor.y)}`).join("|");
    if (sig !== sigRef.current) {
      sigRef.current = sig;
      anchorSigRef.current = anchorSig;
      modelRef.current = model;
      applyModel(simRef.current, model);
    } else {
      if (anchorSig !== anchorSigRef.current) {
        anchorSigRef.current = anchorSig;
        reanchor(simRef.current, { ...modelRef.current, rigs: model.rigs });
      }
      // Same shape: carry the live fields onto the simulated nodes.
      const live = new Map(model.nodes.map((n) => [n.id, n]));
      for (const n of modelRef.current.nodes) {
        const u = live.get(n.id);
        if (!u) continue;
        n.seat = u.seat; n.tone = u.tone; n.ctx = u.ctx; n.working = u.working; n.needsInput = u.needsInput;
        n.activity = u.activity; n.inProgress = u.inProgress; n.pending = u.pending; n.blocked = u.blocked; n.qitems = u.qitems;
      }
      modelRef.current = { ...modelRef.current, rigs: model.rigs };
    }
  }, [model]);
  // The working flag decays with time, so refresh the model every 10 s.
  useEffect(() => { const t = setInterval(() => setClock(Date.now()), 10_000); return () => clearInterval(t); }, []);

  // Messages on two clocks: when this browser saw them (live) and when the daemon logged them (replay/timeline).
  const liveMessages = useMemo(() => events.map((e) => messageOf(e, "seen")).filter(Boolean) as Message[], [events]);
  const loggedMessages = useMemo(() => events.map((e) => messageOf(e, "logged")).filter(Boolean) as Message[], [events]);
  signalsRef.current = mode === "live"
    ? { messages: liveMessages, now: () => Date.now() }
    : { messages: loggedMessages, now: () => cursor };
  const bars = useMemo(() => histogram(loggedMessages, clock), [loggedMessages, clock]);

  // Replay playback.
  useEffect(() => {
    if (!playing || mode !== "live" && !playing) return;
    const t = setInterval(() => setCursor((c) => {
      const next = c + 100 * REPLAY_SPEED;
      if (next >= Date.now()) { setPlaying(false); setMode("live"); return Date.now(); }
      return next;
    }), 100);
    return () => clearInterval(t);
  }, [playing, mode]);
  const scrub = useCallback((t: number) => { setMode("replay"); setCursor(Math.max(Date.now() - WINDOW_MS, Math.min(Date.now(), t))); }, []);
  const goLive = useCallback(() => { setMode("live"); setPlaying(false); }, []);

  const selectedNode: GNode | undefined = modelRef.current.nodes.find((n) => n.id === selected) ?? model.nodes.find((n) => n.id === selected);
  const rigColor = model.rigs.find((r) => r.rigId === selectedNode?.rigId)?.color ?? "var(--accent)";
  const working = model.nodes.filter((n) => n.working).length;
  const needs = model.nodes.filter((n) => n.tone === "warn").length;

  return (
    <div className="page page-graph">
      <div className="gtoolbar">
        <div className="gchips">
          {model.rigs.map((r) => (
            <button key={r.rigId} type="button" className="gchip" style={{ "--chip": r.color } as React.CSSProperties}
              onClick={() => setFocusRig({ token: Date.now(), nodeIds: r.nodeIds })} title={`zoom to ${r.name}`}>
              <i />{r.name}<span className="muted">{r.nodeIds.length}</span>
            </button>
          ))}
          {model.rigs.length > 1 && <button type="button" className="gchip" onClick={() => setFitToken((t) => t + 1)}>all</button>}
        </div>
        <div className="gsummary">
          <span>{model.nodes.length} seats</span>
          <span className="busy">{working} working</span>
          <span className={needs ? "warn" : ""}>{needs} need you</span>
          <span className={`live ${connected ? "live-on" : "live-off"}`}>{connected ? "live" : "polling"}</span>
        </div>
      </div>
      <ErrorNote error={fleet.error} />
      <div className={`gstage ${selectedNode ? "has-panel" : ""}`}>
        {fleet.isLoading && <Empty>Loading fleet…</Empty>}
        <GraphView modelRef={modelRef} sim={simRef.current} signalsRef={signalsRef} selected={selected} onSelect={setSelected} fitToken={fitToken} focusRig={focusRig}
          onResize={(w, h) => { if (w > 0 && h > 0) setAspect(Math.round(Math.max(0.6, Math.min(2.6, w / h)) * 4) / 4); }} />
        {selectedNode && (
          <SeatPanel node={selectedNode} color={rigColor} messages={loggedMessages} local={hostId === "local"} onClose={() => setSelected(null)} onSelect={setSelected} />
        )}
      </div>
      <Timeline bars={bars} now={clock} mode={mode} cursor={cursor} playing={playing} onScrub={scrub} onLive={goLive} onTogglePlay={() => setPlaying((p) => !p)} />
      <div className="glegend">
        <span><i className="dot dot-busy" /> working (rings breathe)</span>
        <span><i className="dot dot-warn" /> needs you</span>
        <span><i className="swatch" style={{ borderTopColor: "#5aa9ff" }} /> new work</span>
        <span><i className="swatch" style={{ borderTopColor: "#b48cff" }} /> handoff</span>
        <span><i className="swatch" style={{ borderTopColor: "#f0a35e" }} /> rerouted</span>
        <span><i className="swatch" /> delegates to</span>
        <span>arc = context used · drag seats · scroll or pinch to zoom · double-click a seat to frame its rig</span>
      </div>
    </div>
  );
}
