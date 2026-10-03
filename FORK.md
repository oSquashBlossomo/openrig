# Developing this fork

- Repository: https://github.com/oSquashBlossomo/openrig
- Project: https://github.com/users/oSquashBlossomo/projects/5
- Upstream: https://github.com/mvschwarz/openrig

The fork starts from upstream 0.6.3. The separate local operations installation
uses 0.5.16. Source development and GitHub setup do not authorize upgrading that
running installation or replaying its version-gated patches onto newer source.

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

Codex's GitHub connector must cover this fork, and automatic review must be
enabled in [Codex's repository review settings](https://chatgpt.com/codex/cloud/settings/code-review).
This fork is set to review all PRs and every push. An installed connector alone
does not enable reviews. Use `@codex review` in a PR comment for a manual pass.
Codex follows `AGENTS.md`. See the
[official setup](https://learn.chatgpt.com/docs/third-party/github).

Claude uses `.github/workflows/claude-code-review.yml` and follows `CLAUDE.md`
and `AGENTS.md`. The Claude GitHub app must cover this repository and the
repository must have the `CLAUDE_CODE_OAUTH_TOKEN` Actions secret. Once that
secret is installed, set repository variable `CLAUDE_REVIEW_ENABLED` to `true`.
Until then, Claude jobs are explicitly skipped. Generate a
dedicated token with `claude setup-token`; never put it in an issue, PR, file,
command argument, or chat. Use GitHub's hidden secret input or `gh secret set`
with standard input. See the
[official setup](https://code.claude.com/docs/en/github-actions).

The workflow reviews ready PRs from trusted members whose branch belongs to
this fork. It does not receive secrets for external-fork PRs. It checks out the
base revision and reads the diff via GitHub; PR code is not executed. External
contributions can receive Codex review and an independent local Claude review.
Claude runs have a timeout and turn limit. Subscription usage still applies.
The workflow must be merged into main before Claude's GitHub app will trust it;
its bootstrap PR can show a successful workflow-validation skip without a review.

For a manual Claude review after activation, use the CLI:

```sh
gh workflow run claude-code-review.yml --repo oSquashBlossomo/openrig --ref main -f pull_request_number=6
```

The manual path validates the same trusted-branch and author conditions before
loading Claude credentials. It can review the merged setup PR as an activation
check. This workflow responds to automatic PR events and manual dispatch, not
to `@claude` mentions.

Review activation is complete only after a PR receives actual reviewer output.
Keep setup issue #1 open until both integrations and required checks are verified.

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
