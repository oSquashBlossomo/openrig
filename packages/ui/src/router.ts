// Path state without a router library: three screens, one history stack.
import { useEffect, useState } from "react";

export type Route =
  | { page: "fleet" }
  | { page: "seat"; session: string }
  | { page: "activity" }
  | { page: "graph" };

export function parseRoute(pathname: string): Route {
  const seat = /^\/seat\/([^/]+)/.exec(pathname);
  if (seat) return { page: "seat", session: decodeURIComponent(seat[1]!) };
  if (pathname.startsWith("/activity")) return { page: "activity" };
  if (pathname.startsWith("/graph")) return { page: "graph" };
  return { page: "fleet" };
}

export function seatPath(session: string): string {
  return `/seat/${encodeURIComponent(session)}`;
}

export function navigate(path: string): void {
  if (window.location.pathname === path) return;
  window.history.pushState(null, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(window.location.pathname));
  useEffect(() => {
    const onPop = () => setRoute(parseRoute(window.location.pathname));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  return route;
}

/** Internal links stay in the app; modifier-clicks and middle-clicks keep browser behaviour. */
export function onLinkClick(e: React.MouseEvent<HTMLAnchorElement>): void {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  navigate(e.currentTarget.getAttribute("href") ?? "/");
}
