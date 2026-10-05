// Routed /files adapter. The location is read from the ORIGINAL publicHref
// query (no router JSON/number coercion: a file named "1.0" or "true" stays
// that exact string) and every navigation is pushed/replaced byte-for-byte
// through router history, mirroring the catalog project adapter. Browser
// Back/Forward restore root, directory, filter, file and anchor; the router
// restores per-entry scroll for the data-scroll-restoration-id panes.
// Drafts are never serialized into the URL.

import { useCallback, useMemo, useRef } from "react";
import { useRouter, useRouterState } from "@tanstack/react-router";
import { filesHref, parseFilesLocation, type FilesLocation } from "./file-source.js";
import { FilesWorkspace, type FilesNavigate } from "./FilesWorkspace.js";

const FILES_PATH = "/files";

function rawQuery(publicHref: string): string {
  const hash = publicHref.indexOf("#");
  const path = hash >= 0 ? publicHref.slice(0, hash) : publicHref;
  const query = path.indexOf("?");
  return query >= 0 ? path.slice(query + 1) : "";
}

export function useFilesLocation(): { location: FilesLocation; go: FilesNavigate } {
  const router = useRouter();
  const publicHref = useRouterState({ select: (state) => state.location.publicHref ?? state.location.href });
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  // While the route is being left, keep the last /files location and ignore
  // late effects so they cannot replace the destination entry.
  const last = useRef<FilesLocation>({});
  const onFiles = pathname === FILES_PATH;
  const location = useMemo(() => (onFiles ? parseFilesLocation(rawQuery(publicHref)) : last.current), [onFiles, publicHref]);
  last.current = location;
  const go = useCallback<FilesNavigate>((next, options) => {
    // history.location updates synchronously on push, before router state.
    if (router.history.location.pathname !== FILES_PATH) return;
    const href = filesHref(next);
    if (options?.replace) router.history.replace(href);
    else router.history.push(href);
  }, [router]);
  return { location, go };
}

/** Route component for `/files` (no validateSearch). */
export function FilesRoutePage() {
  const { location, go } = useFilesLocation();
  return <FilesWorkspace location={location} onNavigate={go} />;
}
