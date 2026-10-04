// Slice 28 Checkpoint C-4 — useLibrarySkills consumes /api/skills/library.
//
// Pre-C4 the hook fanned out per-allowlist-root × per-candidate-path probes
// (N×3 fetches) and recursively walked nested category folders client-side.
// QA verdict on slice 28 C-2 (qitem-20260513045711-39ccfdf3) proved that
// approach fails when the operator's allowlist doesn't include the daemon's
// source tree.
//
// Daemon-owned discovery (SkillLibraryDiscoveryService, SC-29 EXCEPTION #11
// cumulative) is the single source of truth: shared skills resolve via the
// daemon install path; workspace skills via the daemon's filesAllowlist.

import { useQuery } from "@tanstack/react-query";
import { boundedJsonRead } from "../lib/bounded-json-read.js";
import { arrayOf, hasShape, isNumber, isText, oneOf, optional, OperatorReadError } from "../lib/operator-read.js";

export type LibrarySkillSource = "workspace" | "openrig-managed";

export interface LibrarySkillFile {
  /** Filename only (no path prefix). */
  name: string;
  /** Path relative to the skill folder root (e.g., "SKILL.md" or "examples/basic.md"). */
  path: string;
  size: number;
  mtime: string;
}

export interface LibrarySkillEntry {
  /** Stable id incl. source + relative path within source tree
   *  (e.g., "openrig-managed:core/openrig-user" or "workspace:<root-name>:skill-name"). */
  id: string;
  /** Leaf skill folder name. */
  name: string;
  source: LibrarySkillSource;
  /** Top-level markdown files of the skill folder. */
  files: LibrarySkillFile[];
  /** Slice 29 HG-4 — absolute filesystem path the daemon reads this skill
   *  from. Operators see this on the skill detail page to know where each
   *  shipped skill actually lives on disk (daemon bundle / plugin / user
   *  workspace). Older discovery APIs omitted this public display fact. */
  absolutePath?: string;
}

function isLibrarySkillEntry(value: unknown): value is LibrarySkillEntry {
  return hasShape(value, {
    id: value => isText(value) && value.length > 0, name: isText,
    source: oneOf("workspace", "openrig-managed"), absolutePath: optional(isText),
    files: arrayOf(file => hasShape(file, { name: isText, path: isText, size: isNumber, mtime: isText })),
  });
}

async function fetchLibrarySkills(signal?: AbortSignal): Promise<LibrarySkillEntry[]> {
  // Daemon-owned connected-instance discovery; no selected-host forwarding.
  const body = await boundedJsonRead<unknown>("/api/skills/library", { signal });
  if (!Array.isArray(body) || !body.every(isLibrarySkillEntry)) {
    throw new OperatorReadError("invalid_contract", "Skill library returned an invalid catalog.");
  }
  return body;
}

export function useLibrarySkills() {
  return useQuery({
    queryKey: ["skills", "library"],
    queryFn: ({ signal }) => fetchLibrarySkills(signal),
    staleTime: 30_000,
    retry: false,
    placeholderData: undefined,
  });
}
