import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { parse } = require("yaml");
const workflow = parse(readFileSync(new URL("../.github/workflows/claude-code-review.yml", import.meta.url), "utf8"));
const targetStep = workflow.jobs["claude-review"].steps.find(step => step.id === "target");
const repository = "oSquashBlossomo/openrig";
const baseSha = "a".repeat(40);

function trustedTarget() {
  return {
    head: { repo: { full_name: repository } },
    base: { repo: { full_name: repository }, ref: "main", sha: baseSha },
    draft: false,
    author_association: "OWNER",
  };
}

function validate(metadata, number = "6") {
  const directory = mkdtempSync(join(tmpdir(), "openrig-review-target-"));
  try {
    const fixture = join(directory, "fixture.json");
    const output = join(directory, "outputs");
    writeFileSync(fixture, JSON.stringify(metadata));
    // Only the GitHub transport is replaced. Execute the maintained workflow's
    // complete validation shell step, including its real jq predicate.
    writeFileSync(join(directory, "gh"), '#!/bin/sh\ncat "$REVIEW_TEST_FIXTURE"\n', { mode: 0o700 });
    const result = spawnSync("bash", ["-c", targetStep.run], {
      encoding: "utf8",
      timeout: 5000,
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        GH_TOKEN: "test-fixture-only",
        REVIEW_TEST_FIXTURE: fixture,
        REVIEW_REPOSITORY: repository,
        REVIEW_PR_NUMBER: number,
        RUNNER_TEMP: directory,
        GITHUB_OUTPUT: output,
      },
    });
    assert.ifError(result.error);
    return { status: result.status, output: existsSync(output) ? readFileSync(output, "utf8") : "", stderr: result.stderr };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("exports the exact PR number and protected-main base SHA for a trusted target", () => {
  const result = validate(trustedTarget());
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.output, `number=6\nbase=${baseSha}\n`);
});

for (const [name, mutate] of [
  ["a PR targeting an unprotected branch", target => { target.base.ref = "attacker-controlled"; }],
  ["a PR with a different base repository", target => { target.base.repo.full_name = "other/openrig"; }],
  ["a PR missing base repository identity", target => { target.base.repo = null; }],
  ["an external-fork head", target => { target.head.repo.full_name = "other/openrig"; }],
  ["a draft PR", target => { target.draft = true; }],
  ["an untrusted author", target => { target.author_association = "NONE"; }],
]) {
  test(`rejects ${name} without exporting a checkout SHA`, () => {
    const target = trustedTarget();
    mutate(target);
    const result = validate(target);
    assert.notEqual(result.status, 0);
    assert.equal(result.output, "");
  });
}

test("rejects an invalid dispatch PR number without exporting a checkout SHA", () => {
  const result = validate(trustedTarget(), "6; echo injected");
  assert.notEqual(result.status, 0);
  assert.equal(result.output, "");
});
