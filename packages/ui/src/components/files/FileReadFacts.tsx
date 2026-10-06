// Served read facts shared by the Files workspace and drawer reader:
// authored versus canonical source, size, mtime, full-file hash and
// completeness. Values are the daemon's, never recomputed or inferred.

import type { FilesReadResponse } from "../../hooks/useFiles.js";
import type { FileSourceTarget } from "./file-source.js";

export function readCompleteness(read: FilesReadResponse): { state: "complete" | "truncated" | "binary" | "unverified"; label: string } {
  if (read.binary === true) return { state: "binary", label: "binary / non-UTF-8 — text not shown" };
  if (read.truncated === true) return { state: "truncated", label: `truncated preview · ${read.truncatedAtBytes ?? "?"} of ${read.totalBytes ?? read.size} bytes` };
  if (read.truncated === false && read.binary === false) return { state: "complete", label: "complete read" };
  return { state: "unverified", label: "completeness not confirmed by the daemon" };
}

export function FileReadFacts({ read, target, testIdPrefix }: { read: FilesReadResponse; target: FileSourceTarget; testIdPrefix: string }) {
  const canonical = read.resolvedPath ?? read.path;
  const completeness = readCompleteness(read);
  return (
    <dl
      data-testid={`${testIdPrefix}-facts`}
      data-completeness={completeness.state}
      className="mx-4 mt-3 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 border border-outline-variant bg-background px-3 py-2 font-mono text-[10px] text-on-surface"
    >
      <dt className="text-on-surface-variant">source</dt>
      <dd className="break-all" data-testid={`${testIdPrefix}-absolute-path`}>{read.absolutePath}</dd>
      {canonical !== target.path && (
        <>
          <dt className="text-on-surface-variant">resolves to</dt>
          <dd className="break-all" data-testid={`${testIdPrefix}-canonical-path`}>{read.root}/{canonical}</dd>
        </>
      )}
      <dt className="text-on-surface-variant">read</dt>
      <dd data-testid={`${testIdPrefix}-completeness`}>{completeness.label}</dd>
      <dt className="text-on-surface-variant">size</dt>
      <dd>{read.size} bytes</dd>
      <dt className="text-on-surface-variant">modified</dt>
      <dd>{read.mtime}</dd>
      <dt className="text-on-surface-variant">sha-256</dt>
      <dd className="break-all" title={read.contentHash}>{read.contentHash.slice(0, 16)}{read.contentHash.length > 16 ? "…" : ""}</dd>
      {target.project && (
        <>
          <dt className="text-on-surface-variant">project</dt>
          <dd className="break-all">{target.project.projectId} · {target.project.projectRoot}</dd>
        </>
      )}
    </dl>
  );
}
