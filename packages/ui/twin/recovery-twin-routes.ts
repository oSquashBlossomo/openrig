// TEST-ONLY twin routes for seat startup, connected fleet restore and the
// terminal catalog. Bodies come from the cohort's contract-typed fictional
// fixtures (`recovery-fixtures.ts`); nothing reaches a daemon, provider or
// native runtime.
//
// Effects stay inert and truthful:
// - startup POSTs are refused with the served pre-effect code
//   `launch_unavailable` (a known rejection, so no "outcome unknown");
// - fleet restore is explicitly fictional: kickoff returns a fixed twin
//   handle, status advances through fixture frames, cancel is accepted;
// - terminal Open reports zero opened panes (a failure, never a success).

import {
  fleetDoneMixed, fleetRunningEmpty, fleetRunningPartial, startupPrerequisitesFixture, startupRigAlpha,
  terminalPreviewFixture, terminalViewsFixture,
} from "./recovery-fixtures.js";
import type { StartupRig } from "../src/lib/startup-contracts.js";

type TwinResponse = { body: unknown; status: number };

export const TWIN_FLEET_ATTEMPT_ID = "twin-fleet-attempt-1";
let fleetReads = 0;
let fleetStarted = false;

/** Test isolation: forget the fictional fleet attempt. */
export function resetRecoveryTwin(): void { fleetReads = 0; fleetStarted = false; }

/** Fictional startup rig for any twin rig ID: the cohort's seat fixture,
 * re-stamped with that exact rig identity. */
function startupRigFor(rigId: string, rigName: string): StartupRig {
  return {
    ...startupRigAlpha, rigId, rigName,
    seats: startupRigAlpha.seats.map((seat) => ({ ...seat, observed: { ...seat.observed, sessionName: `${seat.logicalId}@${rigName}` } })),
  };
}

export function recoveryTwinBody(pathname: string, search: URLSearchParams, method: string, rigs: ReadonlyArray<{ id: string; name: string }>): TwinResponse | undefined {
  if (pathname === "/api/startup/prerequisites" && method === "GET") return { body: startupPrerequisitesFixture, status: 200 };
  if (pathname.startsWith("/api/startup/") && method === "POST") {
    return { body: { error: "launch_unavailable", message: "Digital twin: no native launch is performed." }, status: 409 };
  }
  const startup = /^\/api\/startup\/([^/]+)$/.exec(pathname);
  if (startup && method === "GET") {
    const rigId = decodeURIComponent(startup[1]!);
    const rig = rigs.find((r) => r.id === rigId);
    return rig ? { body: startupRigFor(rig.id, rig.name), status: 200 } : { body: { error: "rig_not_found" }, status: 404 };
  }

  if (pathname === "/api/crash-cart/restore-fleet" && method === "POST") {
    fleetStarted = true; fleetReads = 0;
    return { body: { fleetAttemptId: TWIN_FLEET_ATTEMPT_ID, status: "started" }, status: 202 };
  }
  if (pathname === `/api/crash-cart/restore-fleet/${TWIN_FLEET_ATTEMPT_ID}` && method === "GET") {
    if (!fleetStarted) return { body: { error: "unknown fleet restore attempt" }, status: 404 };
    fleetReads += 1;
    return { body: fleetReads < 3 ? fleetRunningEmpty : fleetReads < 6 ? fleetRunningPartial : fleetDoneMixed, status: 200 };
  }
  if (pathname.startsWith("/api/crash-cart/restore-fleet/") && method === "GET") return { body: { error: "unknown fleet restore attempt" }, status: 404 };
  if (pathname.startsWith("/api/crash-cart/") && method === "POST" && pathname.endsWith("/cancel")) return { body: { ok: true, cancelled: true }, status: 200 };

  if (pathname === "/api/terminal/views" && method === "GET") {
    return { body: { saved: terminalViewsFixture.saved, rigs: rigs.map((r) => r.name) }, status: 200 };
  }
  if (pathname === "/api/terminal/preview" && method === "GET") {
    const view = search.get("view") ?? "";
    const provider = search.get("provider") ?? "herdr";
    const saved = terminalViewsFixture.saved.find((s) => `saved:${s.id}` === view);
    const rig = view.startsWith("rig:") ? view.slice(4) : null;
    const seats = saved ? saved.members.map((m) => m.seat) : rig ? ["orch.lead", "build.worker", "review.peer"].map((s) => `${s}@${rig}`) : null;
    if (!seats) return { body: { error: "view_not_found", message: `Unknown typed view ${view}` }, status: 404 };
    return { body: terminalPreviewFixture(view, provider, seats), status: 200 };
  }
  if (pathname === "/api/terminal/open" && method === "POST") {
    return { body: { provider: "herdr", ok: false, opened: [], absent: [], degraded: [], pages: 0 }, status: 200 };
  }
  return undefined;
}
