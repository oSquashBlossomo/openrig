import { useCallback, useMemo } from "react";
import { useRouter, useRouterState } from "@tanstack/react-router";
import { catalogHref, normalizeCatalogLocation, parseCatalogLocation, type CatalogLocation } from "./project-location.js";

export type CatalogNavigate = (next: CatalogLocation, options?: { replace?: boolean }) => void;

/** The raw query of the history entry. The router's parsed/canonical
 * `searchStr` re-stringifies JSON-like values (`1.0` becomes `1`), so exact
 * project identity is read from the original `publicHref` instead. */
function rawQuery(publicHref: string): string {
  const hash = publicHref.indexOf("#");
  const path = hash >= 0 ? publicHref.slice(0, hash) : publicHref;
  const query = path.indexOf("?");
  return query >= 0 ? path.slice(query + 1) : "";
}

/** URL-owned selection: every choice is a history entry, so browser Back
 * restores the previous exact project/mission/slice. Tab switches replace.
 * Entries are pushed byte-for-byte through router history, never rebuilt by
 * the router's search serializer. */
export function useCatalogLocation(): { location: CatalogLocation; go: CatalogNavigate } {
  const router = useRouter();
  const publicHref = useRouterState({ select: (state) => state.location.publicHref });
  const location = useMemo(() => normalizeCatalogLocation(parseCatalogLocation(rawQuery(publicHref))), [publicHref]);
  const go = useCallback<CatalogNavigate>((next, options) => {
    const href = catalogHref(next);
    if (options?.replace) router.history.replace(href);
    else router.history.push(href);
  }, [router]);
  return { location, go };
}
