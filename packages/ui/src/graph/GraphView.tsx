// The interactive canvas: physics ticks, pan/zoom/pinch, node dragging,
// hover and selection. State that changes every frame lives in refs.
import { useEffect, useRef, useState, type RefObject } from "react";
import type { GNode, Message, Model } from "./model.js";
import type { Sim } from "./sim.js";
import { draw, fitView, hitTest, readTheme, type View } from "./render.js";

export type Signals = { messages: Message[]; now: () => number };

type Props = {
  modelRef: RefObject<Model>;
  sim: Sim;
  signalsRef: RefObject<Signals>;
  selected: string | null;
  onSelect: (id: string | null) => void;
  fitToken: number;
  focusRig: { token: number; nodeIds: string[] } | null;
  onResize?: (w: number, h: number) => void;
};

const MIN_K = 0.15, MAX_K = 4;

export function GraphView({ modelRef, sim, signalsRef, selected, onSelect, fitToken, focusRig, onResize }: Props) {
  const boxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewRef = useRef<View>({ x: 0, y: 0, k: 1 });
  const targetRef = useRef<View | null>(null);
  const sizeRef = useRef({ w: 0, h: 0, dpr: 1 });
  const measureRef = useRef<() => void>(() => {});
  const framesRef = useRef(0);
  const onResizeRef = useRef(onResize);
  onResizeRef.current = onResize;
  const themeRef = useRef(readTheme());
  const userMovedRef = useRef(false);
  const fittedRef = useRef(false);
  const selectedRef = useRef<string | null>(selected);
  const hoverRef = useRef<string | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ kind: "pan" | "drag" | "pinch" | null; node: GNode | null; start: { x: number; y: number }; moved: number; pinch?: { d: number; mid: { x: number; y: number } } }>({ kind: null, node: null, start: { x: 0, y: 0 }, moved: 0 });
  const [tip, setTip] = useState<{ node: GNode; x: number; y: number } | null>(null);
  selectedRef.current = selected;

  // Size and theme.
  useEffect(() => {
    const box = boxRef.current, canvas = canvasRef.current;
    if (!box || !canvas) return;
    const measure = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = box.clientWidth, h = box.clientHeight;
      if (w === sizeRef.current.w && h === sizeRef.current.h && dpr === sizeRef.current.dpr) return;
      sizeRef.current = { w, h, dpr };
      onResizeRef.current?.(w, h);
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`; canvas.style.height = `${h}px`;
      themeRef.current = readTheme();
      if (!userMovedRef.current && modelRef.current.nodes.length) targetRef.current = fitView(modelRef.current.nodes, w, h);
    };
    measureRef.current = measure;
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onTheme = () => { themeRef.current = readTheme(); };
    mq.addEventListener("change", onTheme);
    return () => { ro.disconnect(); mq.removeEventListener("change", onTheme); };
  }, [modelRef]);

  // Fit and focus requests from the page.
  useEffect(() => {
    if (fitToken === 0) return;
    const { w, h } = sizeRef.current;
    targetRef.current = fitView(modelRef.current.nodes, w, h);
    userMovedRef.current = false;
  }, [fitToken, modelRef]);
  useEffect(() => {
    if (!focusRig) return;
    const { w, h } = sizeRef.current;
    const ns = modelRef.current.nodes.filter((n) => focusRig.nodeIds.includes(n.id));
    if (ns.length) { targetRef.current = fitView(ns, w, h, 90, 2); userMovedRef.current = true; }
  }, [focusRig, modelRef]);

  // Animation loop.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const motion = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf = 0;
    let ticks = 0;
    const frame = () => {
      raf = requestAnimationFrame(frame);
      framesRef.current++;
      if (document.hidden) return;
      const model = modelRef.current;
      if (sim.alpha() > 0.004) { sim.tick(); ticks++; }
      if (sizeRef.current.w === 0) measureRef.current();
      const { w, h, dpr } = sizeRef.current;
      if (!fittedRef.current && model.nodes.length && ticks > 24 && w > 0) {
        fittedRef.current = true;
        viewRef.current = fitView(model.nodes, w, h);
        targetRef.current = null;
      }
      // Until the person moves the view, keep the whole fleet framed while the physics settle.
      if (fittedRef.current && !userMovedRef.current && sim.alpha() > 0.02 && ticks % 8 === 0 && w > 0) {
        targetRef.current = fitView(model.nodes, w, h);
      }
      const tgt = targetRef.current;
      if (tgt) {
        const v = viewRef.current;
        v.x += (tgt.x - v.x) * 0.18; v.y += (tgt.y - v.y) * 0.18; v.k += (tgt.k - v.k) * 0.18;
        if (Math.abs(tgt.x - v.x) < 0.3 && Math.abs(tgt.y - v.y) < 0.3 && Math.abs(tgt.k - v.k) < 0.002) { viewRef.current = { ...tgt }; targetRef.current = null; }
      }
      const sig = signalsRef.current;
      draw(ctx, {
        model, messages: sig.messages, now: sig.now(), selected: selectedRef.current, hovered: hoverRef.current,
        view: viewRef.current, width: w, height: h, dpr, motion, theme: themeRef.current,
      });
    };
    raf = requestAnimationFrame(frame);
    if (import.meta.env.DEV) (window as unknown as { __graph?: unknown }).__graph = { modelRef, sim, viewRef, sizeRef, fittedRef, pointers, gesture, framesRef, signalsRef, targetRef };
    return () => cancelAnimationFrame(raf);
  }, [modelRef, sim, signalsRef]);

  // Wheel zoom needs a non-passive listener.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      zoomAt(viewRef.current, Math.exp(-e.deltaY * 0.0016), e.clientX - rect.left, e.clientY - rect.top);
      targetRef.current = null;
      userMovedRef.current = true;
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, []);

  const local = (e: { clientX: number; clientY: number }) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    canvasRef.current?.setPointerCapture(e.pointerId);
    const p = local(e);
    pointers.current.set(e.pointerId, p);
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      gesture.current = { kind: "pinch", node: null, start: p, moved: 10, pinch: { d: Math.hypot(a!.x - b!.x, a!.y - b!.y), mid: { x: (a!.x + b!.x) / 2, y: (a!.y + b!.y) / 2 } } };
      return;
    }
    const hit = hitTest(modelRef.current, viewRef.current, p.x, p.y);
    gesture.current = { kind: hit ? "drag" : "pan", node: hit, start: p, moved: 0 };
    if (hit) { hit.fx = hit.x; hit.fy = hit.y; }
    setTip(null);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const p = local(e);
    const prev = pointers.current.get(e.pointerId);
    const g = gesture.current;
    if (prev && g.kind) {
      pointers.current.set(e.pointerId, p);
      g.moved += Math.hypot(p.x - prev.x, p.y - prev.y);
      const v = viewRef.current;
      if (g.kind === "pinch" && pointers.current.size === 2 && g.pinch) {
        const [a, b] = [...pointers.current.values()];
        const d = Math.hypot(a!.x - b!.x, a!.y - b!.y), mid = { x: (a!.x + b!.x) / 2, y: (a!.y + b!.y) / 2 };
        zoomAt(v, d / (g.pinch.d || 1), mid.x, mid.y);
        v.x += mid.x - g.pinch.mid.x; v.y += mid.y - g.pinch.mid.y;
        g.pinch = { d, mid };
      } else if (g.kind === "drag" && g.node) {
        g.node.fx = (p.x - v.x) / v.k; g.node.fy = (p.y - v.y) / v.k;
        if (sim.alpha() < 0.2) sim.alpha(0.2);
      } else if (g.kind === "pan") {
        v.x += p.x - prev.x; v.y += p.y - prev.y;
      }
      targetRef.current = null;
      userMovedRef.current = true;
      return;
    }
    if (e.pointerType === "mouse") {
      const hit = hitTest(modelRef.current, viewRef.current, p.x, p.y);
      hoverRef.current = hit?.id ?? null;
      setTip(hit ? { node: hit, x: p.x, y: p.y } : null);
    }
  };
  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const g = gesture.current;
    pointers.current.delete(e.pointerId);
    if (g.kind === "drag" && g.node) { g.node.fx = null; g.node.fy = null; }
    if (g.kind !== "pinch" && g.moved < 5) onSelect(g.kind === "drag" && g.node ? g.node.id : null);
    if (pointers.current.size === 0) gesture.current = { kind: null, node: null, start: { x: 0, y: 0 }, moved: 0 };
  };
  const onDoubleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const p = local(e);
    const hit = hitTest(modelRef.current, viewRef.current, p.x, p.y);
    const { w, h } = sizeRef.current;
    if (hit) {
      const ns = modelRef.current.nodes.filter((n) => n.rigId === hit.rigId);
      targetRef.current = fitView(ns, w, h, 90, 2);
    } else targetRef.current = fitView(modelRef.current.nodes, w, h);
    userMovedRef.current = true;
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLCanvasElement>) => {
    const { w, h } = sizeRef.current;
    if (e.key === "f") { targetRef.current = fitView(modelRef.current.nodes, w, h); userMovedRef.current = false; }
    if (e.key === "Escape") onSelect(null);
    if (e.key === "+" || e.key === "=") zoomAt(viewRef.current, 1.25, w / 2, h / 2);
    if (e.key === "-") zoomAt(viewRef.current, 0.8, w / 2, h / 2);
  };
  const zoomButton = (f: number) => { const { w, h } = sizeRef.current; zoomAt(viewRef.current, f, w / 2, h / 2); targetRef.current = null; userMovedRef.current = true; };

  return (
    <div className="gview" ref={boxRef}>
      <canvas
        ref={canvasRef}
        role="img"
        aria-label="fleet map: seats grouped by rig, messages animate between them"
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={() => { hoverRef.current = null; setTip(null); }}
        onDoubleClick={onDoubleClick}
        onKeyDown={onKeyDown}
      />
      <div className="gcontrols">
        <button type="button" onClick={() => zoomButton(1.3)} aria-label="zoom in">+</button>
        <button type="button" onClick={() => zoomButton(0.77)} aria-label="zoom out">−</button>
        <button type="button" onClick={() => { const { w, h } = sizeRef.current; targetRef.current = fitView(modelRef.current.nodes, w, h); userMovedRef.current = false; }} aria-label="fit all" title="fit (f)">⌖</button>
      </div>
      {tip && (
        <div className="gtip" style={{ left: tip.x + 14, top: tip.y + 14 }}>
          <div className="gtip-title">{tip.node.id}</div>
          <div className="gtip-row">{tip.node.working ? "working" : tip.node.needsInput ? "needs input" : tip.node.tone === "warn" ? "needs attention" : tip.node.tone === "ok" ? "idle" : tip.node.tone}
            {tip.node.ctx !== null ? ` · context ${tip.node.ctx}%` : ""}{tip.node.inProgress ? ` · ${tip.node.inProgress} in progress` : ""}</div>
          {tip.node.activity && <div className="gtip-row gtip-act">{tip.node.activity}</div>}
        </div>
      )}
    </div>
  );
}

function zoomAt(v: View, factor: number, sx: number, sy: number): void {
  const k = Math.max(MIN_K, Math.min(MAX_K, v.k * factor));
  const f = k / v.k;
  v.x = sx - (sx - v.x) * f;
  v.y = sy - (sy - v.y) * f;
  v.k = k;
}
