// Producing-origin adapters from Project evidence reads to the Files contracts
// (components/files/file-source.ts, FileLink, MarkdownViewer `source`). No new
// resolver or transport: these only describe which host served a reference and
// which served facts a Markdown document has, so a later host selection cannot
// retarget a saved reference and unknown stays unknown.
//
// - `/api/files/*` reads (useScopeMarkdown, useFilesList) run only while the
//   KNOWN selection is the connected local instance, so a served read was
//   produced by that instance. No served read → unknown (null).
// - Canonical operator reads (project slice documents, workflow/queue reads)
//   describe the operator scope they were issued with.
// - A document read through a route that serves no Files root (project slice
//   documents, narratives, STEERING.md text) gets a source with an explicit
//   empty root: anchors and external links work, relative links/images are
//   refused with a reason. No allowlist root or canonical path is invented.

import { useCallback } from "react";
import { useDrawerSelection } from "../AppShell.js";
import type { FileViewerData } from "../drawer-viewers/FileViewer.js";
import { sourceFactsFromRead, type FileProjectIdentity, type FileSourceTarget } from "../files/file-source.js";
import { useFileOriginAdmission } from "../files/useFileAdmission.js";
import type { MarkdownSource } from "../markdown/MarkdownViewer.js";
import type { UseScopeMarkdownResult } from "../../hooks/useScopeMarkdown.js";
import { LOCAL_HOST_ID } from "../../lib/host-param.js";
import type { OperatorInstanceScope } from "../../lib/operator-read.js";

/** Host that served a Files read. Files reads exist only for the known local
 * selection, so a supported read that returned data came from it. */
export function filesReadOrigin(read: { scopeSupported: boolean; data?: unknown; file?: unknown }): string | null {
  const served = read.file !== undefined ? read.file != null : read.data !== undefined;
  return read.scopeSupported && served ? LOCAL_HOST_ID : null;
}

/** Host a canonical operator read was issued to. */
export function operatorScopeOrigin(scope: OperatorInstanceScope): string {
  return scope.kind === "local-instance" ? LOCAL_HOST_ID : scope.hostId;
}

/** The exact Files target of a served useScopeMarkdown read, or null. */
export function scopeMarkdownTarget(md: Pick<UseScopeMarkdownResult, "file" | "resolved" | "scopeSupported">, project?: FileProjectIdentity): FileSourceTarget | null {
  if (!md.file || !md.resolved) return null;
  return {
    originInstance: filesReadOrigin({ scopeSupported: md.scopeSupported, file: md.file }),
    root: md.resolved.rootName,
    path: md.file.path,
    ...(project ? { project } : {}),
  };
}

/** MarkdownSource for a served useScopeMarkdown document: served root, the
 * authored request path, canonical resolvedPath when served, truncation and
 * current local admission. Undefined when nothing was served. */
export function useScopeMarkdownSource(md: Pick<UseScopeMarkdownResult, "file" | "resolved" | "scopeSupported">, project?: FileProjectIdentity): MarkdownSource | undefined {
  const target = scopeMarkdownTarget(md, project);
  const admission = useFileOriginAdmission(target?.originInstance ?? null);
  if (!target) return undefined;
  return {
    facts: sourceFactsFromRead(target, md.file),
    admitted: admission.admitted,
    ...(admission.admitted ? {} : { blockedMessage: admission.message }),
    truncated: md.file?.truncated === true,
  };
}

export const NO_FILES_ROOT_REASON = "This document was read through a route that serves no Files location, so relative links and images in it are not resolved.";

/** Source for text served without a Files root. `path` is the served document
 * identity (never a request path); `root` is explicitly empty. */
export function useDetachedMarkdownSource(originInstance: string | null, path: string, project?: FileProjectIdentity): MarkdownSource {
  const admission = useFileOriginAdmission(originInstance);
  const target: FileSourceTarget = { originInstance, root: "", path, ...(project ? { project } : {}) };
  return {
    facts: sourceFactsFromRead(target, null),
    admitted: admission.admitted,
    blockedMessage: admission.admitted ? NO_FILES_ROOT_REASON : admission.message,
  };
}

/** The drawer payload FileLink would build for a resolved Files target. */
export function fileViewerDataForTarget(target: FileSourceTarget): FileViewerData {
  return {
    path: target.path,
    root: target.root,
    originInstance: target.originInstance,
    ...(target.anchor !== undefined ? { anchor: target.anchor } : {}),
    ...(target.project !== undefined ? { project: target.project } : {}),
  };
}

/** Opens a sibling target from an inline document in the shared drawer. */
export function useOpenFileTarget() {
  const { setSelection } = useDrawerSelection();
  return useCallback((target: FileSourceTarget) => setSelection({ type: "file", data: fileViewerDataForTarget(target) }), [setSelection]);
}
