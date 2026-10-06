// Safe 2D renderer projection of an untrusted /api/rigs/:id/graph payload.
//
// The shared transport validates only the {nodes[], edges[]} containers (by
// design: a partial graph is still useful). Individual entries can be null,
// non-objects, duplicated, dangling or self-parenting, and React Flow / the
// layout helpers dereference them directly — {nodes:[null]} crashed RigGraph
// at `node.type`, {edges:[null]} at `edge.data`. This projection keeps every
// usable entry with its exact served identity, drops the rest, and reports
// each drop so the graph can disclose that it is partial.

import type { Edge, Node } from "@xyflow/react";
import { hasUnpairedSurrogate } from "../../lib/topology-search.js";

export type RigGraphIssueKind =
  | "malformed-node"
  | "duplicate-node"
  | "orphan-parent"
  | "parent-cycle"
  | "malformed-edge"
  | "duplicate-edge"
  | "dangling-edge";

export interface RigGraphIssue {
  kind: RigGraphIssueKind;
  detail: string;
}

export interface RigGraphProjection {
  nodes: Node[];
  edges: Edge[];
  issues: RigGraphIssue[];
}

const EMPTY: RigGraphProjection = { nodes: [], edges: [], issues: [] };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isIdentity = (v: unknown): v is string => typeof v === "string" && v.length > 0 && !hasUnpairedSurrogate(v);
const isFinitePoint = (v: unknown): v is { x: number; y: number } =>
  isRecord(v) && Number.isFinite(v.x) && Number.isFinite(v.y);
const quote = (id: string) => JSON.stringify(id.length > 80 ? `${id.slice(0, 80)}…` : id);

export function projectRigGraph(raw: unknown): RigGraphProjection {
  if (!isRecord(raw)) return EMPTY;
  const rawNodes = Array.isArray(raw.nodes) ? raw.nodes : [];
  const rawEdges = Array.isArray(raw.edges) ? raw.edges : [];
  if (rawNodes.length === 0 && rawEdges.length === 0) return EMPTY;
  const issues: RigGraphIssue[] = [];

  const byId = new Map<string, Node>();
  rawNodes.forEach((entry, index) => {
    if (!isRecord(entry) || !isIdentity(entry.id)
      || (entry.type !== undefined && typeof entry.type !== "string")
      || (entry.data !== undefined && entry.data !== null && !isRecord(entry.data))
      || (entry.parentId !== undefined && entry.parentId !== null && typeof entry.parentId !== "string")) {
      issues.push({ kind: "malformed-node", detail: `node entry ${index} is malformed` });
      return;
    }
    if (byId.has(entry.id)) {
      issues.push({ kind: "duplicate-node", detail: `duplicate node id ${quote(entry.id)} (first kept)` });
      return;
    }
    const node = { ...entry, data: isRecord(entry.data) ? entry.data : {} } as Record<string, unknown>;
    if (!isFinitePoint(node.position)) node.position = { x: 0, y: 0 };
    if (node.parentId === null) delete node.parentId;
    byId.set(entry.id, node as unknown as Node);
  });

  // Parents must exist and must not form a cycle (React Flow and the layout
  // walk parent chains). An unusable parent link is cut; the node stays.
  for (const node of byId.values()) {
    if (node.parentId === undefined) continue;
    if (!byId.has(node.parentId)) {
      issues.push({ kind: "orphan-parent", detail: `node ${quote(node.id)} names missing parent ${quote(node.parentId)}` });
      delete (node as { parentId?: string }).parentId;
    }
  }
  for (const node of byId.values()) {
    const seen = new Set<string>([node.id]);
    let cursor = node.parentId;
    while (cursor !== undefined) {
      if (seen.has(cursor)) {
        issues.push({ kind: "parent-cycle", detail: `node ${quote(node.id)} is in a parent cycle` });
        delete (node as { parentId?: string }).parentId;
        break;
      }
      seen.add(cursor);
      cursor = byId.get(cursor)?.parentId;
    }
  }

  const edgeIds = new Set<string>();
  const edges: Edge[] = [];
  rawEdges.forEach((entry, index) => {
    if (!isRecord(entry) || !isIdentity(entry.id) || !isIdentity(entry.source) || !isIdentity(entry.target)
      || (entry.data !== undefined && entry.data !== null && !isRecord(entry.data))) {
      issues.push({ kind: "malformed-edge", detail: `edge entry ${index} is malformed` });
      return;
    }
    if (edgeIds.has(entry.id)) {
      issues.push({ kind: "duplicate-edge", detail: `duplicate edge id ${quote(entry.id)} (first kept)` });
      return;
    }
    if (!byId.has(entry.source) || !byId.has(entry.target)) {
      issues.push({ kind: "dangling-edge", detail: `edge ${quote(entry.id)} references a node that is not in the graph` });
      return;
    }
    edgeIds.add(entry.id);
    const edge = { ...entry } as Record<string, unknown>;
    if (edge.data === null) delete edge.data;
    if (edge.label !== undefined && typeof edge.label !== "string" && typeof edge.label !== "number") delete edge.label;
    edges.push(edge as unknown as Edge);
  });

  return { nodes: [...byId.values()], edges, issues };
}
