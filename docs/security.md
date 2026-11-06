# Security model of the GitHub integration

This document covers the shadow-mode GitHub integration shipped from 0.4.0: what it protects, from whom, how, and what it doesn't protect against. Each claim names the test that demonstrates it. If a claim has no test, it's listed as an assumption.

## What's being protected

1. **The repository and its secrets.** The reporter runs with a token that can comment on PRs and set commit statuses. Code from a PR must never run with that token.
2. **The integrity of the report.** A PR must not be able to choose its own evaluator, its own policy, or the verdict that gets posted about it.
3. **Reviewers.** A report must not be usable to ping people, fake a different report, inject links or images, or overwrite someone else's comment.

## The adversary

Anyone who can open a pull request: a fork contributor, or a collaborator whose branch or account is compromised. That includes AI coding agents. They control:

- every file in the PR's commits: names, contents, `.gitattributes`, `package.json`, `.npmrc`, workflow files;
- the PR title, body, branch name and head repository name;
- the PR's copy of every workflow file, including `change-evidence-trigger.yml`;
- comments on the PR, including text that copies the bot's comment marker.

They don't control the default branch, repository settings, the npm registry contents for a published version, or GitHub itself.

## Architecture

```
pull_request ──▶ change-evidence-trigger.yml   permissions: {}     PR's own copy; does nothing
                         │ completes
                         ▼
workflow_run ──▶ change-evidence.yml           default branch's copy
                   1. download the pinned evaluator tarball, verify its sha512
                   2. checkout the default branch (persist-credentials: false)
                   3. github-report: validate event → find PR via API → git fetch
                      refs/pull/N/head as objects → evaluate → comment + status
```

GitHub runs `workflow_run` workflows from the default branch, whatever the PR changed. Nothing produced by the trigger run is used: not its outputs, artifacts, logs or exit status. The trigger exists only so that a PR causes a `workflow_run` event.

### Why not the alternatives

| Design | Problem |
|---|---|
| `pull_request_target`, which 0.1–0.3 used | Safe as written, because nothing from the PR ran. But GitHub blocks it by default in public repositories from December 2, 2026 (brownouts November 9 and 16) unless an Actions event policy allows it. It's also the trigger behind most "pwn request" incidents, so allowing it is a standing exception that has to be justified. |
| `pull_request` only, with a read-only token | Can't comment on fork PRs. Worse, the workflow file comes from the PR: the PR can change the evaluator version, the policy, or just print a fake "low" report. A verdict produced inside the PR's workflow can't be trusted. |
| `pull_request` analysis → artifact → `workflow_run` posts it | The privileged step would publish whatever the PR's workflow wrote. The artifact is attacker-controlled, so the report would be too, and validating its schema doesn't help: a well-formed lie is still a lie. |
| **`pull_request` trigger → `workflow_run` re-evaluates from git** (0.4) | The privileged job derives everything itself, from git objects and the API. The trigger run is untrusted and is used for nothing but timing. |

## Threats and mitigations

| # | Threat | Mitigation | Demonstrated by |
|---|---|---|---|
| T1 | PR code runs in the privileged job: install scripts, build steps, a checkout of the PR | The PR is fetched as git objects into `refs/change-evidence/*` and never checked out. The workspace is the default branch. The evaluator has no dependencies, so nothing is `npm install`ed. No code path runs `git checkout/switch/restore/worktree/reset/apply`, or spawns `npm`, `npx`, `composer`, `php` or a shell. | `test/github.test.js` "hostile same-repo PR" (a `postinstall`/`preinstall` PR leaves no file behind; the worktree stays clean on `main`). `test/workflow-security.test.js` "never checks out…" (source scan, mutation-tested). |
| T2 | Git itself runs PR-supplied programs | Filter, diff and textconv drivers need git *config*, which the PR can't set. Attributes are read from the base worktree. Hooks come from the base checkout's `.git`, which has none. | `.gitattributes` with `filter=evil diff=evil` in the hostile fixture. |
| T3 | The PR replaces the evaluator or its version | The version and its tarball sha512 live in the default branch's workflow. The tarball is verified before it's unpacked and run. | `workflow-security.test.js` "integrity-checked before it runs". |
| T4 | The PR changes the policy that judges it | The overlay (`.change-evidence.json`) is read from the base branch tip. A PR that edits it is trust-root high. | `test/policy.test.js` "comes from the base commit". |
| T5 | Forged event data points the reporter at another PR, commit or repository | `head_sha` must be 40 hex characters, `repository` must equal `GITHUB_REPOSITORY`, and the triggering event must be `pull_request`. PR numbers from the payload are only hints: each is re-read from the API and accepted only if it's open, based on this repository, and its head is exactly `head_sha`. `head_branch` and `display_title` are never read. | `github.test.js` "malformed or hostile events" (10 cases, no API call made), "claims that don't match", "hostile PR numbers in the payload hint". |
| T6 | Shell or expression injection through branch names, titles or paths | No `${{ }}` in any `run:` line. The only expressions are `head_sha` (in `concurrency`), `runner.temp` and `github.token`, none of them shell. All logic is in Node, and git is called with argument arrays, never a shell. | `workflow-security.test.js` "no expression is interpolated into shell" (mutation-tested). The hostile `head_branch` payload doesn't execute. |
| T7 | Comment injection: pings, links, images, HTML, fake rows or sections | Every PR-controlled string goes through `code()` or `text()` in `lib/markdown.js`. Control characters (newlines, bidi overrides) are replaced. Code fences adapt to backticks inside, table pipes are escaped, `@` and `://` are broken outside code, and HTML is escaped. Each item and the whole comment have a size limit. | `github.test.js` "hostile same-repo PR": hostile file and route names; no mention or HTML outside code; every table row keeps its columns. |
| T8 | A forged marker hijacks the sticky comment | Only a comment written by `github-actions[bot]`, of type `Bot`, that *ends* with the marker is updated. Markers inside report content are broken, so the real one appears exactly once. | `github.test.js`: an attacker's comment containing the marker is left untouched, and the bot posts its own. The second run updates the bot's comment. |
| T9 | Token exposure | The token is passed to git through `GIT_CONFIG_*` environment variables, not argv or `.git/config` (`persist-credentials: false`). The trigger job has `permissions: {}` and no secrets. The reporter has only `contents: read`, `pull-requests: write` and `statuses: write`. | `workflow-security.test.js` "permissions are exactly…", "checkout … without persisted credentials". |
| T10 | Unpinned Actions are moved under the workflow | Every `uses:` is pinned to a 40-character SHA. | `workflow-security.test.js` "pinned to a full commit SHA". |
| T11 | Resource exhaustion through huge diffs or payloads | Bounded API responses (20 MB), event payload (25 MB), comment length (60,000 characters) and per-item length. Pattern rules only read the scoped files. The job timeout is 10 minutes. | Partly: limits are in code; `test/limits.test.js` covers large and binary diffs. |

## Residual risks and assumptions

- **A PR can suppress its own report.** Deleting, renaming or breaking `change-evidence-trigger.yml` in the PR means no `workflow_run`, so no comment. In shadow mode, a missing report is a missing signal, never a pass. Closing this gap is the job of the commit status the reporter posts (`change-evidence`): make it a **required status check** in branch protection or a ruleset, and a PR without a report can't merge. That's a repository setting, and only available where GitHub offers rulesets or branch protection: public repositories, or private ones on paid plans.
- **First-time fork contributors need approval.** GitHub holds their `pull_request` runs until a maintainer approves them, and the report waits for that.
- **The report reflects the head at the time of the run.** If the PR is pushed again while the reporter starts, the head check fails and that run reports nothing; the newer push's run reports.
- **npm and GitHub are trusted.** Integrity pinning protects against a different tarball under the same version. It doesn't protect against a malicious version you upgrade to: review the changelog and diff before running `upgrade`. Published versions carry provenance attestations from the release workflow.
- **The evaluator parses attacker-controlled text.** The parsers are hand-written and regex-based, with no `eval`. A parser bug can make evidence wrong or UNKNOWN, but it can't execute code. Pathological input can slow it down, within the job timeout.
- **The status is informational.** It's always `success`, with the review priority in its description. Making it reflect the tier, so it can block, is a later phase, and needs the study numbers to justify it.

## Configuration this needs

- Actions enabled, and `workflow_run` allowed (the default).
- Both workflow files on the **default branch**: the reporter only runs from there.
- No `pull_request_target` policy exception is needed.

## Migrating from 0.1–0.3

Those versions installed one workflow on `pull_request_target`. To move:

```bash
npx @semeton/change-evidence@latest upgrade
```

- If `change-evidence.yml` is an unmodified copy of the old template, `upgrade` replaces it with the `workflow_run` reporter, pins the version and its sha512, and adds `change-evidence-trigger.yml`.
- If you've edited it, only the pin moves, and `upgrade` warns that the workflow still runs on `pull_request_target` and doesn't verify integrity. Compare it with `npx @semeton/change-evidence@latest init`.

Commit the result in its own PR and merge it to the default branch. The PR that migrates won't itself get a report from the new design, because the reporter isn't on the default branch yet. Private repositories aren't affected by the December 2 change, but should still migrate, for integrity pinning and the stricter comment handling.
