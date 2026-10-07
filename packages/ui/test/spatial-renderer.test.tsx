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

// Night Atelier scene: real figures by configured runtime on instanced stone
// plinths, one selection spotlight, no shadow maps, and traffic arcs that
// come ONLY from real records, driven by their own timestamps.
type SceneLike = { traverse(fn: (o: unknown) => void): void };
function lastScene(): SceneLike {
  return gl.instances.at(-1)!.render.mock.calls.at(-1)![0] as SceneLike;
}
function sceneObjects<T>(predicate: (o: unknown) => o is T): T[] {
  const out: T[] = [];
  lastScene().traverse((o) => { if (predicate(o)) out.push(o); });
  return out;
}

function runtimeSetup() {
  const nodes = [
    { id: "pod-p", type: "podGroup", data: { podNamespace: "lead" } },
    { id: "c1", type: "rigNode", parentId: "pod-p", data: { logicalId: "lead.coordinator", runtime: "claude-code", status: "running" } },
    { id: "c2", type: "rigNode", parentId: "pod-p", data: { logicalId: "lead.builder", runtime: "claude-code", status: "running" } },
    { id: "x1", type: "rigNode", parentId: "pod-p", data: { logicalId: "lead.reviewer", runtime: "codex", status: "running" } },
    { id: "u1", type: "rigNode", data: { logicalId: "loose.helper", runtime: "pi", status: "running" } },
  ];
  const model = buildSpatialModel("local", [parseSpatialRig("local", { rigId: "r", rigName: "rig", graph: { nodes, edges: [{ id: "e", source: "c1", target: "x1", label: "delegates_to" }] } })]);
  const base = setup();
  const keyOf = (node: string) => [...model.agentsByKey.values()].find((a) => a.nodeId === node)!.key;
  return { ...base, props: { ...base.props, model, layout: layoutSpatialModel(model) }, keyOf };
}

describe("SpatialRenderer Night Atelier scene", () => {
  it("draws Clawd for Claude seats, Null for Codex and a neutral stele otherwise, sharing geometry by kind; no pucks", async () => {
    const { Mesh, InstancedMesh } = await import("three");
    const { props, keyOf } = runtimeSetup();
    render(<SpatialRenderer {...props} />);
    flushFrames();
    const figures = sceneObjects((o): o is InstanceType<typeof Mesh> => o instanceof Mesh && !(o instanceof InstancedMesh) && typeof (o as InstanceType<typeof Mesh>).userData.spatialKey === "string");
    const geometryOf = (key: string) => figures.filter((f) => f.userData.spatialKey === key).map((f) => f.geometry);
    // Two Claude seats share one Clawd geometry; Codex differs; the Pi seat is neutral.
    expect(geometryOf(keyOf("c1"))[0]).toBe(geometryOf(keyOf("c2"))[0]);
    expect(geometryOf(keyOf("x1"))[0]).not.toBe(geometryOf(keyOf("c1"))[0]);
    expect(geometryOf(keyOf("u1"))[0]).not.toBe(geometryOf(keyOf("c1"))[0]);
    expect(geometryOf(keyOf("u1"))[0]).not.toBe(geometryOf(keyOf("x1"))[0]);
    // Codex seats carry the glowing NULL face as a second, shared mesh.
    expect(geometryOf(keyOf("x1"))).toHaveLength(2);
    expect(geometryOf(keyOf("c1"))).toHaveLength(1);
    // No legacy puck cylinders anywhere in the scene (cones subclass cylinders; check the type).
    expect(sceneObjects((o): o is InstanceType<typeof Mesh> => o instanceof Mesh && o.geometry.type === "CylinderGeometry")).toHaveLength(0);
    // Every seat label names its figure kind for styling (from runtime only).
    // (Read from the scene: CSS2D attaches an element only once it has shown.)
    const figuresByLabel = sceneObjects((o): o is { element: HTMLElement } => (o as { element?: HTMLElement }).element?.dataset.spatialLabel === "agent")
      .map((o) => o.element.dataset.figure).sort();
    expect(figuresByLabel).toEqual(["clawd", "clawd", "neutral", "null"]);
  });

  it("stands every seat on one instanced plinth draw with instanced contact shadows, one spotlight and no shadow maps", async () => {
    const { InstancedMesh, SpotLight } = await import("three");
    const { props } = runtimeSetup();
    render(<SpatialRenderer {...props} />);
    flushFrames();
    // Scene stone only (the traffic pool's bead strings are separate, idle instances).
    const instanced = sceneObjects((o): o is InstanceType<typeof InstancedMesh> => o instanceof InstancedMesh && (o as InstanceType<typeof InstancedMesh>).name !== "traffic-beads");
    expect(instanced).toHaveLength(2);
    const plinths = instanced.find((m) => Array.isArray(m.userData.instanceKeys))!;
    expect(plinths.count).toBe(4);
    expect(new Set(plinths.userData.instanceKeys)).toEqual(new Set(props.model.agentsByKey.keys()));
    expect(instanced.find((m) => m !== plinths)!.count).toBe(8); // plinth + figure shadow per seat
    expect(sceneObjects((o): o is InstanceType<typeof SpotLight> => o instanceof SpotLight)).toHaveLength(1);
    expect((gl.instances[0] as unknown as { shadowMap: { enabled: boolean } }).shadowMap.enabled).toBe(false);
  });

  it("a tap on a seat's plinth selects that exact seat (instance index → key)", async () => {
    const { Raycaster } = await import("three");
    const { props, onSelect, keyOf } = runtimeSetup();
    render(<SpatialRenderer {...props} />);
    flushFrames();
    const { InstancedMesh } = await import("three");
    const plinths = sceneObjects((o): o is InstanceType<typeof InstancedMesh> => o instanceof InstancedMesh && Array.isArray((o as InstanceType<typeof InstancedMesh>).userData.instanceKeys))[0]!;
    const index = (plinths.userData.instanceKeys as string[]).indexOf(keyOf("x1"));
    vi.spyOn(Raycaster.prototype, "intersectObjects").mockImplementation(() => [{ object: plinths, instanceId: index }] as unknown as ReturnType<InstanceType<typeof Raycaster>["intersectObjects"]>);
    const canvas = gl.instances[0]!.domElement;
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, left: 0, top: 0, width: 800, height: 500, right: 800, bottom: 500, toJSON: () => ({}) });
    Object.assign(canvas, { setPointerCapture: vi.fn(), releasePointerCapture: vi.fn(), hasPointerCapture: () => false });
    act(() => {
      canvas.dispatchEvent(pointerEvent("pointerdown", { id: 1, x: 300, y: 300, pointerType: "mouse" }));
      canvas.dispatchEvent(pointerEvent("pointerup", { id: 1, x: 300, y: 300, pointerType: "mouse" }));
    });
    expect(onSelect).toHaveBeenCalledWith(keyOf("x1"));
  });

  it("the one spotlight lights the selected seat and goes dark with no selection, in a single frame", async () => {
    const { SpotLight } = await import("three");
    const { props, keyOf } = runtimeSetup();
    const { rerender } = render(<SpatialRenderer {...props} />);
    flushFrames();
    const spot = () => sceneObjects((o): o is InstanceType<typeof SpotLight> => o instanceof SpotLight)[0]!;
    expect(spot().intensity).toBe(0);
    rerender(<SpatialRenderer {...props} selectedKey={keyOf("x1")} />);
    expect(flushFrames()).toBe(1);
    expect(spot().intensity).toBeGreaterThan(0);
    const seat = props.layout.agents.find((a) => a.key === keyOf("x1"))!;
    expect(spot().target.position.x).toBeCloseTo(seat.position[0], 5);
    expect(spot().target.position.z).toBeCloseTo(seat.position[2], 5);
    rerender(<SpatialRenderer {...props} selectedKey={null} />);
    flushFrames();
    expect(spot().intensity).toBe(0);
  });

  describe("traffic arcs (real records only)", () => {
    const T0 = 1_760_000_000_000;
    beforeEach(() => { vi.spyOn(Date, "now").mockImplementation(() => T0 + now); });
    const caption = () => document.querySelector<HTMLElement>("[data-spatial-label='traffic']:not([style*='display: none'])");
    // Traffic lines live in the traffic layer: the group holding the traffic captions.
    async function arcLines() {
      const { Line } = await import("three");
      type Node = { children: Array<{ element?: HTMLElement }> };
      return sceneObjects((o): o is InstanceType<typeof Line> => o instanceof Line
        && ((o as unknown as { parent: Node | null }).parent?.children.some((c) => c.element?.dataset.spatialLabel === "traffic") ?? false));
    }
    const record = (keyOf: (n: string) => string, over: Partial<{ id: string; occurredAt: number }> = {}) => ({
      id: over.id ?? "q-1", sourceKey: keyOf("c2"), targetKey: keyOf("c1"), type: "queue.handed_off",
      label: "handoff · builder → coordinator", occurredAt: over.occurredAt ?? T0 + now,
    });

    it("no traffic: nothing drawn and no frames requested", async () => {
      const { props } = runtimeSetup();
      const { rerender } = render(<SpatialRenderer {...props} />);
      flushFrames();
      rerender(<SpatialRenderer {...props} traffic={[]} />);
      expect(rafQueue.size).toBe(0);
      expect((await arcLines()).some((l) => l.visible)).toBe(false);
    });

    it("a fresh record travels sender → receiver for a bounded number of frames, then the scene is quiet", async () => {
      const { props, keyOf } = runtimeSetup();
      const { rerender } = render(<SpatialRenderer {...props} />);
      flushFrames();
      rerender(<SpatialRenderer {...props} traffic={[record(keyOf)]} />);
      expect(rafQueue.size).toBe(1);
      flushFrames(4);
      const live = (await arcLines()).filter((l) => l.visible);
      expect(live).toHaveLength(1);
      expect(caption()?.textContent).toBe("handoff · builder → coordinator");
      const frames = flushFrames(2000);
      // ~4.2s at 16ms per frame, then it stops by itself.
      expect(frames).toBeGreaterThan(200);
      expect(frames).toBeLessThan(300);
      expect(rafQueue.size).toBe(0);
      expect((await arcLines()).some((l) => l.visible)).toBe(false);
    });

    it("never replays: an id already seen, or a record older than the window, schedules nothing", async () => {
      const { props, keyOf } = runtimeSetup();
      const { rerender } = render(<SpatialRenderer {...props} traffic={[record(keyOf)]} />);
      flushFrames(2000);
      expect(rafQueue.size).toBe(0);
      // Same record re-delivered in a fresh array (cache refresh).
      rerender(<SpatialRenderer {...props} traffic={[{ ...record(keyOf, { id: "q-1", occurredAt: T0 }) }]} />);
      expect(rafQueue.size).toBe(0);
      // A different, but old, record (replayed history).
      rerender(<SpatialRenderer {...props} traffic={[record(keyOf, { id: "q-old", occurredAt: T0 + now - 60_000 })]} />);
      expect(rafQueue.size).toBe(0);
      expect((await arcLines()).some((l) => l.visible)).toBe(false);
    });

    it("a record re-delivered while still in flight keeps one arc (no duplicate, no restart)", async () => {
      const { props, keyOf } = runtimeSetup();
      const first = record(keyOf);
      const { rerender } = render(<SpatialRenderer {...props} traffic={[first]} />);
      flushFrames(20);
      const before = (await arcLines()).find((l) => l.visible)!;
      const headBefore = before.geometry.drawRange.start + before.geometry.drawRange.count;
      rerender(<SpatialRenderer {...props} traffic={[{ ...first }, { ...first }]} />);
      flushFrames(1);
      const visible = (await arcLines()).filter((l) => l.visible);
      expect(visible).toHaveLength(1);
      expect(visible[0]!.geometry.drawRange.start + visible[0]!.geometry.drawRange.count).toBeGreaterThanOrEqual(headBefore);
    });

    it("a record that leaves traffic (disconnect, hidden or reduced suppression) stops at once and never replays", async () => {
      const { props, keyOf } = runtimeSetup();
      const live = record(keyOf);
      const { rerender } = render(<SpatialRenderer {...props} traffic={[live]} />);
      flushFrames(4);
      expect((await arcLines()).some((l) => l.visible)).toBe(true);
      // The activity hook drops its pulses: the arc ends in one paint, idle after.
      rerender(<SpatialRenderer {...props} traffic={[]} />);
      expect(flushFrames(1)).toBe(1);
      expect((await arcLines()).some((l) => l.visible)).toBe(false);
      expect(caption()).toBeNull();
      expect(rafQueue.size).toBe(0);
      // Pulses come back (reconnect) with the same, still-recent record: it was
      // already seen, so it is not admitted again; only a new id animates.
      rerender(<SpatialRenderer {...props} traffic={[{ ...live }]} />);
      expect(rafQueue.size).toBe(0);
      rerender(<SpatialRenderer {...props} traffic={[{ ...live }, record(keyOf, { id: "q-2" })]} />);
      flushFrames(2);
      expect((await arcLines()).filter((l) => l.visible)).toHaveLength(1);
    });

    it("a record whose seats are not in this scene draws nothing", async () => {
      const { props, keyOf } = runtimeSetup();
      const { rerender } = render(<SpatialRenderer {...props} />);
      flushFrames();
      rerender(<SpatialRenderer {...props} traffic={[{ ...record(keyOf), targetKey: "local/r/agent/ghost" }]} />);
      expect(rafQueue.size).toBe(0);
    });

    it("reduced motion: one static paint for the window, cleared by a single timer, no frame loop", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const { props, keyOf } = runtimeSetup();
        const { rerender } = render(<SpatialRenderer {...props} reducedMotion />);
        flushFrames();
        rerender(<SpatialRenderer {...props} reducedMotion traffic={[record(keyOf)]} />);
        expect(flushFrames()).toBe(1);
        expect(rafQueue.size).toBe(0);
        const line = (await arcLines()).find((l) => l.visible)!;
        expect(line.geometry.drawRange.start).toBe(0); // whole arc, no travel
        act(() => { now += 5000; vi.advanceTimersByTime(5000); });
        expect(flushFrames()).toBe(1);
        expect((await arcLines()).some((l) => l.visible)).toBe(false);
        expect(rafQueue.size).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("a hidden tab does not keep painting an arc", async () => {
      const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
      const { props, keyOf } = runtimeSetup();
      const { rerender } = render(<SpatialRenderer {...props} />);
      flushFrames();
      rerender(<SpatialRenderer {...props} traffic={[record(keyOf)]} />);
      expect(flushFrames()).toBe(1);
      expect(rafQueue.size).toBe(0);
      visibility.mockRestore();
    });

    it("unmount releases figure geometry, the shadow texture and the traffic pool", async () => {
      const { BufferGeometry, Texture, Material } = await import("three");
      const geometryDispose = vi.spyOn(BufferGeometry.prototype, "dispose");
      const textureDispose = vi.spyOn(Texture.prototype, "dispose");
      const materialDispose = vi.spyOn(Material.prototype, "dispose");
      const { props, keyOf } = runtimeSetup();
      const { unmount } = render(<SpatialRenderer {...props} traffic={[record(keyOf)]} />);
      flushFrames(3);
      geometryDispose.mockClear();
      materialDispose.mockClear();
      unmount();
      // 13 shared + 6 figure geometries (4 bodies, 2 glows) + 6 traffic lines, at least.
      expect(geometryDispose.mock.calls.length).toBeGreaterThanOrEqual(25);
      expect(textureDispose).toHaveBeenCalled();
      expect(materialDispose.mock.calls.length).toBeGreaterThanOrEqual(24);
      expect(rafQueue.size).toBe(0);
      expect(document.querySelector("[data-spatial-label='traffic']")).toBeNull();
    });
  });
});

// Painted-QA composition fixes, measured against the real scene and camera:
// figures are a usable size at a ~500px stage, stone hugs the seats, Fit never
// lands on figure backs, and no label plate covers any figure.
describe("SpatialRenderer atelier composition", () => {
  type Cam = InstanceType<typeof import("three").PerspectiveCamera>;
  const lastCamera = () => gl.instances.at(-1)!.render.mock.calls.at(-1)![1] as Cam;

  function threeSeatRig() {
    const nodes = [
      { id: "pod-lead", type: "podGroup", data: { podNamespace: "lead" } },
      { id: "pod-b", type: "podGroup", data: { podNamespace: "builders" } },
      { id: "c1", type: "rigNode", parentId: "pod-lead", data: { logicalId: "lead.coordinator", runtime: "claude-code", status: "running" } },
      { id: "b2", type: "rigNode", parentId: "pod-b", data: { logicalId: "builders.builder2", runtime: "claude-code", status: "running" } },
      { id: "r1", type: "rigNode", parentId: "pod-b", data: { logicalId: "builders.reviewer1", runtime: "codex", status: "idle" } },
    ];
    const graph = { nodes, edges: [{ id: "e1", source: "c1", target: "b2", label: "delegates_to" }, { id: "e2", source: "c1", target: "r1", label: "delegates_to" }] };
    const model = buildSpatialModel("local", [parseSpatialRig("local", { rigId: "r", rigName: "acme-build", graph })]);
    const base = setup();
    const keyOf = (node: string) => [...model.agentsByKey.values()].find((a) => a.nodeId === node)!.key;
    return { ...base, props: { ...base.props, model, layout: layoutSpatialModel(model) }, keyOf };
  }

  async function figureRects() {
    const { Mesh, InstancedMesh, Vector3 } = await import("three");
    const cam = lastCamera();
    cam.updateMatrixWorld();
    const out = new Map<string, { left: number; top: number; right: number; bottom: number }>();
    lastScene().traverse((o) => {
      if (!(o instanceof Mesh) || o instanceof InstancedMesh || typeof o.userData.spatialKey !== "string") return;
      if (!(o.material as { vertexColors?: boolean }).vertexColors || (o.material as { toneMapped?: boolean }).toneMapped === false) return;
      // The figure's own bounding-box corners through its world matrix: the
      // true hull of the rotated figure (a world-axis box would overstate it).
      o.updateWorldMatrix(true, false);
      const box = o.geometry.boundingBox!;
      let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
      for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
        const p = new Vector3(x, y, z).applyMatrix4(o.matrixWorld).project(cam);
        const sx = (p.x + 1) * 400, sy = (1 - p.y) * 250;
        left = Math.min(left, sx); right = Math.max(right, sx); top = Math.min(top, sy); bottom = Math.max(bottom, sy);
      }
      out.set(o.userData.spatialKey, { left, top, right, bottom });
    });
    return out;
  }

  it("at an 800×500 stage the default fit shows figures large enough to recognise; the selected one is portrait-sized", async () => {
    const { props, keyOf } = threeSeatRig();
    render(<SpatialRenderer {...props} selectedKey={keyOf("c1")} />);
    flushFrames();
    const rects = await figureRects();
    expect(rects.size).toBe(3);
    for (const [key, r] of rects) {
      expect(r.bottom - r.top, key).toBeGreaterThan(60);
      expect(r.left, key).toBeGreaterThanOrEqual(0);
      expect(r.right, key).toBeLessThanOrEqual(800);
    }
    const selected = rects.get(keyOf("c1"))!;
    expect(selected.bottom - selected.top).toBeGreaterThanOrEqual(90);
    expect(selected.bottom - selected.top).toBeLessThanOrEqual(160);
  });

  it("each dais hugs its seats' plinths and the slab hugs the daises: tighter than the layout rectangles, containing every plinth", async () => {
    const { Mesh, BoxGeometry } = await import("three");
    const { props } = threeSeatRig();
    render(<SpatialRenderer {...props} />);
    flushFrames();
    const { InstancedMesh } = await import("three");
    const boxes = sceneObjects((o): o is InstanceType<typeof Mesh> => o instanceof Mesh && !(o instanceof InstancedMesh) && o.geometry instanceof BoxGeometry && (o.geometry as InstanceType<typeof BoxGeometry>).parameters.height >= 0.6)
      .map((m) => { const p = (m.geometry as InstanceType<typeof BoxGeometry>).parameters; return { x0: m.position.x - p.width / 2, x1: m.position.x + p.width / 2, z0: m.position.z - p.depth / 2, z1: m.position.z + p.depth / 2, w: p.width, d: p.depth }; });
    const layoutArea = [...props.layout.pods, ...props.layout.rigs].reduce((n, r) => n + r.w * r.d, 0);
    const drawnArea = boxes.reduce((n, b) => n + b.w * b.d, 0);
    expect(boxes).toHaveLength(3); // two daises + one slab
    expect(drawnArea).toBeLessThan(layoutArea * 0.85);
    for (const seat of props.layout.agents) {
      const inside = boxes.filter((b) => seat.position[0] - 1.85 >= b.x0 - 1e-6 && seat.position[0] + 1.85 <= b.x1 + 1e-6 && seat.position[2] - 1.85 >= b.z0 - 1e-6 && seat.position[2] + 1.85 <= b.z1 + 1e-6);
      expect(inside.length, seat.key).toBe(2); // its dais and its slab
    }
  });

  it("Fit from behind the figures returns to their fronts; Fit from a front angle keeps that angle", async () => {
    const { props, controllerRef } = threeSeatRig();
    render(<SpatialRenderer {...props} />);
    flushFrames();
    const facing = { x: Math.sin(0.4), z: Math.cos(0.4) };
    const viewDir = () => {
      const cam = lastCamera();
      const t = cam.position.clone().sub(controllerRef.current!.snapshot()!.target.length ? new (cam.position.constructor as typeof import("three").Vector3)(...controllerRef.current!.snapshot()!.target) : cam.position);
      return t.normalize();
    };
    act(() => controllerRef.current!.orbit(Math.PI, 0));
    flushFrames();
    const behind = viewDir();
    expect(behind.x * facing.x + behind.z * facing.z).toBeLessThan(0);
    act(() => controllerRef.current!.fit());
    flushFrames();
    const front = viewDir();
    expect(front.x * facing.x + front.z * facing.z).toBeGreaterThan(0.5);
    act(() => controllerRef.current!.orbit(0.3, 0));
    flushFrames();
    const angled = viewDir();
    act(() => controllerRef.current!.fit());
    flushFrames();
    const kept = viewDir();
    expect(kept.x).toBeCloseTo(angled.x, 2);
    expect(kept.z).toBeCloseTo(angled.z, 2);
  });

  it("no visible seat label plate overlaps any figure, including the selected seat's own", async () => {
    const { estimateLabelSize } = await import("../src/components/topology/spatial/spatial-view-math.js");
    const { props, keyOf } = threeSeatRig();
    render(<SpatialRenderer {...props} selectedKey={keyOf("c1")} />);
    flushFrames();
    const figures = [...(await figureRects()).values()];
    const labels = sceneObjects((o): o is { element: HTMLElement; center: { x: number; y: number } } => (o as { element?: HTMLElement }).element?.dataset.spatialLabel === "agent")
      .filter((o) => o.element.style.display !== "none" && o.element.style.transform);
    expect(labels.length).toBeGreaterThanOrEqual(1);
    for (const label of labels) {
      const m = label.element.style.transform.match(/translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/)!;
      const [x, y] = [Number(m[1]), Number(m[2])];
      const meta = label.element.querySelector<HTMLElement>(".spatial-label__meta");
      const size = estimateLabelSize("agent", label.element.querySelector(".spatial-label__text")!.textContent ?? "", meta && !meta.hidden ? meta.textContent : null);
      const rect = { left: x - label.center.x * size.w, top: y - label.center.y * size.h, right: x - label.center.x * size.w + size.w, bottom: y - label.center.y * size.h + size.h };
      for (const f of figures) {
        const overlap = rect.left < f.right && f.left < rect.right && rect.top < f.bottom && f.top < rect.bottom;
        expect(overlap, `${label.element.textContent} over a figure`).toBe(false);
      }
    }
    const selected = labels.find((l) => l.element.classList.contains("is-selected"));
    expect(selected).toBeTruthy();
    expect(["plinth", "above", "below"]).toContain(selected!.element.dataset.anchor);
  });
});

// Handoff effect geometry: a luminous trail (core + additive glow tubes over
// the hairline), travelling sparks behind the head, ends just outside the
// figures, and a grounded arrival accent on the receiver's plinth top.
describe("SpatialRenderer traffic effect geometry", () => {
  const T0 = 1_760_000_000_000;
  beforeEach(() => { vi.spyOn(Date, "now").mockImplementation(() => T0 + now); });
  type Obj = { name: string; visible: boolean; position: { x: number; y: number; z: number }; parent: { children: Obj[] } | null };
  function trafficSlot() {
    // The slot whose hairline is visible (the active arc's siblings share its index).
    const lines = sceneObjects((o): o is Obj => (o as Obj).name === "traffic-line" && (o as Obj).visible);
    expect(lines).toHaveLength(1);
    const layer = lines[0]!.parent!.children;
    const index = layer.filter((c) => c.name === "traffic-line").indexOf(lines[0]!);
    const pick = (name: string) => layer.filter((c) => c.name === name)[index] as unknown as Record<string, any>;
    return { line: lines[0] as unknown as Record<string, any>, core: pick("traffic-core"), glow: pick("traffic-glow"), beads: pick("traffic-beads"), head: pick("traffic-head"), arrival: pick("traffic-arrival") };
  }
  function seatBase(key: string) {
    const body = sceneObjects((o): o is { userData: { spatialKey?: string }; parent: { position: { x: number; y: number; z: number } } } => (o as { userData?: { spatialKey?: string } }).userData?.spatialKey === key && !!(o as { parent?: unknown }).parent)[0]!;
    return body.parent.position;
  }
  const pulse = (keyOf: (n: string) => string) => ({ id: "q-fx", sourceKey: keyOf("c2"), targetKey: keyOf("x1"), type: "queue.handed_off", label: "handoff", occurredAt: T0 + now });

  it("while travelling: glow and core tubes trace the visible trail; sparks sit on the arc behind the head", async () => {
    const { AdditiveBlending, Vector3 } = await import("three");
    const { props, keyOf } = runtimeSetup();
    const { rerender } = render(<SpatialRenderer {...props} />);
    flushFrames();
    rerender(<SpatialRenderer {...props} traffic={[pulse(keyOf)]} />);
    flushFrames(52); // ~0.6 of travel
    const slot = trafficSlot();
    for (const tube of [slot.core, slot.glow]) {
      expect(tube.visible).toBe(true);
      expect(tube.material.blending).toBe(AdditiveBlending);
      const range = tube.geometry.drawRange;
      expect(range.count).toBeGreaterThan(0);
      expect(range.start + range.count).toBeLessThanOrEqual(tube.geometry.index.count);
      expect(range.count).toBeLessThan(tube.geometry.index.count); // only the trail, not the whole arc
    }
    expect(slot.glow.geometry.boundingSphere.radius).toBeGreaterThan(slot.core.geometry.boundingSphere.radius - 1e-6);
    expect(slot.beads.visible).toBe(true);
    expect(slot.beads.count).toBeGreaterThan(1);
    // Each spark is on the arc (a hairline vertex) and earlier along it than the head.
    const pts = slot.line.geometry.getAttribute("position");
    const nearestIndex = (p: { x: number; y: number; z: number }) => {
      let best = 0, bestD = Infinity;
      for (let i = 0; i < pts.count; i++) { const d = Math.hypot(pts.getX(i) - p.x, pts.getY(i) - p.y, pts.getZ(i) - p.z); if (d < bestD) { bestD = d; best = i; } }
      return { best, bestD };
    };
    const head = nearestIndex(slot.head.position);
    expect(head.bestD).toBeLessThan(1e-4);
    const m = new (await import("three")).Matrix4();
    for (let i = 0; i < slot.beads.count; i++) {
      slot.beads.getMatrixAt(i, m);
      const spark = nearestIndex(new Vector3().setFromMatrixPosition(m));
      expect(spark.bestD).toBeLessThan(1e-4);
      expect(spark.best).toBeLessThan(head.best);
    }
  });

  it("arc ends sit outside the sender and receiver figures, and the arrival accent is grounded on the receiver's plinth top", async () => {
    const { props, keyOf } = runtimeSetup();
    const { rerender } = render(<SpatialRenderer {...props} />);
    flushFrames();
    rerender(<SpatialRenderer {...props} traffic={[pulse(keyOf)]} />);
    flushFrames(2);
    const slot = trafficSlot();
    const pts = slot.line.geometry.getAttribute("position");
    const start = { x: pts.getX(0), z: pts.getZ(0) };
    const end = { x: pts.getX(pts.count - 1), z: pts.getZ(pts.count - 1) };
    const src = seatBase(keyOf("c2"));
    const dst = seatBase(keyOf("x1"));
    expect(Math.hypot(start.x - src.x, start.z - src.z)).toBeGreaterThan(0.9);
    expect(Math.hypot(end.x - dst.x, end.z - dst.z)).toBeGreaterThan(0.9);
    // The ends lean toward each other (the light leaves on the facing side).
    expect(Math.hypot(start.x - dst.x, start.z - dst.z)).toBeLessThan(Math.hypot(src.x - dst.x, src.z - dst.z));
    // After travel, the arrival accent glows flat at the receiver's plinth top, not through its body.
    now += 1500;
    flushFrames(1);
    expect(slot.arrival.visible).toBe(true);
    expect(slot.arrival.position.y).toBeCloseTo(dst.y + 0.03, 5);
    expect(slot.arrival.position.x).toBeCloseTo(dst.x, 5);
    expect(slot.arrival.position.z).toBeCloseTo(dst.z, 5);
    expect(slot.head.visible).toBe(false);
    expect(slot.beads.visible).toBe(false);
    // Expiry: every part of the effect is hidden and no frame remains.
    flushFrames(2000);
    for (const part of [slot.line, slot.core, slot.glow, slot.beads, slot.head, slot.arrival]) expect(part.visible).toBe(false);
    expect(rafQueue.size).toBe(0);
  });

  it("reduced motion: a static luminous arc (full tubes), no head and no sparks, painted once", async () => {
    const { props, keyOf } = runtimeSetup();
    const { rerender } = render(<SpatialRenderer {...props} reducedMotion />);
    flushFrames();
    rerender(<SpatialRenderer {...props} reducedMotion traffic={[pulse(keyOf)]} />);
    expect(flushFrames()).toBe(1);
    const slot = trafficSlot();
    for (const tube of [slot.core, slot.glow]) {
      expect(tube.visible).toBe(true);
      expect(tube.geometry.drawRange.start).toBe(0);
      expect(tube.geometry.drawRange.count).toBe(tube.geometry.index.count);
    }
    expect(slot.head.visible).toBe(false);
    expect(slot.beads.visible).toBe(false);
    expect(rafQueue.size).toBe(0);
  });
});

// Top view is the plan: every seat's name shows, anchored to its own seat,
// not just the hovered/selected one; the angled view keeps its quiet labels.
describe("SpatialRenderer top view names every seat", () => {
  function rigGraph(pods: Array<{ ns: string; seats: string[] }>) {
    const nodes: Array<Record<string, unknown>> = [];
    for (const { ns, seats } of pods) {
      nodes.push({ id: `pod-${ns}`, type: "podGroup", data: { podNamespace: ns } });
      seats.forEach((s, i) => nodes.push({ id: `${ns}-${s}`, type: "rigNode", parentId: `pod-${ns}`, data: { logicalId: `${ns}.${s}`, runtime: i % 2 ? "codex" : "claude-code", status: "running" } }));
    }
    return { nodes, edges: [] };
  }
  const gua = () => parseSpatialRig("local", { rigId: "gua", rigName: "gua", graph: rigGraph([{ ns: "gua", seats: ["orchestrator", "architect", "implementer", "reviewer", "designer", "qa-lead"] }]) });
  const headwaters = () => parseSpatialRig("local", { rigId: "hw", rigName: "headwaters", graph: rigGraph([
    { ns: "lead", seats: ["orchestrator", "advisor"] },
    { ns: "build", seats: ["frontend", "backend", "infra"] },
    { ns: "review", seats: ["reviewer", "qa"] },
    { ns: "ops", seats: ["watchdog", "release", "docs"] },
  ]) });
  const viewport = (w: number, h: number) => {
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => w });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => h });
  };
  function renderTop(rigs: ReturnType<typeof gua>[], density: "full" | "compact") {
    const model = buildSpatialModel("local", rigs);
    const base = setup();
    render(<SpatialRenderer {...base.props} model={model} layout={layoutSpatialModel(model)} density={density} />);
    flushFrames();
    act(() => base.controllerRef.current!.preset("top"));
    flushFrames();
    return model;
  }

  for (const [name, w, h, density] of [["desktop", 1006, 900, "full"], ["tablet", 768, 700, "full"], ["phone", 390, 560, "compact"]] as const) {
    it(`shows all six GUA seat names in top view (${name})`, () => {
      viewport(w, h);
      renderTop([gua()], density);
      const shown = agentLabels().filter(isShown);
      expect(shown).toHaveLength(6);
      // Plan names are one line; status stays in the card / on selection.
      for (const label of shown) expect(metaOf(label)?.hidden).toBe(true);
    });
  }

  it("shows every seat name in top view of a multi-rig scene (no ambient budget)", () => {
    viewport(1006, 900);
    const model = renderTop([gua(), headwaters()], "full");
    const layer = document.querySelector<HTMLElement>(".spatial-label-layer")!;
    expect(agentLabels().filter(isShown)).toHaveLength(model.agentsByKey.size);
    // Names clip to the projected seat pitch instead of disappearing.
    expect(parseFloat(layer.style.getPropertyValue("--spatial-plan-name-max"))).toBeGreaterThanOrEqual(48);
  });

  it("returning to the angled view restores its quiet full-density labels", () => {
    viewport(1006, 900);
    const model = buildSpatialModel("local", [gua(), headwaters()]);
    const base = setup();
    render(<SpatialRenderer {...base.props} model={model} layout={layoutSpatialModel(model)} density="full" />);
    flushFrames();
    const isoShown = agentLabels().filter(isShown).length;
    act(() => base.controllerRef.current!.preset("top"));
    flushFrames();
    act(() => base.controllerRef.current!.preset("iso"));
    flushFrames();
    const layer = document.querySelector<HTMLElement>(".spatial-label-layer")!;
    expect(layer.style.getPropertyValue("--spatial-plan-name-max")).toBe("");
    expect(agentLabels().some((el) => el.classList.contains("is-compact"))).toBe(false);
    expect(agentLabels().filter(isShown).length).toBe(isoShown);
    for (const label of agentLabels().filter(isShown)) expect(metaOf(label)?.hidden).toBe(false);
  });
});

// Astra's host-density case: 25 seats over five rigs, fitted in Top on a
// phone stage with the compact HUD and Key toggle measured as occluders.
// Every name must show, none may overlap another name or a control, and a
// name with no room by its seat keeps a leader back to it.
describe("SpatialRenderer top view names a 25-seat fleet on a phone stage", () => {
  const NAMES = ["orchestrator", "architect", "implementer", "reviewer", "designer", "qa-lead"];
  function fleet() {
    let n = 0;
    return ([[3], [4], [2], [6], [2, 3, 2, 3]] as const).map((pods, r) => {
      const nodes: Array<Record<string, unknown>> = [];
      pods.forEach((count, p) => {
        nodes.push({ id: `pod-p${p}`, type: "podGroup", data: { podNamespace: `p${p}` } });
        for (let i = 0; i < count; i++, n++) {
          nodes.push({ id: `s${n}`, type: "rigNode", parentId: `pod-p${p}`, data: { logicalId: `p${p}.${NAMES[n % NAMES.length]}`, runtime: n % 2 ? "codex" : "claude-code", status: "running" } });
        }
      });
      return parseSpatialRig("local", { rigId: `r${r}`, rigName: `rig-${r}`, graph: { nodes, edges: [] } });
    });
  }
  type Box = { left: number; top: number; right: number; bottom: number };
  const overlap = (a: Box, b: Box) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

  async function renderFleetTop(w: number, h: number, selected = false) {
    const { estimateLabelSize } = await import("../src/components/topology/spatial/spatial-view-math.js");
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => w });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => h });
    // SpatialTopologyView controls. Compact (< 600px): Fit + More top-right,
    // Key bottom-left. Full: the five-button HUD column and the legend.
    const density = w < 600 ? "compact" : "full";
    const controls: Box[] = density === "compact"
      ? [{ left: w - 8 - 88, top: 8, right: w - 8, bottom: 52 }, { left: 8, top: h - 8 - 44, right: 68, bottom: h - 8 }]
      : [{ left: w - 12 - 34, top: 12, right: w - 12, bottom: 12 + 5 * 32 }, { left: 12, top: h - 12 - 70, right: 12 + 180, bottom: h - 12 }];
    const original = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const i = this.dataset.occluderIndex;
      if (i === undefined) return original.call(this);
      const c = controls[Number(i)]!;
      return { left: c.left, top: c.top, right: c.right, bottom: c.bottom, width: c.right - c.left, height: c.bottom - c.top, x: c.left, y: c.top, toJSON() {} } as DOMRect;
    });
    const model = buildSpatialModel("local", fleet());
    const base = setup();
    const selectedKey = selected ? [...model.agentsByKey.keys()][12]! : null;
    render(
      <div className="spatial-stage">
        {controls.map((_, i) => <div key={i} data-spatial-occluder="" data-occluder-index={i} />)}
        <SpatialRenderer {...base.props} model={model} layout={layoutSpatialModel(model)} density={density} selectedKey={selectedKey} />
      </div>,
    );
    flushFrames();
    act(() => base.controllerRef.current!.preset("top"));
    flushFrames();
    const layer = document.querySelector<HTMLElement>(".spatial-label-layer")!;
    const cap = parseFloat(layer.style.getPropertyValue("--spatial-plan-name-max"));
    // Painted box from the CSS2D transform, the applied shift and the size
    // estimate the placement used (compact one-line name, pitch-clipped).
    const boxOf = (el: HTMLElement): Box => {
      const m = /translate\((-?[\d.]+)%, (-?[\d.]+)%\) translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(el.style.transform)!;
      const forced = el.classList.contains("is-selected");
      const text = el.querySelector(".spatial-label__text")!.textContent!;
      const meta = forced ? el.querySelector(".spatial-label__meta")!.textContent : null;
      const size = estimateLabelSize("agent", text, meta, "compact");
      const bw = forced ? size.w : Math.min(size.w, cap);
      const left = Number(m[3]) + (Number(m[1]) / 100) * bw + (parseFloat(el.style.marginLeft) || 0);
      const top = Number(m[4]) + (Number(m[2]) / 100) * size.h + (parseFloat(el.style.marginTop) || 0);
      return { left, top, right: left + bw, bottom: top + size.h };
    };
    return { model, controls, boxOf, selectedKey };
  }

  for (const [w, h] of [[430, 932], [430, 640], [390, 560], [1006, 900], [1006, 1224]] as const) {
    it(`shows all 25 names at ${w}×${h} without overlapping names or controls`, async () => {
      const { controls, boxOf } = await renderFleetTop(w, h);
      const shown = agentLabels().filter(isShown);
      expect(shown).toHaveLength(25);
      const boxes = shown.map(boxOf);
      boxes.forEach((b, i) => {
        expect(b.left).toBeGreaterThanOrEqual(0);
        expect(b.top).toBeGreaterThanOrEqual(0);
        expect(b.right).toBeLessThanOrEqual(w);
        expect(b.bottom).toBeLessThanOrEqual(h);
        for (const c of controls) expect(overlap(b, c)).toBe(false);
        for (let j = i + 1; j < boxes.length; j++) expect(overlap(b, boxes[j]!)).toBe(false);
      });
      // Names moved for room keep a leader; nudges within reach do not need one.
      for (const el of shown.filter((e) => e.classList.contains("has-leader"))) {
        expect(parseFloat(el.style.getPropertyValue("--leader-len"))).toBeGreaterThan(0);
      }
    });
  }

  it("keeps the selected seat's name and status line by its seat among the relocated names", async () => {
    const { boxOf } = await renderFleetTop(430, 932, true);
    const shown = agentLabels().filter(isShown);
    expect(shown).toHaveLength(25);
    const selected = shown.find((el) => el.classList.contains("is-selected"))!;
    expect(metaOf(selected)?.hidden).toBe(false);
    expect(selected.classList.contains("has-leader")).toBe(false);
    const box = boxOf(selected);
    for (const other of shown.filter((el) => el !== selected)) expect(overlap(box, boxOf(other))).toBe(false);
  });
});
