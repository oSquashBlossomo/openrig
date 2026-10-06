// Phone / narrow-tablet 2D topology graph layout (below the 1024px shell
// breakpoint). Pure: input is the exact-identity spatial model the 3D view
// also reads (lib/spatial-topology.ts), output is positioned React Flow
// nodes/edges.
//
// Progressive hierarchy instead of a shrunken desktop canvas:
//   - rigs stack in 1–3 masonry columns sized for the viewport; a collapsed
//     rig is a compact tile with per-status tallies, so a dense fleet keeps
//     every rig visible (unreadable/loading rigs and rigs past the bounded
//     fetch get their own tiles; nothing is silently dropped);
//   - an expanded rig shows its pods; a collapsed pod is a one-row tile;
//   - seats are readable fixed-size chips in a two-column grid per pod.
// Relationships stay understandable at every level: an edge whose endpoint
// sits inside a collapsed pod/rig is re-attached to that tile and merged
// (with a count) instead of disappearing.
//
// Identity: node ids are the spatial keys (host/rig/kind/served node id), so
// duplicate display names never merge two entities. Labels that collide in
// the same group carry a qualifier.

import type { Edge, Node } from "@xyflow/react";
import type {
  SpatialAgent,
  SpatialRig,
  SpatialSeatStatus,
  SpatialTone,
} from "./spatial-topology.js";

export const PHONE_SEAT_W = 148;
export const PHONE_SEAT_H = 48;
export const PHONE_SEAT_GAP = 8;
export const PHONE_POD_PAD = 8;
export const PHONE_POD_HEADER = 44;
export const PHONE_POD_SEAT_COLS = 2;
export const PHONE_POD_W = PHONE_POD_SEAT_COLS * PHONE_SEAT_W + (PHONE_POD_SEAT_COLS - 1) * PHONE_SEAT_GAP + 2 * PHONE_POD_PAD;
export const PHONE_RIG_PAD = 8;
export const PHONE_RIG_HEADER = 48;
export const PHONE_RIG_TILE_H = 76;
export const PHONE_BLOCK_GAP = 10;
export const PHONE_COLUMN_GAP = 16;
/** A rig with more seats than this opens with its pods collapsed. */
export const PHONE_POD_AUTO_COLLAPSE_SEATS = 24;
/** Host scope opens every rig expanded only while the whole scope stays this small. */
export const PHONE_HOST_AUTO_EXPAND_SEATS = 16;

export type PhoneTally = Record<SpatialTone, number>;

export type PhoneRigEntry =
  | { kind: "ready"; rig: SpatialRig }
  | { kind: "error"; rigId: string; rigName: string; message: string }
  | { kind: "loading"; rigId: string; rigName: string };

export interface PhoneRigNodeData {
  kind: "rig";
  rigId: string;
  rigName: string;
  /** Set when another rig in view has the same name: the exact id disambiguates. */
  qualifier: string | null;
  state: "ready" | "error" | "loading";
  message: string | null;
  expanded: boolean;
  /** Rig scope/pod scope: the rig is the scope itself and cannot collapse. */
  collapsible: boolean;
  seatCount: number;
  podCount: number;
  tally: PhoneTally;
  issueCount: number;
}

export interface PhonePodNodeData {
  kind: "pod";
  podKey: string;
  rigId: string;
  label: string;
  namespace: string;
  /** Another pod in this rig resolves to the same namespace: no exact pod route. */
  ambiguous: boolean;
  /** Loose seats with no pod; a group, not a navigable pod. */
  loose: boolean;
  expanded: boolean;
  seatCount: number;
  tally: PhoneTally;
}

export interface PhoneSeatNodeData {
  kind: "seat";
  agentKey: string;
  rigId: string;
  nodeId: string;
  label: string;
  qualifier: string | null;
  tone: SpatialTone;
  statusLabel: string;
  stale: boolean;
  problem: boolean;
  runtime: string | null;
}

export interface PhoneTruncatedNodeData {
  kind: "truncated";
  count: number;
}

export type PhoneNodeData = PhoneRigNodeData | PhonePodNodeData | PhoneSeatNodeData | PhoneTruncatedNodeData;

export interface PhoneEdgeData {
  kinds: string[];
  /** Served relationships represented by this drawn edge (>1 when merged). */
  count: number;
  /** Seat keys at either end of the represented relationships. */
  agentKeys: string[];
  merged: boolean;
}

export type PhoneNode = Node & { data: PhoneNodeData & Record<string, unknown>; width: number; height: number };
export type PhoneEdge = Edge & { data: PhoneEdgeData & Record<string, unknown> };

export interface PhoneGraphLayoutInput {
  entries: PhoneRigEntry[];
  truncatedRigCount: number;
  statusByKey: ReadonlyMap<string, SpatialSeatStatus>;
  /** Host scope only; rig/pod scope always expands its single rig. */
  expandedRigIds: ReadonlySet<string>;
  collapsedPodKeys: ReadonlySet<string>;
  /** 1–3 masonry columns (see phoneGraphColumns). */
  columns: number;
  scopeKind: "host" | "rig" | "pod";
}

export interface PhoneGraphLayout {
  nodes: PhoneNode[];
  edges: PhoneEdge[];
  bounds: { x: number; y: number; width: number; height: number };
  /** Drawn node that currently represents each seat (itself, or a collapsed tile). */
  representativeOf: ReadonlyMap<string, string>;
  /** Stable for unchanged structure; changes on expand/collapse/columns. */
  signature: string;
}

const TONES: SpatialTone[] = ["active", "needs_input", "blocked", "idle", "unknown", "offline"];

export function emptyTally(): PhoneTally {
  return { active: 0, needs_input: 0, blocked: 0, idle: 0, unknown: 0, offline: 0 };
}

export function tallyTones(agentKeys: readonly string[], statusByKey: ReadonlyMap<string, SpatialSeatStatus>): PhoneTally {
  const tally = emptyTally();
  for (const key of agentKeys) tally[statusByKey.get(key)?.tone ?? "unknown"] += 1;
  return tally;
}

export function tallyEntries(tally: PhoneTally): Array<[SpatialTone, number]> {
  return TONES.filter((tone) => tally[tone] > 0).map((tone) => [tone, tally[tone]]);
}

/** Masonry column count for a canvas width (CSS px). */
export function phoneGraphColumns(containerWidth: number): number {
  if (!Number.isFinite(containerWidth) || containerWidth <= 0) return 1;
  return Math.max(1, Math.min(3, Math.floor((containerWidth + PHONE_COLUMN_GAP) / 380)));
}

/** Default host-scope expansion: small scopes open fully, dense fleets open as
 *  tiles. An explicit operator choice (shared with the desktop graph) wins,
 *  and the rig holding the URL selection always opens so it is visible. */
export function defaultPhoneExpandedRigIds(
  entries: readonly PhoneRigEntry[],
  explicit: ReadonlyMap<string, boolean>,
  selectedRigId: string | null,
): Set<string> {
  const ready = entries.filter((e): e is Extract<PhoneRigEntry, { kind: "ready" }> => e.kind === "ready");
  const seats = ready.reduce((sum, e) => sum + e.rig.agents.length, 0);
  const openByDefault = ready.length <= 1 || seats <= PHONE_HOST_AUTO_EXPAND_SEATS;
  const out = new Set<string>();
  for (const e of ready) {
    const chosen = explicit.get(e.rig.rigId);
    if (chosen ?? openByDefault) out.add(e.rig.rigId);
  }
  // An explicit collapse of that rig still wins (the operator chose it).
  if (selectedRigId && !explicit.has(selectedRigId) && ready.some((e) => e.rig.rigId === selectedRigId)) out.add(selectedRigId);
  return out;
}

/** Pods of dense rigs open collapsed; the pod holding the selection stays open. */
export function defaultPhoneCollapsedPodKeys(rigs: readonly SpatialRig[], selectedPodKey: string | null): Set<string> {
  const out = new Set<string>();
  for (const rig of rigs) {
    if (rig.agents.length <= PHONE_POD_AUTO_COLLAPSE_SEATS) continue;
    for (const pod of rig.pods) if (pod.key !== selectedPodKey) out.add(pod.key);
  }
  return out;
}

function seatLabels(agents: readonly SpatialAgent[]): Map<string, { label: string; qualifier: string | null }> {
  const counts = new Map<string, number>();
  for (const a of agents) counts.set(a.displayName, (counts.get(a.displayName) ?? 0) + 1);
  const out = new Map<string, { label: string; qualifier: string | null }>();
  for (const a of agents) {
    const dup = (counts.get(a.displayName) ?? 0) > 1;
    // The logical id is the operator-facing identity; the served node id is
    // the last resort when even that collides (or is absent).
    let qualifier: string | null = null;
    if (dup) qualifier = a.logicalId && a.logicalId !== a.displayName ? a.logicalId : a.nodeId;
    out.set(a.key, { label: a.displayName, qualifier });
  }
  // Still colliding after the logical id (same logical id twice): node id.
  const seen = new Map<string, number>();
  for (const a of agents) {
    const v = out.get(a.key)!;
    const k = `${v.label}\u0000${v.qualifier ?? ""}`;
    seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  for (const a of agents) {
    const v = out.get(a.key)!;
    if ((seen.get(`${v.label}\u0000${v.qualifier ?? ""}`) ?? 0) > 1) out.set(a.key, { label: v.label, qualifier: a.nodeId });
  }
  return out;
}

function seatGrid(count: number): { rows: number; height: number } {
  const rows = Math.ceil(count / PHONE_POD_SEAT_COLS);
  return { rows, height: rows === 0 ? 0 : rows * PHONE_SEAT_H + (rows - 1) * PHONE_SEAT_GAP };
}

interface Block {
  /** Pod/group node (relative to the rig content origin). */
  height: number;
  place: (x: number, y: number, out: PhoneNode[], rep: Map<string, string>) => void;
}

function buildRigBlocks(
  rig: SpatialRig,
  input: PhoneGraphLayoutInput,
  labels: Map<string, { label: string; qualifier: string | null }>,
): Block[] {
  const agentByKey = new Map(rig.agents.map((a) => [a.key, a]));
  const namespaceCount = new Map<string, number>();
  for (const pod of rig.pods) namespaceCount.set(pod.namespace, (namespaceCount.get(pod.namespace) ?? 0) + 1);

  const seatNode = (agent: SpatialAgent, x: number, y: number): PhoneNode => {
    const status = input.statusByKey.get(agent.key);
    const l = labels.get(agent.key)!;
    const data: PhoneSeatNodeData = {
      kind: "seat",
      agentKey: agent.key,
      rigId: agent.rigId,
      nodeId: agent.nodeId,
      label: l.label,
      qualifier: l.qualifier,
      tone: status?.tone ?? "unknown",
      statusLabel: status?.label ?? "unknown",
      stale: status?.stale ?? false,
      problem: (status?.problems.length ?? 0) > 0,
      runtime: agent.runtime,
    };
    return {
      id: agent.key,
      type: "phoneSeat",
      position: { x, y },
      width: PHONE_SEAT_W,
      height: PHONE_SEAT_H,
      zIndex: 2,
      data: data as PhoneNode["data"],
    };
  };

  const groupBlock = (
    id: string,
    data: Omit<PhonePodNodeData, "expanded" | "seatCount" | "tally">,
    agentKeys: string[],
  ): Block => {
    const expanded = data.loose || !input.collapsedPodKeys.has(data.podKey);
    const grid = seatGrid(agentKeys.length);
    const height = expanded
      ? PHONE_POD_HEADER + (grid.rows ? grid.height + PHONE_POD_PAD : 0)
      : PHONE_POD_HEADER;
    return {
      height,
      place: (x, y, out, rep) => {
        const podData: PhonePodNodeData = {
          ...data,
          expanded,
          seatCount: agentKeys.length,
          tally: tallyTones(agentKeys, input.statusByKey),
        };
        out.push({
          id,
          type: "phonePod",
          position: { x, y },
          width: PHONE_POD_W,
          height,
          zIndex: 1,
          data: podData as PhoneNode["data"],
        });
        if (!expanded) {
          for (const key of agentKeys) rep.set(key, id);
          return;
        }
        agentKeys.forEach((key, i) => {
          const agent = agentByKey.get(key);
          if (!agent) return;
          const col = i % PHONE_POD_SEAT_COLS;
          const row = Math.floor(i / PHONE_POD_SEAT_COLS);
          out.push(seatNode(
            agent,
            x + PHONE_POD_PAD + col * (PHONE_SEAT_W + PHONE_SEAT_GAP),
            y + PHONE_POD_HEADER + row * (PHONE_SEAT_H + PHONE_SEAT_GAP),
          ));
          rep.set(key, agent.key);
        });
      },
    };
  };

  const blocks: Block[] = rig.pods.map((pod) => groupBlock(pod.key, {
    kind: "pod",
    podKey: pod.key,
    rigId: rig.rigId,
    label: pod.label,
    namespace: pod.namespace,
    ambiguous: (namespaceCount.get(pod.namespace) ?? 0) > 1,
    loose: false,
  }, pod.agentKeys.filter((k) => agentByKey.has(k))));
  const loose = rig.looseAgentKeys.filter((k) => agentByKey.has(k));
  if (loose.length > 0) {
    const id = `${rig.key}/loose`;
    blocks.push(groupBlock(id, {
      kind: "pod",
      podKey: id,
      rigId: rig.rigId,
      label: "No pod",
      namespace: "",
      ambiguous: false,
      loose: true,
    }, loose));
  }
  return blocks;
}

/** Place blocks in `cols` masonry columns; returns content size. */
function masonry(heights: number[], cols: number, colWidth: number, gap: number): { positions: Array<{ x: number; y: number }>; width: number; height: number } {
  const colHeights = new Array(Math.max(1, cols)).fill(0) as number[];
  const positions = heights.map((h) => {
    let c = 0;
    for (let i = 1; i < colHeights.length; i++) if (colHeights[i]! < colHeights[c]!) c = i;
    const pos = { x: c * (colWidth + gap), y: colHeights[c]! === 0 ? 0 : colHeights[c]! + gap };
    colHeights[c] = pos.y + h;
    return pos;
  });
  const used = Math.min(Math.max(1, cols), Math.max(1, heights.length));
  return { positions, width: used * colWidth + (used - 1) * gap, height: Math.max(0, ...colHeights) };
}

function chooseHandles(a: PhoneNode, b: PhoneNode): { sourceHandle: string; targetHandle: string } {
  const ax = a.position.x + a.width / 2;
  const ay = a.position.y + a.height / 2;
  const bx = b.position.x + b.width / 2;
  const by = b.position.y + b.height / 2;
  const dx = bx - ax;
  const dy = by - ay;
  if (Math.abs(dy) >= Math.abs(dx) * 0.6) {
    return dy >= 0 ? { sourceHandle: "s-bottom", targetHandle: "t-top" } : { sourceHandle: "s-top", targetHandle: "t-bottom" };
  }
  return dx >= 0 ? { sourceHandle: "s-right", targetHandle: "t-left" } : { sourceHandle: "s-left", targetHandle: "t-right" };
}

export function layoutPhoneGraph(input: PhoneGraphLayoutInput): PhoneGraphLayout {
  const nodes: PhoneNode[] = [];
  const rep = new Map<string, string>();
  const columns = Math.max(1, Math.min(3, Math.floor(input.columns) || 1));
  // Host scope stacks rigs in columns; a single scoped rig spreads its pods
  // across the columns instead.
  const rigCols = input.scopeKind === "host" ? columns : 1;
  const podCols = input.scopeKind === "host" ? 1 : columns;
  const nameCount = new Map<string, number>();
  for (const e of input.entries) {
    const name = e.kind === "ready" ? e.rig.rigName : e.rigName;
    nameCount.set(name, (nameCount.get(name) ?? 0) + 1);
  }

  type Placed = { height: number; width: number; place: (x: number, y: number) => void };
  const items: Placed[] = input.entries.map((entry) => {
    const rigId = entry.kind === "ready" ? entry.rig.rigId : entry.rigId;
    const rigName = entry.kind === "ready" ? entry.rig.rigName : entry.rigName;
    const qualifier = (nameCount.get(rigName) ?? 0) > 1 ? rigId : null;
    const rigKeyId = entry.kind === "ready" ? entry.rig.key : `rig:${rigId}`;
    const ready = entry.kind === "ready" ? entry.rig : null;
    const collapsible = input.scopeKind === "host" && ready !== null;
    const expanded = ready !== null && (input.scopeKind !== "host" || input.expandedRigIds.has(rigId));
    const baseData: PhoneRigNodeData = {
      kind: "rig",
      rigId,
      rigName,
      qualifier,
      state: entry.kind,
      message: entry.kind === "error" ? entry.message : null,
      expanded,
      collapsible,
      seatCount: ready?.agents.length ?? 0,
      podCount: ready?.pods.length ?? 0,
      tally: ready ? tallyTones(ready.agents.map((a) => a.key), input.statusByKey) : emptyTally(),
      issueCount: ready?.issues.length ?? 0,
    };
    const tileWidth = podCols * PHONE_POD_W + (podCols - 1) * PHONE_COLUMN_GAP + 2 * PHONE_RIG_PAD;
    if (!ready || !expanded) {
      return {
        width: tileWidth,
        height: PHONE_RIG_TILE_H,
        place: (x, y) => {
          nodes.push({ id: rigKeyId, type: "phoneRig", position: { x, y }, width: tileWidth, height: PHONE_RIG_TILE_H, zIndex: 0, data: baseData as PhoneNode["data"] });
          if (ready) for (const a of ready.agents) rep.set(a.key, rigKeyId);
        },
      };
    }
    const labels = seatLabels(ready.agents);
    const blocks = buildRigBlocks(ready, input, labels);
    const packed = masonry(blocks.map((b) => b.height), podCols, PHONE_POD_W, PHONE_BLOCK_GAP);
    const width = tileWidth;
    const height = PHONE_RIG_HEADER + (blocks.length ? packed.height + PHONE_RIG_PAD : 0);
    return {
      width,
      height,
      place: (x, y) => {
        nodes.push({ id: rigKeyId, type: "phoneRig", position: { x, y }, width, height, zIndex: 0, data: baseData as PhoneNode["data"] });
        blocks.forEach((b, i) => b.place(x + PHONE_RIG_PAD + packed.positions[i]!.x, y + PHONE_RIG_HEADER + packed.positions[i]!.y, nodes, rep));
      },
    };
  });
  if (input.truncatedRigCount > 0) {
    const width = PHONE_POD_W + 2 * PHONE_RIG_PAD;
    items.push({
      width,
      height: PHONE_RIG_TILE_H,
      place: (x, y) => {
        const data: PhoneTruncatedNodeData = { kind: "truncated", count: input.truncatedRigCount };
        nodes.push({ id: "phone-graph/truncated", type: "phoneTruncated", position: { x, y }, width, height: PHONE_RIG_TILE_H, zIndex: 0, data: data as PhoneNode["data"] });
      },
    });
  }

  const colWidth = Math.max(0, ...items.map((i) => i.width));
  const packed = masonry(items.map((i) => i.height), rigCols, colWidth, PHONE_COLUMN_GAP);
  items.forEach((item, i) => item.place(packed.positions[i]!.x, packed.positions[i]!.y));

  // Relationships, re-attached to whatever currently represents each seat.
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const merged = new Map<string, { source: string; target: string; kinds: Set<string>; count: number; agentKeys: Set<string>; firstKey: string }>();
  for (const entry of input.entries) {
    if (entry.kind !== "ready") continue;
    for (const edge of entry.rig.edges) {
      const source = rep.get(edge.sourceKey);
      const target = rep.get(edge.targetKey);
      if (!source || !target || source === target) continue;
      const id = `${source}\u0000${target}`;
      let m = merged.get(id);
      if (!m) merged.set(id, (m = { source, target, kinds: new Set(), count: 0, agentKeys: new Set(), firstKey: edge.key }));
      m.kinds.add(edge.kind);
      m.count += 1;
      m.agentKeys.add(edge.sourceKey);
      m.agentKeys.add(edge.targetKey);
    }
  }
  const edges: PhoneEdge[] = [];
  for (const m of merged.values()) {
    const a = byId.get(m.source)!;
    const b = byId.get(m.target)!;
    const isMerged = m.count > 1 || a.type !== "phoneSeat" || b.type !== "phoneSeat";
    const data: PhoneEdgeData = { kinds: [...m.kinds].sort(), count: m.count, agentKeys: [...m.agentKeys], merged: isMerged };
    edges.push({
      id: m.count === 1 && !isMerged ? m.firstKey : `merged:${m.source}->${m.target}`,
      source: m.source,
      target: m.target,
      ...chooseHandles(a, b),
      data: data as PhoneEdge["data"],
    });
  }

  const signature = [
    input.scopeKind,
    columns,
    input.truncatedRigCount,
    ...nodes.map((n) => `${n.id}@${Math.round(n.position.x)},${Math.round(n.position.y)},${n.width}x${n.height}`),
  ].join("|");
  return {
    nodes,
    edges,
    bounds: { x: 0, y: 0, width: packed.width, height: packed.height },
    representativeOf: rep,
    signature,
  };
}

export interface PhoneViewport { x: number; y: number; zoom: number }

/** Readable opening viewport: fit everything when that stays legible,
 *  otherwise fit the width and start at the top (the operator pans down)
 *  rather than shrinking chips to unreadable dots. */
export function readablePhoneViewport(
  bounds: { x: number; y: number; width: number; height: number },
  container: { width: number; height: number },
  options: { padding?: number; maxZoom?: number; minReadableZoom?: number } = {},
): PhoneViewport | null {
  const padding = options.padding ?? 12;
  const maxZoom = options.maxZoom ?? 1.25;
  const minReadable = options.minReadableZoom ?? 0.72;
  if (container.width <= 0 || container.height <= 0 || bounds.width <= 0 || bounds.height <= 0) return null;
  const fitW = (container.width - 2 * padding) / bounds.width;
  const fitH = (container.height - 2 * padding) / bounds.height;
  const fit = Math.min(fitW, fitH);
  if (fit >= minReadable) {
    const zoom = Math.min(fit, maxZoom);
    return {
      zoom,
      x: (container.width - bounds.width * zoom) / 2 - bounds.x * zoom,
      y: (container.height - bounds.height * zoom) / 2 - bounds.y * zoom,
    };
  }
  const zoom = Math.min(maxZoom, Math.max(fitW, minReadable));
  const x = fitW >= minReadable ? (container.width - bounds.width * zoom) / 2 - bounds.x * zoom : padding - bounds.x * zoom;
  return { zoom, x, y: padding - bounds.y * zoom };
}

/** Viewport centring one node at a readable zoom (selection follow). */
export function centerPhoneViewport(
  node: { position: { x: number; y: number }; width: number; height: number },
  container: { width: number; height: number },
  zoom: number,
): PhoneViewport | null {
  if (container.width <= 0 || container.height <= 0) return null;
  const cx = node.position.x + node.width / 2;
  const cy = node.position.y + node.height / 2;
  return { zoom, x: container.width / 2 - cx * zoom, y: container.height / 2 - cy * zoom };
}
