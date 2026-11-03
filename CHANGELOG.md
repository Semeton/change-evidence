# Changelog

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
