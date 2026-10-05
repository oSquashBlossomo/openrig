import { describe, expect, it } from "vitest";
import { isHostsResponse } from "../src/lib/hosts-read.js";
import { isTopologyRigSummary } from "../src/lib/topology-read.js";
import { isFleetRestoreStatus, isStartupPrerequisites, isStartupRig } from "../src/lib/startup-contracts.js";
import { isTerminalPreview, isTerminalViews } from "../src/lib/terminal-read.js";
import * as f from "../twin/recovery-fixtures.js";

// The sanitized fixtures are only useful if the real transport guards accept them.
describe("recovery fixtures satisfy the verified contracts", () => {
  it("hosts, rigs and startup", () => {
    expect(isHostsResponse(f.recoveryHostsLocal) && isHostsResponse(f.recoveryHostsRemote)).toBe(true);
    expect(isTopologyRigSummary(f.recoveryRigSummaries)).toBe(true);
    expect(isStartupPrerequisites(f.startupPrerequisitesFixture)).toBe(true);
    expect(isStartupRig(f.startupRigAlpha) && isStartupRig(f.startupRigAlphaRevised)).toBe(true);
  });
  it("fleet observations", () => {
    for (const status of [f.fleetRunningEmpty, f.fleetRunningPartial, f.fleetCancelledRunning, f.fleetDoneMixed, f.fleetDoneCancelled, f.fleetDoneAllFailed, f.fleetDoneNoneAttempted])
      expect(isFleetRestoreStatus(status)).toBe(true);
  });
  it("terminal views and previews at 0/1/16/17/33 panes", () => {
    expect(isTerminalViews(f.terminalViewsFixture) && isTerminalViews(f.terminalViewsSavedOnly) && isTerminalViews(f.terminalViewsEmpty)).toBe(true);
    for (const count of [0, 1, 16, 17, 33]) {
      const preview = f.terminalPreviewFixture("saved:sv-wall", "herdr", Array.from({ length: count }, (_, i) => `s${i}@alpha`));
      expect(isTerminalPreview(preview)).toBe(true);
      expect(preview.composed.pages.map(p => p.length)).toEqual(count === 0 ? [] : count === 33 ? [16, 16, 1] : count === 17 ? [16, 1] : [count]);
    }
  });
});
