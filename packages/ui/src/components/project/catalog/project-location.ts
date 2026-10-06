// Exact catalog-project location. The URL is the durable selection: project ID
// AND canonical root travel together through links, Back and reload. Reads use
// the raw query string (not the router's JSON-coercing search parser) so an ID
// such as "1.0" can never be rewritten into a different identity.

import { createProjectSelection, type CatalogProject, type ProjectSelection } from "../../../lib/project-read.js";
import { OperatorReadError } from "../../../lib/operator-read.js";

export const CATALOG_PROJECT_PATH = "/project/catalog";

export const MISSION_VIEWS = ["story", "workflows", "capacity", "sources"] as const;
export type MissionView = (typeof MISSION_VIEWS)[number];
export const SLICE_VIEWS = ["outcomes", "proof", "work", "story", "docs", "workflow"] as const;
export type SliceView = (typeof SLICE_VIEWS)[number];

export interface CatalogLocation {
  project?: string;
  projectRoot?: string;
  mission?: string;
  slice?: string;
  view?: string;
  /** Inspected frontier packet within the mission's workflows. */
  packet?: string;
  /** Selected-project document path within the selected slice. */
  doc?: string;
}

const KEYS = ["project", "projectRoot", "mission", "slice", "view", "packet", "doc"] as const;

/** Parse a raw `?a=b` string. Unknown keys are ignored; empty values are absent. */
export function parseCatalogLocation(searchStr: string): CatalogLocation {
  const params = new URLSearchParams(searchStr.startsWith("?") ? searchStr.slice(1) : searchStr);
  const out: CatalogLocation = {};
  for (const key of KEYS) {
    const value = params.get(key);
    if (value !== null && value !== "") out[key] = value;
  }
  return out;
}

/** Child coordinates are only meaningful under their parent; drop orphans. */
export function normalizeCatalogLocation(loc: CatalogLocation): CatalogLocation {
  const out: CatalogLocation = {};
  if (loc.project !== undefined) out.project = loc.project;
  if (loc.projectRoot !== undefined) out.projectRoot = loc.projectRoot;
  if (out.project === undefined || out.projectRoot === undefined) return out;
  if (loc.mission === undefined) { if (loc.view !== undefined) out.view = loc.view; return out; }
  out.mission = loc.mission;
  if (loc.slice !== undefined) out.slice = loc.slice;
  if (loc.view !== undefined) out.view = loc.view;
  if (loc.packet !== undefined && loc.slice === undefined) out.packet = loc.packet;
  if (loc.doc !== undefined && loc.slice !== undefined) out.doc = loc.doc;
  return out;
}

export function catalogHref(loc: CatalogLocation): string {
  const normalized = normalizeCatalogLocation(loc);
  const params = new URLSearchParams();
  for (const key of KEYS) {
    const value = normalized[key];
    if (value !== undefined) params.set(key, value);
  }
  const query = params.toString();
  return query ? `${CATALOG_PROJECT_PATH}?${query}` : CATALOG_PROJECT_PATH;
}

export function locationForProject(project: Pick<CatalogProject, "id" | "root">): CatalogLocation {
  return { project: project.id, projectRoot: project.root };
}

export type CatalogSelectionState =
  | { kind: "none" }
  | { kind: "invalid"; reason: string; location: CatalogLocation }
  | { kind: "selected"; selection: ProjectSelection };

/** Both identity halves are required. Neither half is ever resolved by name,
 * by the other half, or from the configured default workspace. */
export function selectionFromLocation(loc: CatalogLocation): CatalogSelectionState {
  if (loc.project === undefined && loc.projectRoot === undefined) return { kind: "none" };
  if (loc.project === undefined || loc.projectRoot === undefined) {
    return { kind: "invalid", location: loc, reason: loc.project === undefined
      ? "This link names a project root without its catalog ID. Choose the project explicitly from the catalog."
      : "This link names a project ID without its canonical root. Choose the project explicitly from the catalog." };
  }
  try {
    return { kind: "selected", selection: createProjectSelection(loc.project, loc.projectRoot) };
  } catch (error) {
    return { kind: "invalid", location: loc, reason: error instanceof OperatorReadError ? error.message : "The linked project identity is malformed." };
  }
}

/** How the URL selection relates to the current catalog read. */
export type CatalogMatch =
  | { kind: "listed"; entry: CatalogProject }
  /** Same ID, different root: the project moved or the link is old. */
  | { kind: "moved"; current: CatalogProject[] }
  /** Same root under a different ID. */
  | { kind: "renamed"; current: CatalogProject[] }
  | { kind: "absent" };

export function matchCatalogSelection(projects: readonly CatalogProject[], selection: ProjectSelection): CatalogMatch {
  const exact = projects.find((p) => p.id === selection.id && p.root === selection.root);
  if (exact) return { kind: "listed", entry: exact };
  const sameId = projects.filter((p) => p.id === selection.id);
  if (sameId.length) return { kind: "moved", current: sameId };
  const sameRoot = projects.filter((p) => p.root === selection.root);
  if (sameRoot.length) return { kind: "renamed", current: sameRoot };
  return { kind: "absent" };
}

/** Count of OTHER catalog entries sharing a display name (identify by ID/root). */
export function duplicateNameCounts(projects: readonly CatalogProject[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const p of projects) counts.set(p.name, (counts.get(p.name) ?? 0) + 1);
  return counts;
}

export function isMissionView(value: string | undefined): value is MissionView {
  return value !== undefined && (MISSION_VIEWS as readonly string[]).includes(value);
}
export function isSliceView(value: string | undefined): value is SliceView {
  return value !== undefined && (SLICE_VIEWS as readonly string[]).includes(value);
}

/** Server codes the daemon uses when an exact catalog selection no longer resolves. */
// (daemon domain/workspace/project-read.ts selectedProject; all HTTP 409).
export const PROJECT_IDENTITY_CODES = new Set(["project_changed", "project_unavailable", "project_not_found", "missions_unavailable", "project_identity_conflict"]);
