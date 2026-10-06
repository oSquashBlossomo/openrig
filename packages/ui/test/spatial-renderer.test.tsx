// SpatialRenderer lifecycle — real three.js scene graph, OrbitControls and
// CSS2D labels, with ONLY the WebGL context faked (jsdom has none). This proves
// render scheduling, disposal and failure reporting; it cannot prove pixels.

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { render, act, cleanup } from "@testing-library/react";
import { StrictMode, createRef } from "react";
import SpatialRenderer, { toColor, type SpatialCameraController } from "../src/components/topology/spatial/SpatialRenderer.js";
import { buildSpatialModel, layoutSpatialModel, parseSpatialRig } from "../src/lib/spatial-topology.js";
import { readSpatialPalette } from "../src/components/topology/spatial/spatial-palette.js";

interface FakeGl {
  dispose: Mock;
  forceContextLoss: Mock;
  render: Mock;
  domElement: HTMLCanvasElement;
}

const gl = vi.hoisted(() => ({
  instances: [] as FakeGl[],
  throwOnCreate: false,
  throwOnSize: false,
}));

vi.mock("three", async (importOriginal) => {
  const actual = await importOriginal<typeof import("three")>();
  // Spies are assigned via Object.assign: a class field literally named
  // after an imported binding trips vitest's mock-hoisting analysis.
  class FakeWebGLRenderer {
    domElement: HTMLCanvasElement;
    shadowMap = { enabled: false };
    constructor() {
      if (gl.throwOnCreate) throw new Error("Error creating WebGL context.");
      this.domElement = document.createElement("canvas");
      Object.assign(this, { dispose: vi.fn(), forceContextLoss: vi.fn(), ["ren" + "der"]: vi.fn() });
      gl.instances.push(this as unknown as FakeGl);
    }
    setPixelRatio() {}
    setSize(w: number, h: number) {
      if (gl.throwOnSize) throw new Error("fixture late init failure");
      this.domElement.width = w;
      this.domElement.height = h;
    }
  }
  return { ...actual, WebGLRenderer: FakeWebGLRenderer };
});

// Manual animation-frame queue so tests can prove the loop terminates.
let rafQueue: Map<number, FrameRequestCallback>;
let rafId = 0;
let now = 0;

function flushFrames(max = 400): number {
  let ran = 0;
  while (rafQueue.size > 0 && ran < max) {
    const [id, cb] = rafQueue.entries().next().value as [number, FrameRequestCallback];
    rafQueue.delete(id);
    now += 16;
    cb(now);
    ran++;
  }
  return ran;
}

const graph = {
  nodes: [
    { id: "pod-p", type: "podGroup", data: { podNamespace: "core" } },
    { id: "a", type: "rigNode", parentId: "pod-p", data: { logicalId: "core.<img src=x onerror=alert(1)>", status: "running", terminalActive: true } },
    { id: "b", type: "rigNode", parentId: "pod-p", data: { logicalId: "core.b", status: "running", startupStatus: "failed" } },
  ],
  edges: [{ id: "e", source: "a", target: "b", label: "delegates_to" }],
};

function setup() {
  const model = buildSpatialModel("local", [parseSpatialRig("local", { rigId: "r", rigName: "rig", graph })]);
  const layout = layoutSpatialModel(model);
  const controllerRef = createRef<SpatialCameraController | null>() as { current: SpatialCameraController | null };
  const onFailure = vi.fn();
  const onReady = vi.fn();
  const onSelect = vi.fn();
  const props = {
    model,
    layout,
    palette: readSpatialPalette("light"),
    selectedKey: null,
    hoveredKey: null,
    matchKeys: null,
    reducedMotion: false,
    controllerRef,
    onSelect,
    onHover: vi.fn(),
    onFailure,
    onReady,
  };
  return { props, controllerRef, onFailure, onReady, onSelect };
}

beforeEach(() => {
  gl.instances = [];
  gl.throwOnCreate = false;
  gl.throwOnSize = false;
  rafQueue = new Map();
  rafId = 0;
  now = 0;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
    rafId += 1;
    rafQueue.set(rafId, cb);
    return rafId;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
    rafQueue.delete(id);
  });
  vi.spyOn(performance, "now").mockImplementation(() => now);
  // Give the host a size so resize() configures the camera.
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 500 });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
  delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
});

describe("SpatialRenderer", () => {
  it("mounts one canvas + label layer, reports ready, and renders on demand (no perpetual loop)", () => {
    const { props, controllerRef, onReady } = setup();
    const { container } = render(<SpatialRenderer {...props} />);
    expect(container.querySelectorAll("canvas")).toHaveLength(1);
    expect(container.querySelector(".spatial-label-layer")).toBeTruthy();
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(controllerRef.current).toBeTruthy();

    const settled = flushFrames();
    expect(settled).toBeGreaterThan(0);
    expect(settled).toBeLessThan(5);
    expect(rafQueue.size).toBe(0);
    const renders = gl.instances[0]!.render.mock.calls.length;
    expect(renders).toBeGreaterThan(0);

    // Idle: nothing re-renders without input.
    expect(flushFrames()).toBe(0);
    expect(gl.instances[0]!.render.mock.calls.length).toBe(renders);
  });

  it("camera commands animate on a bounded budget and then stop", () => {
    const { props, controllerRef } = setup();
    render(<SpatialRenderer {...props} />);
    flushFrames();
    act(() => controllerRef.current!.preset("top"));
    const frames = flushFrames();
    expect(frames).toBeGreaterThan(5);
    expect(frames).toBeLessThan(120);
    expect(rafQueue.size).toBe(0);
  });

  it("reduced motion applies camera moves instantly (single frame)", () => {
    const { props, controllerRef } = setup();
    render(<SpatialRenderer {...props} reducedMotion />);
    flushFrames();
    act(() => controllerRef.current!.zoom(0.5));
    expect(flushFrames()).toBe(1);
  });

  it("selection / search changes re-render once without restarting a loop", () => {
    const { props } = setup();
    const { rerender } = render(<SpatialRenderer {...props} />);
    flushFrames();
    const key = [...props.model.agentsByKey.keys()][0]!;
    rerender(<SpatialRenderer {...props} selectedKey={key} matchKeys={new Set([key])} />);
    expect(flushFrames()).toBe(1);
  });

  it("labels are text, never HTML", () => {
    const { props } = setup();
    // Selected, so the collision pass must show it however long the name is.
    const xssKey = [...props.model.agentsByKey.values()].find((a) => a.logicalId?.includes("<img"))!.key;
    const { container } = render(<SpatialRenderer {...props} selectedKey={xssKey} />);
    flushFrames();
    expect(container.querySelector(".spatial-label-layer img")).toBeNull();
    expect(container.textContent).toContain("<img src=x onerror=alert(1)>");
  });

  it("webglcontextlost reports a failure for the fallback", () => {
    const { props, onFailure } = setup();
    render(<SpatialRenderer {...props} />);
    const canvas = gl.instances[0]!.domElement;
    const evt = new Event("webglcontextlost", { cancelable: true });
    act(() => {
      canvas.dispatchEvent(evt);
    });
    expect(onFailure).toHaveBeenCalledWith("context-lost");
    expect(evt.defaultPrevented).toBe(true);
  });

  it("constructor failure reports unsupported and leaves no canvas behind", () => {
    gl.throwOnCreate = true;
    const { props, onFailure, controllerRef } = setup();
    const { container } = render(<SpatialRenderer {...props} />);
    expect(onFailure).toHaveBeenCalledWith("unsupported");
    expect(container.querySelector("canvas")).toBeNull();
    expect(controllerRef.current).toBeNull();
  });

  it("unmount releases the GL context, DOM, frame and controller (without a false failure)", () => {
    const { props, controllerRef, onFailure } = setup();
    const { container, unmount } = render(<SpatialRenderer {...props} />);
    act(() => controllerRef.current!.fit());
    expect(rafQueue.size).toBeGreaterThan(0);
    const inst = gl.instances[0]!;
    unmount();
    expect(inst.dispose).toHaveBeenCalledTimes(1);
    expect(inst.forceContextLoss).toHaveBeenCalledTimes(1);
    expect(inst.domElement.isConnected).toBe(false);
    expect(container.querySelector(".spatial-label-layer")).toBeNull();
    expect(rafQueue.size).toBe(0);
    expect(controllerRef.current).toBeNull();
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("StrictMode double-mount leaves exactly one live renderer", () => {
    const { props } = setup();
    const { container } = render(
      <StrictMode>
        <SpatialRenderer {...props} />
      </StrictMode>,
    );
    expect(gl.instances).toHaveLength(2);
    expect(gl.instances[0]!.dispose).toHaveBeenCalledTimes(1);
    expect(gl.instances[0]!.forceContextLoss).toHaveBeenCalledTimes(1);
    expect(gl.instances[1]!.dispose).not.toHaveBeenCalled();
    expect(container.querySelectorAll("canvas")).toHaveLength(1);
    expect(container.querySelectorAll(".spatial-label-layer")).toHaveLength(1);
  });
});

// Regressions ported from the independent reliability review
// (/private/tmp/openrig-spatial-reliability-review.md, findings 1-3).
describe("SpatialRenderer reliability regressions", () => {
  it("keeps an explicit Top preset across an identical-data refresh", () => {
    const { props, controllerRef } = setup();
    const { rerender } = render(<SpatialRenderer {...props} />);
    flushFrames();
    act(() => controllerRef.current!.preset("top"));
    flushFrames();
    const camera = gl.instances[0]!.render.mock.calls.at(-1)![1] as { position: { toArray(): number[]; clone(): { toArray(): number[] } } };
    const before = camera.position.clone().toArray();
    // A refetch produces a new model object with the same content.
    rerender(<SpatialRenderer {...props} model={{ ...props.model }} layout={layoutSpatialModel({ ...props.model })} />);
    flushFrames();
    expect(camera.position.toArray()).toEqual(before);
  });

  it("keeps an explicit zoom across a refresh", () => {
    const { props, controllerRef } = setup();
    const { rerender } = render(<SpatialRenderer {...props} reducedMotion />);
    flushFrames();
    act(() => controllerRef.current!.zoom(0.5));
    flushFrames();
    const camera = gl.instances[0]!.render.mock.calls.at(-1)![1] as { position: { toArray(): number[]; clone(): { toArray(): number[] } } };
    const before = camera.position.clone().toArray();
    rerender(<SpatialRenderer {...props} reducedMotion model={{ ...props.model }} />);
    flushFrames();
    expect(camera.position.toArray()).toEqual(before);
  });

  // Reset hands framing back to auto-fit and starts a tween; an automatic
  // instant fit that lands mid-tween must win, not be replayed over.
  it("keeps the latest automatic fit when graph bounds change during a Reset tween", () => {
    const { props, controllerRef } = setup();
    const { rerender } = render(<SpatialRenderer {...props} />);
    flushFrames();
    act(() => controllerRef.current!.preset("top"));
    flushFrames();
    act(() => controllerRef.current!.reset());
    expect(rafQueue.size).toBeGreaterThan(0);
    const camera = gl.instances[0]!.render.mock.calls.at(-1)![1] as { position: { toArray(): number[]; clone(): { toArray(): number[] } } };
    const wider = { ...props.layout, bounds: { ...props.layout.bounds, min: [-100, -1, -30] as [number, number, number], max: [100, 6, 30] as [number, number, number] } };
    rerender(<SpatialRenderer {...props} model={{ ...props.model }} layout={wider} />);
    const latest = camera.position.clone().toArray();
    flushFrames();
    expect(rafQueue.size).toBe(0);
    expect(camera.position.toArray()).toEqual(latest);
  });

  it("keeps the latest automatic fit when the stage resizes during a Reset tween", () => {
    let observed: (() => void) | null = null;
    vi.stubGlobal("ResizeObserver", class {
      constructor(cb: () => void) { observed = cb; }
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    try {
      const { props, controllerRef } = setup();
      render(<SpatialRenderer {...props} />);
      flushFrames();
      act(() => controllerRef.current!.preset("top"));
      flushFrames();
      act(() => controllerRef.current!.reset());
      expect(rafQueue.size).toBeGreaterThan(0);
      const camera = gl.instances[0]!.render.mock.calls.at(-1)![1] as { position: { toArray(): number[]; clone(): { toArray(): number[] } } };
      Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 360 });
      Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 640 });
      act(() => observed!());
      const latest = camera.position.clone().toArray();
      flushFrames();
      expect(rafQueue.size).toBe(0);
      expect(camera.position.toArray()).toEqual(latest);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("releases the GL context, shared geometries and materials when initialization fails after construction", async () => {
    const { BufferGeometry, Material } = await import("three");
    const geometryDispose = vi.spyOn(BufferGeometry.prototype, "dispose");
    const materialDispose = vi.spyOn(Material.prototype, "dispose");
    gl.throwOnSize = true;
    const { props, onFailure, controllerRef } = setup();
    const { container } = render(<SpatialRenderer {...props} />);
    expect(onFailure).toHaveBeenCalledWith("init-error");
    expect(gl.instances[0]!.dispose).toHaveBeenCalledTimes(1);
    expect(gl.instances[0]!.forceContextLoss).toHaveBeenCalledTimes(1);
    expect(geometryDispose.mock.calls.length).toBeGreaterThanOrEqual(6);
    expect(materialDispose.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(container.querySelector("canvas")).toBeNull();
    expect(container.querySelector(".spatial-label-layer")).toBeNull();
    expect(controllerRef.current).toBeNull();
    expect(rafQueue.size).toBe(0);
  });

  it("does not restore a hover after pointerleave when a pick frame was queued", async () => {
    const { Raycaster } = await import("three");
    vi.spyOn(Raycaster.prototype, "intersectObjects").mockImplementation(
      (objects) => [{ object: objects[0] }] as unknown as ReturnType<InstanceType<typeof Raycaster>["intersectObjects"]>,
    );
    const { props } = setup();
    render(<SpatialRenderer {...props} />);
    flushFrames();
    const canvas = gl.instances[0]!.domElement;
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, left: 0, top: 0, width: 800, height: 500, right: 800, bottom: 500, toJSON: () => ({}),
    });
    act(() => {
      canvas.dispatchEvent(new MouseEvent("pointermove", { clientX: 200, clientY: 200 }));
      canvas.dispatchEvent(new MouseEvent("pointerleave"));
      flushFrames();
    });
    expect((props.onHover as Mock).mock.calls.some(([key]) => key !== null)).toBe(false);
  });
});

// jsdom has no PointerEvent: a MouseEvent carrying the pointer fields is what
// both the renderer and the real OrbitControls read. Events bubble so the
// controls' document-level move/up listeners see the same sequence.
interface PointerInit { id: number; x: number; y: number; pointerType?: "touch" | "mouse" | "pen"; isPrimary?: boolean; button?: number }
function pointerEvent(type: string, init: PointerInit): MouseEvent {
  const released = type === "pointerup" || type === "pointercancel";
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: init.x,
    clientY: init.y,
    button: type === "pointermove" ? -1 : init.button ?? 0,
    buttons: released ? 0 : (init.button ?? 0) === 2 ? 2 : 1,
  });
  Object.defineProperties(event, {
    pointerId: { value: init.id },
    pointerType: { value: init.pointerType ?? "touch" },
    isPrimary: { value: init.isPrimary ?? true },
  });
  return event;
}

describe("SpatialRenderer tap selection (touch, multi-touch and cancellation)", () => {
  async function mountPickable() {
    const { Raycaster } = await import("three");
    // Every ray hits the first seat, so any selection the renderer emits is a seat key.
    vi.spyOn(Raycaster.prototype, "intersectObjects").mockImplementation(
      (objects) => [{ object: objects[0] }] as unknown as ReturnType<InstanceType<typeof Raycaster>["intersectObjects"]>,
    );
    const { props, onSelect } = setup();
    render(<SpatialRenderer {...props} />);
    flushFrames();
    const canvas = gl.instances[0]!.domElement;
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, left: 0, top: 0, width: 800, height: 500, right: 800, bottom: 500, toJSON: () => ({}),
    });
    // OrbitControls captures the pointer on down; jsdom has no capture API.
    Object.assign(canvas, { setPointerCapture: vi.fn(), releasePointerCapture: vi.fn(), hasPointerCapture: () => false });
    const send = (type: string, init: PointerInit) => act(() => { canvas.dispatchEvent(pointerEvent(type, init)); flushFrames(); });
    // A terminal event that lands outside the canvas (uncaptured release elsewhere).
    const sendOutside = (type: string, init: PointerInit) => act(() => { document.body.dispatchEvent(pointerEvent(type, init)); flushFrames(); });
    return { send, sendOutside, onSelect, canvas };
  }

  it("a single-finger tap selects the seat under it exactly once", async () => {
    const { send, onSelect } = await mountPickable();
    send("pointerdown", { id: 11, x: 200, y: 200 });
    send("pointerup", { id: 11, x: 202, y: 201 });
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(typeof onSelect.mock.calls[0]![0]).toBe("string");
  });

  it("a pinch whose second finger stays still selects nothing", async () => {
    const { send, onSelect } = await mountPickable();
    send("pointerdown", { id: 11, x: 200, y: 200 });
    send("pointerdown", { id: 12, x: 400, y: 260, isPrimary: false });
    send("pointermove", { id: 11, x: 120, y: 180 });
    send("pointermove", { id: 11, x: 60, y: 160 });
    send("pointerup", { id: 12, x: 400, y: 260, isPrimary: false });
    send("pointerup", { id: 11, x: 60, y: 160 });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("a stationary two-finger tap selects nothing", async () => {
    const { send, onSelect } = await mountPickable();
    send("pointerdown", { id: 11, x: 200, y: 200 });
    send("pointerdown", { id: 12, x: 260, y: 220, isPrimary: false });
    send("pointerup", { id: 12, x: 260, y: 220, isPrimary: false });
    send("pointerup", { id: 11, x: 200, y: 200 });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("a cancelled touch leaves no tap candidate for a later stray release", async () => {
    const { send, onSelect } = await mountPickable();
    send("pointerdown", { id: 11, x: 200, y: 200 });
    send("pointercancel", { id: 11, x: 200, y: 200 });
    // A release whose press began elsewhere (never seen by the canvas).
    send("pointerup", { id: 1, x: 201, y: 200, pointerType: "mouse" });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("a release from a different pointer than the one pressed does not select", async () => {
    const { send, onSelect } = await mountPickable();
    send("pointerdown", { id: 11, x: 200, y: 200 });
    send("pointerup", { id: 99, x: 200, y: 200 });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("a drag that wanders past the slop and returns to its origin selects nothing", async () => {
    const { send, onSelect } = await mountPickable();
    send("pointerdown", { id: 11, x: 200, y: 200 });
    send("pointermove", { id: 11, x: 260, y: 230 });
    send("pointermove", { id: 11, x: 201, y: 200 });
    send("pointerup", { id: 11, x: 201, y: 200 });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("a primary mouse press while a primary touch is held selects nothing (each pointer type has its own primary)", async () => {
    const { send, onSelect } = await mountPickable();
    send("pointerdown", { id: 11, x: 200, y: 200 });
    send("pointerdown", { id: 1, x: 300, y: 250, pointerType: "mouse" });
    send("pointerup", { id: 1, x: 300, y: 250, pointerType: "mouse" });
    expect(onSelect).not.toHaveBeenCalled();
    send("pointerup", { id: 11, x: 200, y: 200 });
    expect(onSelect).not.toHaveBeenCalled();
    // Both pointers ended: the next tap is a genuine single-pointer tap again.
    send("pointerdown", { id: 13, x: 210, y: 210 });
    send("pointerup", { id: 13, x: 210, y: 210 });
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("a non-primary touch (its first finger began outside the canvas) never starts a tap", async () => {
    const { send, onSelect } = await mountPickable();
    send("pointerdown", { id: 12, x: 200, y: 200, isPrimary: false });
    send("pointerup", { id: 12, x: 200, y: 200, isPrimary: false });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("a pointer released outside the canvas does not stay active and block later taps", async () => {
    const { send, sendOutside, onSelect } = await mountPickable();
    send("pointerdown", { id: 11, x: 200, y: 200 });
    sendOutside("pointerup", { id: 11, x: 900, y: 700 });
    expect(onSelect).not.toHaveBeenCalled();
    send("pointerdown", { id: 1, x: 300, y: 300, pointerType: "mouse" });
    sendOutside("pointerup", { id: 1, x: 900, y: 700, pointerType: "mouse" });
    expect(onSelect).not.toHaveBeenCalled();
    send("pointerdown", { id: 14, x: 220, y: 210 });
    send("pointerup", { id: 14, x: 220, y: 210 });
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("unmount drops the document release listeners and a remount starts with no held pointer", async () => {
    const removeSpy = vi.spyOn(document, "removeEventListener");
    const first = await mountPickable();
    first.send("pointerdown", { id: 11, x: 200, y: 200 });
    cleanup();
    for (const type of ["pointerup", "pointercancel"]) {
      expect(removeSpy.mock.calls.some(([t, , capture]) => t === type && capture === true)).toBe(true);
    }
    // An event after unmount reaches no renderer.
    act(() => { document.body.dispatchEvent(pointerEvent("pointerup", { id: 11, x: 200, y: 200 })); });
    expect(first.onSelect).not.toHaveBeenCalled();

    gl.instances = [];
    const second = await mountPickable();
    second.send("pointerdown", { id: 15, x: 200, y: 200 });
    second.send("pointerup", { id: 15, x: 200, y: 200 });
    expect(second.onSelect).toHaveBeenCalledTimes(1);
  });

  it("a valid tap after a pinch and a cancel still selects, and the mouse keeps working", async () => {
    const { send, onSelect } = await mountPickable();
    send("pointerdown", { id: 11, x: 200, y: 200 });
    send("pointerdown", { id: 12, x: 300, y: 200, isPrimary: false });
    send("pointerup", { id: 11, x: 200, y: 200 });
    send("pointerup", { id: 12, x: 300, y: 200, isPrimary: false });
    send("pointerdown", { id: 13, x: 200, y: 200 });
    send("pointercancel", { id: 13, x: 200, y: 200 });
    expect(onSelect).not.toHaveBeenCalled();

    send("pointerdown", { id: 14, x: 220, y: 210 });
    send("pointerup", { id: 14, x: 220, y: 210 });
    expect(onSelect).toHaveBeenCalledTimes(1);

    send("pointerdown", { id: 1, x: 300, y: 300, pointerType: "mouse" });
    send("pointerup", { id: 1, x: 303, y: 300, pointerType: "mouse" });
    expect(onSelect).toHaveBeenCalledTimes(2);

    // A secondary-button click is not a selection.
    send("pointerdown", { id: 1, x: 300, y: 300, pointerType: "mouse", button: 2 });
    send("pointerup", { id: 1, x: 300, y: 300, pointerType: "mouse", button: 2 });
    expect(onSelect).toHaveBeenCalledTimes(2);
  });
});


function hslToHex(h: number, s: number, l: number): string {
  // CSS Color 4 hsl() → sRGB, independent of three.
  const sat = s / 100;
  const light = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sat * Math.min(light, 1 - light);
  const f = (n: number) => light - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("");
}

describe("SpatialRenderer color and labels", () => {
  it("interprets CSS theme HSL as sRGB (dark stage stays as dark as the UI around it)", async () => {
    const { Color } = await import("three");
    for (const token of [{ h: 120, s: 8, l: 7 }, { h: 47, s: 20, l: 97 }, { h: 158, s: 64, l: 52 }]) {
      expect(toColor(token).getHexString()).toBe(hslToHex(token.h, token.s, token.l));
    }
    // The previous linear interpretation lifted near-black into grey.
    const linear = new Color().setHSL(120 / 360, 0.08, 0.07);
    expect(linear.getHexString()).not.toBe(hslToHex(120, 8, 7));
  });

  it("places labels by priority: problem seat and rig name shown, selection always shown", () => {
    const { props } = setup();
    const { container, rerender } = render(<SpatialRenderer {...props} />);
    flushFrames();
    const layer = container.querySelector<HTMLElement>(".spatial-label-layer")!;
    const shownText = () => [...layer.querySelectorAll<HTMLElement>("[data-spatial-label]")]
      .filter((el) => el.style.display !== "none")
      .map((el) => `${el.dataset.spatialLabel}:${el.querySelector(".spatial-label__text")?.textContent}`);
    expect(shownText()).toContain("agent:b");
    expect(shownText()).toContain("rig:rig");
    expect(Number(layer.dataset.visibleLabels)).toBe(shownText().length);

    const xssKey = [...props.model.agentsByKey.values()].find((a) => a.logicalId?.includes("<img"))!.key;
    rerender(<SpatialRenderer {...props} selectedKey={xssKey} />);
    flushFrames();
    expect(shownText()).toContain("agent:<img src=x onerror=alert(1)>");
  });

  it("dense pods suppress colliding seat names instead of overlapping them", () => {
    const nodes: Array<Record<string, unknown>> = [{ id: "pod-p", type: "podGroup", data: { podNamespace: "crowd" } }];
    for (let i = 0; i < 40; i++) nodes.push({ id: `n${i}`, type: "rigNode", parentId: "pod-p", data: { logicalId: `crowd.seat-with-a-long-name-${i}`, status: "running", terminalActive: true } });
    const model = buildSpatialModel("local", [parseSpatialRig("local", { rigId: "r", rigName: "rig", graph: { nodes, edges: [] } })]);
    const { props } = setup();
    const { container } = render(<SpatialRenderer {...props} model={model} layout={layoutSpatialModel(model)} />);
    flushFrames();
    const layer = container.querySelector<HTMLElement>(".spatial-label-layer")!;
    const visible = Number(layer.dataset.visibleLabels);
    const suppressed = Number(layer.dataset.suppressedLabels);
    expect(visible).toBeGreaterThan(0);
    expect(suppressed).toBeGreaterThan(0);
    expect(visible).toBeLessThan(42);
  });

  // --- Visit camera continuity (navigation contract) ------------------------
  // The pose is a bounded value: snapshot/restore through the controller,
  // reported on settle (not per frame) and on teardown, applied once,
  // instantly, and only to compatible layout bounds.
  describe("camera snapshot / restore", () => {
    const cameraOf = () =>
      gl.instances.at(-1)!.render.mock.calls.at(-1)![1] as { position: { toArray(): number[] } };

    it("reports one settled pose after a command, none while idle, and a final pose on teardown", () => {
      const { props, controllerRef } = setup();
      const onCameraSettle = vi.fn();
      const { unmount } = render(<SpatialRenderer {...props} onCameraSettle={onCameraSettle} />);
      flushFrames();
      onCameraSettle.mockClear();
      act(() => controllerRef.current!.preset("top"));
      const frames = flushFrames();
      expect(frames).toBeGreaterThan(5);
      expect(onCameraSettle).toHaveBeenCalledTimes(1);
      expect(onCameraSettle.mock.calls[0]![0]).toMatchObject({ userMoved: true });
      expect(flushFrames()).toBe(0);
      expect(onCameraSettle).toHaveBeenCalledTimes(1);
      unmount();
      expect(onCameraSettle).toHaveBeenCalledTimes(2);
      expect(onCameraSettle.mock.calls[1]![0].position).toEqual(onCameraSettle.mock.calls[0]![0].position);
    });

    it("a remounted renderer restores the saved manual pose instantly instead of auto-fitting", () => {
      const first = setup();
      const onCameraSettle = vi.fn();
      const a = render(<SpatialRenderer {...first.props} reducedMotion onCameraSettle={onCameraSettle} />);
      flushFrames();
      act(() => first.controllerRef.current!.zoom(0.5));
      act(() => first.controllerRef.current!.orbit(0.4, 0.1));
      flushFrames();
      const saved = first.controllerRef.current!.snapshot()!;
      expect(saved.userMoved).toBe(true);
      a.unmount();

      const second = setup();
      render(<SpatialRenderer {...second.props} initialCamera={saved} />);
      expect(flushFrames()).toBeLessThan(5);
      const restored = cameraOf().position.toArray();
      saved.position.forEach((v, i) => expect(restored[i]).toBeCloseTo(v, 6));
      expect(second.controllerRef.current!.snapshot()!.userMoved).toBe(true);
      // An ordinary refresh does not re-fit the restored pose.
      expect(flushFrames()).toBe(0);
    });

    it("ignores a pose taken against different layout bounds, nonfinite values or a degenerate camera", () => {
      const base = setup();
      render(<SpatialRenderer {...base.props} />);
      flushFrames();
      const fitted = base.controllerRef.current!.snapshot()!;
      cleanup();

      const variants = [
        { ...fitted, userMoved: true, position: [fitted.position[0] + 5, fitted.position[1], fitted.position[2]] as [number, number, number], bounds: { center: fitted.bounds.center, radius: fitted.bounds.radius * 3 } },
        { ...fitted, userMoved: true, position: [Number.NaN, 1, 1] as [number, number, number] },
        { ...fitted, userMoved: true, position: fitted.target },
      ];
      for (const bad of variants) {
        const next = setup();
        render(<SpatialRenderer {...next.props} initialCamera={bad} />);
        flushFrames();
        const pose = next.controllerRef.current!.snapshot()!;
        expect(pose.userMoved).toBe(false);
        pose.position.forEach((v, i) => expect(v).toBeCloseTo(fitted.position[i]!, 6));
        expect(next.controllerRef.current!.restore(bad)).toBe(false);
        cleanup();
      }
    });

    it("Reset hands the camera back to auto-fit; restoring that pose fits rather than pinning it", () => {
      const { props, controllerRef } = setup();
      render(<SpatialRenderer {...props} reducedMotion />);
      flushFrames();
      act(() => controllerRef.current!.zoom(0.4));
      act(() => controllerRef.current!.reset());
      flushFrames();
      const afterReset = controllerRef.current!.snapshot()!;
      expect(afterReset.userMoved).toBe(false);
      cleanup();
      const next = setup();
      render(<SpatialRenderer {...next.props} initialCamera={{ ...afterReset, position: [afterReset.position[0] * 0.9, afterReset.position[1], afterReset.position[2]] }} />);
      flushFrames();
      expect(next.controllerRef.current!.snapshot()!.userMoved).toBe(false);
    });

    it("clamps a restored distance into the current control limits", () => {
      const { props, controllerRef } = setup();
      render(<SpatialRenderer {...props} />);
      flushFrames();
      const fitted = controllerRef.current!.snapshot()!;
      const [tx, ty, tz] = fitted.target;
      const far = { ...fitted, userMoved: true, position: [tx, ty + 1e5, tz + 1e5] as [number, number, number] };
      expect(controllerRef.current!.restore(far)).toBe(true);
      const pose = controllerRef.current!.snapshot()!;
      const distance = Math.hypot(pose.position[0] - tx, pose.position[1] - ty, pose.position[2] - tz);
      expect(distance).toBeLessThan(1300);
      expect(distance).toBeGreaterThan(6);
    });
  });

  // Reduced motion turning on while a camera move is animating ends it at
  // once: one final paint at the move's destination, a settled pose report,
  // and instantaneous commands from then on (no further tween frames).
  describe("live reduced-motion activation", () => {
    it("lands an in-flight tween on its destination in one frame and keeps later commands instant", () => {
      const reference = setup();
      render(<SpatialRenderer {...reference.props} />);
      flushFrames();
      act(() => reference.controllerRef.current!.preset("top"));
      flushFrames();
      const destination = reference.controllerRef.current!.snapshot()!;
      cleanup();

      const { props, controllerRef } = setup();
      const onCameraSettle = vi.fn();
      const mounted = render(<SpatialRenderer {...props} onCameraSettle={onCameraSettle} />);
      flushFrames();
      onCameraSettle.mockClear();
      act(() => controllerRef.current!.preset("top"));
      expect(flushFrames(2)).toBe(2);
      expect(rafQueue.size).toBeGreaterThan(0);
      mounted.rerender(<SpatialRenderer {...props} onCameraSettle={onCameraSettle} reducedMotion />);
      expect(flushFrames()).toBeLessThanOrEqual(1);
      expect(rafQueue.size).toBe(0);
      const pose = controllerRef.current!.snapshot()!;
      pose.position.forEach((v, i) => expect(v).toBeCloseTo(destination.position[i]!, 6));
      pose.target.forEach((v, i) => expect(v).toBeCloseTo(destination.target[i]!, 6));
      expect(pose.userMoved).toBe(true);
      expect(onCameraSettle).toHaveBeenCalledTimes(1);
      expect(onCameraSettle.mock.calls[0]![0].position).toEqual(pose.position);

      act(() => controllerRef.current!.zoom(0.6));
      expect(flushFrames()).toBe(1);
      expect(flushFrames()).toBe(0);
    });

    it("idle activation schedules no frame; turning reduced motion off restores bounded animation", () => {
      const { props, controllerRef } = setup();
      const mounted = render(<SpatialRenderer {...props} />);
      flushFrames();
      mounted.rerender(<SpatialRenderer {...props} reducedMotion />);
      expect(flushFrames()).toBe(0);
      mounted.rerender(<SpatialRenderer {...props} reducedMotion={false} />);
      act(() => controllerRef.current!.preset("iso"));
      const frames = flushFrames();
      expect(frames).toBeGreaterThan(5);
      expect(frames).toBeLessThan(120);
    });
  });
});

// Phone / compact stage: the scene must stay visible. Seat names are one
// line (status text only on the selected seat), the ambient label count is
// small, and a density switch (rotation, split view) restyles the existing
// labels in place instead of rebuilding the scene. Touch taps that just miss
// a small puck snap to the nearest seat; a far tap still clears.
function manySeatSetup(seats = 24) {
  const nodes: Array<Record<string, unknown>> = [];
  for (const pod of ["core", "build", "review"]) nodes.push({ id: `pod-${pod}`, type: "podGroup", data: { podNamespace: pod } });
  for (let i = 0; i < seats; i++) {
    const pod = ["core", "build", "review"][i % 3]!;
    nodes.push({ id: `s${i}`, type: "rigNode", parentId: `pod-${pod}`, data: { logicalId: `${pod}.seat-${i}`, status: "running", ...(i === 4 ? { startupStatus: "failed" } : {}) } });
  }
  const model = buildSpatialModel("local", [parseSpatialRig("local", { rigId: "r", rigName: "rig", graph: { nodes, edges: [] } })]);
  const base = setup();
  return { ...base, props: { ...base.props, model, layout: layoutSpatialModel(model) }, keys: [...model.agentsByKey.keys()] };
}

function agentLabels(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>("[data-spatial-label='agent']")];
}
const isShown = (el: HTMLElement) => el.style.display !== "none";
const metaOf = (el: HTMLElement) => el.querySelector<HTMLElement>(".spatial-label__meta");

describe("SpatialRenderer compact (phone) density", () => {
  function phoneViewport() {
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 430 });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 480 });
  }

  it("shows few one-line seat names; only the selected seat carries its status line", async () => {
    phoneViewport();
    const { props, keys } = manySeatSetup();
    const { rerender } = render(<SpatialRenderer {...props} density="compact" />);
    flushFrames();
    const layer = document.querySelector<HTMLElement>(".spatial-label-layer")!;
    expect(Number(layer.dataset.visibleLabels)).toBeLessThanOrEqual(16);
    for (const label of agentLabels().filter(isShown)) expect(metaOf(label)?.hidden).toBe(true);

    const selected = keys[7]!;
    rerender(<SpatialRenderer {...props} density="compact" selectedKey={selected} />);
    flushFrames();
    const selectedLabel = agentLabels().find((el) => el.classList.contains("is-selected"))!;
    expect(isShown(selectedLabel)).toBe(true);
    expect(metaOf(selectedLabel)?.hidden).toBe(false);
    for (const label of agentLabels().filter((el) => isShown(el) && el !== selectedLabel)) expect(metaOf(label)?.hidden).toBe(true);
  });

  it("switching density restyles the same label elements without a rebuild and paints once", async () => {
    phoneViewport();
    const { props } = manySeatSetup(6);
    const { rerender } = render(<SpatialRenderer {...props} density="compact" />);
    flushFrames();
    const before = agentLabels();
    expect(before.filter(isShown).every((el) => metaOf(el)?.hidden === true)).toBe(true);

    rerender(<SpatialRenderer {...props} density="full" />);
    expect(rafQueue.size).toBe(1);
    flushFrames();
    const after = agentLabels();
    expect(after).toHaveLength(before.length);
    after.forEach((el, i) => expect(el).toBe(before[i]));
    expect(after.filter(isShown).length).toBeGreaterThan(0);
    for (const label of after.filter(isShown)) expect(metaOf(label)?.hidden).toBe(false);
  });

  it("a touch tap that just misses a seat selects it; a far tap clears; a precise mouse miss never snaps", async () => {
    const { Raycaster } = await import("three");
    vi.spyOn(Raycaster.prototype, "intersectObjects").mockImplementation(() => []);
    const { props, controllerRef, onSelect, keys } = manySeatSetup(6);
    render(<SpatialRenderer {...props} />);
    flushFrames();
    const canvas = gl.instances[0]!.domElement;
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, left: 0, top: 0, width: 800, height: 500, right: 800, bottom: 500, toJSON: () => ({}),
    });
    Object.assign(canvas, { setPointerCapture: vi.fn(), releasePointerCapture: vi.fn(), hasPointerCapture: () => false });
    const target = keys[2]!;
    // Focus centres the camera on the seat: it now projects to the stage centre.
    act(() => controllerRef.current!.focus(target));
    flushFrames();
    const tap = (x: number, y: number, pointerType: "touch" | "mouse", id: number) => act(() => {
      canvas.dispatchEvent(pointerEvent("pointerdown", { id, x, y, pointerType }));
      canvas.dispatchEvent(pointerEvent("pointerup", { id, x, y, pointerType }));
      flushFrames();
    });
    tap(412, 258, "touch", 21);
    expect(onSelect).toHaveBeenLastCalledWith(target);
    tap(780, 30, "touch", 22);
    expect(onSelect).toHaveBeenLastCalledWith(null);
    tap(412, 258, "mouse", 1);
    expect(onSelect).toHaveBeenLastCalledWith(null);
    expect(onSelect).toHaveBeenCalledTimes(3);
  });

  it("touch tolerance never turns a pinch, a drag or a cancelled touch near a seat into a selection", async () => {
    const { Raycaster } = await import("three");
    vi.spyOn(Raycaster.prototype, "intersectObjects").mockImplementation(() => []);
    const { props, controllerRef, onSelect, keys } = manySeatSetup(6);
    render(<SpatialRenderer {...props} />);
    flushFrames();
    const canvas = gl.instances[0]!.domElement;
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, left: 0, top: 0, width: 800, height: 500, right: 800, bottom: 500, toJSON: () => ({}),
    });
    Object.assign(canvas, { setPointerCapture: vi.fn(), releasePointerCapture: vi.fn(), hasPointerCapture: () => false });
    act(() => controllerRef.current!.focus(keys[2]!));
    flushFrames();
    const send = (type: string, init: PointerInit) => act(() => { canvas.dispatchEvent(pointerEvent(type, init)); flushFrames(); });
    // Stationary two-finger tap right beside the seat.
    send("pointerdown", { id: 31, x: 405, y: 252 });
    send("pointerdown", { id: 32, x: 440, y: 260, isPrimary: false });
    send("pointerup", { id: 32, x: 440, y: 260, isPrimary: false });
    send("pointerup", { id: 31, x: 405, y: 252 });
    // A drag that ends on the seat.
    send("pointerdown", { id: 33, x: 300, y: 250 });
    send("pointermove", { id: 33, x: 360, y: 250 });
    send("pointerup", { id: 33, x: 404, y: 251 });
    // A cancelled touch on the seat.
    send("pointerdown", { id: 34, x: 404, y: 251 });
    send("pointercancel", { id: 34, x: 404, y: 251 });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("refreshOverlays re-reads stage overlays and schedules exactly one frame", () => {
    const { props, controllerRef } = manySeatSetup(6);
    render(<SpatialRenderer {...props} density="compact" />);
    flushFrames();
    expect(rafQueue.size).toBe(0);
    act(() => controllerRef.current!.refreshOverlays());
    expect(rafQueue.size).toBe(1);
    flushFrames();
    expect(rafQueue.size).toBe(0);
  });
});
