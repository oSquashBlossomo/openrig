// Invocation-time admission for connected-instance effects (startup, fleet
// restore, terminal Open).
//
// Rendered state is not authority: the shared ["hosts"] cache can switch to a
// remote selection, fail its refresh, or report a different instance before the
// observing component re-renders, and a retained callback can run long after
// its render. Every effect owner therefore re-reads the CURRENT cache entry at
// the moment of invocation, before acquiring a lane, creating a record or
// starting transport. Unknown, failed/stale and remote selections are refused;
// nothing defaults to local.

import type { QueryClient } from "@tanstack/react-query";
import type { HostsResponse } from "../../hooks/useHosts.js";
import { LOCAL_HOST_ID } from "../../lib/host-param.js";

/** Stable connected-daemon key: browser origin plus the daemon-reported
 * instance name. A renamed or different instance yields a different key, so an
 * old handle or attempt is shown as foreign rather than relabelled. */
export function fleetConnectionKey(origin: string, instanceName: string | null): string {
  return `${origin}#instance=${instanceName ?? "unnamed"}`;
}

export function currentOrigin(): string {
  return typeof window !== "undefined" ? window.location.origin : "unknown-origin";
}

export type ConnectedAdmission = { ok: true; connectionKey: string } | { ok: false; reason: string };

/** Admit an effect only when the current host cache is a successful, known-local
 * read and (when given) still names the connection the caller rendered for. */
export function admitConnectedLocal(client: QueryClient, expectedConnectionKey?: string | null): ConnectedAdmission {
  const state = client.getQueryState<HostsResponse>(["hosts"]);
  const data = state?.data;
  if (!state || !data) return { ok: false, reason: "The host selection is not known yet; nothing is sent until it reads as the connected local instance." };
  if (state.status === "error") {
    return { ok: false, reason: "The latest host-selection read failed, so it is not known to still be local. Nothing is sent until it reads again." };
  }
  if (data.selected !== LOCAL_HOST_ID) {
    return { ok: false, reason: `Topology is now viewing remote host ${data.selected}. This effect acts only on the connected instance; select the local host first.` };
  }
  const connectionKey = fleetConnectionKey(currentOrigin(), data.ownName?.trim() || null);
  if (expectedConnectionKey !== undefined && expectedConnectionKey !== connectionKey) {
    return { ok: false, reason: "The connected instance changed since this view was shown. Review the current instance before acting." };
  }
  return { ok: true, connectionKey };
}
