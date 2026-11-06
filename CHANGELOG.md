# Changelog

## [0.4.0]

Security: the GitHub integration no longer uses `pull_request_target`. GitHub blocks that trigger by default in public repositories from December 2, 2026. `docs/security.md` has the threat model.

- **Two workflows instead of one.** `change-evidence-trigger.yml` runs on `pull_request` with no permissions and does nothing. `change-evidence.yml` runs on `workflow_run`, from the default branch, and uses nothing the trigger run produced.
- **New `github-report` command**, run by the reporter workflow:
  - it validates every event field it uses, and refuses with exit 3 before any API call;
  - it only reports on an open PR on this repository whose head is exactly the event's commit, cross-checked through the API, and finds fork PRs through the API too;
  - it fetches the PR as git objects only, passing credentials through the environment rather than argv or `.git/config`;
  - it posts one comment and an informational `change-evidence` commit status.
- **Evaluator integrity.** The workflow pins the evaluator's sha512 and verifies the tarball before running it. Nothing is `npm install`ed.
- **Comment injection fixed.** File paths, route URIs and other PR-controlled strings could close code spans, split table rows, ping users (`@name`) or carry the comment marker. Everything now goes through `lib/markdown.js`.
- **Sticky comment hijack fixed.** Only the bot's own comment is ever updated; any comment containing the marker used to qualify.
- `pr` and `change` resolve revisions with `--end-of-options`: a revision like `--upload-pack=…` is refused, not passed to git as an option. Unrelated histories exit 2 with a clear message.
- **`init` and `upgrade`:**
  - `init --write` writes both workflows, `init --trigger` prints the trigger, and `init` resolves the published integrity, or takes `--integrity`;
  - `upgrade` migrates an unmodified 0.1–0.3 workflow to the new pair, moves the pin and integrity together, and warns about edited workflows still on `pull_request_target`.
- Tests:
  - end-to-end adversarial tests against a fake GitHub API: hostile names and paths, install scripts, filter drivers, injected branch names, a forged marker, forks, mismatched SHAs, closed PRs and other repositories;
  - static checks on the workflow templates, each mutation-tested;
  - edge cases: binary files, renames, deletions, large diffs, unrelated histories.

## [0.3.0]

0.2.0 was released from `main` before these changes merged; it is the 0.1.x code.


- `suggest`: drafts a `.change-evidence.json` from the repository. It proposes a size threshold from the repo's own merged-PR sizes (only loosened unless `--budget` is given), policy and middleware folders the defaults miss, global scopes (tenant isolation goes to high, along with `withoutGlobalScope`) and payment code. `--write` saves it.
- `upgrade`: moves the workflow's pinned version to the latest release (or `--to`). A workflow that is an unmodified copy of any shipped template (`templates/history.json`) is refreshed whole; an edited one only gets its pin moved. `--check` exits 1 when out of date.
- Update notice on local runs: at most once a day, checked in a detached background process, never in CI, never installs anything; off with `CHANGE_EVIDENCE_NO_UPDATE_CHECK=1` or `NO_UPDATE_NOTIFIER=1`.
- `init` pins the version that printed it (it printed the template's literal `0.1.0` before).
- `-v`/`--version`/`version`, `-h`/`--help`/`help`, `--flag=value`, and a clear error for unknown commands.
- Policy v3: policies, middleware and migrations are matched in modular layouts (`app/Modules/*`, nwidart `Modules/*`); globs support `[Dd]` character classes.
- `suggest` finds scope classes portably: git narrows candidates, the match runs in JavaScript (git's `-E` regex has no `\b` on macOS, so scope classes were missed there).
- Tests run on Windows: the isolated git config is an empty temp file, not `os.devNull`.
- Routes: route files included with `require __DIR__.'/x.php'` or `->group(base_path('routes/x.php'))` are parsed under the including group, so they inherit its prefix and middleware. Module route files are covered; their routes are marked provider-loaded and aren't called unauthenticated, since the provider's middleware isn't visible.

## [0.1.0] - 2026-11-03

First published version: Phase 0, shadow mode.

- `pr` command: evidence and risk for one pull request, diffed from the merge base, as `report.md` (evidence first: rules with files, routes, schema, dependencies, workflows, UNKNOWNs) and `evidence.json`. `--github` writes the step summary and a `tier` output. `--fail-on` exists for later phases; the default reports only.
- `init` prints the shadow-mode workflow. It runs on `pull_request_target`, so the base branch's workflow judges the PR; the PR's commits are fetched as objects only; the evaluator version is pinned; every Action is SHA-pinned; one sticky comment per PR.
- Repository overlay `.change-evidence.json`: read from the base branch tip, rules merged by id, `disable` and `size` supported, and editing it is trust-root high.
- Routes: Laravel's middleware-parameter idiom (`Ensure::class.':x'`) is read statically; a new route behind throttle alone counts as unauthenticated.
- CI on three operating systems and Node 18–22; npm trusted publishing on `v*` tags.

## [0.0.2] - 2026-11-03

- Policy v2: `bootstrap/app.php` is a pattern rule over middleware and CSRF calls (it was a path rule); new `index_change_existing_table` and `unpinned_action` evidence rules.
- Workflow extractor: Action ref changes with SHA-pinning, and bump-only detection.
- Parser: case-insensitive PHP method names; unreadable middleware recorded as `<dynamic>`.
- Summary: size-threshold sweep.
- Second pilot: monicahq/monica.

## [0.0.1] - 2026-11-03

- Phase 1 study tool: PR replay from git history; route, migration and dependency extractors; risk engine and default Laravel policy; revert and SZZ outcome linking; CSV, JSON and Markdown reports. First pilot: koel/koel.
