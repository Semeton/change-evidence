# Changelog

## [0.2.0]

- `suggest`: drafts a `.change-evidence.json` from the repository. It proposes a size threshold from the repo's own merged-PR sizes (only loosened unless `--budget` is given), policy and middleware folders the defaults miss, global scopes (tenant isolation goes to high, along with `withoutGlobalScope`) and payment code. `--write` saves it.
- `upgrade`: moves the workflow's pinned version to the latest release (or `--to`). A workflow that is an unmodified copy of any shipped template (`templates/history.json`) is refreshed whole; an edited one only gets its pin moved. `--check` exits 1 when out of date.
- Update notice on local runs: at most once a day, checked in a detached background process, never in CI, never installs anything; off with `CHANGE_EVIDENCE_NO_UPDATE_CHECK=1` or `NO_UPDATE_NOTIFIER=1`.
- `-v`/`--version`/`version`, `-h`/`--help`/`help`, `--flag=value`, and a clear error for unknown commands.
- Policy v3: policies, middleware and migrations are matched in modular layouts (`app/Modules/*`, nwidart `Modules/*`); globs support `[Dd]` character classes.
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
