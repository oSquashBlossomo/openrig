// Spatial topology renderer — the ONLY three.js consumer. Lazy-loaded by
// SpatialTopologyView so three never enters the initial bundle.
//
// Rendering discipline:
//   - Render on demand: input, data, selection, palette and resize schedule a
//     single animation frame. There is no perpetual requestAnimationFrame loop
//     and no auto-rotation.
//   - Damping and camera tweens run on a BOUNDED frame budget, and are skipped
//     entirely when the operator prefers reduced motion.
//   - DPR is capped at 2; no shadows; small shared geometries.
//   - Everything allocated here (geometries, materials, label elements,
//     controls, observers, listeners, the pending frame and the GL context) is
//     released on unmount — including StrictMode's mount/unmount/mount.
//   - Constructor failure (no WebGL) and webglcontextlost both report a
//     failure so the view falls back to the seat index instead of going blank.
//     A failure part-way through initialization releases everything already
//     allocated (GL context included) through the same teardown as unmount.
//   - Theme tokens are CSS (sRGB) HSL; colors are built with SRGBColorSpace so
//     three converts them into its linear working space instead of treating
//     them as linear (which lifts a near-black stage into a grey panel).
//   - Labels are placed by a bounded screen-space collision pass each frame:
//     selected/hovered labels always show, then problem seats, search hits,
//     rig names, pod names and ambient seat names, each only where it fits.
//   - Auto-framing follows streaming data until the operator commands the
//     camera (drag, orbit, zoom, preset, fit, focus); Reset hands it back.

import { useEffect, useRef, type MutableRefObject } from "react";
import {
  AmbientLight,
  BoxGeometry,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DirectionalLight,
  EdgesGeometry,
  Float32BufferAttribute,
  Fog,
  GridHelper,
  Group,
  HemisphereLight,
  Line,
  LineBasicMaterial,
  LineDashedMaterial,
  LineSegments,
  Material,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  OctahedronGeometry,
  PerspectiveCamera,
  QuadraticBezierCurve3,
  Raycaster,
  Scene,
  SRGBColorSpace,
  TorusGeometry,
  Vector2,
  Vector3,
  WebGLRenderer,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { CSS2DObject, CSS2DRenderer } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import {
  SPATIAL_CAMERA_DIRECTIONS,
  SPATIAL_LAYOUT,
  deriveSeatStatus,
  fitDistance,
  type SpatialCameraPreset,
  type SpatialLayout,
  type SpatialModel,
  type SpatialTone,
  type Vec3,
} from "../../../lib/spatial-topology.js";
import { hslCss, type Hsl, type SpatialPalette } from "./spatial-palette.js";
import {
  LABEL_TIER,
  estimateLabelSize,
  frameBox,
  layoutLabels,
  type LabelAnchor,
  type LabelCandidate,
  type LabelKind,
  type Rect,
} from "./spatial-view-math.js";

export type SpatialRendererFailure = "unsupported" | "context-lost" | "init-error";

export interface SpatialCameraController {
  fit(): void;
  reset(): void;
  preset(preset: SpatialCameraPreset): void;
  zoom(factor: number): void;
  orbit(dAzimuth: number, dPolar: number): void;
  focus(key: string): void;
}

export interface SpatialRendererProps {
  model: SpatialModel;
  layout: SpatialLayout;
  palette: SpatialPalette;
  selectedKey: string | null;
  hoveredKey: string | null;
  /** null = no active search; otherwise the matching agent keys. */
  matchKeys: ReadonlySet<string> | null;
  reducedMotion: boolean;
  controllerRef: MutableRefObject<SpatialCameraController | null>;
  onSelect: (key: string | null) => void;
  onHover: (key: string | null) => void;
  onFailure: (reason: SpatialRendererFailure) => void;
  onReady?: () => void;
}

const FOV = 38;
const MAX_DPR = 2;
const DAMPING_FRAME_BUDGET = 72;
const TWEEN_MS = 460;
const CLICK_SLOP_PX = 6;
/** Ambient (non-priority) seat labels need this much projected seat spacing. */
const AMBIENT_LABEL_SPACING_PX = 44;
const MAX_AMBIENT_LABELS = 80;

interface AgentVisual {
  key: string;
  group: Group;
  body: Mesh;
  bodyMaterial: MeshStandardMaterial;
  ring: Mesh;
  ringMaterial: MeshBasicMaterial;
  beacon: Group | null;
  beaconMaterials: Material[];
  label: CSS2DObject;
  tone: SpatialTone;
  stale: boolean;
}

interface LabelEntry {
  object: CSS2DObject;
  kind: LabelKind;
  /** Agent key for seat labels; rig/pod key otherwise. */
  key: string;
  w: number;
  h: number;
  /** Seat has a problem or needs-input/blocked state. */
  priority: boolean;
  /** Candidate anchors in the label's parent space; [0] is preferred. */
  anchors: Array<{ local: Vector3; cx: number; cy: number }>;
  /** Anchor currently applied to the object. */
  anchorIndex: number;
  /** Last applied horizontal clamp offset, px. */
  offset: number;
}

interface EdgeVisual {
  key: string;
  sourceKey: string;
  targetKey: string;
  line: Line;
  material: LineBasicMaterial | LineDashedMaterial;
  arrow: Mesh;
  arrowMaterial: MeshBasicMaterial;
}

interface Engine {
  renderer: WebGLRenderer;
  labels: CSS2DRenderer;
  scene: Scene;
  camera: PerspectiveCamera;
  controls: OrbitControls;
  shared: {
    puck: CylinderGeometry;
    infra: BoxGeometry;
    ring: TorusGeometry;
    selection: TorusGeometry;
    arrow: ConeGeometry;
    beaconHead: OctahedronGeometry;
  };
  content: Group;
  contentDisposables: Array<{ dispose(): void }>;
  grid: GridHelper | null;
  selectionMarker: Mesh;
  selectionMaterial: MeshBasicMaterial;
  agents: Map<string, AgentVisual>;
  agentPositions: Map<string, Vector3>;
  edges: EdgeVisual[];
  labelEntries: LabelEntry[];
  occluders: Rect[];
  viewport: { w: number; h: number };
  pickables: Mesh[];
  boundsCenter: Vector3;
  boundsRadius: number;
  boundsMin: Vec3;
  boundsMax: Vec3;
  requestRender: () => void;
  tweenTo: (position: Vector3, target: Vector3) => void;
  /** Instant iso fit used while data streams in (before the operator moves). */
  fitInitial: () => void;
  measureOccluders: () => void;
  userMoved: boolean;
  fittedOnce: boolean;
  state: {
    selectedKey: string | null;
    hoveredKey: string | null;
    matchKeys: ReadonlySet<string> | null;
    palette: SpatialPalette;
  };
}

/** Theme tokens are CSS sRGB HSL; convert into three's linear working space. */
export function toColor(c: Hsl): Color {
  return new Color().setHSL(c.h / 360, c.s / 100, c.l / 100, SRGBColorSpace);
}

function v3(p: Vec3): Vector3 {
  return new Vector3(p[0], p[1], p[2]);
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export default function SpatialRenderer(props: SpatialRendererProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<Engine | null>(null);
  // Latest props for event handlers without re-binding listeners.
  const propsRef = useRef(props);
  propsRef.current = props;

  // --- Mount: renderer, scene, camera, controls, listeners -----------------
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let renderer: WebGLRenderer | null = null;
    let labels: CSS2DRenderer | null = null;
    let controls: OrbitControls | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let shared: Engine["shared"] | null = null;
    let selectionMaterial: MeshBasicMaterial | null = null;
    let frame = 0;
    let disposed = false;
    let dampingFrames = 0;
    let tween: { from: Vector3; to: Vector3; fromTarget: Vector3; toTarget: Vector3; start: number } | null = null;
    const cleanups: Array<() => void> = [];

    // One teardown for unmount AND a failure part-way through init, so every
    // allocation that exists at that point is released exactly once.
    const teardown = () => {
      disposed = true;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      for (const fn of cleanups.splice(0)) fn();
      resizeObserver?.disconnect();
      resizeObserver = null;
      const engine = engineRef.current;
      if (engine) {
        clearContent(engine);
        disposeGrid(engine);
      }
      if (shared) for (const g of Object.values(shared)) g.dispose();
      shared = null;
      selectionMaterial?.dispose();
      selectionMaterial = null;
      controls?.dispose();
      controls = null;
      labels?.domElement.remove();
      labels = null;
      if (renderer) {
        renderer.dispose();
        // The contextlost listener is already removed, so this cannot report
        // a false failure; it releases the GL context immediately instead of
        // waiting for GC (browsers cap live contexts).
        renderer.forceContextLoss();
        renderer.domElement.remove();
        renderer = null;
      }
      engineRef.current = null;
      if (propsRef.current.controllerRef.current) propsRef.current.controllerRef.current = null;
    };

    try {
      renderer = new WebGLRenderer({ antialias: true, alpha: false, powerPreference: "default" });
    } catch {
      propsRef.current.onFailure("unsupported");
      return;
    }

    try {
      const palette = propsRef.current.palette;
      const gl = renderer;
      gl.setPixelRatio(Math.min(typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1, MAX_DPR));
      gl.shadowMap.enabled = false;
      const canvas = gl.domElement;
      canvas.setAttribute("data-testid", "spatial-canvas");
      canvas.setAttribute("aria-hidden", "true");
      canvas.style.display = "block";
      canvas.style.touchAction = "none";
      host.appendChild(canvas);

      const labelRenderer = new CSS2DRenderer();
      labels = labelRenderer;
      labelRenderer.domElement.className = "spatial-label-layer";
      labelRenderer.domElement.setAttribute("aria-hidden", "true");
      host.appendChild(labelRenderer.domElement);

      const scene = new Scene();
      scene.background = toColor(palette.background);
      const camera = new PerspectiveCamera(FOV, 1, 0.5, 5000);
      camera.position.set(60, 70, 80);

      const orbit = new OrbitControls(camera, canvas);
      controls = orbit;
      orbit.enableDamping = !propsRef.current.reducedMotion;
      orbit.dampingFactor = 0.12;
      orbit.screenSpacePanning = false;
      orbit.maxPolarAngle = Math.PI / 2 - 0.06;
      orbit.minDistance = 6;
      orbit.maxDistance = 1200;
      orbit.zoomToCursor = true;

      const hemi = new HemisphereLight(0xffffff, toColor(palette.ground), 1.35);
      const ambient = new AmbientLight(0xffffff, 0.35);
      const sun = new DirectionalLight(0xffffff, 1.25);
      sun.position.set(40, 90, 55);
      scene.add(hemi, ambient, sun);

      const geometries = {
        puck: new CylinderGeometry(0.95, 1.08, 0.7, 36),
        infra: new BoxGeometry(1.7, 0.7, 1.7),
        ring: new TorusGeometry(1.5, 0.1, 8, 56),
        selection: new TorusGeometry(2.05, 0.07, 6, 64),
        arrow: new ConeGeometry(0.34, 0.95, 14),
        beaconHead: new OctahedronGeometry(0.42, 0),
      };
      shared = geometries;
      const selectionMat = new MeshBasicMaterial({ color: toColor(palette.selection), transparent: true, opacity: 0.95 });
      selectionMaterial = selectionMat;
      const selectionMarker = new Mesh(geometries.selection, selectionMat);
      selectionMarker.rotation.x = Math.PI / 2;
      selectionMarker.visible = false;
      scene.add(selectionMarker);

      const content = new Group();
      scene.add(content);

      const renderNow = () => {
        if (disposed) return;
        gl.render(scene, camera);
        const engine = engineRef.current;
        if (engine) placeLabels(engine);
        labelRenderer.render(scene, camera);
      };

      const tick = (now: number) => {
        frame = 0;
        if (disposed) return;
        let again = false;
        if (tween) {
          const t = Math.min(1, (now - tween.start) / TWEEN_MS);
          const k = easeInOutCubic(t);
          camera.position.lerpVectors(tween.from, tween.to, k);
          orbit.target.lerpVectors(tween.fromTarget, tween.toTarget, k);
          camera.lookAt(orbit.target);
          if (t >= 1) tween = null;
          else again = true;
        } else if (orbit.enableDamping && dampingFrames > 0) {
          dampingFrames--;
          // update() emits "change" while still settling, which re-requests a
          // frame; the budget guarantees this terminates.
          orbit.update();
        }
        renderNow();
        if (again) requestRender();
      };

      const requestRender = () => {
        if (disposed || frame) return;
        frame = requestAnimationFrame(tick);
      };

      const tweenTo = (position: Vector3, target: Vector3) => {
        dampingFrames = 0;
        if (propsRef.current.reducedMotion) {
          tween = null;
          camera.position.copy(position);
          orbit.target.copy(target);
          camera.lookAt(target);
          orbit.update();
          requestRender();
          return;
        }
        tween = {
          from: camera.position.clone(),
          to: position.clone(),
          fromTarget: orbit.target.clone(),
          toTarget: target.clone(),
          start: performance.now(),
        };
        requestRender();
      };

      const engine: Engine = {
        renderer: gl,
        labels: labelRenderer,
        scene,
        camera,
        controls: orbit,
        shared: geometries,
        content,
        contentDisposables: [],
        grid: null,
        selectionMarker,
        selectionMaterial: selectionMat,
        agents: new Map(),
        agentPositions: new Map(),
        edges: [],
        labelEntries: [],
        occluders: [],
        viewport: { w: 0, h: 0 },
        pickables: [],
        boundsCenter: new Vector3(),
        boundsRadius: 20,
        boundsMin: [-10, -1, -10],
        boundsMax: [10, 4, 10],
        requestRender,
        tweenTo,
        fitInitial: () => {},
        measureOccluders: () => {},
        userMoved: false,
        fittedOnce: false,
        state: {
          selectedKey: propsRef.current.selectedKey,
          hoveredKey: propsRef.current.hoveredKey,
          matchKeys: propsRef.current.matchKeys,
          palette,
        },
      };
      engineRef.current = engine;

      const onControlsChange = () => requestRender();
      const onControlsStart = () => {
        engine.userMoved = true;
        tween = null;
        dampingFrames = 0;
      };
      const onControlsEnd = () => {
        if (orbit.enableDamping) {
          dampingFrames = DAMPING_FRAME_BUDGET;
          requestRender();
        }
      };
      orbit.addEventListener("change", onControlsChange);
      orbit.addEventListener("start", onControlsStart);
      orbit.addEventListener("end", onControlsEnd);
      cleanups.push(() => {
        orbit.removeEventListener("change", onControlsChange);
        orbit.removeEventListener("start", onControlsStart);
        orbit.removeEventListener("end", onControlsEnd);
      });

      // Picking: click (not drag) selects; hover is coalesced to one raycast per frame.
      const raycaster = new Raycaster();
      const ndc = new Vector2();
      const pick = (clientX: number, clientY: number): string | null => {
        const rect = canvas.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return null;
        ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
        raycaster.setFromCamera(ndc, camera);
        const hit = raycaster.intersectObjects(engine.pickables, false)[0];
        const key = hit?.object.userData.spatialKey;
        return typeof key === "string" ? key : null;
      };
      let downAt: { x: number; y: number } | null = null;
      let hoverFrame = 0;
      let lastHoverEvent: PointerEvent | null = null;
      let lastHoverKey: string | null = null;
      const cancelHoverPick = () => {
        if (hoverFrame) cancelAnimationFrame(hoverFrame);
        hoverFrame = 0;
        lastHoverEvent = null;
      };
      const onPointerDown = (e: PointerEvent) => {
        downAt = { x: e.clientX, y: e.clientY };
      };
      const onPointerUp = (e: PointerEvent) => {
        if (!downAt || e.button !== 0) return;
        const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
        downAt = null;
        if (moved > CLICK_SLOP_PX) return;
        propsRef.current.onSelect(pick(e.clientX, e.clientY));
      };
      const onDoubleClick = (e: MouseEvent) => {
        const key = pick(e.clientX, e.clientY);
        if (key) controller.focus(key);
      };
      const onPointerMove = (e: PointerEvent) => {
        if (e.buttons !== 0) return;
        lastHoverEvent = e;
        if (hoverFrame) return;
        hoverFrame = requestAnimationFrame(() => {
          hoverFrame = 0;
          const event = lastHoverEvent;
          lastHoverEvent = null;
          if (disposed || !event) return;
          const key = pick(event.clientX, event.clientY);
          canvas.style.cursor = key ? "pointer" : "grab";
          if (key !== lastHoverKey) {
            lastHoverKey = key;
            propsRef.current.onHover(key);
          }
        });
      };
      const onPointerLeave = () => {
        // A pick queued before the pointer left must not resurrect a hover.
        cancelHoverPick();
        downAt = null;
        if (lastHoverKey !== null) {
          lastHoverKey = null;
          propsRef.current.onHover(null);
        }
      };
      canvas.addEventListener("pointerdown", onPointerDown);
      canvas.addEventListener("pointerup", onPointerUp);
      canvas.addEventListener("pointermove", onPointerMove);
      canvas.addEventListener("pointerleave", onPointerLeave);
      canvas.addEventListener("dblclick", onDoubleClick);
      cleanups.push(() => {
        canvas.removeEventListener("pointerdown", onPointerDown);
        canvas.removeEventListener("pointerup", onPointerUp);
        canvas.removeEventListener("pointermove", onPointerMove);
        canvas.removeEventListener("pointerleave", onPointerLeave);
        canvas.removeEventListener("dblclick", onDoubleClick);
        cancelHoverPick();
      });

      const onContextLost = (e: Event) => {
        e.preventDefault();
        propsRef.current.onFailure("context-lost");
      };
      canvas.addEventListener("webglcontextlost", onContextLost);
      cleanups.push(() => canvas.removeEventListener("webglcontextlost", onContextLost));

      const cameraDistance = () => camera.position.distanceTo(orbit.target);
      const viewDirection = () => camera.position.clone().sub(orbit.target).normalize();
      const fitAlong = (direction: Vector3, animate: boolean) => {
        const { w, h } = engine.viewport;
        const framing = frameBox(engine.boundsMin, engine.boundsMax, [direction.x, direction.y, direction.z], {
          width: w || 800,
          height: h || 500,
          fovDeg: camera.fov,
          // Room for seat labels above pucks, rig names and the camera HUD.
          insetX: Math.min(52, Math.max(16, (w || 800) * 0.05)),
          insetY: Math.min(44, Math.max(20, (h || 500) * 0.06)),
        }, orbit.minDistance);
        orbit.maxDistance = Math.max(120, framing.distance * 2.6);
        const target = v3(framing.target);
        const position = target.clone().add(direction.clone().normalize().multiplyScalar(framing.distance));
        if (animate) tweenTo(position, target);
        else {
          // An instant fit supersedes any in-flight tween (a Reset still
          // animating when bounds or viewport change); otherwise the next
          // frame would replay the stale framing over the new one.
          tween = null;
          dampingFrames = 0;
          camera.position.copy(position);
          orbit.target.copy(target);
          camera.lookAt(target);
          orbit.update();
          requestRender();
        }
      };

      // Every explicit command takes the camera from auto-framing, so a data
      // refresh never undoes the operator's chosen view. Reset hands it back.
      const controller: SpatialCameraController = {
        fit: () => {
          engine.userMoved = true;
          fitAlong(viewDirection(), true);
        },
        reset: () => {
          engine.userMoved = false;
          fitAlong(v3(SPATIAL_CAMERA_DIRECTIONS.iso), true);
        },
        preset: (preset) => {
          engine.userMoved = true;
          fitAlong(v3(SPATIAL_CAMERA_DIRECTIONS[preset]), true);
        },
        zoom: (factor) => {
          engine.userMoved = true;
          const target = orbit.target.clone();
          const dir = viewDirection();
          const dist = Math.min(orbit.maxDistance, Math.max(orbit.minDistance, cameraDistance() * factor));
          tweenTo(target.clone().add(dir.multiplyScalar(dist)), target);
        },
        orbit: (dAzimuth, dPolar) => {
          const offset = camera.position.clone().sub(orbit.target);
          const radius = offset.length();
          let theta = Math.atan2(offset.x, offset.z) + dAzimuth;
          let phi = Math.acos(Math.min(1, Math.max(-1, offset.y / radius))) + dPolar;
          phi = Math.min(orbit.maxPolarAngle, Math.max(0.02, phi));
          if (!Number.isFinite(theta)) theta = 0;
          const next = new Vector3(
            radius * Math.sin(phi) * Math.sin(theta),
            radius * Math.cos(phi),
            radius * Math.sin(phi) * Math.cos(theta),
          ).add(orbit.target);
          engine.userMoved = true;
          tweenTo(next, orbit.target.clone());
        },
        focus: (key) => {
          const point = engine.agentPositions.get(key);
          if (!point) return;
          engine.userMoved = true;
          // Close enough that the seat and its neighbours are legible.
          const dist = Math.min(cameraDistance(), 34);
          tweenTo(point.clone().add(viewDirection().multiplyScalar(dist)), point.clone());
        },
      };
      propsRef.current.controllerRef.current = controller;
      engine.fitInitial = () => fitAlong(v3(SPATIAL_CAMERA_DIRECTIONS.iso), false);

      // Stage overlays (camera HUD, legend) mark themselves as occluders so
      // labels never hide underneath them. Measured on resize / rebuild only.
      engine.measureOccluders = () => {
        const stage = host.closest(".spatial-stage") ?? host.parentElement;
        const base = host.getBoundingClientRect();
        const rects: Rect[] = [];
        stage?.querySelectorAll<HTMLElement>("[data-spatial-occluder]").forEach((el) => {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) {
            rects.push({ left: r.left - base.left, top: r.top - base.top, right: r.right - base.left, bottom: r.bottom - base.top });
          }
        });
        engine.occluders = rects;
      };

      const resize = () => {
        if (disposed) return;
        const w = Math.max(0, Math.floor(host.clientWidth));
        const h = Math.max(0, Math.floor(host.clientHeight));
        if (w === engine.viewport.w && h === engine.viewport.h) return;
        engine.viewport = { w, h };
        if (w === 0 || h === 0) return;
        gl.setSize(w, h);
        labelRenderer.setSize(w, h);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        engine.measureOccluders();
        engine.fittedOnce = true;
        // Re-frame on resize until the operator takes the camera.
        if (!engine.userMoved) engine.fitInitial();
        requestRender();
      };
      if (typeof ResizeObserver !== "undefined") {
        resizeObserver = new ResizeObserver(resize);
        resizeObserver.observe(host);
      }
      resize();
      propsRef.current.onReady?.();
    } catch {
      // Partial init: release whatever exists through the normal teardown,
      // then fall back to the seat index.
      teardown();
      propsRef.current.onFailure("init-error");
      return;
    }

    return teardown;
  }, []);

  // --- Content: rebuild on model/layout change -----------------------------
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    buildContent(engine, props.model, props.layout, props.palette);
    applyInteractionState(engine);
    engine.measureOccluders();
    // Keep framing the topology while data streams in, until the operator
    // takes the camera.
    if (!engine.userMoved && engine.fittedOnce) engine.fitInitial();
    engine.requestRender();
  }, [props.model, props.layout]);

  // --- Palette (theme) ------------------------------------------------------
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine || engine.state.palette === props.palette) return;
    engine.state.palette = props.palette;
    buildContent(engine, props.model, props.layout, props.palette);
    applyInteractionState(engine);
    engine.requestRender();
    // model/layout handled by the content effect
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.palette]);

  // --- Selection / hover / search ------------------------------------------
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.state.selectedKey = props.selectedKey;
    engine.state.hoveredKey = props.hoveredKey;
    engine.state.matchKeys = props.matchKeys;
    applyInteractionState(engine);
    engine.requestRender();
  }, [props.selectedKey, props.hoveredKey, props.matchKeys]);

  // --- Reduced motion toggles damping live ----------------------------------
  useEffect(() => {
    const engine = engineRef.current;
    if (engine) engine.controls.enableDamping = !props.reducedMotion;
  }, [props.reducedMotion]);

  return <div ref={hostRef} data-testid="spatial-renderer-host" className="spatial-renderer-host" />;
}

// ---------------------------------------------------------------------------
// Scene construction
// ---------------------------------------------------------------------------

function track<T extends { dispose(): void }>(engine: Engine, item: T): T {
  engine.contentDisposables.push(item);
  return item;
}

function clearContent(engine: Engine) {
  for (const child of [...engine.content.children]) {
    child.traverse((obj) => {
      if (obj instanceof CSS2DObject) obj.element.remove();
    });
    engine.content.remove(child);
  }
  for (const item of engine.contentDisposables) item.dispose();
  engine.contentDisposables = [];
  engine.agents.clear();
  engine.agentPositions.clear();
  engine.edges = [];
  engine.labelEntries = [];
  engine.pickables = [];
}

function disposeGrid(engine: Engine) {
  if (!engine.grid) return;
  engine.scene.remove(engine.grid);
  engine.grid.geometry.dispose();
  const mat = engine.grid.material;
  if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
  else mat.dispose();
  engine.grid = null;
}

type AnchorSpec = { at: Vec3; cx: number; cy: number };

/** Registers a label with its preferred anchor and fallbacks, applies the
 *  preferred one, and adds it to `parent`. */
function registerLabel(
  engine: Engine,
  parent: Group,
  object: CSS2DObject,
  kind: LabelKind,
  key: string,
  text: string,
  meta: string | null,
  anchors: AnchorSpec[],
  priority = false,
) {
  const { w, h } = estimateLabelSize(kind, text, meta);
  object.element.dataset.spatialLabel = kind;
  const resolved = anchors.map((a) => ({ local: v3(a.at), cx: a.cx, cy: a.cy }));
  object.position.copy(resolved[0]!.local);
  object.center.set(resolved[0]!.cx, resolved[0]!.cy);
  parent.add(object);
  engine.labelEntries.push({ object, kind, key, w, h, priority, anchors: resolved, anchorIndex: 0, offset: 0 });
}

function makeLabel(className: string, text: string, sub?: string): CSS2DObject {
  const el = document.createElement("div");
  el.className = className;
  const main = document.createElement("span");
  main.className = "spatial-label__text";
  main.textContent = text;
  el.appendChild(main);
  if (sub) {
    const meta = document.createElement("span");
    meta.className = "spatial-label__meta";
    meta.textContent = sub;
    el.appendChild(meta);
  }
  return new CSS2DObject(el);
}

function buildContent(engine: Engine, model: SpatialModel, layout: SpatialLayout, palette: SpatialPalette) {
  clearContent(engine);
  const L = SPATIAL_LAYOUT;
  const { content, shared } = engine;

  engine.scene.background = toColor(palette.background);
  engine.selectionMaterial.color = toColor(palette.selection);

  // Ground survey grid sized to the layout.
  disposeGrid(engine);
  const span = Math.max(120, Math.ceil((layout.bounds.radius * 4.5) / 10) * 10);
  const grid = new GridHelper(span, Math.max(12, Math.round(span / 5)), toColor(palette.grid), toColor(palette.grid));
  const gridMat = grid.material as Material;
  gridMat.transparent = true;
  gridMat.opacity = palette.theme === "dark" ? 0.5 : 0.55;
  gridMat.depthWrite = false;
  grid.position.set(layout.bounds.center[0], -L.deckThickness - 0.02, layout.bounds.center[2]);
  engine.scene.add(grid);
  engine.grid = grid;

  engine.boundsCenter.set(...layout.bounds.center);
  engine.boundsRadius = layout.bounds.radius;
  engine.boundsMin = layout.bounds.min;
  engine.boundsMax = layout.bounds.max;
  const fitDist = fitDistance(layout.bounds.radius, FOV, 1.6);
  engine.scene.fog = new Fog(toColor(palette.background), fitDist * 1.15, fitDist * 3.6);

  const deckMat = track(engine, new MeshStandardMaterial({ color: toColor(palette.deck), roughness: 0.95, metalness: 0 }));
  const deckEdgeMat = track(engine, new LineBasicMaterial({ color: toColor(palette.deckEdge), transparent: true, opacity: 0.85 }));
  const platformMat = track(engine, new MeshStandardMaterial({ color: toColor(palette.platform), roughness: 0.9, metalness: 0, transparent: true, opacity: 0.94 }));
  const platformEdgeMat = track(engine, new LineBasicMaterial({ color: toColor(palette.platformEdge) }));
  const plumbMat = track(engine, new LineDashedMaterial({ color: toColor(palette.platformEdge), dashSize: 0.35, gapSize: 0.35, transparent: true, opacity: 0.7 }));

  const rigByKey = new Map(model.rigs.map((r) => [r.key, r]));
  for (const rect of layout.rigs) {
    const rig = rigByKey.get(rect.key);
    const deckGeo = track(engine, new BoxGeometry(rect.w, L.deckThickness, rect.d));
    const deck = new Mesh(deckGeo, deckMat);
    deck.position.set(rect.x + rect.w / 2, -L.deckThickness / 2, rect.z + rect.d / 2);
    const edgeGeo = track(engine, new EdgesGeometry(deckGeo));
    const outline = new LineSegments(edgeGeo, deckEdgeMat);
    outline.position.copy(deck.position);
    content.add(deck, outline);

    // Survey tick marks along the header band: a quiet instrument detail
    // that also reads the rig's front edge at oblique angles.
    const tickPositions: number[] = [];
    const tickCount = Math.max(2, Math.floor(rect.w / 3));
    for (let i = 0; i <= tickCount; i++) {
      const x = rect.x + (rect.w * i) / tickCount;
      const len = i % 5 === 0 ? 0.9 : 0.45;
      tickPositions.push(x, 0.01, rect.z, x, 0.01, rect.z + len);
    }
    const tickGeo = track(engine, new BufferGeometry());
    tickGeo.setAttribute("position", new Float32BufferAttribute(tickPositions, 3));
    content.add(new LineSegments(tickGeo, deckEdgeMat));

    if (rig) {
      const seatCount = rig.agents.length;
      const podCount = rig.pods.length;
      const parts = [`${podCount} pod${podCount === 1 ? "" : "s"}`, `${seatCount} seat${seatCount === 1 ? "" : "s"}`];
      if (rig.summaryNodeCount !== null && rig.summaryNodeCount !== seatCount) parts.push(`summary ${rig.summaryNodeCount}`);
      const meta = parts.join(" · ");
      const label = makeLabel("spatial-label spatial-label--rig", rig.rigName, meta);
      const headerZ = rect.z + L.rigHeader * 0.5;
      registerLabel(engine, content, label, "rig", rig.key, rig.rigName, meta, [
        { at: [rect.x + 0.8, 0.05, headerZ], cx: 0, cy: 0.5 },
        // Far end of the header band, then the deck's front edge.
        { at: [rect.x + rect.w - 0.8, 0.05, headerZ], cx: 1, cy: 0.5 },
        { at: [rect.x + 0.8, 0.05, rect.z + rect.d - 0.8], cx: 0, cy: 0.5 },
      ]);
    }
  }

  for (const rect of layout.pods) {
    const pod = model.podsByKey.get(rect.key);
    const geo = track(engine, new BoxGeometry(rect.w, L.podThickness, rect.d));
    const platform = new Mesh(geo, platformMat);
    platform.position.set(rect.x + rect.w / 2, rect.top - L.podThickness / 2, rect.z + rect.d / 2);
    const edgeGeo = track(engine, new EdgesGeometry(geo));
    const outline = new LineSegments(edgeGeo, platformEdgeMat);
    outline.position.copy(platform.position);
    content.add(platform, outline);

    // Plumb lines from the platform corners to the rig deck: containment.
    const bottom = rect.top - L.podThickness;
    const corners: Array<[number, number]> = [
      [rect.x, rect.z], [rect.x + rect.w, rect.z], [rect.x, rect.z + rect.d], [rect.x + rect.w, rect.z + rect.d],
    ];
    const plumb: number[] = [];
    for (const [x, z] of corners) plumb.push(x, bottom, z, x, 0.02, z);
    const plumbGeo = track(engine, new BufferGeometry());
    plumbGeo.setAttribute("position", new Float32BufferAttribute(plumb, 3));
    const plumbLines = new LineSegments(plumbGeo, plumbMat);
    plumbLines.computeLineDistances();
    content.add(plumbLines);

    if (pod) {
      const n = pod.agentKeys.length;
      const meta = `${n} seat${n === 1 ? "" : "s"}`;
      const label = makeLabel("spatial-label spatial-label--pod", pod.label, meta);
      const podHeaderZ = rect.z + L.podHeader * 0.5;
      registerLabel(engine, content, label, "pod", pod.key, pod.label, meta, [
        { at: [rect.x + 0.7, rect.top + 0.05, podHeaderZ], cx: 0, cy: 0.5 },
        { at: [rect.x + rect.w - 0.7, rect.top + 0.05, podHeaderZ], cx: 1, cy: 0.5 },
        { at: [rect.x + 0.7, rect.top + 0.05, rect.z + rect.d - 0.5], cx: 0, cy: 0.5 },
      ]);
    }
  }

  for (const placed of layout.agents) {
    const agent = model.agentsByKey.get(placed.key);
    if (!agent) continue;
    const status = deriveSeatStatus(agent);
    const toneColor = toColor(palette.tones[status.tone]);
    const group = new Group();
    group.position.set(...placed.position);

    const bodyMaterial = track(engine, new MeshStandardMaterial({
      color: toColor(palette.platform).lerp(toneColor, status.stale ? 0.12 : 0.28),
      roughness: 0.6,
      metalness: 0.05,
      transparent: true,
      opacity: 1,
    }));
    const body = new Mesh(agent.nodeKind === "infrastructure" ? shared.infra : shared.puck, bodyMaterial);
    body.userData.spatialKey = agent.key;
    const ringMaterial = track(engine, new MeshBasicMaterial({
      color: toneColor,
      transparent: true,
      opacity: status.stale ? 0.4 : 0.95,
    }));
    const ring = new Mesh(shared.ring, ringMaterial);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = -0.22;
    group.add(body, ring);

    let beacon: Group | null = null;
    const beaconMaterials: Material[] = [];
    if (status.problems.length > 0 || status.tone === "needs_input" || status.tone === "blocked") {
      beacon = new Group();
      const beaconColor = toColor(palette.tones[status.tone === "blocked" ? "blocked" : "needs_input"]);
      const stemMat = track(engine, new LineBasicMaterial({ color: beaconColor, transparent: true, opacity: 0.9 }));
      const stemGeo = track(engine, new BufferGeometry());
      stemGeo.setAttribute("position", new Float32BufferAttribute([0, 0.4, 0, 0, 2.5, 0], 3));
      const headMat = track(engine, new MeshBasicMaterial({ color: beaconColor, transparent: true, opacity: 1 }));
      const head = new Mesh(shared.beaconHead, headMat);
      head.position.y = 2.85;
      beacon.add(new Line(stemGeo, stemMat), head);
      beaconMaterials.push(stemMat, headMat);
      group.add(beacon);
    }

    const label = makeLabel(
      `spatial-label spatial-label--agent${status.stale ? " is-stale" : ""}`,
      agent.displayName,
      status.label,
    );
    label.element.style.setProperty("--spatial-tone", hslCss(palette.tones[status.tone]));
    const urgent = status.problems.length > 0 || status.tone === "needs_input" || status.tone === "blocked";
    if (urgent) label.element.classList.add("is-urgent");
    registerLabel(engine, group, label, "agent", agent.key, agent.displayName, status.label, [
      { at: [0, beacon ? 3.5 : 1.15, 0], cx: 0.5, cy: 1 },
      // Hang below the puck when the space above is taken.
      { at: [0, -0.45, 0], cx: 0.5, cy: 0 },
    ], urgent);

    content.add(group);
    engine.pickables.push(body);
    engine.agentPositions.set(agent.key, group.position.clone());
    engine.agents.set(agent.key, {
      key: agent.key,
      group,
      body,
      bodyMaterial,
      ring,
      ringMaterial,
      beacon,
      beaconMaterials,
      label,
      tone: status.tone,
      stale: status.stale,
    });
  }

  const edgeByKey = new Map(model.edges.map((e) => [e.key, e]));
  for (const placed of layout.edges) {
    const edge = edgeByKey.get(placed.key);
    const curve = new QuadraticBezierCurve3(v3(placed.from), v3(placed.control), v3(placed.to));
    const geo = track(engine, new BufferGeometry().setFromPoints(curve.getPoints(32)));
    const material = edge?.crossPod
      ? track(engine, new LineDashedMaterial({ color: toColor(palette.link), dashSize: 0.8, gapSize: 0.5, transparent: true, opacity: 0.7 }))
      : track(engine, new LineBasicMaterial({ color: toColor(palette.link), transparent: true, opacity: 0.7 }));
    const line = new Line(geo, material);
    if (edge?.crossPod) line.computeLineDistances();
    // Direction cue: a small cone near the target, aligned with the tangent.
    const arrowMaterial = track(engine, new MeshBasicMaterial({ color: toColor(palette.link), transparent: true, opacity: 0.8 }));
    const arrow = new Mesh(engine.shared.arrow, arrowMaterial);
    const t = 0.78;
    arrow.position.copy(curve.getPoint(t));
    const tangent = curve.getTangent(t).normalize();
    arrow.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), tangent);
    content.add(line, arrow);
    engine.edges.push({ key: placed.key, sourceKey: placed.sourceKey, targetKey: placed.targetKey, line, material, arrow, arrowMaterial });
  }
}

// ---------------------------------------------------------------------------
// Interaction state (selection, hover, search) — cheap property updates only.
// ---------------------------------------------------------------------------

function applyInteractionState(engine: Engine) {
  const { selectedKey, hoveredKey, matchKeys, palette } = engine.state;
  const searching = matchKeys !== null;
  const link = toColor(palette.link);
  const linkActive = toColor(palette.linkActive);

  for (const visual of engine.agents.values()) {
    const dimmed = searching && !matchKeys!.has(visual.key);
    const emphasized = visual.key === selectedKey || visual.key === hoveredKey;
    const scale = emphasized ? 1.14 : 1;
    visual.group.scale.setScalar(scale);
    visual.bodyMaterial.opacity = dimmed ? 0.22 : 1;
    visual.ringMaterial.opacity = dimmed ? 0.12 : visual.stale ? 0.4 : 0.95;
    for (const m of visual.beaconMaterials) m.opacity = dimmed ? 0.15 : 0.95;
    visual.label.element.classList.toggle("is-dimmed", dimmed);
    visual.label.element.classList.toggle("is-selected", visual.key === selectedKey);
    visual.label.element.classList.toggle("is-hovered", visual.key === hoveredKey);
  }

  const focusKey = selectedKey ?? hoveredKey;
  for (const edge of engine.edges) {
    const touches = focusKey !== null && (edge.sourceKey === focusKey || edge.targetKey === focusKey);
    const dimmed = (focusKey !== null && !touches)
      || (searching && !(matchKeys!.has(edge.sourceKey) || matchKeys!.has(edge.targetKey)));
    const color = touches ? linkActive : link;
    edge.material.color = color;
    edge.material.opacity = dimmed ? 0.12 : touches ? 1 : 0.7;
    edge.arrowMaterial.color = color;
    edge.arrowMaterial.opacity = dimmed ? 0.12 : 0.9;
  }

  const selectedPos = selectedKey ? engine.agentPositions.get(selectedKey) : undefined;
  if (selectedPos) {
    engine.selectionMarker.visible = true;
    engine.selectionMarker.position.set(selectedPos.x, selectedPos.y - 0.22, selectedPos.z);
  } else {
    engine.selectionMarker.visible = false;
  }
}

const _labelPoint = new Vector3();

/**
 * Screen-space label placement, run after each WebGL render and before the
 * CSS2D pass. Bounded: one projection per label plus a grid-bucketed overlap
 * test (see layoutLabels). Selected/hovered labels always show; problem
 * seats, search hits, rig names, pod names and finally ambient seat names
 * fill the remaining room only where they do not collide with each other,
 * the camera HUD or the legend, or run off the stage edge.
 */
function placeLabels(engine: Engine) {
  const { w, h } = engine.viewport;
  const { selectedKey, hoveredKey, matchKeys } = engine.state;
  const searching = matchKeys !== null;
  const camera = engine.camera;
  // Projected seat spacing decides whether ambient seat names have room.
  const distance = camera.position.distanceTo(engine.controls.target);
  const pxPerUnit = h / (2 * Math.max(distance, 1e-3) * Math.tan((camera.fov * Math.PI) / 360));
  const ambient = engine.agents.size <= 18 || SPATIAL_LAYOUT.agentSpacing * pxPerUnit >= AMBIENT_LABEL_SPACING_PX;

  const candidates: LabelCandidate[] = [];
  // Candidate anchor index -> entry.anchors index (culled anchors are skipped).
  const anchorMap = new Map<string, number[]>();
  for (const entry of engine.labelEntries) {
    let tier: number | null;
    if (entry.kind === "agent") {
      const isForced = entry.key === selectedKey || entry.key === hoveredKey;
      const dimmed = searching && !matchKeys!.has(entry.key);
      if (isForced) tier = LABEL_TIER.forced;
      else if (dimmed) tier = null;
      else if (entry.priority) tier = LABEL_TIER.problem;
      else if (searching) tier = LABEL_TIER.match;
      else tier = ambient ? LABEL_TIER.agent : null;
    } else {
      tier = entry.kind === "rig" ? LABEL_TIER.rig : LABEL_TIER.pod;
    }
    if (tier === null || w === 0 || h === 0 || !entry.object.parent) continue;
    const anchors: LabelAnchor[] = [];
    const indices: number[] = [];
    let depth = 0;
    entry.anchors.forEach((anchor, index) => {
      entry.object.parent!.localToWorld(_labelPoint.copy(anchor.local)).project(camera);
      if (_labelPoint.z < -1 || _labelPoint.z > 1) return;
      if (anchors.length === 0) depth = _labelPoint.z;
      anchors.push({ x: (_labelPoint.x + 1) * 0.5 * w, y: (1 - _labelPoint.y) * 0.5 * h, cx: anchor.cx, cy: anchor.cy });
      indices.push(index);
    });
    if (anchors.length === 0) continue;
    const id = `${entry.kind}:${entry.key}`;
    anchorMap.set(id, indices);
    candidates.push({
      id,
      ...anchors[0]!,
      alternatives: anchors.slice(1),
      w: entry.w,
      h: entry.h,
      tier,
      depth,
      clampX: entry.kind !== "agent",
    });
  }
  const result = layoutLabels(candidates, { width: w, height: h, occluders: engine.occluders, maxVisible: MAX_AMBIENT_LABELS });
  for (const entry of engine.labelEntries) {
    const id = `${entry.kind}:${entry.key}`;
    entry.object.visible = result.visible.has(id);
    const chosen = result.choice.get(id);
    const anchorIndex = chosen === undefined ? entry.anchorIndex : anchorMap.get(id)?.[chosen] ?? 0;
    if (anchorIndex !== entry.anchorIndex && entry.anchors[anchorIndex]) {
      const anchor = entry.anchors[anchorIndex]!;
      entry.anchorIndex = anchorIndex;
      entry.object.position.copy(anchor.local);
      entry.object.center.set(anchor.cx, anchor.cy);
      // CSS2D projects from matrixWorld; refresh it for this same frame.
      entry.object.updateMatrixWorld();
    }
    const offset = result.offsets.get(id) ?? 0;
    if (offset !== entry.offset) {
      entry.offset = offset;
      entry.object.element.style.marginLeft = offset ? `${offset}px` : "";
    }
  }
  const layer = engine.labels.domElement;
  layer.dataset.visibleLabels = String(result.visible.size);
  layer.dataset.suppressedLabels = String(result.suppressed);
}
