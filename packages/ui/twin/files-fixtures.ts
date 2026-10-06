// TEST-ONLY fictional Files fixtures for the digital twin (Files/Markdown
// cohort). In-memory roots answer /api/files/{roots,list,read,write} with
// DTOs that pass the real read guards, including a symlink-style alias
// (authored path ≠ resolvedPath), equal filenames in two roots, uniform
// CRLF/CR, mixed endings, empty, binary and truncated reads, and CAS writes
// (409 on a stale token). Nothing touches disk, a daemon or user files.
//
// Not covered: <img>/download requests to /api/files/asset bypass fetch and
// reach the dev server; browser image proof needs the real daemon fixture.
//
// Registration (operator-owned fetch-stub.ts), before the existing
// /api/files handlers:
//   const files = filesTwinBody(pathname, search, method, body);
//   if (files) return json(files.body, files.status);
// and append `...filesTwinRoots` to the /api/files/roots response.

import type { AllowlistRoot, FileEntry, FilesReadResponse } from "../src/hooks/useFiles.js";

const MTIME0 = "2025-09-01T02:00:00.000Z";

interface TwinFile { content: string; mtime: string; binary?: boolean; truncated?: boolean; aliasOf?: string }

const encoder = new TextEncoder();

function fictionalHash(text: string): string {
  // FNV-1a, repeated to 64 hex chars. Fictional change token, not SHA-256.
  let out = "";
  for (let round = 0; out.length < 64; round++) {
    let h = 0x811c9dc5 ^ round;
    for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    out += h.toString(16).padStart(8, "0");
  }
  return out.slice(0, 64);
}

const README_A = [
  "# Demo notes",
  "",
  "![diagram](media/diagram.svg)",
  "",
  "Read the [setup guide](guides/setup.md#install), the [Résumé](r%C3%A9sum%C3%A9.md) or [spaced name](space%20%26%20name.md).",
  "External: [OpenRig docs](https://openrig.dev/docs).",
  "",
  "## Overview",
  "",
  "```md",
  "## Overview",
  "```",
  "",
  "## Overview",
  "",
  "Jump to the [second overview](#overview-1).",
  "",
].join("\n");

const roots: Record<string, { path: string; files: Record<string, TwinFile> }> = {
  "demo-notes": {
    path: "/home/demo/files/demo-notes",
    files: {
      "README.md": { content: README_A, mtime: MTIME0 },
      "guides/setup.md": { content: "# Setup\n\n[Back to readme](../README.md)\n\n## Install\n\nInstall steps.\n\n## Usage\n\nUsage notes.\n", mtime: MTIME0 },
      "guides/alias.md": { content: "", mtime: MTIME0, aliasOf: "guides/setup.md" },
      "résumé.md": { content: "# Résumé\n\nUnicode name.\n", mtime: MTIME0 },
      "space & name.md": { content: "# Spaced\n", mtime: MTIME0 },
      "windows.txt": { content: "first\r\nsecond\r\nthird\r\n", mtime: MTIME0 },
      "classic-mac.txt": { content: "first\rsecond\rthird\r", mtime: MTIME0 },
      "mixed.txt": { content: "same\r\nsame\nother\rend\n", mtime: MTIME0 },
      "empty.md": { content: "", mtime: MTIME0 },
      "blob.bin": { content: "A��B", mtime: MTIME0, binary: true },
      "huge.log": { content: "line\n".repeat(200), mtime: MTIME0, truncated: true },
    },
  },
  "demo-mirror": {
    path: "/home/demo/files/demo-mirror",
    files: {
      "README.md": { content: "# Mirror readme\n\nSame filename, different root.\n", mtime: MTIME0 },
    },
  },
};

export const filesTwinRoots: AllowlistRoot[] = Object.entries(roots).map(([name, r]) => ({ name, path: r.path }));

function readDto(rootName: string, path: string): FilesReadResponse | null {
  const root = roots[rootName];
  const authored = root?.files[path];
  if (!root || !authored) return null;
  const canonicalPath = authored.aliasOf ?? path;
  const file = root.files[canonicalPath]!;
  const bytes = encoder.encode(file.content).length;
  const totalBytes = file.truncated ? bytes * 4 : bytes;
  return {
    root: rootName,
    path,
    absolutePath: `${root.path}/${canonicalPath}`,
    resolvedPath: canonicalPath,
    content: file.content,
    mtime: file.mtime,
    contentHash: fictionalHash(file.content + (file.truncated ? ":full" : "")),
    size: totalBytes,
    binary: file.binary === true,
    truncated: file.truncated === true,
    truncatedAtBytes: file.truncated ? bytes : null,
    totalBytes,
  };
}

function listDto(rootName: string, dir: string): { root: string; path: string; entries: FileEntry[] } | null {
  const root = roots[rootName];
  if (!root) return null;
  const prefix = dir ? `${dir}/` : "";
  const entries = new Map<string, FileEntry>();
  for (const [p, f] of Object.entries(root.files)) {
    if (!p.startsWith(prefix)) continue;
    const rest = p.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash >= 0) entries.set(rest.slice(0, slash), { name: rest.slice(0, slash), type: "dir", size: null, mtime: null });
    else entries.set(rest, { name: rest, type: "file", size: encoder.encode(f.content).length, mtime: f.mtime });
  }
  if (dir && entries.size === 0) return null;
  return { root: rootName, path: dir, entries: [...entries.values()].sort((a, b) => a.name.localeCompare(b.name)) };
}

export function filesTwinBody(pathname: string, search: URLSearchParams, method = "GET", body?: unknown): { status: number; body: unknown } | null {
  if (!pathname.startsWith("/api/files/")) return null;
  if (pathname === "/api/files/write" && method === "POST") {
    const req = body as { root?: string; path?: string; content?: string; expectedMtime?: string; expectedContentHash?: string } | undefined;
    if (!req?.root || !(req.root in roots)) return null;
    const current = req.path ? readDto(req.root, req.path) : null;
    if (!current || typeof req.content !== "string") return { status: 404, body: { error: "not_found" } };
    if (current.mtime !== req.expectedMtime || current.contentHash !== req.expectedContentHash) {
      return { status: 409, body: { error: "conflict", currentMtime: current.mtime, currentContentHash: current.contentHash, message: "file changed externally" } };
    }
    const canonical = current.resolvedPath ?? current.path;
    const mtime = new Date(Date.parse(current.mtime) + 1000).toISOString();
    roots[req.root]!.files[canonical] = { content: req.content, mtime };
    const next = readDto(req.root, req.path!)!;
    return { status: 200, body: { root: req.root, path: req.path, absolutePath: next.absolutePath, newMtime: next.mtime, newContentHash: next.contentHash, byteCountDelta: next.size - current.size } };
  }
  const rootName = search.get("root") ?? "";
  if (!(rootName in roots)) return null;
  const path = search.get("path") ?? "";
  if (pathname === "/api/files/list") {
    const dto = listDto(rootName, path);
    return dto ? { status: 200, body: dto } : { status: 404, body: { error: "not_found" } };
  }
  if (pathname === "/api/files/read") {
    const dto = readDto(rootName, path);
    return dto ? { status: 200, body: dto } : { status: 404, body: { error: "not_found" } };
  }
  return null;
}
