// The project/workflow twin fixtures must satisfy the same structural guards
// the browser applies to real daemon responses, or the twin would only ever
// demonstrate error states. Also checks the twin's exact-identity refusals.

import { afterEach, describe, expect, it, vi } from "vitest";
import { LOCAL_OPERATOR_INSTANCE as local } from "../src/lib/operator-read.js";
import { readProjectCatalog } from "../src/hooks/useProjectCatalog.js";
import { readCanonicalScopes, readProjectSliceDetail, readProjectSliceDocument } from "../src/hooks/useCanonicalScopes.js";
import { readExecutionView } from "../src/hooks/useExecutionView.js";
import { readWorkflowInstances, readWorkflowRevision, readWorkflowTrace, readWorkflowOperation } from "../src/hooks/useWorkflow.js";
import { abortWorkflow, resumeWorkflowOccurrence, reviseWorkflow } from "../src/hooks/useWorkflowMutations.js";
import { isWorkflowLifecycleExecution, workflowFailureChoices } from "../src/lib/workflow-contracts.js";
import { projectWorkflowTwinBody } from "../twin/project-workflow-fixtures.js";
import { readLibraryEntries, readLibraryReview } from "../src/lib/node-library-reads.js";
import { matchWorkflowSpec, verifiedWorkflowReview } from "../src/components/workflow/workflow-spec-identity.js";

function stub() {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://twin.local");
    const hit = projectWorkflowTwinBody(url.pathname, url.searchParams, init?.method ?? "GET", init?.body ? JSON.parse(String(init.body)) : undefined);
    return hit ? Response.json(hit.body, { status: hit.status }) : Response.json({ error: "unrouted" }, { status: 599 });
  }));
}
afterEach(() => vi.unstubAllGlobals());
const north = { id: "guide-north", root: "/srv/books/north" }, south = { id: "guide-south", root: "/srv/books/south" };

describe("project/workflow twin fixtures", () => {
  it("serve guard-valid exact project reads for both equally named projects", async () => {
    stub();
    const catalog = await readProjectCatalog(local);
    expect(catalog.projects.filter((p) => p.name === "Field Guide")).toHaveLength(2);
    expect(catalog.projects.find((p) => p.id === "atlas")?.error).toBeTruthy();
    for (const sel of [north, south]) {
      expect((await readCanonicalScopes(local, sel)).project.root).toBe(sel.root);
      const view = await readExecutionView(local, sel, "launch");
      expect(view.rows[0]!.lifecycle_instances.every(isWorkflowLifecycleExecution)).toBe(true);
      expect((await readProjectSliceDetail(local, sel, "launch", "01-intro")).slicePath.startsWith(sel.root)).toBe(true);
      expect((await readProjectSliceDocument(local, sel, "launch", "01-intro", "notes/notes.md")).content).toContain(sel.root);
    }
    const nativeItem = (await readCanonicalScopes(local, north)).missions[0]!.slices[0]!.readiness!.items[0]!;
    expect(nativeItem.state).toBe("withdrawn");
  });

  it("refuse moved roots and unavailable projects instead of answering for another project", async () => {
    stub();
    await expect(readCanonicalScopes(local, { id: "guide-north", root: "/srv/books/south" })).rejects.toMatchObject({ status: 409, serverCode: "project_changed" });
    await expect(readExecutionView(local, { id: "atlas", root: "/srv/books/atlas" }, "launch")).rejects.toMatchObject({ status: 409, serverCode: "project_unavailable" });
  });

  it("serve guard-valid workflow reads and exact-occurrence, abort and revision mutations", async () => {
    stub();
    const list = await readWorkflowInstances(local);
    expect(list.map((i) => i.status).sort()).toEqual(["aborted", "active", "failed"]);
    const north = await readWorkflowTrace(local, "wf-guide-north");
    expect(workflowFailureChoices(north.instance, north.failures).state).toBe("multiple");
    await expect(resumeWorkflowOccurrence(local, "wf-guide-north", { occurrenceId: "occ-missing", actorSession: "ops@guide" })).rejects.toMatchObject({ code: "rejected", serverCode: "failure_occurrence_not_unresolved" });
    expect((await resumeWorkflowOccurrence(local, "wf-guide-north", { occurrenceId: "occ-north-2", actorSession: "ops@guide", decision: "retry" })).newPacketId).toBe("redrive-occ-north-2");
    const proposal = await readWorkflowRevision(local, "wf-guide-south");
    expect(proposal.status).toBe("source-only");
    const op = await reviseWorkflow(local, "wf-guide-south", { operationKey: proposal.operationKey!, expectedVersion: proposal.expectedVersion, expectedDigest: proposal.proposedDigest!, actorSession: "ops@guide", reason: "Adopt catalog move" });
    expect((await readWorkflowOperation(local, op.receipt.operationKey)).receipt.instanceId).toBe("wf-guide-south");
    await expect(abortWorkflow(local, "wf-guide-old", { reason: "again", actorSession: "ops@guide" })).rejects.toMatchObject({ code: "rejected", serverCode: "instance_not_abortable" });
  });

  it("serve a guard-valid connected workflow library whose exact entry verifies for the twin instances, including a colon sibling pair", async () => {
    stub();
    const entries = await readLibraryEntries("workflow", "local");
    const trace = await readWorkflowTrace(local, "wf-guide-north");
    const match = matchWorkflowSpec(entries, trace.instance.workflowName, trace.instance.workflowVersion);
    expect(match.kind).toBe("matched");
    const id = match.kind === "matched" ? match.entry.id : "";
    expect(verifiedWorkflowReview(await readLibraryReview(id, "local"), id, "guide-release", "1")).not.toBeNull();
    const exact = matchWorkflowSpec(entries, "release-notes", "1:2");
    expect(exact).toMatchObject({ kind: "matched", entry: { id: "workflow:@WyJyZWxlYXNlLW5vdGVzIiwiMToyIl0" } });
    expect(verifiedWorkflowReview(await readLibraryReview("workflow:@WyJyZWxlYXNlLW5vdGVzIiwiMToyIl0", "local"), "workflow:@WyJyZWxlYXNlLW5vdGVzIiwiMToyIl0", "release-notes", "1:2")).not.toBeNull();
  });
});
