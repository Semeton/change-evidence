# Validation: what the study can and can't show

`change-evidence study` replays a repository's merged PRs and compares the tool's review priority with what later happened to each PR. This document explains the method, its limits, and what four repositories show so far. The short version: **nothing here supports a claim that change-evidence predicts defective PRs.** What the evidence does support is narrower, and it's set out below.

## The question

change-evidence routes changes to human review. Two questions follow, and they need different evidence:

1. **Routing by consequence.** Does it flag the changes a reviewer *should* look at: auth, schema, money, CI, supply chain? That's a judgement, so it needs human labels (see *Independent labels*).
2. **Routing by likelihood.** Do the PRs it flags later turn out to need undoing or fixing more often than the rest? Outcome proxies can approximate this.

Most of the policy (security, data and trust-root rules) is aimed at the first question. The study's proxies only measure the second. So a rule can be right to exist and still show no lift on a defect proxy. That's why no rule is ever disabled for being quiet or noisy.

## Outcome labels

Neither label is ground truth.

| Label | Positive | Negative | Excluded |
|---|---|---|---|
| **strict** | A revert matched by commit SHA (`This reverts commit …`) or by exact title, and not later restored | No outcome of any kind | Low-confidence reverts (a `#N` mention), restored reverts, SZZ-only candidates |
| **inclusive** | Any revert, or an SZZ candidate | None | Nothing |

Every outcome records how it was found (`how`, `confidence`, `restored`, `blamed_lines`) in `study.json` and `study.csv`. Ambiguous associations are excluded from *strict* and counted; they are never silently treated as failures.

### Limits

- **Reverts:**
  - Only main-line reverts that say what they revert are found. Hand-made undo commits, refactors and reverts in other branches are invisible.
  - A revert can be for timing or a dependency, not a defect, which is why restored reverts are excluded from *strict*.
  - Both `Revert "Revert …"` and git ≥ 2.43's `Reapply "…"` are recognised as restoring the original change.
- **SZZ:**
  - It blames the lines a later fix deletes or modifies (`git blame -w` at the fix's parent), so fixes that only add lines implicate nothing.
  - It can blame a PR that merely moved a line.
  - Large PRs own more lines and so collect more blame. **SZZ is biased toward size**, and that favours the size-only baseline in every comparison here.
  - Fixes are any main-line commit, PR or direct push, typed `fix` or titled Fix…, Fixed…, Hotfix… or Bugfix…. Unlabelled fixes are missed.
- **Window:** a fix counts only within `--followup-days` (default 14). Later fixes are missed; unrelated ones can be caught.
- **PR recovery:** only squash titles ending `(#N)` and `Merge pull request #N` merges are recovered. Rebased merges, direct pushes and renamed titles are invisible, so the studied PRs are not a random sample of all changes. For merge-commit PRs, blame is mapped from the branch's commits back to the PR. Before 0.4 it wasn't, and merge-based repositories silently got no SZZ labels.

## Metrics

For *flagged* = review priority medium or high, the study reports precision, recall, false-positive rate, false-negative rate and flagged share. Each comes with a Wilson 95% interval and its numerator and denominator.

It also reports **capture at a fixed review budget** (10%, 20%, 30%): if reviewers can only look closely at that share of PRs, what share of the positives do they see? It's computed three ways:

- the **tool**, ranking by priority, with ties in PR order so size doesn't sneak in;
- **size only**, ranking by reviewable changed lines (generated files excluded);
- **random**, which in expectation captures the budget itself.

These are kept from earlier versions:

- **Size control:** positive rate within size bands, for PRs flagged by a non-size rule versus the rest.
- **Size threshold sweep:** review load and capture at each threshold.
- **Per-rule analysis:** frequency, *sole escalations* (the review load a rule adds by itself), positive rate, and *lift over size*. Lift is observed positives over the number expected from those PRs' size bands.

Results that rest on fewer than 20 positive labels are marked † and are **exploratory**: the intervals are too wide for a difference to be a finding.

## Holdout and calibration

The policy's own development history matters here. **Policy v2 and v3 were changed after studying Koel and Monica**, through 2026-11-03. Any number from those two repositories is in-sample. The policy records this in a `calibration` register, and the study prints it at the top of the summary for any matching repository.

Every study also splits PRs chronologically: the earliest 70% for development and the latest 30% held out (`--holdout`). For an uncalibrated repository, that's the protocol for tuning an overlay: tune on development, judge on holdout, and don't report holdout numbers after tuning on them. For a calibrated repository the holdout isn't independent, and the summary says so.

External validation needs repositories the policy was never tuned on. So far there are two: BookStack and lawyering.

## Results so far (policy v4, built-in rules, no overlay)

| Repository | Sample | PRs | Strict positives | Inclusive positives | Flagged | Recall (inclusive) | Precision (inclusive) | Capture at 20%: tool / size |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| koel/koel | in-sample | 1,392 | 4 † | 161 | 26.6% [24.3–29.0] | 50.3% [42.7–57.9] | 21.9% [18.0–26.4] | 33.5% / 57.1% |
| monicahq/monica | in-sample | 445 | 0 | 16 † | 25.2% [21.4–29.4] | 87.5% [64.0–96.5] | 12.5% [7.6–19.9] | 62.5% / 93.8% |
| BookStackApp/BookStack | **out-of-sample** | 435 | 0 | 16 † | 44.4% [39.8–49.1] | 75.0% [50.5–89.8] | 6.2% [3.6–10.6] | 43.8% / 25.0% |
| semeton/lawyering | **out-of-sample** | 80 | 0 | 8 † | 75.0% [64.5–83.2] | 75.0% [40.9–92.9] | 10.0% [4.7–20.1] | 25.0% / 25.0% |
| documenso/documenso (node-next v1, last 400 PRs) | **out-of-sample** | 400 | 0 | 37 | 36.8% [32.2–41.6] | 56.8% [40.9–71.3] | 14.3% [9.5–20.9] | 32.4% / 32.4% |

What this supports:

- **Strict labels are too rare to validate anything.** There are 4 confirmed reverts across 2,352 PRs. Every strict result is exploratory, in every repository.
- **On the one non-exploratory result (Koel, inclusive), size alone beats the tool at a fixed budget**: 57% against 34% at 20%, with intervals that don't overlap. Part of that is SZZ's size bias, but not obviously all of it. Koel's size-controlled table shows no lift from non-size rules below 800 lines.
- **The flagged tiers do contain more positives than the low tier** on Koel: 21.5% (medium) and 22.9% (high) against 7.8% (low). That's a real difference, but most of it is explained by size.
- **BookStack, the first out-of-sample repository, points the other way**: the tool captures 44% against 25% for size. With 16 positives the intervals overlap heavily, so it's an observation, not a finding.
- **Review load varies by repository**, from 25% (Monica) to 75% (lawyering, with large agent-written PRs). The built-in size threshold doesn't fit every repository. That's what `suggest` and overlays are for, and it has to be judged on a holdout.

- **Documenso is the first out-of-sample repository with 20+ positives**, run under the node-next policy. The tiers are ordered: 6.3% (low), 12.5% (medium) and 22.2% (high) positive rates. Flagging 37% of PRs captures 57%. At fixed budgets the tool and size are level: worse at 10% (19% against 32%), equal at 20%, slightly ahead at 30% (49% against 43%). That's the clearest evidence so far that flagged PRs carry more risk than unflagged ones. It's also evidence that, as a ranking, the tool isn't better than size.
- **zap-scan-app is in-sample for node-next.** The policy was written after reviewing the PRs that scored low there (issue #3): all seven are now medium or high, and the low tier fell from 19 to 6 of 32 PRs. That shows the rules express what they were written for, not that they generalise. Documenso is the generalisation check.

What it doesn't support:

- that change-evidence predicts defects or reverts;
- that a low-tier PR is safe;
- that any individual rule improves outcomes. Per-rule lift on every repository but Koel rests on fewer than 20 positives.

## Independent labels

Outcome proxies can't answer the routing-by-consequence question, so the study supports blind human labelling:

```bash
change-evidence study repo --out study/ --export-sample study/sample.csv --sample 60 --seed 1
# give study/sample.csv to a reviewer; keep study/sample.csv.key.json back
change-evidence study repo --out study/ --labels study/sample.csv
```

How the sample works:

- **The labeller's sheet shows no tool output.** It has the PR number, title, link and size; no tier, rules or outcome. Rows are shuffled.
- **The sample is stratified by tier**, an equal share from each, so low-tier PRs get examined: that's where a miss would hide.
- **The labeller answers one question per PR:** *did this change warrant a careful human review before merge (it touches security, data integrity, money, infrastructure, or is likely to break something)?* The answer is `risky`, `fine` or `unsure`.
- **The summary reports, per tier, the share judged risky,** with intervals; each tier is a simple random sample of itself. It also gives a size-weighted estimate of the share of risky PRs the tool flags, and how the tool and the outcome proxy agree with the human labels.

No human labels have been collected yet. This is the most useful next step, and it should come before any more rule tuning: two people labelling 60 PRs each on lawyering and BookStack would answer the question that matters most here.

## Reproducibility

The same repository, ref and options produce byte-identical `study.json`, `study.csv`, `summary.md` and sample files. No wall-clock time is recorded; the head commit identifies the input, and sampling is seeded. A test enforces this.
