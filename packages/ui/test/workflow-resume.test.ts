// OPR.0.4.6.WF4 — guard blocker 1 regression, migrated to occurrence-specific
// Resume. The route requires a structured `actorSession` (400 without it) and,
// with several unresolved failures, an explicit `occurrenceId`. The old
// actor-only `postResume` could not choose among failures, so it is removed:
// the instance page resumes only through FailureOccurrenceChooser, which sends
// the exact occurrence, actor and decision bytes via useWorkflowResume
// (behaviour covered in workflow-instance-actions.test.tsx).

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import * as instancePage from "../src/components/workflow/WorkflowInstancePage.js";

const src = (rel: string) => readFileSync(path.resolve(import.meta.dirname, "../src", rel), "utf8");

describe("WF-4 guard blocker 1: web Resume names its occurrence and actor", () => {
  it("the instance page no longer exports or issues an actor-only resume POST", () => {
    expect("postResume" in instancePage).toBe(false);
    const page = src("components/workflow/WorkflowInstancePage.tsx");
    expect(page).not.toMatch(/\/resume[`"']/);
    expect(page).not.toMatch(/(^|[^.\w])fetch\(/m);
    expect(page).toContain("<FailureOccurrenceChooser");
  });

  it("the chooser builds its attempt from the selected occurrence and the actor field", () => {
    const chooser = src("components/workflow/FailureOccurrenceChooser.tsx");
    expect(chooser).toContain("occurrenceId: selected!.occurrenceId, actorSession: actor");
    expect(chooser).toContain("useWorkflowResume(instance.instanceId, scope)");
  });
});
