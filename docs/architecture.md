# Architecture

One change flows through seven stages. Each lives in its own module and talks to the next through plain data, so a second ecosystem can be added without touching the Laravel code.

| Stage | Module | Input | Output |
|---|---|---|---|
| 1. Git change acquisition | `lib/git.js` | repository, two commits | changed files (with renames), per-file line counts, numbered diff lines, file contents at a commit. Read-only; never checks out. |
| 2. File classification | `lib/generated.js` | changed files, policy, base commit | each file marked `generated` or not, from policy globs and the base's `.gitattributes` |
| 3. Extraction | `lib/extractors/*.js` | `{ cwd, base, head, changed }` | one evidence result per extractor |
| 4. Evidence normalisation | `lib/evidence.js` | extractor findings | `result()`: the shared shape, checked by `validateResult()` |
| 5. Policy evaluation | `lib/risk.js` (`assess`), `lib/policy.js` | files, line counts, diff, evidence, policy and overlay | rule hits, each with a `kind` and locations |
| 6. Risk aggregation | `lib/risk.js` | hits | a level per dimension, the review priority (the highest dimension), and `contributors` / `decided_by` |
| 7. Report generation | `lib/report.js`, `lib/markdown.js` | everything above | the PR comment; all untrusted text escaped |

`lib/study.js` runs stages 1–6 over a repository's history and adds outcomes (`lib/outcomes.js`), metrics (`lib/metrics.js`) and blind labels (`lib/labels.js`). `lib/github.js` is the privileged GitHub reporter around stages 1–7.

## The evidence contract

Every extractor returns `result(extractor, { observed, unknown, inspected, note, ecosystem })`:

| Field | Meaning |
|---|---|
| `extractor`, `ecosystem` | who produced it and what it reads (`laravel`, `composer+npm`, `github-actions`) |
| `class`, `producer` | the spec's evidence class; `trusted` for anything read as data |
| `state` | `PASS`, `UNKNOWN` (anything couldn't be established) or `NOT_APPLICABLE`. Never `PASS` with unknowns. |
| `observed[]` | `{ op, key, detail?, risk?, file?, line?, category?, conditional? }`: one fact each. `risk` names a policy evidence rule. |
| `unknown[]` | strings naming what couldn't be established, and where |
| `coverage` | `{ inspected, skipped }` |

`validateResult()` enforces this. `test/contract.test.js` runs it over every extractor on ordinary, empty, malformed and hostile changes, and checks that an extractor which throws becomes UNKNOWN and escalates.

## Adding a second ecosystem

Say, Django:

1. Write extractors (`lib/extractors/django-urls.js`, `django-migrations.js`) that return `result(..., { ecosystem: "django" })`, and register them in `EXTRACTORS` in `lib/study.js`.
2. Give their `risk` values evidence rules, and add path and pattern rules, in a new `policies/django.json`. Generated globs, size and calibration go there too.
3. Extend `lib/report.js`'s observed-impact summary if the new evidence needs its own wording. The per-dimension sections and the decision trace are already generic.

Two things are deliberately not built yet: a plugin loader, and per-repository extractor selection. Both should be designed against a second real implementation, not guessed at now. At the moment every registered extractor runs on every change, and it returns PASS ("no … changed") when nothing it reads changed.
