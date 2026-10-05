// Source-aware Files reading contract shared by the Files workspace, the
// drawer FileViewer, MarkdownViewer and every caller that opens a file.
//
// One attributable target: {originInstance, root, path, anchor?}. The origin
// is the exact host whose data produced the reference. /api/files/* only
// reads the connected LOCAL instance and has no remote forwarding, so a
// reference is readable only when its origin AND the current known host
// selection are both local. Absent/unknown/remote origins never produce a
// local read, image, download or write.
//
// Relative references resolve against the served canonical source
// (`resolvedPath`, e.g. the target of a symlink) like TUI reading.ts, never
// against the SPA URL or an authored alias path. Root containment remains
// server-owned; an escape above the root is refused here, not normalized away.

import { LOCAL_HOST_ID } from "../../lib/host-param.js";
import { fileAssetUrl, type FilesReadResponse } from "../../hooks/useFiles.js";

export interface FileProjectIdentity {
  projectId: string;
  projectRoot: string;
}

export interface FileSourceTarget {
  /** Exact host id that produced this reference; null = unknown. */
  originInstance: string | null;
  /** Allowlist root name served by /api/files/roots on that instance. */
  root: string;
  /** Authored root-relative path (the read request identity). */
  path: string;
  /** Heading slug inside the document (TUI headingSlug semantics). */
  anchor?: string;
  /** Applicable catalog project identity, carried for attribution/return. */
  project?: FileProjectIdentity;
}

/** A served read's source facts: authored request path versus canonical. */
export interface FileSourceFacts {
  target: FileSourceTarget;
  /** Canonical root-relative path (served resolvedPath; falls back to path). */
  canonicalPath: string;
  absolutePath: string | null;
}

export function sourceFactsFromRead(target: FileSourceTarget, read: FilesReadResponse | null | undefined): FileSourceFacts {
  return {
    target,
    canonicalPath: read?.resolvedPath ?? read?.path ?? target.path,
    absolutePath: read?.absolutePath ?? null,
  };
}

export type FileAdmissionBlock = "unknown-origin" | "remote-origin" | "selection-unknown" | "selection-remote";
export type FileOriginAdmission =
  | { admitted: true }
  | { admitted: false; reason: FileAdmissionBlock; message: string };

/** Pure admission: local effects need a local origin AND a known local selection. */
export function fileOriginAdmission(originInstance: string | null | undefined, knownSelectedHost: string | undefined): FileOriginAdmission {
  if (!originInstance) {
    return { admitted: false, reason: "unknown-origin", message: "This file reference has no known source instance, so nothing was read. Reopen it from the page that lists it." };
  }
  if (originInstance !== LOCAL_HOST_ID) {
    return { admitted: false, reason: "remote-origin", message: `This file belongs to host ${originInstance}. Files are read only from the connected local instance and are not forwarded; nothing was read.` };
  }
  if (knownSelectedHost === undefined) {
    return { admitted: false, reason: "selection-unknown", message: "Reading the host selection. Local files stay closed until the connected instance is confirmed." };
  }
  if (knownSelectedHost !== LOCAL_HOST_ID) {
    return { admitted: false, reason: "selection-remote", message: `Remote host ${knownSelectedHost} is selected. Local files are unavailable until you select the connected local instance; nothing was read.` };
  }
  return { admitted: true };
}

export function fileTargetKey(target: Pick<FileSourceTarget, "originInstance" | "root" | "path">): string {
  return `${target.originInstance ?? "\u0000unknown"}\u0000${target.root}\u0000${target.path}`;
}

// --- paths --------------------------------------------------------------

export function parentPath(p: string): string {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(0, i) : "";
}

/** POSIX normalize for root-relative paths. A result starting with "../"
 * or equal to ".." escapes the root and is reported, never clamped. */
export function normalizeRelativePath(p: string): string {
  const out: string[] = [];
  for (const segment of p.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else out.push("..");
      continue;
    }
    out.push(segment);
  }
  return out.join("/");
}

function escapesRoot(p: string): boolean {
  return p === ".." || p.startsWith("../");
}

// --- references ----------------------------------------------------------

export type FileReference =
  | { kind: "external"; url: string }
  | { kind: "anchor"; anchor: string }
  | { kind: "file"; target: FileSourceTarget }
  | { kind: "unsupported"; reason: string };

/** Markdown link destination: strip optional <...> and a quoted title. */
export function markdownDestination(raw: string): string {
  let href = raw.trim();
  const titled = href.match(/^(.*?)\s+(?:"[^"]*"|'[^']*')$/);
  if (titled) href = titled[1]!.trim();
  if (href.startsWith("<") && href.endsWith(">")) href = href.slice(1, -1);
  return href;
}

const EXTERNAL = /^https?:\/\//i;
const SCHEME = /^[a-z][a-z\d+.-]*:/i;

/** TUI referenceAction parity, against the served canonical source path. */
export function resolveFileReference(source: FileSourceFacts, rawHref: string): FileReference {
  const href = markdownDestination(rawHref);
  if (!href) return { kind: "unsupported", reason: "Empty reference; nothing opened." };
  if (EXTERNAL.test(href)) return { kind: "external", url: href };
  if (SCHEME.test(href) || href.startsWith("//")) return { kind: "unsupported", reason: "Unsupported reference scheme; nothing opened." };
  const hash = href.indexOf("#");
  let name: string;
  let anchor: string | undefined;
  try {
    name = decodeURIComponent(hash < 0 ? href : href.slice(0, hash));
    anchor = hash < 0 ? undefined : decodeURIComponent(href.slice(hash + 1));
  } catch {
    return { kind: "unsupported", reason: "Invalid percent-encoding in reference; nothing opened." };
  }
  if (!name) return anchor ? { kind: "anchor", anchor } : { kind: "unsupported", reason: "Empty reference; nothing opened." };
  if (name.startsWith("/")) return { kind: "unsupported", reason: "Absolute path reference; open it from its Files root." };
  if (!source.target.root) return { kind: "unsupported", reason: "Relative reference in an inline excerpt with no file source; nothing opened." };
  const resolved = normalizeRelativePath(`${parentPath(source.canonicalPath)}/${name}`);
  if (escapesRoot(resolved) || resolved === "") return { kind: "unsupported", reason: `Reference leaves root ${source.target.root}; nothing opened.` };
  if (resolved === normalizeRelativePath(source.canonicalPath) || resolved === normalizeRelativePath(source.target.path)) {
    return anchor ? { kind: "anchor", anchor } : { kind: "file", target: { ...withoutAnchor(source.target) } };
  }
  return {
    kind: "file",
    target: { ...withoutAnchor(source.target), path: resolved, ...(anchor ? { anchor } : {}) },
  };
}

function withoutAnchor(target: FileSourceTarget): FileSourceTarget {
  const { anchor: _anchor, ...rest } = target;
  return rest;
}

export type FileAssetReference =
  | { kind: "external"; url: string }
  | { kind: "same-origin"; url: string }
  | { kind: "local"; root: string; path: string; url: string }
  | { kind: "unsupported"; reason: string };

/** Image/asset source. Local siblings join the canonical source directory
 * (".", for a root-level file) and leave containment to the server. */
export function resolveFileAsset(source: FileSourceFacts, rawSrc: string): FileAssetReference {
  const src = markdownDestination(rawSrc);
  if (!src) return { kind: "unsupported", reason: "Empty image source." };
  if (EXTERNAL.test(src) || src.startsWith("data:")) return { kind: "external", url: src };
  if (src.startsWith("//") || SCHEME.test(src)) return { kind: "unsupported", reason: "Unsupported image scheme; not loaded." };
  if (src.startsWith("/")) return { kind: "same-origin", url: src };
  if (!source.target.root) return { kind: "unsupported", reason: "Relative image in an inline excerpt with no file source; not loaded." };
  let name: string;
  try { name = decodeURIComponent(src.split("#")[0]!); }
  catch { return { kind: "unsupported", reason: "Invalid percent-encoding in image source; not loaded." }; }
  const dir = parentPath(source.canonicalPath) || ".";
  const path = `${dir}/${name}`;
  return { kind: "local", root: source.target.root, path, url: fileAssetUrl(source.target.root, path) };
}

// --- /files location -----------------------------------------------------

/** Exact /files query. Strings round-trip byte-for-byte via URLSearchParams;
 * the router's JSON search coercion is never consulted. Drafts are never
 * serialized here. */
export interface FilesLocation {
  root?: string;
  /** Directory shown in the tree (root-relative, "" = root). */
  dir?: string;
  /** Selected file (authored root-relative path). */
  file?: string;
  anchor?: string;
  /** Directory filter text. */
  q?: string;
  /** Exact origin instance when a caller attributes a reference. */
  origin?: string;
  project?: string;
  projectRoot?: string;
  /** Same-app return href and its label. */
  from?: string;
  fromLabel?: string;
}

const LOCATION_KEYS = ["root", "dir", "file", "anchor", "q", "origin", "project", "projectRoot", "from", "fromLabel"] as const;

export function isSafeReturnHref(href: string): boolean {
  return href.startsWith("/") && !href.startsWith("//") && !href.includes("\\") && href.length <= 2048 && !/[\u0000-\u001f]/.test(href);
}

export function parseFilesLocation(query: string): FilesLocation {
  const params = new URLSearchParams(query.startsWith("?") ? query.slice(1) : query);
  const out: FilesLocation = {};
  for (const key of LOCATION_KEYS) {
    const value = params.get(key);
    if (value === null) continue;
    if (key === "from" && !isSafeReturnHref(value)) continue;
    if (value === "" && key !== "dir" && key !== "q") continue;
    out[key] = value;
  }
  if ((out.project === undefined) !== (out.projectRoot === undefined)) { delete out.project; delete out.projectRoot; }
  return out;
}

export function filesHref(location: FilesLocation): string {
  const params = new URLSearchParams();
  for (const key of LOCATION_KEYS) {
    const value = location[key];
    if (value === undefined) continue;
    if (value === "" && key !== "dir") continue;
    if (key === "from" && !isSafeReturnHref(value)) continue;
    params.set(key, value);
  }
  const query = params.toString();
  return query ? `/files?${query}` : "/files";
}

/** The /files location that opens one target. Unknown origins have no
 * honest destination and return null. */
export function filesLocationForTarget(target: FileSourceTarget, extra: Pick<FilesLocation, "from" | "fromLabel"> = {}): FilesLocation | null {
  if (!target.originInstance) return null;
  return {
    root: target.root,
    dir: parentPath(target.path),
    file: target.path,
    ...(target.anchor ? { anchor: target.anchor } : {}),
    ...(target.originInstance !== LOCAL_HOST_ID ? { origin: target.originInstance } : {}),
    ...(target.project ? { project: target.project.projectId, projectRoot: target.project.projectRoot } : {}),
    ...extra,
  };
}

// --- headings -------------------------------------------------------------

/** TUI reading.ts headingSlug parity. */
export function headingSlug(value: string): string {
  return value.trim().toLowerCase().replace(/[^\p{L}\p{N}_\-\s]/gu, "").replace(/\s/g, "-");
}

/** Assigns GitHub-style duplicate suffixes in document order. */
export function createSlugger(): (text: string) => string {
  const seen = new Map<string, number>();
  return (text) => {
    const slug = headingSlug(text);
    const n = seen.get(slug) ?? 0;
    seen.set(slug, n + 1);
    return n ? `${slug}-${n}` : slug;
  };
}
