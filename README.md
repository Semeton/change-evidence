# change-evidence

Phase 1 of the change evidence gate: an offline study tool. It replays a repository's merged pull requests, extracts what each one changed structurally, assigns a risk tier from a policy, and joins every PR to what happened to it later. The question it answers is whether the tiers would route the right changes to a human, at a review load the team can carry, before anything is put in a merge path.

It is read-only. It reads git objects as data and never checks out, builds or runs the code it studies, so every piece of evidence it produces is *trusted* in the spec's sense.

## Usage

```bash
npx change-evidence study path/to/repo --out study/           # all merged PRs on HEAD
npx change-evidence study path/to/repo --since 2025-01-01 --limit 500 --followup-days 14
npx change-evidence change path/to/repo <base-sha> <head-sha>  # one change, as JSON
```

`study` writes three files:

- `study.csv`: one row per PR, with tier, the tier per dimension, the rules that fired, route, schema and dependency counts, UNKNOWN extractors, and outcome labels.
- `study.json`: the full evidence, every rule hit, and the outcome links.
- `summary.md`: tiers against outcomes, a size-only baseline, a size-controlled comparison, per-rule hit rates, extractor coverage, and misses.

PRs are recovered from git alone: squash merges ending `(#N)` and `Merge pull request #N` commits on the first-parent line. No GitHub API is used.

## What it extracts (Laravel)

| Extractor | Reads | Reports | UNKNOWN when |
|---|---|---|---|
| routes | `routes/**/*.php`, statically | added, removed and changed routes, each with its full URI, action and accumulated middleware; follows `prefix/middleware/name()->group()` and `Route::group([...])` nesting; marks routes inside `if` blocks as conditional | a non-literal URI, a group loaded from another file, a dynamic prefix or domain |
| migrations | `up()` of added or changed migrations | tables created, dropped and renamed; columns added (NOT NULL without a default on an existing table is flagged), dropped, renamed and retyped; indexes; data migrations; edits to an already-shipped migration | raw SQL, non-literal table names, helper calls it can't follow |
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

## First result: Koel

[koel/koel](https://github.com/koel/koel): 1,392 merged PRs from 2015 to 2026, replayed in about 80 seconds.

| Tier | PRs | Bad-outcome proxy |
|---|---:|---:|
| low | 73.6% | 5.9% |
| medium | 18.2% | 17.8% |
| high | 8.2% | 16.7% |

- **The tiers concentrate trouble.** Medium and high PRs fail at three times the rate of low ones. Routing 26% of PRs to a human catches 52% of the PRs that later needed a fix or a revert.
- **Size alone does better on that yardstick.** Flagging the same number of PRs by size catches 66%.
- **Controlling for size, the non-size rules add little.** Below 800 changed lines, PRs flagged by a non-size rule fail at the same rate as unflagged PRs of the same size. Only in the largest band does the flag separate them, at 42% against 21%. On a defect proxy, the static rules mostly rediscover size.
- **That isn't their only job.** Security, data and trust-root rules route changes by consequence, not by the likelihood of a bug. Editing a shipped migration (#2534), changing CI or loosening mass assignment needs a human whether or not it later gets "fixed". The defect proxy can't validate those rules; it can only tell you what they cost.
- **The misses are informative.** Two reverted StyleCI auto-fix PRs and one index refactor (#2511) were low tier. Index changes inside an existing table are reported but don't escalate. That's a candidate rule, to be tested before it's added.
- **One rule is noisy enough to fix.** The `http-kernel` path rule fires on every `bootstrap/app.php` edit (23 PRs). In Laravel 11+ that file holds routing, exceptions and middleware together. It should become a pattern rule over the middleware and CSRF calls.
- **Coverage.** Routes were UNKNOWN in 1% of the PRs that touched them, dependencies in 1.4%. Migrations were UNKNOWN in 14%, mostly raw SQL, config-driven table names (spatie/permission) and data-migration helpers. Those are the right things to be UNKNOWN about.

Next, in Phase 1:

- calibrate `http-kernel` and size against this data;
- add an index-change rule and measure it;
- run a second pilot repository, because one repository's history is one sample;
- record per-rule cost (review load) next to per-rule yield, so each rule earns its place.

## Development

```bash
npm test   # node:test, fixture git repos; no network, no dependencies
```
