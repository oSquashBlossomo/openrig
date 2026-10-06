// Route adapter for /specs/$specKind/$specName → Library's SpecLookupPage
// (exact served kind+name, optional version, explicit source origin).
//
// Path params arrive once-decoded from the router and are passed verbatim
// (no second decode, no trimming). `version`/`source` are read RAW from the
// original publicHref — no validateSearch, so "1.0" is never coerced: absent
// stays undefined, present-but-empty stays "". Resolution, ambiguity and
// origin admission belong to SpecLookupPage; nothing is guessed here.

import { useParams, useRouterState } from "@tanstack/react-router";
import { SpecLookupPage } from "../specs/SpecLookupPage.js";

/** Raw query of an href: after the FIRST "?" and before the first "#". */
export function rawQueryOf(href: string): URLSearchParams {
  const hash = href.indexOf("#");
  const withoutHash = hash < 0 ? href : href.slice(0, hash);
  const question = withoutHash.indexOf("?");
  return new URLSearchParams(question < 0 ? "" : withoutHash.slice(question + 1));
}

export function lookupPropsFrom(params: { specKind: string; specName: string }, href: string) {
  const query = rawQueryOf(href);
  return {
    kind: params.specKind,
    name: params.specName,
    version: query.has("version") ? query.get("version")! : undefined,
    source: query.has("source") ? query.get("source")! : undefined,
  };
}

export function SpecLookupRoute() {
  const params = useParams({ from: "/specs/$specKind/$specName" });
  const href = useRouterState({ select: (state) => (state.location as { publicHref?: string }).publicHref ?? state.location.href });
  return <SpecLookupPage {...lookupPropsFrom(params, href)} />;
}
