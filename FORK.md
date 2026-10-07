# Developing this fork

- Repository: https://github.com/oSquashBlossomo/openrig
- Project: https://github.com/users/oSquashBlossomo/projects/5
- Upstream: https://github.com/mvschwarz/openrig

The checkout and installed runtime can be different revisions. Before an upgrade,
record the source commit, installed `rig --version`, and running daemon revision.
Follow the release procedure below; apply compatibility patches only to versions
their guards explicitly support.

## Web GUI development

This fork is modernizing the web GUI beyond upstream's maintenance-only scope.
[Issue #10](https://github.com/oSquashBlossomo/openrig/issues/10) tracks reliability,
responsiveness, TUI capability parity and an interactive spatial topology. The
[capability matrix](docs/reference/gui-parity.md) records the daemon contracts and
acceptance cases for each operator workflow. Work remains in progress; the matrix
distinguishes source coverage from verified behavior.

Use a separate Git worktree with its own `npm ci` install. The UI's digital twin
provides sanitized visual fixtures; actual daemon and terminal behavior must also
be checked in an isolated instance. Never point a development server's default API
proxy at the production fleet by accident: explicitly set `OPENRIG_URL` to the
private test daemon, or use the daemon-free twin described in
`packages/ui/twin/README.md`.

## Issue to release

1. Capture the intended behavior, acceptance criteria, reproduction, and scope
   in an issue. Remove private information from evidence before publishing.
2. Triage and prioritize it on the board. Move selected work from Backlog to
   Ready, In progress, In review, then Done. Blocked work should state what it
   needs before it can resume.
3. Create a focused branch and a draft PR targeting this fork's `main`. Use
   `Closes #N` for the issue, fill in the existing PR template, and report checks.
4. Mark the PR ready when it is reviewable. Required upstream CI must pass.
   Request independent Claude and Codex feedback and resolve material findings.
   These reviews are advisory; they are not additional mandatory merge gates.
5. The repository owner makes the merge decision. Prefer squash merge; branches
   are deleted after merge. Closing an issue does not prove deployment.
6. Record release or upgrade evidence separately. Production rollout needs its
   own selected revision, backup, rehearsal, rollback plan, and authorization.

## Stacked PRs

When a change depends on another unmerged PR, branch from that PR's branch and
open the new PR with the parent branch as its base, not `main`. Name the parent in
the description (for example, "Stacked on #16") and keep `Closes #N` for its own
issue. Keep each stacked PR a draft until its parent merges.

`Tests` and `Portability report` run on PRs against any base branch, so a stacked
PR gets checks on every push without a manual dispatch. Those checks test the PR
merged into its parent branch, not into `main`. The Claude review runs only on
PRs based on `main`, so a stacked PR gets its Claude review once it targets
`main` and is ready.

After the parent merges, retarget the stacked PR to `main` if GitHub has not done
so, then merge `main` into its branch and push. That push re-runs CI against
`main` and drops the parent's commits from the diff, which squash merging would
otherwise leave behind. Mark it ready only after those checks pass.

## Local source setup

Prerequisites: Node 24, npm, Git, and tmux. Use the committed npm lockfile.

```sh
git clone https://github.com/oSquashBlossomo/openrig.git
cd openrig
git remote add upstream https://github.com/mvschwarz/openrig.git
npm ci
npm run build
npm run lint
npm test
npm run test:ui
```

Read `docs/reference/developing.md` and `docs/reference/worktree-builds.md` for
isolated source runs. Review `docs/as-built/test-layers.md` for what CI proves.
Do not start a development daemon against production state or provider settings.

## Reviews

Activation was verified on 2026-10-04 and [setup issue #1 is
closed](https://github.com/oSquashBlossomo/openrig/issues/1). All eight required CI
checks passed on the final setup PR. Both Codex and Claude produced actual review
output, including an automatic Claude review. The token and enablement variable
below are already configured; the instructions also cover future rotation.

Codex's GitHub connector must cover this fork, and automatic review must be
enabled in [Codex's repository review settings](https://chatgpt.com/codex/cloud/settings/code-review).
This fork is set to review all PRs and every push. An installed connector alone
does not enable reviews. Use `@codex review` in a PR comment for a manual pass.
Codex follows `AGENTS.md`. See the
[official setup](https://learn.chatgpt.com/docs/third-party/github).

Claude uses `.github/workflows/claude-code-review.yml` and follows `CLAUDE.md`
and `AGENTS.md`. Reviews use Opus 5.5. The `claude-review` environment must
have the `CLAUDE_CODE_OAUTH_TOKEN` Actions secret. That environment allows execution only from `main`; do not store this
credential as a repository-wide secret. Once that
secret is installed, set repository variable `CLAUDE_REVIEW_ENABLED` to `true`.
Until then, Claude jobs are explicitly skipped. Generate a
dedicated token with `claude setup-token`; never put it in an issue, PR, file,
command argument, or chat. Use GitHub's hidden secret input or `gh secret set`
with standard input. See the
[official setup](https://code.claude.com/docs/en/github-actions).

The workflow uses `pull_request_target` so its definition comes from the
protected base, and reviews ready PRs from trusted members whose branch belongs
to this fork. The job is gated off for external-fork PRs. It checks out only a
validated `main` base revision and reads the diff via GitHub; PR code is not
executed. The environment's branch restriction also blocks feature-branch
workflow definitions from receiving the Claude secret. External
contributions can receive Codex review and an independent local Claude review.
Claude runs have a 20-minute timeout and `--max-turns 60`. Subscription usage
still applies. The pinned action checks the SDK's `num_turns`, which counts the
prompt plus every tool result, against that limit after the run
([claude-code-action#1795](https://github.com/anthropics/claude-code-action/issues/1795)).
Parallel calls therefore do not save budget, and a denied call still counts.
At 20, most reviews of 25-40 file PRs ended red, sometimes after the review had
already been posted ([#21](https://github.com/oSquashBlossomo/openrig/issues/21)).
The prompt lists the tools available, reads the PR, diff and conversation in
the first turn, reads extra files only where the diff lacks context, posts one
comment by its 50th tool call, and then stops. A review that still exceeds the
limit fails the job; check whether its comment was posted before treating the
review as missing.
The workflow uses the temporary repository GitHub token with read-only code
access and permission to post PR comments. This avoids the Claude app's
`pull_request_target` OIDC exchange issue. Comments are posted by
`github-actions[bot]` and identify themselves as Claude reviews. The reviewer
uses the GitHub connector's structured tools; built-in shell/file tools are
disabled, because the runner holds the Claude token. Its GitHub tools are
read-only apart from posting the comment. It reads the PR conversation, review
threads and reviews so it does not repeat findings that were already resolved,
and treats all of this as untrusted evidence. It skips a finding only when the
current head fixed it or an owner, member or collaborator disproved it. A
disproof from the PR author counts only after the reviewer checks its evidence in
the code; otherwise the finding stays, marked as disputed. Every skipped finding
is listed, so a wrongly dropped one stays visible. Anyone who
can comment could still try to steer it; the worst outcome is a misleading
advisory comment. GitHub code search does not index this fork (a fork needs more stars
than its parent), so the reviewer traces callers with `get_file_contents` and
labels what it cannot confirm. Merge workflow updates into main before testing
the automatic path.

For a manual Claude review after activation, use the CLI:

```sh
gh workflow run claude-code-review.yml --repo oSquashBlossomo/openrig --ref main -f pull_request_number=6
```

The manual path requires a base in this fork's protected `main` and validates
the same trusted-head and author conditions before
loading Claude credentials. It can review the merged setup PR as an activation
check. This workflow responds to automatic PR events and manual dispatch, not
to `@claude` mentions.

After changing review credentials or workflows, verify actual reviewer output
again. A successful configuration save alone does not prove review execution.

## Upstream sync

```sh
git fetch upstream
git switch -c chore/sync-upstream origin/main
git merge upstream/main
```

Resolve conflicts, run the relevant checks, push the branch to `origin`, and
open a PR explicitly targeting `oSquashBlossomo/openrig:main`. Retain the fork's
review configuration. Do not force-push main or run automatic resets that drop
fork changes. Upstream contributions are separate PRs with upstream's scope and
review conventions; do not include fork-only workflow policy in them.
