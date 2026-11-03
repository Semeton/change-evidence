# change-evidence

Evidence for pull requests. It reads what a PR changes in routes, schema, dependencies and CI as data, assigns a risk tier from a policy, and reports where a reviewer should look. On a 3,000-line agent PR, the report says which four routes became public, which migration retypes a column, and which three files bypass tenant scoping.

It never runs the code it judges. It reads git objects as data and never checks out, builds or executes the PR, so every piece of evidence it produces is *trusted* in the design spec's sense. Anything it can't establish is reported as UNKNOWN and raises the tier; it never counts as a pass.

It has two modes:

- **`pr`**: one pull request, as a PR comment and a GitHub step summary. Phase 0 of the gate: shadow mode, which reports and never blocks.
- **`study`**: replays a repository's merged PRs offline and measures whether the tiers would have routed the right changes to a human. Phase 1: calibration before anything goes in a merge path.

## Shadow mode on a GitHub repository

```bash
npx @semeton/change-evidence init > .github/workflows/change-evidence.yml
```

The workflow:

- runs on `pull_request_target`, so it uses the workflow file **from the base branch**: a PR can't edit the check that judges it;
- fetches the PR's commits as git objects only, with no checkout and no install;
- runs a pinned evaluator version from outside the repository;
- posts one comment per PR (updated on each push), writes the step summary, and keeps `evidence.json` as a 90-day artifact.

It needs `pull-requests: write` for the comment and nothing else. Every Action it uses is pinned to a commit SHA.

Don't add a step that checks out or runs the PR head to this workflow. `pull_request_target` is safe here only because nothing from the PR executes.

### Repository overlay (optional)

The defaults work without any setup. They cover standard Laravel locations and modular layouts: `app/Modules/*`, and nwidart's `Modules/*`, for policies, middleware, routes and migrations. An overlay is for what only your repository knows: where your tenant boundary is, where money moves, and a review budget that fits your PR sizes. `suggest` drafts one from the repository itself:

```bash
npx @semeton/change-evidence suggest            # print a proposed .change-evidence.json
npx @semeton/change-evidence suggest --write    # save it; review it, commit it in its own PR
```

`suggest` looks for four things:

- **Size**: a threshold from your own merged PRs. It only loosens a default that flags more than `--budget` (default 0.2) of your PRs. Pass `--budget` to tighten it as well.
- **Folders**: policy and middleware folders the defaults don't reach (for example `src/`).
- **Global scopes**: the scope classes and the files that register them. When they look like tenant isolation, both they and `withoutGlobalScope` calls become high.
- **Money**: payment and billing folders, at medium.

How an overlay is applied:

- Rules merge by `id`; an overlay rule replaces the built-in rule with the same id.
- `disable` removes rules by id; `size` sets your own thresholds.
- The overlay is read from the **base branch tip**, never from the PR, and a PR that edits it is itself trust-root high.

`examples/lawyering.change-evidence.json` is `suggest`'s output for a multi-tenant app, after review.

### Keeping current

The workflow pins an exact evaluator version on purpose. With `@latest`, whoever publishes the next version could change your trust root without a review. Upgrades are a reviewed change instead:

```bash
npx @semeton/change-evidence@latest upgrade          # move the pin; refresh the workflow if it's the stock template
npx @semeton/change-evidence@latest upgrade --check  # exit 1 if a newer version exists (no write)
```

If your workflow is an unmodified copy of a template this package has shipped, `upgrade` replaces it with the current template, so new Action SHAs and steps arrive with the version. If you've edited it, only the pin moves. Commit the result in its own PR.

Run locally, the CLI also prints a notice when a newer version exists. It checks at most once a day in a background process, never in CI, and never installs anything. Turn it off with `CHANGE_EVIDENCE_NO_UPDATE_CHECK=1` (or `NO_UPDATE_NOTIFIER=1`).

## Usage

```bash
npx @semeton/change-evidence pr path/to/repo --base <base-sha> --head <head-sha> --out ce/ [--github] [--fail-on high]
npx @semeton/change-evidence init                      # print the shadow-mode workflow
npx @semeton/change-evidence suggest [repo] [--budget 0.2] [--write]
npx @semeton/change-evidence upgrade [repo] [--to VERSION] [--check]
npx @semeton/change-evidence study path/to/repo --out study/ [--since 2025-01-01] [--limit 500] [--followup-days 14]
npx @semeton/change-evidence change path/to/repo <base-sha> <head-sha>   # raw JSON for one diff
npx @semeton/change-evidence --version   # or -v
npx @semeton/change-evidence --help      # or -h
```

`pr` diffs from the merge base and writes `report.md` and `evidence.json`. It exits 0 unless `--fail-on` is given; that flag is for later phases, once the study numbers justify blocking.

`study` writes three files:

- `study.csv`: one row per PR, with tier, the tier per dimension, the rules that fired, route, schema, dependency and Action counts, UNKNOWN extractors, and outcome labels.
- `study.json`: the full evidence, every rule hit, and the outcome links.
- `summary.md`: tiers against outcomes, a size-only baseline, a size-controlled comparison, a size-threshold sweep, per-rule hit rates, extractor coverage, and misses.

PRs are recovered from git alone: squash merges ending `(#N)` and `Merge pull request #N` commits on the first-parent line. No GitHub API is used.

## What it extracts (Laravel)

| Extractor | Reads | Reports | UNKNOWN when |
|---|---|---|---|
| routes | `routes/**/*.php`, statically | added, removed and changed routes, each with its full URI, action and accumulated middleware; follows `prefix/middleware/name()->group()` and `Route::group([...])` nesting; marks routes inside `if` blocks as conditional | a non-literal URI, a group loaded from another file, a dynamic prefix or domain |
| migrations | `up()` of added or changed migrations | tables created, dropped and renamed; columns added (NOT NULL without a default on an existing table is flagged), dropped, renamed and retyped; indexes; data migrations; edits to an already-shipped migration | raw SQL, non-literal table names, helper calls it can't follow |
| workflows | `.github/workflows`, `.github/actions` | each Action added, removed or re-pinned (old → new ref, SHA-pinned or not), and how many non-`uses:` lines changed | — |
| dependencies | composer.lock, pnpm-lock.yaml (v5–9), yarn.lock (v1 and berry), package-lock.json (v1–3) | direct dependencies added, removed, upgraded (major flagged) and downgraded; install scripts; transitive changes as counts | a manifest's constraints changed without its lockfile |

Routes registered by service providers or packages are outside coverage, and the results say so.

## Policy

`policies/laravel.json` holds the default rules, as data:

- **Path rules**: CI workflows, the test harness, auth config, the HTTP kernel, middleware, policies and infrastructure config.
- **Pattern rules** over added or removed diff lines: `withoutMiddleware`, `$guarded = []`, raw SQL, `{!!`, removed `authorize()` calls and skipped tests. These are labelled heuristic.
- **Evidence rules** keyed on what the extractors observed.
- **Size thresholds**.

Rules only escalate. An extractor's UNKNOWN raises its dimension to `on_unknown`, and a rule that throws does the same; neither ever counts as a pass. Pass `--policy` to use your own policy file.

## Outcome labels

Both labels are proxies.

- **reverted**: a later commit on the main line reverts the PR, matched by "This reverts commit <sha>", by a `#N` reference, or by the reverted title.
- **fix_followup**: a later `fix` PR within the window deletes or modifies lines this PR introduced (SZZ: `git blame -w` on the fix's base, test and lock files excluded). It misses fixes that only add lines and fixes not typed `fix`.

## Results: two Laravel repositories

Policy v2, all merged PRs recovered from history. Bad outcome means reverted or SZZ-linked to a later `fix` PR within 14 days.

| | [koel/koel](https://github.com/koel/koel) | [monicahq/monica](https://github.com/monicahq/monica) |
|---|---:|---:|
| PRs, period | 1,392, 2015–2026 | 445, 2023–2026 |
| Mix | feat/fix, one main author | 58% bot dependency PRs |
| Bad-outcome base rate | 8.9% | 3.8% |
| Low tier: share / bad rate | 73% / 5.9% | 74% / 0.6% |
| Medium + high: review load / capture | 27% / 52% | 26% / 88% |
| Same load by size alone: capture | 66% | 82% |
| Replay time | ~100 s | ~40 s |

What holds across both:

- **The low tier is safe to skim.** Three quarters of PRs land there, and they carry a third (Koel) to a tenth (Monica) of the bad-outcome rate of the flagged ones.
- **Size is the strongest single signal, and the size threshold is a budget choice.** Precision stays flat from 250 to 2,000 lines (about 17% on Koel, 12% on Monica). Lowering the threshold buys capture at the same hit rate. `summary.md` prints the sweep, so each team can pick its own point.

What doesn't hold:

- **Whether the other rules add anything beyond size.** On Koel, flagged and unflagged PRs of the same size fail at the same rate below 800 lines. On Monica the flagged ones fail more in every band under 250 lines, but that rests on 5 bad PRs. Two samples, two answers: this stays open until a third repository or a larger window.

Calibration from v1 to v2, each change measured before it was kept:

- `bootstrap/app.php` became a pattern rule over middleware and CSRF calls. Koel hits dropped from 23 to 3, all three real middleware changes.
- `index_change_existing_table` (medium): 28 Koel PRs at a 25% bad rate against an 8.9% base. It now catches #2511, a revert that v1 missed.
- Parser fixes: PHP method names are case-insensitive (`$table->datetime()`), and an unreadable middleware entry is recorded as `<dynamic>` instead of making every route under it UNKNOWN. Monica's route UNKNOWN rate went from 29% to 0%.

The trust-root cost is the CI rule. On Monica, 43 of 59 high-tier PRs are high because of the CI rule alone, and 21 of those only move `uses:` refs. The tier stays high: an Action version bump is a supply-chain change. Instead, the workflow extractor makes the review a glance. It lists each Action whose ref moved, from which ref to which, and whether the new ref is pinned to a SHA. `workflow_only_action_bumps` in the CSV marks PRs that change nothing else. Between them, the two repositories introduced 38 unpinned Action refs.

The consequence rules (security, data, trust root) aren't meant to predict bugs. A defect proxy can show what they cost in review load, not whether they're right; #2534, an edit to a migration that had already shipped, is the kind of change they exist for.

## Development

```bash
npm test   # node:test, fixture git repos; no network, no dependencies
```
