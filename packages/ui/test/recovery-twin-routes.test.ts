// Twin routes for startup / fleet restore / terminal catalog: served bodies
// pass the actual browser guards, and effects stay inert or explicitly
// fictional (no native launch, no provider panes).

import { beforeEach, describe, expect, it } from "vitest";
import { isFleetRestoreKickoff, isFleetRestoreStatus, isStartupPrerequisites, isStartupRig } from "../src/lib/startup-contracts.js";
import { isTerminalPreview, isTerminalViews } from "../src/lib/terminal-read.js";
import { isOpenViewResult } from "../src/components/terminal-catalog/catalog-model.js";
import { recoveryTwinBody, resetRecoveryTwin, TWIN_FLEET_ATTEMPT_ID } from "../twin/recovery-twin-routes.js";

const RIGS = [{ id: "rig_alpha", name: "acme-build" }, { id: "rig/odd", name: "odd" }];
const get = (path: string, query = "") => recoveryTwinBody(path, new URLSearchParams(query), "GET", RIGS);
const post = (path: string) => recoveryTwinBody(path, new URLSearchParams(), "POST", RIGS);

beforeEach(() => resetRecoveryTwin());

describe("recovery twin routes", () => {
  it("serves startup reads that pass the real guards, with the exact requested rig identity", () => {
    expect(isStartupPrerequisites(get("/api/startup/prerequisites")?.body)).toBe(true);
    const rig = get(`/api/startup/${encodeURIComponent("rig/odd")}`);
    expect(rig?.status).toBe(200);
    expect(isStartupRig(rig?.body)).toBe(true);
    expect(rig?.body).toMatchObject({ rigId: "rig/odd", rigName: "odd" });
    expect(get("/api/startup/rig_missing")?.status).toBe(404);
  });

  it("refuses startup effects with a known pre-effect code", () => {
    expect(post("/api/startup/rig_alpha/seat")).toEqual({ status: 409, body: { error: "launch_unavailable", message: "Digital twin: no native launch is performed." } });
  });

  it("fleet restore is explicitly fictional: one handle, progressing frames, 404 before kickoff", () => {
    expect(get(`/api/crash-cart/restore-fleet/${TWIN_FLEET_ATTEMPT_ID}`)?.status).toBe(404);
    const kickoff = post("/api/crash-cart/restore-fleet");
    expect(kickoff?.status).toBe(202);
    expect(isFleetRestoreKickoff(kickoff?.body)).toBe(true);
    const frames = Array.from({ length: 7 }, () => get(`/api/crash-cart/restore-fleet/${TWIN_FLEET_ATTEMPT_ID}`)!.body);
    expect(frames.every(isFleetRestoreStatus)).toBe(true);
    expect((frames.at(-1) as { done: boolean }).done).toBe(true);
    expect((frames[0] as { done: boolean }).done).toBe(false);
    expect(post(`/api/crash-cart/restore-fleet/${TWIN_FLEET_ATTEMPT_ID}/cancel`)?.status).toBe(200);
  });

  it("terminal views and previews pass the guards; Open reports nothing opened", () => {
    const views = get("/api/terminal/views")!.body;
    expect(isTerminalViews(views)).toBe(true);
    expect((views as { rigs: string[] }).rigs).toEqual(["acme-build", "odd"]);
    const preview = get("/api/terminal/preview", "view=saved%3Asv-wall&provider=herdr")!.body;
    expect(isTerminalPreview(preview)).toBe(true);
    expect(isTerminalPreview(get("/api/terminal/preview", "view=rig%3Aacme-build&provider=tmux")!.body)).toBe(true);
    expect(get("/api/terminal/preview", "view=saved%3Anope&provider=herdr")?.status).toBe(404);
    const open = post("/api/terminal/open")!.body;
    expect(isOpenViewResult(open)).toBe(true);
    expect(open).toMatchObject({ ok: false, opened: [] });
  });
});
