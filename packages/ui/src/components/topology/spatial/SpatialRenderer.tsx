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
//   - Density: "compact" (a small stage: phone, short landscape) shows
//     one-line seat names with a shape status marker, the status line only on
//     the selected/hovered seat, name-only rig/pod labels and a small ambient
//     cap. A density change restyles the existing labels in place and paints
//     once; it never rebuilds the scene.
//   - Touch taps that just miss a figure snap to the nearest seat within a few
//     px (mouse picking stays exact); a tap in clear space still clears.
//   - Night Atelier scene: warm-charcoal (or limestone, light theme) stone
//     floor, rig slabs and pod daises; every seat stands on its own plinth as
//     a real figure (Clawd for Claude, a reconstructed Null for Codex, an
//     honest neutral stele otherwise; see spatial-mascots.ts). One warm key,
//     one cool rim, a hemisphere fill and ONE selection spotlight; no shadow
//     maps — contact shadows are a single instanced draw. Plinths and shadows
//     are instanced; figure geometry and materials are shared by kind.
//   - Traffic arcs come only from props.traffic (real activity records): each
//     animates from its own timestamp for a bounded window, never restarts
//     for an id already seen, never plays for an old (cached) record, and
//     stops requesting frames as soon as no arc is in flight. Reduced motion
//     shows a static arc for the same window; a hidden tab requests nothing.
//   - Auto-framing follows streaming data until the operator commands the
//     camera (drag, orbit, zoom, preset, fit, focus); Reset hands it back.
//   - Camera continuity is a value, not GPU state: the controller can
//     snapshot/restore a bounded pose, the renderer reports the pose when it
//     settles (never per frame) and on teardown, and a restore is instant,
//     validated, clamped and rejected when the layout bounds have moved.

import { useEffect, useRef, type MutableRefObject } from "react";
import {
  ACESFilmicToneMapping,
  AdditiveBlending,
  BoxGeometry,
  BufferGeometry,
  Color,
  ConeGeometry,
  DataTexture,
  DirectionalLight,
  EdgesGeometry,
  Float32BufferAttribute,
  Fog,
  GridHelper,
  Group,
  HemisphereLight,
  InstancedMesh,
  Line,
  LinearFilter,
  LineBasicMaterial,
  LineDashedMaterial,
  LineSegments,
  Material,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  OctahedronGeometry,
  PerspectiveCamera,
  PlaneGeometry,
  QuadraticBezierCurve3,
  Quaternion,
  Raycaster,
  RepeatWrapping,
  Scene,
  SphereGeometry,
  SpotLight,
  SRGBColorSpace,
  TorusGeometry,
  TubeGeometry,
  Vector2,
  Vector3,
  WebGLRenderer,
} from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { CSS2DObject, CSS2DRenderer } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import {
  SPATIAL_CAMERA_DIRECTIONS,
  SPATIAL_LAYOUT,
  normalize,
  deriveSeatStatus,
  fitDistance,
  type SpatialCameraPreset,
  type SpatialLayout,
  type SpatialModel,
  type SpatialTone,
  type Vec3,
} from "../../../lib/spatial-topology.js";
import { hslCss, type Hsl, type SpatialPalette } from "./spatial-palette.js";
import { isSpatialCameraSnapshot, type SpatialCameraSnapshot, type Vec3Tuple } from "./spatial-visit-store.js";
import {
  LABEL_TIER,
  COMPACT_LABEL_MAX_WIDTH_PX,
  estimateLabelSize,
  frameBox,
  layoutLabels,
  leaderLine,
  nearestWithin,
  trafficBeads,
  trafficPhase,
  TRAFFIC_BEADS,
  TRAFFIC_TOTAL_MS,
  type LabelAnchor,
  type LabelCandidate,
  type LabelDensity,
  type LabelKind,
  type Rect,
} from "./spatial-view-math.js";
import { buildMascotGeometries, mascotKindFor, type MascotGeometry, type MascotKind } from "./spatial-mascots.js";

export type SpatialRendererFailure = "unsupported" | "context-lost" | "init-error";

export interface SpatialCameraController {
  fit(): void;
  reset(): void;
  preset(preset: SpatialCameraPreset): void;
  zoom(factor: number): void;
  orbit(dAzimuth: number, dPolar: number): void;
  focus(key: string): void;
  /** Current pose, or null before the first framing. */
  snapshot(): SpatialCameraSnapshot | null;
  /** Apply a saved pose instantly. False (and nothing changes) when it is
   *  invalid or was taken against materially different layout bounds. */
  restore(snapshot: SpatialCameraSnapshot): boolean;
  /** Stage overlays (camera HUD, key) changed size: re-read them so labels
   *  stay clear of them, and paint once. */
  refreshOverlays(): void;
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
  /** Pose to restore on the first content build instead of auto-fitting. */
  initialCamera?: SpatialCameraSnapshot | null;
  /** Reported when the camera settles after a change, and on teardown. */
  onCameraSettle?: (snapshot: SpatialCameraSnapshot) => void;
  /** Label density for the stage size; "compact" on small stages. */
  density?: LabelDensity;
  /** Real inter-seat activity to draw as arcs (the activity hook's pulses).
   *  Optional: absent or empty draws nothing and requests no frames. */
  traffic?: readonly SpatialTrafficPulse[];
}

/** One real activity record, as produced by the spatial activity hook
 *  (structurally the contract's SpatialTrafficRecord). `occurredAt` is the
 *  record's canonical time, epoch ms; keys are exact spatial agent keys. */
export interface SpatialTrafficPulse {
  id: string;
  sourceKey: string;
  targetKey: string;
  type: string;
  label: string;
  occurredAt: number;
  qitemId?: string;
}

const FOV = 32;
const MAX_DPR = 2;
const DAMPING_FRAME_BUDGET = 72;
const TWEEN_MS = 460;
const CLICK_SLOP_PX = 6;
/** Ambient (non-priority) seat labels need this much projected seat spacing. */
const AMBIENT_LABEL_SPACING_PX = 44;
const MAX_AMBIENT_LABELS = 80;
/** Compact: ambient seat names need more room and far fewer labels show. */
const COMPACT_AMBIENT_LABEL_SPACING_PX = 64;
const COMPACT_ALWAYS_LABEL_SEATS = 6;
const MAX_COMPACT_LABELS = 16;
/** View directions steeper than this (camera y of the unit view vector) are
 *  the plan view: Top preset, or an orbit close to it. */
const PLAN_VIEW_MIN_Y = 0.85;
/** Plan-view seat names are clipped to the projected seat pitch, never below
 *  this (px, about ten characters); a name with no room by its seat is
 *  relocated with a leader instead of shrinking further or vanishing. */
const PLAN_NAME_MIN_PX = 80;
/** Plan view tries the slab in front of the plinth first (straight below the
 *  seat on screen), then the plinth plate and the other fallbacks. */
const PLAN_AGENT_ANCHOR_ORDER = [2, 0, 1, 3, 4] as const;
/** A finger tap within this many px of a seat's centre selects it. */
const TOUCH_PICK_RADIUS_PX = 24;
/** Scene staging (world units; seat pitch is SPATIAL_LAYOUT.agentSpacing). */
const PLINTH = { width: 3.7, height: 1.0, radius: 0.12 } as const;
const DAIS_HEIGHT = 0.9;
/** Stone margins around the OCCUPIED seats (the shared layout's padding and
 *  header bands are not drawn as empty stone): dais beyond its plinths, slab
 *  beyond its daises and loose plinths. Hierarchy stays: seat ⊂ dais ⊂ slab. */
const DAIS_MARGIN = 0.55;
const SLAB_MARGIN = 0.85;
/** Figures turn a little toward the default camera. */
const FIGURE_YAW = 0.4;
/** Horizontal facing of every figure (its front, +z rotated by FIGURE_YAW). */
const FIGURE_FACING = { x: Math.sin(FIGURE_YAW), z: Math.cos(FIGURE_YAW) } as const;
/** The atelier's default three-quarter view: lower than the old iso, so the
 *  figures read as figures; Top stays the shared plan view. */
const ATELIER_ISO: Vec3 = normalize([0.62, 0.58, 1]);
const MAX_TRAFFIC_ARCS = 6;
const TRAFFIC_SEGMENTS = 48;
/** Arc tubes: a bright core inside a soft additive glow (no post-processing). */
const TRAFFIC_RADIAL = 6;
const TRAFFIC_CORE_RADIUS = 0.055;
const TRAFFIC_GLOW_RADIUS = 0.22;

function presetDirection(preset: SpatialCameraPreset): Vec3 {
  return preset === "iso" ? ATELIER_ISO : SPATIAL_CAMERA_DIRECTIONS[preset];
}

interface AgentVisual {
  key: string;
  group: Group;
  body: Mesh;
  glow: Mesh | null;
  mats: { normal: Material; dim: Material; glow: Material | null; glowDim: Material | null };
  status: Mesh;
  statusMats: { normal: Material; stale: Material; dim: Material };
  beacon: Mesh | null;
  label: CSS2DObject;
  tone: SpatialTone;
  stale: boolean;
  /** Plinth top centre (figure base), world. */
  base: Vector3;
  height: number;
  width: number;
  /** Figure bounding-box corners relative to `base` (yaw applied), for the
   *  projected silhouette the label layout keeps clear. */
  corners: Vector3[];
}

interface TrafficVisual {
  record: SpatialTrafficPulse | null;
  line: Line;
  lineMaterial: LineBasicMaterial;
  /** Pooled tubes along the arc (vertex buffers refilled per real event). */
  core: Mesh;
  coreMaterial: MeshBasicMaterial;
  glow: Mesh;
  glowMaterial: MeshBasicMaterial;
  /** Travelling sparks trailing the head: one instanced draw. */
  beads: InstancedMesh;
  beadMaterial: MeshBasicMaterial;
  head: Mesh;
  headMaterial: MeshBasicMaterial;
  halo: Mesh;
  haloMaterial: MeshBasicMaterial;
  arrival: Mesh;
  arrivalMaterial: MeshBasicMaterial;
  label: CSS2DObject;
  points: Vector3[];
  apex: Vector3;
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
  /** Last applied vertical shift (plan-view relocation), px. */
  offsetY: number;
  /** Last applied leader line ("" = none), as its CSS custom properties. */
  leader: string;
  text: string;
  meta: string | null;
  metaElement: HTMLElement | null;
  /** Optional names per anchor, exposed as data-anchor for styling. */
  anchorNames: Array<string | null>;
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
    plinth: BufferGeometry;
    shadow: BufferGeometry;
    selection: BufferGeometry;
    arrow: BufferGeometry;
    beacon: BufferGeometry;
    statusActive: BufferGeometry;
    statusNeedsInput: BufferGeometry;
    statusBlocked: BufferGeometry;
    statusIdle: BufferGeometry;
    statusUnknown: BufferGeometry;
    trafficHead: BufferGeometry;
    trafficHalo: BufferGeometry;
    trafficArrival: BufferGeometry;
  };
  mascots: Record<MascotKind, MascotGeometry>;
  shadowTexture: DataTexture;
  lights: { hemi: HemisphereLight; key: DirectionalLight; rim: DirectionalLight; fill: DirectionalLight; spot: SpotLight };
  stoneTexture: DataTexture;
  traffic: { pool: TrafficVisual[]; seen: Map<string, number> };
  content: Group;
  contentDisposables: Array<{ dispose(): void }>;
  grid: GridHelper | null;
  selectionMarker: Mesh;
  selectionMaterial: MeshBasicMaterial;
  agents: Map<string, AgentVisual>;
  agentPositions: Map<string, Vector3>;
  edges: EdgeVisual[];
  labelEntries: LabelEntry[];
  /** Camera looks (near) straight down: every seat gets a one-line name. */
  planView: boolean;
  occluders: Rect[];
  viewport: { w: number; h: number };
  pickables: Array<Mesh | InstancedMesh>;
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
  /** One-shot restore, applied once content AND a real viewport exist. */
  pendingRestore: SpatialCameraSnapshot | null;
  contentBuilt: boolean;
  /** End any in-flight tween (at its destination) and damping now; one paint. */
  settleMotion: () => void;
  restore: (snapshot: SpatialCameraSnapshot) => boolean;
  snapshot: () => SpatialCameraSnapshot | null;
  state: {
    selectedKey: string | null;
    hoveredKey: string | null;
    matchKeys: ReadonlySet<string> | null;
    palette: SpatialPalette;
    density: LabelDensity;
    reducedMotion: boolean;
  };
}

/** Low-contrast stone grain (deterministic value noise), shared by slabs,
 *  daises and plinths so the warm key reveals surface and depth. */
function makeStoneTexture(): DataTexture {
  const size = 128;
  const data = new Uint8Array(size * size * 4);
  let seed = 0x2f6b9d;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const lattice = 16;
  const grid: number[] = [];
  for (let i = 0; i < lattice * lattice; i++) grid.push(rand());
  const at = (x: number, y: number) => grid[((y % lattice) + lattice) % lattice * lattice + (((x % lattice) + lattice) % lattice)]!;
  const smooth = (t: number) => t * t * (3 - 2 * t);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let v = 0;
      let amp = 0.5;
      for (let octave = 0, f = lattice / size; octave < 3; octave++, f *= 2, amp *= 0.5) {
        const fx = x * f, fy = y * f;
        const x0 = Math.floor(fx), y0 = Math.floor(fy);
        const tx = smooth(fx - x0), ty = smooth(fy - y0);
        const top = at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx;
        const bottom = at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx;
        v += amp * (top * (1 - ty) + bottom * ty);
      }
      const shade = Math.round(255 * (0.86 + 0.14 * v));
      const i = (y * size + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = shade;
      data[i + 3] = 255;
    }
  }
  const texture = new DataTexture(data, size, size);
  texture.wrapS = texture.wrapT = RepeatWrapping;
  texture.colorSpace = SRGBColorSpace;
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

/** Soft radial falloff for contact shadows (no canvas needed). */
function makeShadowTexture(): DataTexture {
  const size = 64;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5) / size * 2 - 1;
      const dy = (y + 0.5) / size * 2 - 1;
      const r = Math.min(1, Math.hypot(dx, dy));
      const a = Math.pow(1 - r, 1.8);
      const i = (y * size + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = 0;
      data[i + 3] = Math.round(a * 255);
    }
  }
  const texture = new DataTexture(data, size, size);
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

/** Theme tokens are CSS sRGB HSL; convert into three's linear working space. */
export function toColor(c: Hsl): Color {
  return new Color().setHSL(c.h / 360, c.s / 100, c.l / 100, SRGBColorSpace);
}

function v3(p: Vec3): Vector3 {
  return new Vector3(p[0], p[1], p[2]);
}

const tuple = (v: Vector3): Vec3Tuple => [v.x, v.y, v.z];

/** A saved pose only applies to (nearly) the same layout it was taken in. */
export function cameraBoundsCompatible(saved: SpatialCameraSnapshot["bounds"], center: Vector3, radius: number): boolean {
  if (!(radius > 0)) return false;
  const ratio = saved.radius / radius;
  if (ratio < 0.8 || ratio > 1.25) return false;
  const [x, y, z] = saved.center;
  return Math.hypot(x - center.x, y - center.y, z - center.z) <= radius * 0.25;
}

function documentHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
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
    let mascots: Engine["mascots"] | null = null;
    let shadowTexture: DataTexture | null = null;
    let stoneTexture: DataTexture | null = null;
    let trafficPool: TrafficVisual[] = [];
    let trafficTimer: ReturnType<typeof setTimeout> | null = null;
    let selectionMaterial: MeshBasicMaterial | null = null;
    let frame = 0;
    let disposed = false;
    let dampingFrames = 0;
    let tween: { from: Vector3; to: Vector3; fromTarget: Vector3; toTarget: Vector3; start: number } | null = null;
    const cleanups: Array<() => void> = [];

    // One teardown for unmount AND a failure part-way through init, so every
    // allocation that exists at that point is released exactly once.
    const teardown = () => {
      const settledEngine = engineRef.current;
      if (!disposed && settledEngine?.fittedOnce) {
        const final = settledEngine.snapshot();
        if (final) propsRef.current.onCameraSettle?.(final);
      }
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
      if (trafficTimer) clearTimeout(trafficTimer);
      trafficTimer = null;
      for (const visual of trafficPool) {
        visual.line.geometry.dispose();
        visual.core.geometry.dispose();
        visual.glow.geometry.dispose();
        visual.beads.dispose();
        for (const mat of [visual.lineMaterial, visual.coreMaterial, visual.glowMaterial, visual.beadMaterial, visual.headMaterial, visual.haloMaterial, visual.arrivalMaterial]) mat.dispose();
        visual.label.element.remove();
      }
      trafficPool = [];
      if (shared) for (const g of Object.values(shared)) g.dispose();
      shared = null;
      if (mascots) for (const f of Object.values(mascots)) { f.body.dispose(); f.glow?.dispose(); }
      mascots = null;
      shadowTexture?.dispose();
      shadowTexture = null;
      stoneTexture?.dispose();
      stoneTexture = null;
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
      // Filmic tone mapping keeps the warm key and the coral/orange figures
      // from clipping; status inlays and traffic opt out (toneMapped: false).
      gl.toneMapping = ACESFilmicToneMapping;
      gl.toneMappingExposure = palette.atelier.exposure;
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
      scene.background = toColor(palette.atelier.stage);
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

      // Lighting: hemisphere fill, a warm key from the upper left/front, a
      // cool rim from behind, and one selection spotlight (intensity 0 until
      // a seat is selected). Colours/intensities come from the palette.
      const hemi = new HemisphereLight(0xffffff, 0x000000, 1);
      const key = new DirectionalLight(0xffffff, 1);
      key.position.set(-45, 80, 55);
      const rim = new DirectionalLight(0xffffff, 1);
      rim.position.set(35, 40, -70);
      // Front fill: low, from the viewer's side, so a dark figure (Null)
      // keeps its form and faces read; never the dominant light.
      const fill = new DirectionalLight(0xffffff, 1);
      fill.position.set(12, 22, 90);
      const spot = new SpotLight(0xffffff, 0, 0, 0.36, 0.85, 0);
      scene.add(hemi, key, rim, fill, spot, spot.target);

      const shadowGeo = new PlaneGeometry(1, 1);
      shadowGeo.rotateX(-Math.PI / 2);
      const geometries: Engine["shared"] = {
        plinth: new RoundedBoxGeometry(PLINTH.width, PLINTH.height, PLINTH.width, 2, PLINTH.radius),
        shadow: shadowGeo,
        selection: new TorusGeometry(PLINTH.width * 0.46, 0.045, 6, 64),
        arrow: new ConeGeometry(0.16, 0.42, 10),
        beacon: new OctahedronGeometry(0.24, 0),
        statusActive: new SphereGeometry(0.15, 12, 8),
        statusNeedsInput: new OctahedronGeometry(0.2, 0),
        statusBlocked: new BoxGeometry(0.28, 0.28, 0.12),
        statusIdle: new TorusGeometry(0.13, 0.045, 6, 18),
        statusUnknown: new BoxGeometry(0.34, 0.07, 0.07),
        trafficHead: new SphereGeometry(0.17, 14, 10),
        trafficHalo: new SphereGeometry(0.5, 14, 10),
        // Grounded arrival accent hugging the receiver's plinth-top edge.
        trafficArrival: new TorusGeometry(PLINTH.width * 0.5, 0.06, 6, 56),
      };
      shared = geometries;
      geometries.trafficArrival.rotateX(Math.PI / 2);
      mascots = buildMascotGeometries();
      shadowTexture = makeShadowTexture();
      stoneTexture = makeStoneTexture();
      const selectionMat = new MeshBasicMaterial({ color: toColor(palette.atelier.selection), transparent: true, opacity: 0.95, toneMapped: false });
      selectionMaterial = selectionMat;
      const selectionMarker = new Mesh(geometries.selection, selectionMat);
      selectionMarker.rotation.x = Math.PI / 2;
      selectionMarker.visible = false;
      scene.add(selectionMarker);

      const content = new Group();
      scene.add(content);

      // Traffic arc pool (bounded; reused, never grown).
      const trafficLayer = new Group();
      scene.add(trafficLayer);
      for (let i = 0; i < MAX_TRAFFIC_ARCS; i++) {
        const lineGeo = new BufferGeometry();
        lineGeo.setAttribute("position", new Float32BufferAttribute(new Float32Array((TRAFFIC_SEGMENTS + 1) * 3), 3));
        const lineMaterial = new LineBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, toneMapped: false });
        const luminous = { transparent: true, depthWrite: false, toneMapped: false, blending: AdditiveBlending } as const;
        const headMaterial = new MeshBasicMaterial({ toneMapped: false });
        const haloMaterial = new MeshBasicMaterial({ ...luminous, opacity: 0.3 });
        const arrivalMaterial = new MeshBasicMaterial({ ...luminous, opacity: 0 });
        const coreMaterial = new MeshBasicMaterial({ ...luminous, opacity: 0 });
        const glowMaterial = new MeshBasicMaterial({ ...luminous, opacity: 0 });
        const beadMaterial = new MeshBasicMaterial({ ...luminous, opacity: 1 });
        const line = new Line(lineGeo, lineMaterial);
        const head = new Mesh(geometries.trafficHead, headMaterial);
        const halo = new Mesh(geometries.trafficHalo, haloMaterial);
        const arrival = new Mesh(geometries.trafficArrival, arrivalMaterial);
        const placeholder = new QuadraticBezierCurve3(new Vector3(), new Vector3(0, 1, 0), new Vector3(1, 0, 0));
        const core = new Mesh(new TubeGeometry(placeholder, TRAFFIC_SEGMENTS, TRAFFIC_CORE_RADIUS, TRAFFIC_RADIAL, false), coreMaterial);
        const glow = new Mesh(new TubeGeometry(placeholder, TRAFFIC_SEGMENTS, TRAFFIC_GLOW_RADIUS, TRAFFIC_RADIAL, false), glowMaterial);
        const beads = new InstancedMesh(geometries.trafficHead, beadMaterial, TRAFFIC_BEADS);
        beads.count = 0;
        beads.frustumCulled = false;
        line.name = "traffic-line";
        core.name = "traffic-core";
        glow.name = "traffic-glow";
        beads.name = "traffic-beads";
        head.name = "traffic-head";
        halo.name = "traffic-halo";
        arrival.name = "traffic-arrival";
        const caption = document.createElement("div");
        caption.className = "spatial-label spatial-label--traffic";
        caption.dataset.spatialLabel = "traffic";
        const label = new CSS2DObject(caption);
        label.center.set(0.5, 1.2);
        for (const o of [line, core, glow, beads, head, halo, arrival, label]) o.visible = false;
        line.renderOrder = core.renderOrder = glow.renderOrder = beads.renderOrder = head.renderOrder = halo.renderOrder = 2;
        trafficLayer.add(glow, core, line, beads, halo, head, arrival, label);
        trafficPool.push({ record: null, line, lineMaterial, core, coreMaterial, glow, glowMaterial, beads, beadMaterial, head, headMaterial, halo, haloMaterial, arrival, arrivalMaterial, label, points: [], apex: new Vector3() });
      }

      const renderNow = () => {
        if (disposed) return;
        gl.render(scene, camera);
        const engine = engineRef.current;
        if (engine) placeLabels(engine);
        labelRenderer.render(scene, camera);
      };

      // Settle reporting: once per completed change, never per frame and
      // never mid-drag (an active drag has no tween and no damping budget).
      let cameraDirty = false;
      let interacting = false;
      const reportSettled = () => {
        if (!cameraDirty || interacting || tween || dampingFrames > 0) return;
        cameraDirty = false;
        const engine = engineRef.current;
        const snap = engine?.fittedOnce ? engine.snapshot() : null;
        if (snap) propsRef.current.onCameraSettle?.(snap);
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
        // Traffic: position arcs for the wall clock (records carry epoch ms).
        const engine = engineRef.current;
        const reduced = propsRef.current.reducedMotion;
        const remaining = engine ? updateTraffic(engine, Date.now(), reduced) : null;
        renderNow();
        if (trafficTimer) clearTimeout(trafficTimer);
        trafficTimer = null;
        // In flight + visible tab + motion allowed: keep painting (bounded by
        // the arcs' own lifetime). Otherwise one timer clears it at expiry.
        const trafficAgain = remaining !== null && !reduced && !documentHidden();
        if (remaining !== null && !trafficAgain && !documentHidden()) {
          trafficTimer = setTimeout(() => { trafficTimer = null; requestRender(); }, remaining + 20);
        }
        if (again || trafficAgain) requestRender();
        if (!again) reportSettled();
      };
      // Returning to a hidden tab re-evaluates arcs once (expired ones clear).
      const onVisibility = () => { if (!documentHidden()) requestRender(); };
      document.addEventListener("visibilitychange", onVisibility);
      cleanups.push(() => document.removeEventListener("visibilitychange", onVisibility));

      const requestRender = () => {
        if (disposed || frame) return;
        frame = requestAnimationFrame(tick);
      };

      const tweenTo = (position: Vector3, target: Vector3) => {
        dampingFrames = 0;
        cameraDirty = true;
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
        mascots,
        shadowTexture,
        lights: { hemi, key, rim, fill, spot },
        stoneTexture,
        traffic: { pool: trafficPool, seen: new Map() },
        content,
        contentDisposables: [],
        grid: null,
        selectionMarker,
        selectionMaterial: selectionMat,
        agents: new Map(),
        agentPositions: new Map(),
        edges: [],
        labelEntries: [],
        planView: false,
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
        pendingRestore: isSpatialCameraSnapshot(propsRef.current.initialCamera) ? propsRef.current.initialCamera : null,
        contentBuilt: false,
        settleMotion: () => {},
        restore: () => false,
        snapshot: () => null,
        state: {
          selectedKey: propsRef.current.selectedKey,
          hoveredKey: propsRef.current.hoveredKey,
          matchKeys: propsRef.current.matchKeys,
          palette,
          density: propsRef.current.density ?? "full",
          reducedMotion: propsRef.current.reducedMotion,
        },
      };
      engineRef.current = engine;

      const onControlsChange = () => {
        cameraDirty = true;
        requestRender();
      };
      const onControlsStart = () => {
        engine.userMoved = true;
        interacting = true;
        tween = null;
        dampingFrames = 0;
      };
      const onControlsEnd = () => {
        interacting = false;
        cameraDirty = true;
        if (orbit.enableDamping) dampingFrames = DAMPING_FRAME_BUDGET;
        requestRender();
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
        if (!hit) return null;
        const direct = hit.object.userData.spatialKey;
        if (typeof direct === "string") return direct;
        // Instanced plinth: the instance index names the seat.
        const keys = hit.object.userData.instanceKeys as string[] | undefined;
        const key = hit.instanceId !== undefined ? keys?.[hit.instanceId] : undefined;
        return typeof key === "string" ? key : null;
      };
      // Touch tolerance: the nearest seat centre within TOUCH_PICK_RADIUS_PX
      // of the tap, in screen space. One projection per seat, only on a tap.
      const pickNear = (clientX: number, clientY: number): string | null => {
        const rect = canvas.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return null;
        const points: Array<{ key: string; x: number; y: number }> = [];
        // The figure's centre: the same point camera focus frames.
        for (const [key, center] of engine.agentPositions) {
          _pickPoint.copy(center).project(camera);
          if (_pickPoint.z < -1 || _pickPoint.z > 1) continue;
          points.push({ key, x: rect.left + (_pickPoint.x + 1) * 0.5 * rect.width, y: rect.top + (1 - _pickPoint.y) * 0.5 * rect.height });
        }
        return nearestWithin(points, clientX, clientY, TOUCH_PICK_RADIUS_PX);
      };
      // A selection belongs to one tap: a primary pointer (isPrimary, primary
      // button) pressed while no other pointer of ANY type is down on the
      // canvas, released by that same pointer without ever moving past the
      // slop. A second pointer (pinch/rotate, or a mouse while a finger is
      // held), a cancellation or a drag voids the candidate, and a
      // non-primary pointer (a finger whose first touch began elsewhere)
      // never starts one, so a gesture never selects or clears a seat.
      // Every tracked id leaves the set on its own terminal release or
      // cancel, wherever it lands (document listener below), so an id cannot
      // stay stuck and block later taps.
      let tap: { pointerId: number; x: number; y: number } | null = null;
      const downPointers = new Set<number>();
      let hoverFrame = 0;
      let lastHoverEvent: PointerEvent | null = null;
      let lastHoverKey: string | null = null;
      const cancelHoverPick = () => {
        if (hoverFrame) cancelAnimationFrame(hoverFrame);
        hoverFrame = 0;
        lastHoverEvent = null;
      };
      const releasePointer = (pointerId: number) => {
        downPointers.delete(pointerId);
        if (tap && tap.pointerId === pointerId) tap = null;
      };
      const onPointerDown = (e: PointerEvent) => {
        downPointers.add(e.pointerId);
        tap = downPointers.size === 1 && e.isPrimary && e.button === 0 ? { pointerId: e.pointerId, x: e.clientX, y: e.clientY } : null;
      };
      const onPointerUp = (e: PointerEvent) => {
        const candidate = tap && tap.pointerId === e.pointerId ? tap : null;
        releasePointer(e.pointerId);
        if (!candidate || e.button !== 0) return;
        if (Math.hypot(e.clientX - candidate.x, e.clientY - candidate.y) > CLICK_SLOP_PX) return;
        const exact = pick(e.clientX, e.clientY);
        propsRef.current.onSelect(exact ?? (e.pointerType === "touch" || e.pointerType === "pen" ? pickNear(e.clientX, e.clientY) : null));
      };
      const onPointerCancel = (e: PointerEvent) => releasePointer(e.pointerId);
      // A release or cancel that does not target the canvas (pointer not
      // captured, lifted elsewhere) still ends that pointer. Capture phase so
      // a stopPropagation elsewhere cannot hide it; canvas-targeted events
      // are left to the canvas handlers above.
      const ownerDocument = canvas.ownerDocument;
      const onDocumentPointerEnd = (e: PointerEvent) => {
        if (e.target !== canvas) releasePointer(e.pointerId);
      };
      const onDoubleClick = (e: MouseEvent) => {
        const key = pick(e.clientX, e.clientY);
        if (key) controller.focus(key);
      };
      const onPointerMove = (e: PointerEvent) => {
        if (tap && tap.pointerId === e.pointerId && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) > CLICK_SLOP_PX) tap = null;
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
      const onPointerLeave = (e: PointerEvent) => {
        // A pick queued before the pointer left must not resurrect a hover.
        cancelHoverPick();
        releasePointer(e.pointerId);
        if (lastHoverKey !== null) {
          lastHoverKey = null;
          propsRef.current.onHover(null);
        }
      };
      canvas.addEventListener("pointerdown", onPointerDown);
      canvas.addEventListener("pointerup", onPointerUp);
      canvas.addEventListener("pointercancel", onPointerCancel);
      ownerDocument.addEventListener("pointerup", onDocumentPointerEnd, true);
      ownerDocument.addEventListener("pointercancel", onDocumentPointerEnd, true);
      canvas.addEventListener("pointermove", onPointerMove);
      canvas.addEventListener("pointerleave", onPointerLeave);
      canvas.addEventListener("dblclick", onDoubleClick);
      cleanups.push(() => {
        canvas.removeEventListener("pointerdown", onPointerDown);
        canvas.removeEventListener("pointerup", onPointerUp);
        canvas.removeEventListener("pointercancel", onPointerCancel);
        ownerDocument.removeEventListener("pointerup", onDocumentPointerEnd, true);
        ownerDocument.removeEventListener("pointercancel", onDocumentPointerEnd, true);
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
          cameraDirty = true;
          requestRender();
        }
      };

      // Every explicit command takes the camera from auto-framing, so a data
      // refresh never undoes the operator's chosen view. Reset hands it back.
      const controller: SpatialCameraController = {
        fit: () => {
          engine.userMoved = true;
          // Keep the operator's angle unless it shows the figures' backs (or
          // looks up from below): then return to the three-quarter front.
          const dir = viewDirection();
          const facing = dir.x * FIGURE_FACING.x + dir.z * FIGURE_FACING.z;
          const horizontal = Math.hypot(dir.x, dir.z);
          const showsFronts = horizontal < 1e-3 || facing / horizontal > 0.1;
          fitAlong(showsFronts && dir.y > 0 ? dir : v3(ATELIER_ISO), true);
        },
        reset: () => {
          engine.userMoved = false;
          fitAlong(v3(ATELIER_ISO), true);
        },
        preset: (preset) => {
          engine.userMoved = true;
          fitAlong(v3(presetDirection(preset)), true);
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
          // A portrait framing: the figure reads clearly, its neighbours stay
          // in view (figures are ~3 units tall; seats are 4.4 apart).
          const dist = Math.min(cameraDistance(), 26);
          tweenTo(point.clone().add(viewDirection().multiplyScalar(dist)), point.clone());
        },
        snapshot: () => engine.snapshot(),
        restore: (snapshot) => engine.restore(snapshot),
        refreshOverlays: () => {
          engine.measureOccluders();
          requestRender();
        },
      };
      // Reduced motion turning on mid-move: land the tween on its destination
      // (a valid, intended pose) and drop damping inertia, then paint once;
      // that frame reports the settled pose like any completed move.
      engine.settleMotion = () => {
        if (!tween && dampingFrames === 0) return;
        if (tween) {
          camera.position.copy(tween.to);
          orbit.target.copy(tween.toTarget);
          camera.lookAt(orbit.target);
          tween = null;
        }
        dampingFrames = 0;
        orbit.update();
        cameraDirty = true;
        requestRender();
      };
      engine.snapshot = () => ({
        position: tuple(camera.position),
        target: tuple(orbit.target),
        userMoved: engine.userMoved,
        bounds: { center: tuple(engine.boundsCenter), radius: engine.boundsRadius },
      });
      engine.restore = (snapshot) => {
        if (!isSpatialCameraSnapshot(snapshot)) return false;
        if (!cameraBoundsCompatible(snapshot.bounds, engine.boundsCenter, engine.boundsRadius)) return false;
        if (!snapshot.userMoved) {
          // An auto-fit pose stays auto-fit: frame the current data.
          engine.userMoved = false;
          fitAlong(v3(ATELIER_ISO), false);
          return true;
        }
        const target = v3(snapshot.target);
        const offset = v3(snapshot.position).sub(target);
        const distance = offset.length();
        if (!(distance > 1e-6)) return false;
        // Establish this viewport's control limits, then clamp into them.
        fitAlong(v3(ATELIER_ISO), false);
        const clamped = Math.min(orbit.maxDistance, Math.max(orbit.minDistance, distance));
        const phi = Math.min(orbit.maxPolarAngle, Math.max(0.02, Math.acos(Math.min(1, Math.max(-1, offset.y / distance)))));
        const theta = Math.atan2(offset.x, offset.z);
        tween = null;
        dampingFrames = 0;
        camera.position.set(
          target.x + clamped * Math.sin(phi) * Math.sin(theta),
          target.y + clamped * Math.cos(phi),
          target.z + clamped * Math.sin(phi) * Math.cos(theta),
        );
        orbit.target.copy(target);
        camera.lookAt(target);
        orbit.update();
        engine.userMoved = true;
        cameraDirty = true;
        requestRender();
        return true;
      };
      propsRef.current.controllerRef.current = controller;
      engine.fitInitial = () => fitAlong(v3(ATELIER_ISO), false);

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
        if (!engine.userMoved && !applyPendingRestore(engine)) engine.fitInitial();
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
    engine.contentBuilt = true;
    // A visit's saved pose is applied once, on the first build with real
    // bounds; an incompatible or invalid pose falls back to the normal fit.
    if (applyPendingRestore(engine)) {
      engine.requestRender();
      return;
    }
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

  // --- Traffic (real activity records) -------------------------------------
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    const before = engine.traffic.pool.filter((v) => v.record).length;
    syncTraffic(engine, props.traffic, Date.now());
    const after = engine.traffic.pool.filter((v) => v.record).length;
    if (after > 0 || before > 0) engine.requestRender();
  }, [props.traffic]);

  // --- Label density (stage size) restyles labels in place ------------------
  useEffect(() => {
    const engine = engineRef.current;
    const density = props.density ?? "full";
    if (!engine || engine.state.density === density) return;
    engine.state.density = density;
    applyLabelDensity(engine);
    engine.measureOccluders();
    engine.requestRender();
  }, [props.density]);

  // --- Reduced motion toggles damping live ----------------------------------
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.controls.enableDamping = !props.reducedMotion;
    // An in-flight arc's own frame reads the new setting; idle stays idle.
    engine.state.reducedMotion = props.reducedMotion;
    if (props.reducedMotion) engine.settleMotion();
  }, [props.reducedMotion]);

  return <div ref={hostRef} data-testid="spatial-renderer-host" className="spatial-renderer-host" />;
}

// ---------------------------------------------------------------------------
// Scene construction
// ---------------------------------------------------------------------------

function applyPendingRestore(engine: Engine): boolean {
  const pending = engine.pendingRestore;
  if (!pending || !engine.contentBuilt || !engine.fittedOnce) return false;
  engine.pendingRestore = null;
  return engine.restore(pending);
}

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

type AnchorSpec = { at: Vec3; cx: number; cy: number; name?: string };

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
  object.element.classList.toggle("is-compact", labelsCompact(engine));
  const resolved = anchors.map((a) => ({ local: v3(a.at), cx: a.cx, cy: a.cy }));
  object.position.copy(resolved[0]!.local);
  object.center.set(resolved[0]!.cx, resolved[0]!.cy);
  parent.add(object);
  const metaElement = object.element.querySelector<HTMLElement>(".spatial-label__meta");
  const anchorNames = anchors.map((a) => a.name ?? null);
  if (anchorNames[0]) object.element.dataset.anchor = anchorNames[0];
  engine.labelEntries.push({ object, kind, key, w, h, priority, anchors: resolved, anchorIndex: 0, offset: 0, offsetY: 0, leader: "", text, meta, metaElement, anchorNames });
}

/** One-line names: a small stage, or the plan view at any stage size. */
function labelsCompact(engine: Engine): boolean {
  return engine.state.density === "compact" || engine.planView;
}

/** Density restyle in place: class toggles only; sizes and status lines are
 *  resolved by the next placement pass. */
function applyLabelDensity(engine: Engine) {
  const compact = labelsCompact(engine);
  for (const entry of engine.labelEntries) entry.object.element.classList.toggle("is-compact", compact);
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

/** Visual plinth top (figure base) for a laid-out seat: the shared layout
 *  lifts pod seats to podTop; the atelier stands them on a low dais instead,
 *  each seat on its own stone plinth. Positions stay on the layout's x/z. */
function seatBaseY(position: Vec3): number {
  const inPod = position[1] > SPATIAL_LAYOUT.agentLift + 1e-3;
  return (inPod ? DAIS_HEIGHT : 0) + PLINTH.height;
}

function buildContent(engine: Engine, model: SpatialModel, layout: SpatialLayout, palette: SpatialPalette) {
  clearContent(engine);
  const L = SPATIAL_LAYOUT;
  const A = palette.atelier;
  const { content, shared, mascots } = engine;

  engine.scene.background = toColor(A.stage);
  engine.selectionMaterial.color = toColor(A.selection);
  applyLights(engine, palette);

  // Floor: matte stone with faint tile joints, sized to the layout.
  disposeGrid(engine);
  const span = Math.max(120, Math.ceil((layout.bounds.radius * 4.5) / 10) * 10);
  const floorY = -L.deckThickness - 0.01;
  const floorMat = track(engine, new MeshStandardMaterial({ color: toColor(A.floor), roughness: 0.97, metalness: 0 }));
  const floorGeo = track(engine, new PlaneGeometry(span, span));
  floorGeo.rotateX(-Math.PI / 2);
  const floor = new Mesh(floorGeo, floorMat);
  floor.position.set(layout.bounds.center[0], floorY, layout.bounds.center[2]);
  content.add(floor);
  const grid = new GridHelper(span, Math.max(12, Math.round(span / 4.4)), toColor(A.floorLine), toColor(A.floorLine));
  const gridMat = grid.material as Material;
  gridMat.transparent = true;
  gridMat.opacity = palette.theme === "dark" ? 0.42 : 0.5;
  gridMat.depthWrite = false;
  grid.position.set(layout.bounds.center[0], floorY + 0.004, layout.bounds.center[2]);
  engine.scene.add(grid);
  engine.grid = grid;

  // Camera-pose compatibility keeps the layout's own bounds (snapshots are
  // compared against them); FRAMING uses the occupied stone below.
  engine.boundsCenter.set(...layout.bounds.center);
  engine.boundsRadius = layout.bounds.radius;
  const fitDist = fitDistance(layout.bounds.radius, FOV, 1.6);
  engine.scene.fog = new Fog(toColor(A.stage), fitDist * 1.3, fitDist * 3.6);

  const stone = { map: engine.stoneTexture, roughness: 0.88, metalness: 0 };
  const slabMat = track(engine, new MeshStandardMaterial({ color: toColor(A.slab), ...stone, roughness: 0.92 }));
  const slabEdgeMat = track(engine, new LineBasicMaterial({ color: toColor(A.slabEdge), transparent: true, opacity: 0.6 }));
  const daisMat = track(engine, new MeshStandardMaterial({ color: toColor(A.dais), ...stone }));
  const daisEdgeMat = track(engine, new LineBasicMaterial({ color: toColor(A.plinthEdge), transparent: true, opacity: 0.5 }));

  // Stone sized to what it holds: each dais hugs its seats' plinths, each
  // slab hugs its daises and loose plinths (empty pods/rigs keep the layout's
  // rectangle, so nothing is hidden). Seat x/z come from the shared layout.
  const seatXZ = new Map(layout.agents.map((a) => [a.key, [a.position[0], a.position[2]] as const]));
  const seatHalf = PLINTH.width / 2;
  const podRects = new Map<string, Box2>();
  for (const rect of layout.pods) {
    const pod = model.podsByKey.get(rect.key);
    const seats = (pod?.agentKeys ?? []).map((k) => seatXZ.get(k)).filter((p): p is readonly [number, number] => !!p);
    podRects.set(rect.key, seats.length > 0 ? padBox(boxOfPoints(seats), seatHalf + DAIS_MARGIN) : boxOfRect(rect));
  }
  const rigByKey = new Map(model.rigs.map((r) => [r.key, r]));
  const rigRects = new Map<string, Box2>();
  for (const rect of layout.rigs) {
    const rig = rigByKey.get(rect.key);
    const parts: Box2[] = [...layout.pods.filter((p) => p.rigKey === rect.key).map((p) => podRects.get(p.key)!)];
    for (const key of rig?.looseAgentKeys ?? []) {
      const at = seatXZ.get(key);
      if (at) parts.push(padBox(boxOfPoints([at]), seatHalf));
    }
    rigRects.set(rect.key, parts.length > 0 ? padBox(unionBoxes(parts), SLAB_MARGIN) : boxOfRect(rect));
  }

  for (const rect of layout.rigs) {
    const rig = rigByKey.get(rect.key);
    const box = rigRects.get(rect.key)!;
    const w = box.x1 - box.x0, d = box.z1 - box.z0;
    const slabGeo = track(engine, new BoxGeometry(w, L.deckThickness, d));
    const slab = new Mesh(slabGeo, slabMat);
    slab.position.set(box.x0 + w / 2, -L.deckThickness / 2, box.z0 + d / 2);
    const outline = new LineSegments(track(engine, new EdgesGeometry(slabGeo)), slabEdgeMat);
    outline.position.copy(slab.position);
    content.add(slab, outline);
    if (rig) {
      const seatCount = rig.agents.length;
      const podCount = rig.pods.length;
      const parts = [`${podCount} pod${podCount === 1 ? "" : "s"}`, `${seatCount} seat${seatCount === 1 ? "" : "s"}`];
      if (rig.summaryNodeCount !== null && rig.summaryNodeCount !== seatCount) parts.push(`summary ${rig.summaryNodeCount}`);
      const meta = parts.join(" · ");
      const label = makeLabel("spatial-label spatial-label--rig", rig.rigName, meta);
      // Engraved on the slab's front edge, then its back corners.
      registerLabel(engine, content, label, "rig", rig.key, rig.rigName, meta, [
        { at: [box.x0 + 0.5, 0.05, box.z1 - 0.45], cx: 0, cy: 0.5 },
        { at: [box.x0 + 0.5, 0.05, box.z0 + 0.45], cx: 0, cy: 0.5 },
        { at: [box.x1 - 0.5, 0.05, box.z0 + 0.45], cx: 1, cy: 0.5 },
      ]);
    }
  }

  // Pods: a low stone dais the pod's seats stand on (containment by mass,
  // not by floating platforms).
  for (const rect of layout.pods) {
    const pod = model.podsByKey.get(rect.key);
    const box = podRects.get(rect.key)!;
    const w = box.x1 - box.x0, d = box.z1 - box.z0;
    const geo = track(engine, new BoxGeometry(w, DAIS_HEIGHT, d));
    const dais = new Mesh(geo, daisMat);
    dais.position.set(box.x0 + w / 2, DAIS_HEIGHT / 2, box.z0 + d / 2);
    const outline = new LineSegments(track(engine, new EdgesGeometry(geo)), daisEdgeMat);
    outline.position.copy(dais.position);
    content.add(dais, outline);
    if (pod) {
      const n = pod.agentKeys.length;
      const meta = `${n} seat${n === 1 ? "" : "s"}`;
      const label = makeLabel("spatial-label spatial-label--pod", pod.label, meta);
      registerLabel(engine, content, label, "pod", pod.key, pod.label, meta, [
        { at: [box.x0 + 0.4, DAIS_HEIGHT + 0.05, box.z1 - 0.3], cx: 0, cy: 0.5 },
        { at: [box.x0 + 0.4, DAIS_HEIGHT + 0.05, box.z0 + 0.3], cx: 0, cy: 0.5 },
        { at: [box.x1 - 0.4, DAIS_HEIGHT + 0.05, box.z0 + 0.3], cx: 1, cy: 0.5 },
      ]);
    }
  }

  // Shared per-build materials: one per figure kind (+ a dimmed twin for
  // search), one per status tone. Never one per seat.
  const figureMats = {} as Record<MascotKind, { normal: Material; dim: Material; glow: Material | null; glowDim: Material | null }>;
  for (const kind of ["clawd", "null", "neutral", "infrastructure"] as const) {
    // No environment map: low metalness keeps dark Null readable under the
    // key/rim/fill instead of reflecting nothing.
    const finish = kind === "clawd" ? { roughness: 0.52, metalness: 0 } : kind === "null" ? { roughness: 0.42, metalness: 0.1 } : { roughness: 0.8, metalness: 0.05 };
    const hasGlow = mascots[kind].glow !== null;
    figureMats[kind] = {
      normal: track(engine, new MeshStandardMaterial({ vertexColors: true, ...finish })),
      dim: track(engine, new MeshStandardMaterial({ vertexColors: true, ...finish, transparent: true, opacity: 0.18, depthWrite: false })),
      glow: hasGlow ? track(engine, new MeshBasicMaterial({ vertexColors: true, toneMapped: false })) : null,
      glowDim: hasGlow ? track(engine, new MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.18, depthWrite: false })) : null,
    };
  }
  const statusMats = {} as Record<SpatialTone, { normal: MeshBasicMaterial; stale: MeshBasicMaterial; dim: MeshBasicMaterial }>;
  for (const tone of Object.keys(palette.tones) as SpatialTone[]) {
    const color = toColor(palette.tones[tone]);
    statusMats[tone] = {
      normal: track(engine, new MeshBasicMaterial({ color, toneMapped: false })),
      stale: track(engine, new MeshBasicMaterial({ color, transparent: true, opacity: 0.45, toneMapped: false })),
      dim: track(engine, new MeshBasicMaterial({ color, transparent: true, opacity: 0.12, depthWrite: false, toneMapped: false })),
    };
  }

  const placedAgents = layout.agents.filter((p) => model.agentsByKey.has(p.key));
  // One instanced draw for every plinth and one for every contact shadow.
  const plinthMat = track(engine, new MeshStandardMaterial({ color: toColor(A.plinth), map: engine.stoneTexture, roughness: 0.84, metalness: 0.02 }));
  const plinths = track(engine, new InstancedMesh(shared.plinth, plinthMat, Math.max(1, placedAgents.length)));
  plinths.count = placedAgents.length;
  plinths.userData.instanceKeys = placedAgents.map((p) => p.key);
  const shadowMat = track(engine, new MeshBasicMaterial({ color: 0x000000, map: engine.shadowTexture, transparent: true, opacity: A.shadowOpacity, depthWrite: false }));
  const shadows = track(engine, new InstancedMesh(shared.shadow, shadowMat, Math.max(1, placedAgents.length * 2)));
  shadows.count = placedAgents.length * 2;
  shadows.renderOrder = 1;
  const m = new Matrix4();
  const q = new Quaternion();
  const one = new Vector3(1, 1, 1);

  placedAgents.forEach((placed, index) => {
    const agent = model.agentsByKey.get(placed.key)!;
    const status = deriveSeatStatus(agent);
    const kind = mascotKindFor(agent);
    const figure = mascots[kind];
    const base = seatBaseY(placed.position);
    const [x, , z] = placed.position;
    const group = new Group();
    group.position.set(x, base, z);

    m.compose(new Vector3(x, base - PLINTH.height / 2, z), q.identity(), one);
    plinths.setMatrixAt(index, m);
    // Contact shadows: under the plinth on its dais/slab, and under the figure.
    m.compose(new Vector3(x, base - PLINTH.height + 0.012, z), q.identity(), new Vector3(PLINTH.width * 1.45, 1, PLINTH.width * 1.45));
    shadows.setMatrixAt(index * 2, m);
    m.compose(new Vector3(x, base + 0.012, z), q.identity(), new Vector3(figure.width * 1.15, 1, figure.width * 0.85));
    shadows.setMatrixAt(index * 2 + 1, m);

    const mats = figureMats[kind];
    const body = new Mesh(figure.body, mats.normal);
    body.rotation.y = FIGURE_YAW;
    body.userData.spatialKey = agent.key;
    group.add(body);
    let glow: Mesh | null = null;
    if (figure.glow && mats.glow) {
      glow = new Mesh(figure.glow, mats.glow);
      glow.rotation.y = FIGURE_YAW;
      glow.userData.spatialKey = agent.key;
      group.add(glow);
    }

    // Status: a small lit inlay on the plinth's front edge whose SHAPE names
    // the state (not colour alone).
    const statusMesh = new Mesh(statusShape(shared, status.tone), status.stale ? statusMats[status.tone].stale : statusMats[status.tone].normal);
    statusMesh.position.set(0, -0.2, PLINTH.width / 2 + 0.03);
    group.add(statusMesh);

    const urgent = status.problems.length > 0 || status.tone === "needs_input" || status.tone === "blocked";
    let beacon: Mesh | null = null;
    if (urgent) {
      const beaconTone: SpatialTone = status.tone === "blocked" ? "blocked" : "needs_input";
      beacon = new Mesh(shared.beacon, statusMats[beaconTone].normal);
      beacon.position.set(0, figure.height + 0.55, 0);
      group.add(beacon);
    }

    const label = makeLabel(
      `spatial-label spatial-label--agent${status.stale ? " is-stale" : ""}`,
      agent.displayName,
      status.label,
    );
    label.element.style.setProperty("--spatial-tone", hslCss(palette.tones[status.tone]));
    label.element.dataset.tone = status.tone;
    label.element.dataset.figure = kind;
    if (urgent) label.element.classList.add("is-urgent");
    registerLabel(engine, group, label, "agent", agent.key, agent.displayName, status.label, [
      // Low and quiet: on the plinth's front face, like an engraved plate.
      { at: [0, -PLINTH.height * 0.55, PLINTH.width / 2 + 0.05], cx: 0.5, cy: 0.5, name: "plinth" },
      // Above the figure, clear of its whole silhouette (beacon included).
      { at: [0, figure.height * 1.12 + (beacon ? 1.1 : 0.55), 0], cx: 0.5, cy: 1, name: "above" },
      // Under the plinth, on the dais/slab in front of it.
      { at: [0, -PLINTH.height - 0.02, PLINTH.width / 2 + 0.25], cx: 0.5, cy: 0, name: "below" },
      // Beside the figure, outside its silhouette.
      { at: [figure.width * 0.62 + 0.35, figure.height * 0.5, 0], cx: 0, cy: 0.5, name: "right" },
      { at: [-(figure.width * 0.62 + 0.35), figure.height * 0.5, 0], cx: 1, cy: 0.5, name: "left" },
    ], urgent);

    content.add(group);
    const center = new Vector3(x, base + figure.height * 0.5, z);
    engine.agentPositions.set(agent.key, center);
    engine.pickables.push(body);
    if (glow) engine.pickables.push(glow);
    engine.agents.set(agent.key, {
      key: agent.key,
      group,
      body,
      glow,
      mats,
      status: statusMesh,
      statusMats: statusMats[status.tone],
      beacon,
      label,
      tone: status.tone,
      stale: status.stale,
      base: new Vector3(x, base, z),
      height: figure.height,
      width: figure.width,
      corners: silhouetteCorners(figure),
    });
  });
  plinths.instanceMatrix.needsUpdate = true;
  shadows.instanceMatrix.needsUpdate = true;
  plinths.computeBoundingSphere();
  shadows.computeBoundingSphere();
  content.add(plinths, shadows);

  // Framing bounds: the occupied plinths and the figures standing on them
  // (a small margin; the surrounding dais/slab stone may run into the fit
  // insets). With no seats, the drawn stone, else the layout.
  if (engine.agents.size > 0) {
    const seats = [...engine.agents.values()];
    const all = padBox(boxOfPoints(seats.map((v) => [v.base.x, v.base.z] as const)), seatHalf + 0.3);
    let top = 1;
    for (const v of seats) top = Math.max(top, v.base.y + v.height + (v.beacon ? 0.8 : 0.1));
    engine.boundsMin = [all.x0, 0, all.z0];
    engine.boundsMax = [all.x1, top, all.z1];
  } else if (rigRects.size > 0) {
    const all = unionBoxes([...rigRects.values()]);
    engine.boundsMin = [all.x0, -L.deckThickness, all.z0];
    engine.boundsMax = [all.x1, 1, all.z1];
  } else {
    engine.boundsMin = layout.bounds.min;
    engine.boundsMax = layout.bounds.max;
  }
  // Plinths are a generous, stable touch/click target for their seat; figures
  // stay first so an exact figure hit wins.
  engine.pickables.push(plinths);

  // Relationships: quiet ground-level lines between plinth feet. They are
  // structure, never traffic: they do not move, and only brighten when a
  // seat they touch is selected or hovered.
  const edgeByKey = new Map(model.edges.map((e) => [e.key, e]));
  const linkColor = toColor(A.link);
  for (const placed of layout.edges) {
    const edge = edgeByKey.get(placed.key);
    const from = engine.agents.get(placed.sourceKey);
    const to = engine.agents.get(placed.targetKey);
    if (!from || !to) continue;
    const a = new Vector3(from.base.x, from.base.y - PLINTH.height + 0.05, from.base.z);
    const b = new Vector3(to.base.x, to.base.y - PLINTH.height + 0.05, to.base.z);
    const flat = new Vector3(b.x - a.x, 0, b.z - a.z);
    const dist = flat.length();
    if (dist < 1e-3) continue;
    flat.normalize().multiplyScalar(Math.min(PLINTH.width * 0.62, dist * 0.3));
    a.add(flat);
    b.sub(flat);
    const control = a.clone().add(b).multiplyScalar(0.5);
    control.y = Math.max(a.y, b.y) + 0.35 + dist * 0.035;
    const curve = new QuadraticBezierCurve3(a, control, b);
    const geo = track(engine, new BufferGeometry().setFromPoints(curve.getPoints(28)));
    const material = edge?.crossPod
      ? track(engine, new LineDashedMaterial({ color: linkColor, dashSize: 0.6, gapSize: 0.45, transparent: true, opacity: 0.5 }))
      : track(engine, new LineBasicMaterial({ color: linkColor, transparent: true, opacity: 0.5 }));
    const line = new Line(geo, material);
    if (edge?.crossPod) line.computeLineDistances();
    const arrowMaterial = track(engine, new MeshBasicMaterial({ color: linkColor, transparent: true, opacity: 0.55 }));
    const arrow = new Mesh(shared.arrow, arrowMaterial);
    const t = 0.84;
    arrow.position.copy(curve.getPoint(t));
    arrow.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), curve.getTangent(t).normalize());
    content.add(line, arrow);
    engine.edges.push({ key: placed.key, sourceKey: placed.sourceKey, targetKey: placed.targetKey, line, material, arrow, arrowMaterial });
  }

  // Active traffic follows the rebuilt seats (or ends if a seat is gone).
  refreshTrafficGeometry(engine);
}

interface Box2 { x0: number; z0: number; x1: number; z1: number }
function boxOfPoints(points: ReadonlyArray<readonly [number, number]>): Box2 {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const [x, z] of points) { x0 = Math.min(x0, x); z0 = Math.min(z0, z); x1 = Math.max(x1, x); z1 = Math.max(z1, z); }
  return { x0, z0, x1, z1 };
}
function boxOfRect(r: { x: number; z: number; w: number; d: number }): Box2 {
  return { x0: r.x, z0: r.z, x1: r.x + r.w, z1: r.z + r.d };
}
function padBox(b: Box2, m: number): Box2 {
  return { x0: b.x0 - m, z0: b.z0 - m, x1: b.x1 + m, z1: b.z1 + m };
}
function unionBoxes(boxes: readonly Box2[]): Box2 {
  return boxes.reduce((a, b) => ({ x0: Math.min(a.x0, b.x0), z0: Math.min(a.z0, b.z0), x1: Math.max(a.x1, b.x1), z1: Math.max(a.z1, b.z1) }));
}

/** The figure's bounding-box corners (yaw applied), relative to its base. */
function silhouetteCorners(figure: MascotGeometry): Vector3[] {
  const b = figure.body.boundingBox!;
  const out: Vector3[] = [];
  const c = Math.cos(FIGURE_YAW), sn = Math.sin(FIGURE_YAW);
  for (const x of [b.min.x, b.max.x]) for (const y of [b.min.y, b.max.y]) for (const z of [b.min.z, b.max.z]) {
    out.push(new Vector3(x * c + z * sn, y, -x * sn + z * c));
  }
  return out;
}

function statusShape(shared: Engine["shared"], tone: SpatialTone): BufferGeometry {
  if (tone === "active") return shared.statusActive;
  if (tone === "needs_input") return shared.statusNeedsInput;
  if (tone === "blocked") return shared.statusBlocked;
  if (tone === "idle") return shared.statusIdle;
  return shared.statusUnknown;
}

function applyLights(engine: Engine, palette: SpatialPalette) {
  const A = palette.atelier;
  const { hemi, key, rim, spot } = engine.lights;
  hemi.color = toColor(A.hemiSky);
  hemi.groundColor = toColor(A.hemiGround);
  hemi.intensity = A.hemiIntensity;
  key.color = toColor(A.key);
  key.intensity = A.keyIntensity;
  rim.color = toColor(A.rim);
  rim.intensity = A.rimIntensity;
  engine.lights.fill.color = toColor(A.fill);
  engine.lights.fill.intensity = A.fillIntensity;
  spot.color = toColor(A.spot);
  engine.renderer.toneMappingExposure = A.exposure;
  for (const visual of engine.traffic.pool) {
    visual.lineMaterial.color = toColor(A.trafficCore);
    visual.coreMaterial.color = toColor(A.trafficCore);
    visual.glowMaterial.color = toColor(A.traffic);
    visual.beadMaterial.color = toColor(A.trafficCore);
    visual.headMaterial.color = toColor(A.trafficCore);
    visual.haloMaterial.color = toColor(A.traffic);
    visual.arrivalMaterial.color = toColor(A.traffic);
  }
}

// ---------------------------------------------------------------------------
// Interaction state (selection, hover, search) — cheap property updates only.
// ---------------------------------------------------------------------------

function applyInteractionState(engine: Engine) {
  const { selectedKey, hoveredKey, matchKeys, palette } = engine.state;
  const A = palette.atelier;
  const searching = matchKeys !== null;
  const link = toColor(A.link);
  const linkActive = toColor(A.linkActive);

  for (const visual of engine.agents.values()) {
    const dimmed = searching && !matchKeys!.has(visual.key);
    const emphasized = visual.key === selectedKey || visual.key === hoveredKey;
    const scale = emphasized ? 1.1 : 1;
    visual.body.scale.setScalar(scale);
    visual.body.material = dimmed ? visual.mats.dim : visual.mats.normal;
    if (visual.glow) {
      visual.glow.scale.setScalar(scale);
      visual.glow.material = (dimmed ? visual.mats.glowDim : visual.mats.glow)!;
    }
    visual.status.material = dimmed ? visual.statusMats.dim : visual.stale ? visual.statusMats.stale : visual.statusMats.normal;
    if (visual.beacon) visual.beacon.visible = !dimmed;
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
    edge.material.opacity = dimmed ? 0.1 : touches ? 0.95 : 0.5;
    edge.arrowMaterial.color = color;
    edge.arrowMaterial.opacity = dimmed ? 0.1 : touches ? 0.95 : 0.55;
  }

  // Selected seat: a warm inlay ring on its plinth and the one spotlight
  // (always present, so selection never changes the light count / shaders).
  const selected = selectedKey ? engine.agents.get(selectedKey) : undefined;
  const { spot } = engine.lights;
  if (selected) {
    engine.selectionMarker.visible = true;
    engine.selectionMarker.position.set(selected.base.x, selected.base.y + 0.02, selected.base.z);
    spot.intensity = A.spotIntensity;
    spot.position.set(selected.base.x - 3.5, selected.base.y + 15, selected.base.z + 6);
    spot.target.position.set(selected.base.x, selected.base.y + selected.height * 0.4, selected.base.z);
    spot.target.updateMatrixWorld();
  } else {
    engine.selectionMarker.visible = false;
    spot.intensity = 0;
  }
}

// ---------------------------------------------------------------------------
// Traffic arcs: REAL activity records only (props.traffic). Each record
// animates from its own timestamp for a bounded window; ids are remembered so
// a re-delivered record never restarts, and anything older than the window
// (cached, replayed) never animates. Unplaced ends draw nothing.
// ---------------------------------------------------------------------------

/** Arc ends sit just outside each figure's silhouette, on the side facing
 *  the other seat, so the light leaves and reaches the figure without
 *  passing through it; `toBase` is the receiver's plinth top for the
 *  grounded arrival accent. */
function trafficEndpoints(engine: Engine, record: SpatialTrafficPulse): { from: Vector3; to: Vector3; toBase: Vector3 } | null {
  const a = engine.agents.get(record.sourceKey);
  const b = engine.agents.get(record.targetKey);
  if (!a || !b || a === b) return null;
  const toward = new Vector3(b.base.x - a.base.x, 0, b.base.z - a.base.z);
  const span = toward.length();
  if (span > 1e-6) toward.divideScalar(span);
  const reachA = Math.min(a.width * 0.58, span * 0.3);
  const reachB = Math.min(b.width * 0.58, span * 0.3);
  return {
    from: new Vector3(a.base.x, a.base.y + a.height * 0.62, a.base.z).addScaledVector(toward, reachA),
    to: new Vector3(b.base.x, b.base.y + b.height * 0.62, b.base.z).addScaledVector(toward, -reachB),
    toBase: b.base.clone(),
  };
}

/** Refill a pooled tube's vertex buffers for a new curve (same topology). */
function refillTube(mesh: Mesh, curve: QuadraticBezierCurve3, radius: number) {
  const fresh = new TubeGeometry(curve, TRAFFIC_SEGMENTS, radius, TRAFFIC_RADIAL, false);
  for (const name of ["position", "normal"] as const) {
    const target = mesh.geometry.getAttribute(name) as Float32BufferAttribute;
    (target.array as Float32Array).set(fresh.getAttribute(name).array as Float32Array);
    target.needsUpdate = true;
  }
  fresh.dispose();
  mesh.geometry.computeBoundingSphere();
}

function setTrafficCurve(visual: TrafficVisual, from: Vector3, to: Vector3, toBase: Vector3) {
  const dist = from.distanceTo(to);
  const control = from.clone().add(to).multiplyScalar(0.5);
  control.y = Math.max(from.y, to.y) + 1.4 + dist * 0.3;
  const curve = new QuadraticBezierCurve3(from, control, to);
  const pts = curve.getPoints(TRAFFIC_SEGMENTS);
  const attr = visual.line.geometry.getAttribute("position") as Float32BufferAttribute;
  pts.forEach((p, i) => attr.setXYZ(i, p.x, p.y, p.z));
  attr.needsUpdate = true;
  visual.line.geometry.computeBoundingSphere();
  refillTube(visual.core, curve, TRAFFIC_CORE_RADIUS);
  refillTube(visual.glow, curve, TRAFFIC_GLOW_RADIUS);
  visual.points = pts;
  visual.apex = curve.getPoint(0.5);
  visual.label.position.copy(visual.apex);
  // Grounded on the receiver's plinth top: never a hoop through the figure.
  visual.arrival.position.set(toBase.x, toBase.y + 0.03, toBase.z);
}

/** Admit new records (by id) into the bounded pool, and end any arc whose
 *  record is no longer delivered (the activity hook empties its pulses on
 *  disconnect, reconnect, hidden and reduced motion). Ids stay remembered, so
 *  a record that comes back is never replayed. */
function syncTraffic(engine: Engine, records: readonly SpatialTrafficPulse[] | undefined, nowMs: number) {
  const T = engine.traffic;
  const delivered = new Set((records ?? []).map((r) => r.id));
  for (const visual of T.pool) {
    if (visual.record && !delivered.has(visual.record.id)) visual.record = null;
  }
  for (const record of records ?? []) {
    if (T.seen.has(record.id)) continue;
    T.seen.set(record.id, record.occurredAt);
    if (!trafficPhase(nowMs, record.occurredAt, false).visible) continue;
    const ends = trafficEndpoints(engine, record);
    if (!ends) continue;
    // Reuse a free slot, else the one that started earliest.
    const slot = T.pool.find((v) => v.record === null)
      ?? T.pool.reduce((oldest, v) => (v.record!.occurredAt < oldest.record!.occurredAt ? v : oldest));
    slot.record = record;
    setTrafficCurve(slot, ends.from, ends.to, ends.toBase);
    slot.label.element.textContent = record.label;
  }
  // Bound the remembered ids.
  if (T.seen.size > 512) {
    for (const [id, at] of T.seen) if (nowMs - at > TRAFFIC_TOTAL_MS * 2) T.seen.delete(id);
  }
}

function refreshTrafficGeometry(engine: Engine) {
  for (const visual of engine.traffic.pool) {
    if (!visual.record) continue;
    const ends = trafficEndpoints(engine, visual.record);
    if (ends) setTrafficCurve(visual, ends.from, ends.to, ends.toBase);
    else visual.record = null;
  }
}

/** Position every active arc for `nowMs`. Returns the earliest remaining
 *  lifetime (ms) among visible arcs, or null when none is visible. */
function updateTraffic(engine: Engine, nowMs: number, reducedMotion: boolean): number | null {
  let soonest: number | null = null;
  let newest: TrafficVisual | null = null;
  for (const visual of engine.traffic.pool) {
    const record = visual.record;
    const phase = record ? trafficPhase(nowMs, record.occurredAt, reducedMotion) : null;
    if (!record || !phase || !phase.visible) {
      visual.record = null;
      visual.line.visible = visual.head.visible = visual.halo.visible = visual.arrival.visible = false;
      visual.core.visible = visual.glow.visible = visual.beads.visible = false;
      visual.label.visible = false;
      continue;
    }
    const remaining = TRAFFIC_TOTAL_MS - Math.max(0, nowMs - record.occurredAt);
    soonest = soonest === null ? remaining : Math.min(soonest, remaining);
    if (!newest || record.occurredAt > newest.record!.occurredAt) newest = visual;
    const from = Math.floor(phase.trailFrom * TRAFFIC_SEGMENTS);
    const to = Math.ceil(phase.trailTo * TRAFFIC_SEGMENTS);
    const shown = to > from;
    visual.line.visible = visual.core.visible = visual.glow.visible = shown;
    visual.line.geometry.setDrawRange(from, to - from + 1);
    // Tube indices run segment by segment: 6 per quad, TRAFFIC_RADIAL quads each.
    const perSegment = TRAFFIC_RADIAL * 6;
    visual.core.geometry.setDrawRange(from * perSegment, Math.max(0, to - from) * perSegment);
    visual.glow.geometry.setDrawRange(from * perSegment, Math.max(0, to - from) * perSegment);
    visual.lineMaterial.opacity = 0.9 * phase.alpha;
    visual.coreMaterial.opacity = 0.95 * phase.alpha;
    visual.glowMaterial.opacity = 0.32 * phase.alpha;
    const at = visual.points[Math.min(TRAFFIC_SEGMENTS, Math.round(phase.head * TRAFFIC_SEGMENTS))] ?? visual.apex;
    visual.head.visible = visual.halo.visible = phase.headVisible;
    visual.head.position.copy(at);
    visual.halo.position.copy(at);
    // Travelling sparks: brightness via instance colour (additive blending).
    const beads = trafficBeads(phase);
    visual.beads.visible = beads.length > 0;
    visual.beads.count = beads.length;
    beads.forEach((bead, i) => {
      const p = visual.points[Math.min(TRAFFIC_SEGMENTS, Math.round(bead.t * TRAFFIC_SEGMENTS))] ?? at;
      _beadMatrix.makeScale(bead.size * 0.72, bead.size * 0.72, bead.size * 0.72).setPosition(p);
      visual.beads.setMatrixAt(i, _beadMatrix);
      visual.beads.setColorAt(i, _beadColor.setScalar(bead.intensity));
    });
    if (beads.length > 0) {
      visual.beads.instanceMatrix.needsUpdate = true;
      if (visual.beads.instanceColor) visual.beads.instanceColor.needsUpdate = true;
    }
    visual.arrival.visible = phase.arrival > 0;
    visual.arrivalMaterial.opacity = 0.9 * phase.arrival;
    visual.arrival.scale.setScalar(0.92 + (1 - phase.arrival) * 0.22);
    visual.label.visible = false;
  }
  // One small caption, for the newest arc only, and only on a roomy stage.
  if (newest && engine.state.density === "full" && newest.record!.label) newest.label.visible = true;
  return soonest;
}

const _labelPoint = new Vector3();
const _pickPoint = new Vector3();
const _beadMatrix = new Matrix4();
const _beadColor = new Color();

/**
 * Screen-space label placement, run after each WebGL render and before the
 * CSS2D pass. Bounded: one projection per label plus a grid-bucketed overlap
 * test (see layoutLabels). Selected/hovered labels always show; problem
 * seats, search hits, rig names, pod names and finally ambient seat names
 * fill the remaining room only where they do not collide with each other,
 * the camera HUD or the legend, or run off the stage edge. In the plan view
 * (Top) every seat name is a candidate ahead of rig/pod names, one line,
 * clipped to the projected seat pitch, with no ambient gate or cap.
 */
function placeLabels(engine: Engine) {
  const { w, h } = engine.viewport;
  const { selectedKey, hoveredKey, matchKeys } = engine.state;
  const searching = matchKeys !== null;
  const camera = engine.camera;
  // Projected seat spacing decides whether ambient seat names have room.
  const distance = camera.position.distanceTo(engine.controls.target);
  const plan = distance > 1e-6 && (camera.position.y - engine.controls.target.y) / distance >= PLAN_VIEW_MIN_Y;
  if (plan !== engine.planView) {
    engine.planView = plan;
    applyLabelDensity(engine);
  }
  const pxPerUnit = h / (2 * Math.max(distance, 1e-3) * Math.tan((camera.fov * Math.PI) / 360));
  const pitchPx = SPATIAL_LAYOUT.agentSpacing * pxPerUnit;
  const smallStage = engine.state.density === "compact";
  const compact = labelsCompact(engine);
  const ambient = smallStage
    ? engine.agents.size <= COMPACT_ALWAYS_LABEL_SEATS || pitchPx >= COMPACT_AMBIENT_LABEL_SPACING_PX
    : engine.agents.size <= 18 || pitchPx >= AMBIENT_LABEL_SPACING_PX;
  const nameMax = plan ? Math.max(PLAN_NAME_MIN_PX, Math.min(COMPACT_LABEL_MAX_WIDTH_PX, Math.floor(pitchPx - 8))) : null;
  const layerStyle = engine.labels.domElement.style;
  const nameMaxCss = nameMax === null ? "" : `${nameMax}px`;
  if (layerStyle.getPropertyValue("--spatial-plan-name-max") !== nameMaxCss) {
    if (nameMaxCss) layerStyle.setProperty("--spatial-plan-name-max", nameMaxCss);
    else layerStyle.removeProperty("--spatial-plan-name-max");
  }
  // Compact shows a status line only on the selected/hovered seat; the DOM
  // `hidden` state is kept in step so the painted box matches its estimate.
  const showsMeta = (entry: LabelEntry) =>
    !compact || (entry.kind === "agent" && (entry.key === selectedKey || entry.key === hoveredKey));
  for (const entry of engine.labelEntries) {
    const shown = showsMeta(entry);
    if (entry.metaElement && entry.metaElement.hidden === shown) entry.metaElement.hidden = !shown;
  }

  const candidates: LabelCandidate[] = [];
  // Box size and primary anchor per candidate, for relocated labels' leaders.
  const boxes = new Map<string, { w: number; h: number; cx: number; cy: number }>();
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
      else if (searching || plan) tier = LABEL_TIER.match;
      else tier = ambient ? LABEL_TIER.agent : null;
    } else {
      tier = entry.kind === "rig" ? LABEL_TIER.rig : LABEL_TIER.pod;
    }
    if (tier === null || w === 0 || h === 0 || !entry.object.parent) continue;
    const anchors: LabelAnchor[] = [];
    const indices: number[] = [];
    let depth = 0;
    const order = plan && entry.kind === "agent" ? PLAN_AGENT_ANCHOR_ORDER : entry.anchors.keys();
    for (const index of order) {
      const anchor = entry.anchors[index];
      if (!anchor) continue;
      entry.object.parent!.localToWorld(_labelPoint.copy(anchor.local)).project(camera);
      if (_labelPoint.z < -1 || _labelPoint.z > 1) continue;
      if (anchors.length === 0) depth = _labelPoint.z;
      anchors.push({ x: (_labelPoint.x + 1) * 0.5 * w, y: (1 - _labelPoint.y) * 0.5 * h, cx: anchor.cx, cy: anchor.cy });
      indices.push(index);
    }
    if (anchors.length === 0) continue;
    const id = `${entry.kind}:${entry.key}`;
    anchorMap.set(id, indices);
    const size = compact ? estimateLabelSize(entry.kind, entry.text, showsMeta(entry) ? entry.meta : null, "compact") : { w: entry.w, h: entry.h };
    // Mirrors spatial.css: unforced plan names clip to the seat pitch.
    if (nameMax !== null && entry.kind === "agent" && tier !== LABEL_TIER.forced) size.w = Math.min(size.w, nameMax);
    boxes.set(id, { ...size, cx: anchors[0]!.cx, cy: anchors[0]!.cy });
    candidates.push({
      id,
      ...anchors[0]!,
      alternatives: anchors.slice(1),
      ...size,
      tier,
      depth,
      clampX: entry.kind !== "agent",
      // Top names every seat: a name with no room by its seat moves to the
      // nearest free spot and keeps a leader to it rather than vanishing.
      relocate: plan && entry.kind === "agent" && tier !== LABEL_TIER.forced,
    });
  }
  // Every figure's projected silhouette is hard space: no label covers a
  // figure, and the selected label moves off its own body if it must.
  const silhouettes: Rect[] = [];
  if (w > 0 && h > 0) {
    for (const visual of engine.agents.values()) {
      const scale = visual.body.scale.x;
      let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
      let inFront = true;
      for (const corner of visual.corners) {
        _labelPoint.copy(corner).multiplyScalar(scale).add(visual.base).project(camera);
        if (_labelPoint.z < -1 || _labelPoint.z > 1) { inFront = false; break; }
        const sx = (_labelPoint.x + 1) * 0.5 * w;
        const sy = (1 - _labelPoint.y) * 0.5 * h;
        left = Math.min(left, sx); right = Math.max(right, sx);
        top = Math.min(top, sy); bottom = Math.max(bottom, sy);
      }
      if (inFront && right > 0 && left < w && bottom > 0 && top < h) silhouettes.push({ left, top, right, bottom });
    }
  }
  const result = layoutLabels(candidates, {
    width: w,
    height: h,
    occluders: engine.occluders,
    silhouettes,
    maxVisible: plan ? engine.labelEntries.length : smallStage ? MAX_COMPACT_LABELS : MAX_AMBIENT_LABELS,
  });
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
      const name = entry.anchorNames[anchorIndex];
      if (name) entry.object.element.dataset.anchor = name;
      // CSS2D projects from matrixWorld; refresh it for this same frame.
      entry.object.updateMatrixWorld();
    }
    const shift = result.shifts.get(id);
    const offset = shift ? shift.dx : result.offsets.get(id) ?? 0;
    const element = entry.object.element;
    if (offset !== entry.offset) {
      entry.offset = offset;
      element.style.marginLeft = offset ? `${offset}px` : "";
    }
    const offsetY = shift?.dy ?? 0;
    if (offsetY !== entry.offsetY) {
      entry.offsetY = offsetY;
      element.style.marginTop = offsetY ? `${offsetY}px` : "";
    }
    const line = shift ? leaderLine(boxes.get(id)!, shift.dx, shift.dy) : null;
    const leader = line ? `${line.x}|${line.y}|${line.length}|${line.angle}` : "";
    if (leader !== entry.leader) {
      entry.leader = leader;
      element.classList.toggle("has-leader", line !== null);
      for (const [name, value] of [["x", line?.x], ["y", line?.y], ["len", line?.length]] as const) {
        if (value === undefined) element.style.removeProperty(`--leader-${name}`);
        else element.style.setProperty(`--leader-${name}`, `${value}px`);
      }
      if (line) element.style.setProperty("--leader-angle", `${line.angle}rad`);
      else element.style.removeProperty("--leader-angle");
    }
  }
  const layer = engine.labels.domElement;
  layer.dataset.visibleLabels = String(result.visible.size);
  layer.dataset.suppressedLabels = String(result.suppressed);
}
