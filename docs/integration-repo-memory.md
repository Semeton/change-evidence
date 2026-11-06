# Proposal: surfacing repository decisions in change evidence

**Status: design only. Nothing here is implemented.** The interface is set out so it can be agreed before either package changes.

## Three tools, three questions

| Tool | Question it answers | Source of truth |
|---|---|---|
| `@semeton/agent-contract` | What may this agent change? | `.agent/roles/*.yaml`, enforced at write time by hooks |
| `@semeton/repo-memory` | What has this repository accepted as knowledge and constraints? | `docs/decisions/*.md`, accepted by a human |
| `@semeton/change-evidence` | What does this change actually affect, and what deserves review? | the diff, read as git objects |

The integration adds one thing to change-evidence's report. When a PR touches files that an accepted (or rejected) decision is scoped to, the report says so, so the reviewer can check the change against the decision. It doesn't judge compliance, and it doesn't change the review priority.

### Example: lawyering

`MEM-0001` (accepted, constraint, scope `database/migrations/**`) says that changing a foreign key or a column's nullability on a table with children must run inside `withoutForeignKeyConstraints()`, with the data moved first, because SQLite's table rebuild cascades into child rows.

A PR adds `$table->foreignId('client_id')->constrained()->cascadeOnDelete()` to an existing table. change-evidence already reports `foreign_key_added … cascade_delete` (data, medium). With this integration, the report would add:

> **Repository decisions that apply**
> - `MEM-0001` *(constraint, accepted)*: SQLite rebuilds a table to change FKs or nullability, and the rebuild cascades into child rows. Applies to `database/migrations/2026_11_06_add_client_fk.php`. [docs/decisions/MEM-0001-….md]

The reviewer now knows which rule the change must be read against. Whether it complies is still their call.

## The contract

### What repo-memory provides

A generated, committed index, `docs/decisions/index.json` (or the directory configured in `repo-memory.json`), written by a new command, `npx @semeton/repo-memory export index`:

```json
{
  "schema": "repo-memory/index@1",
  "generated_by": "@semeton/repo-memory@0.2.0",
  "records": [
    {
      "id": "MEM-0001",
      "title": "SQLite rebuilds a table to change FKs or nullability, and the rebuild cascades into child rows",
      "kind": "constraint",
      "status": "accepted",
      "scope": ["database/migrations/**"],
      "file": "docs/decisions/MEM-0001-dropped-fk-constraint-from-add-tenant-and-role-to-users-tabl.md",
      "reviewed": { "by": "Semeton Balogun", "on": "2026-11-03" }
    }
  ]
}
```

| Field | Rule |
|---|---|
| `schema` | exact string `repo-memory/index@1`; a consumer refuses any other major version |
| `records[].id`, `title`, `kind`, `status`, `scope`, `file` | as in the record's frontmatter; `scope` is repo-memory's own glob syntax, documented with the index |
| `records[].reviewed` | present only for human-accepted records |
| order | by `id`, so the file diffs cleanly |

The index holds **no evidence results**. Whether a record's evidence is OK, STALE or VIOLATED is computed by `repo-memory check` and stays there. A copy in the index would go stale, and would invite change-evidence to re-judge it.

Freshness belongs to repo-memory: `repo-memory check` fails when the index doesn't match the records, so a PR that adds or edits a record must regenerate it.

### What change-evidence does with it

1. **Reads the index from the base branch tip**, like the policy overlay. A PR can't add, remove or rescope the decisions it's judged against. A PR that edits decision records or the index is reported as it is today, by path.
2. Takes records with `status` `accepted` or `rejected` (repo-memory's live statuses). Proposed, superseded and deprecated records are ignored.
3. Matches each changed file against each record's `scope`. Repository-wide scopes (`**`) are left out, or every PR would list them. Matches go in the report and in `evidence.json` under `context.decisions`.
4. Lists matches under **Repository decisions that apply**: id, kind, status, title, the matched files (up to five), and a link to the record file at the base commit. At most ten records, most specific scope first: an exact path before a directory glob before a wildcard.

### What change-evidence never does

- **It never changes the review priority because of a decision.** Not down: a PR citing MEM-0001 isn't safer. Not up either: whether a matched decision should escalate is a policy question, and if wanted later it would be an explicit policy rule (`decision_applies`), off by default.
- **It never claims compliance or violation.** It doesn't evaluate a record's evidence; `repo-memory check --since` does, in its own CI job.
- **It doesn't require repo-memory.** No index means no section. A malformed index, or an unknown schema, is one line under *Uncertainty and coverage* ("decision index unreadable: …"). It isn't treated as an UNKNOWN that raises the priority, because it's context, not evidence about the change.
- **It doesn't import repo-memory's code or parse its Markdown records.** The index is the whole interface, so the record format can change without breaking change-evidence.

## Ownership

| Concern | Owner |
|---|---|
| Record format, acceptance workflow, evidence validation | repo-memory |
| Index schema, generation and freshness check | repo-memory |
| Reading the index at the base tip, scope matching, rendering | change-evidence |
| Whether a matched decision affects priority | the repository's change-evidence policy (default: no) |
| Which files an agent may write | agent-contract |

## agent-contract

There's no integration with agent-contract in this proposal. Its rules are enforced while an agent writes, and the gate only sees the result. A future link would surface "this PR touches files outside every agent role's scope" (for example `.github/workflows/`). That needs a defined, base-branch-read view of the role scopes, and should be designed the same way as this one.

## Open questions

1. **Index location:** `docs/decisions/index.json`, or `.repo-memory/index.json` to keep generated files out of `docs/`?
2. **Rejected records:** should they show by default? They record "we chose not to do this", which is useful when a PR does it anyway, but they add noise.
3. **Glob dialect:** should the index carry a `scope_syntax` field, so change-evidence can refuse globs it doesn't understand instead of guessing?
4. **Size:** at 127 records lawyering's index would be about 40 KB. That's fine at this scale; at thousands of records a scope-prefix index would be worth adding.

Once these are settled, the implementation is small: about 150 lines in change-evidence (read, validate, match, render, tests), plus the `export index` command and its freshness check in repo-memory.
