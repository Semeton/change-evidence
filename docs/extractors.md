# Extractors: what each one can and can't establish

Every extractor:

- reads git objects as data; nothing is checked out or run;
- returns the same result for the same commits;
- either establishes a fact, or adds an UNKNOWN entry saying what it couldn't establish and where. An UNKNOWN raises the review priority (`on_unknown`) and is never treated as a pass.
- An extractor that throws becomes UNKNOWN for that change.

Each has fixture tests, malformed-input tests and adversarial tests, including pathological 100 KB lines run under a time limit to guard against regex blow-up. The tests are in `test/*extractors*.test.js`, `test/routes.test.js`, `test/migrations.test.js`, `test/dependencies.test.js` and `test/workflows.test.js`.

Each observation is `{ op, key, detail?, risk?, file?, line? }`. A `risk` names a policy evidence rule; whether and how far it escalates is the policy's decision, not the extractor's.

## Routes (`lib/extractors/routes.js`)

**Reads:**

- `routes/**/*.php`, plus module route files under `Modules/*/routes/` and `app/Modules/*/routes/`;
- `bootstrap/app.php` and `app/Http/Kernel.php`, for middleware aliases;
- added lines of changed PHP files under `app/`, `src/`, `Modules/` and `packages/`, for route registration elsewhere.

**Establishes:**

- each route's verb, full URI, action, accumulated middleware and name, following `prefix()`, `middleware()`, `name()` and `group()` nesting, the array form `Route::group([...], fn)`, and trailing `->middleware()`;
- files pulled in by `require __DIR__.'/x.php'` or `->group(base_path('routes/x.php'))`, parsed under the including group, so they inherit its prefix and middleware;
- routes inside `if`, `else` and loops, marked `conditional`;
- middleware written as `Class::class.':param'`;
- routes added, removed or changed between the two commits, and:
  - `security_middleware_removed` when an auth, can, signed, throttle, role or permission middleware is lost;
  - `unauthenticated_route` (heuristic) when a new route has no auth-like middleware;
- middleware aliases added, removed or remapped (`middleware_alias_changed`): remapping `auth` changes every route that uses it.

**UNKNOWN when:**

- a URI is non-literal (`Route::get($x, …)`), or a prefix or domain is dynamic;
- a group loads a file through a dynamic path or one that can't be read;
- a route file includes itself;
- a PHP file outside `routes/` registers routes (`Route::get` in a provider, `loadRoutesFrom`, `->routes(fn)`). Those routes aren't parsed, and the entry says where.

**Doesn't establish:**

- routes registered by packages;
- the effective middleware of module routes, which their service provider applies (they're marked `provider_loaded` and not called unauthenticated);
- middleware added globally or by group in `bootstrap/app.php` beyond aliases;
- what an action does;
- an unreadable middleware entry (`config('x')`) is recorded as `<dynamic>`. The route is still identified, and adding or removing the entry still diffs.

## Migrations (`lib/extractors/migrations.js`)

**Reads:** `up()` of added migrations under `database/migrations/` and the module equivalents; `up()` on both sides of edited migrations.

**Establishes, per operation, with a `category`** (`destructive`, `structural` or `data`):

- tables created, dropped or renamed;
- columns added, dropped, renamed or retyped:
  - `not_null_without_default` on an existing table;
  - `nullability_tightened` for `->change()` without `->nullable()`, or for `->nullable(false)`;
- indexes added or dropped (`index_change_existing_table` on existing tables);
- foreign keys:
  - `cascade_delete` for `cascadeOnDelete()` or `onDelete('cascade')`;
  - `foreign_key_dropped`;
- data migrations (`DB::table()`, Eloquent writes);
- shipped migrations edited, renamed or deleted (`migration_edited`). On a database where the migration already ran, editing it does nothing.

Laravel method names are matched case-insensitively, as PHP does.

**UNKNOWN when:**

- raw SQL appears (`DB::statement`, `unprepared`, `raw`, `select`);
- a table name is non-literal, such as a config-driven name;
- a helper method, custom abstraction or unrecognised statement is used;
- there's no readable `up()`.

**Doesn't establish:**

- whether a migration is safe to run;
- how long a lock lasts on a large table;
- database-specific behaviour (MySQL against PostgreSQL defaults, implicit commits);
- the previous definition of a column that `->change()` restates.

Syntax shows what's asked for, not what it costs.

## Dependencies (`lib/extractors/dependencies.js`)

**Reads:** root `composer.lock`, `package-lock.json` (v1–3), `yarn.lock` (classic and berry), `pnpm-lock.yaml` (v5–9), the manifests `composer.json` and `package.json`, and committed `vendor/` and `node_modules/` paths.

**Establishes:**

- direct dependencies added, removed, upgraded (`major_upgrade` across a major version) or downgraded;
- install scripts (`install_script`);
- transitive changes, as counts;
- source changes (`dependency_source_changed`): a package moving between registry, git, path and link sources, or to another host; a new direct dependency from a non-registry source;
- real replacements (`package_replacement_changed`): a package leaves the lockfile and another one now claims it via `replace`;
- npm `overrides`, yarn `resolutions` and pnpm `overrides` changing (`dependency_overrides_changed`);
- vendored code changed with no matching lockfile change (`vendored_code_changed`): files under `vendor/<pkg>` or `node_modules/<pkg>` changed, but that package's locked version didn't. Tooling files that regenerate on install (`vendor/composer`, `vendor/bin`, `node_modules/.bin`) are ignored;
- a manifest change with no lockfile in the repository (`unlocked_dependencies`).

**UNKNOWN when:**

- a lockfile can't be parsed;
- dependency constraints changed but the lockfile didn't;
- a required dependency (not peer or optional; not `workspace:`, `catalog:` or an `npm:` alias) is missing from the lockfile.

**Doesn't establish:**

- whether a version is vulnerable (no advisory database is consulted);
- nested lockfiles;
- several locked versions of one npm package (the first is used);
- what an install script does.

## Prisma (`lib/extractors/prisma.js`)

**Reads:** `**/prisma/migrations/<name>/*.sql` and `schema.prisma` (or `prisma/schema/*.prisma`), at any depth, so monorepos are covered.

**Establishes, for each added migration, statement by statement** (split outside quotes, comments, dollar-quoted bodies and parentheses), using the same operation names and risks as the Laravel extractor, so one policy rule covers both:

- `CREATE` and `DROP TABLE`, and `ADD COLUMN` (`not_null_without_default` on an existing table);
- `DROP COLUMN`, `ALTER COLUMN … TYPE` (`column_type_change`), `SET NOT NULL` (`nullability_tightened`), `RENAME`;
- indexes (`index_change_existing_table`);
- foreign keys (`cascade_delete`, `foreign_key_dropped`);
- enum types;
- `INSERT`, `UPDATE` and `DELETE` (`data_migration`), and `TRUNCATE` (`destructive`);
- SQLite's table rebuild (`PRAGMA foreign_keys=OFF` … `RENAME TO`), reported as one `table_rebuilt`, not as a drop;
- an existing migration edited, renamed or deleted (`migration_edited`).

**UNKNOWN when:**

- a statement can't be classified (extensions, functions, `DO` blocks, triggers, grants);
- `schema.prisma` changed in its models, enums, types or views with no migration added, and the repository has a migrations directory: the database change isn't recorded (`db push`, or a migration still to come). Comment-only changes don't count.

**Doesn't establish:**

- whether a migration is safe;
- lock duration;
- database-specific semantics beyond the statement text;
- migrations of other ORMs (Drizzle, TypeORM, Knex): only path rules see those.

## Workflows (`lib/extractors/workflows.js`)

**Reads:** `.github/workflows/*.yml` and `.github/actions/**`, as text, not parsed YAML.

**Establishes, so a routine bump reads differently from a change to what a workflow may do:**

- `uses:` references: added, removed or re-pinned, with old and new ref, and whether the new ref is a full SHA (`unpinned_action`). Reusable workflows and local actions are labelled;
- triggers added or removed; adding `pull_request_target`, `workflow_run`, `issue_comment` and similar is `privileged_trigger_added`;
- permissions, workflow- and job-level: `permissions_widened` for a new write scope, `write-all`, or removing explicit permissions so the repository default applies;
- new `secrets.*` references or `secrets: inherit` (`secret_exposure_changed`). `GITHUB_TOKEN` is excluded, since its reach is set by `permissions:`;
- `${{ github.event.* }}` or `github.head_ref` in an added `run:` line (`untrusted_expression_in_shell`, heuristic);
- a privileged trigger combined with a reference to PR code (`privileged_pr_checkout`, heuristic);
- workflows that publish or deploy (`release_workflow_changed`);
- non-`uses:` line counts, so "only Action bumps" is visible.

**UNKNOWN when:** a file uses tab indentation or several YAML documents.

**Doesn't establish:**

- anchors and aliases, or flow-style mappings beyond the common forms;
- what a third-party Action does;
- whether an expression is actually exploitable;
- secrets used through environment variables set elsewhere.

## Adding an extractor

An extractor is a function `(ctx) → result(...)` (see `lib/evidence.js`), where `ctx` is `{ cwd, base, head, changed }` and `changed` is the list of changed files with `status`, `path`, `from` and `generated`. Register it in `EXTRACTORS` in `lib/study.js` and give its `risk` values evidence rules in the policy. Every extractor must:

- read only through `lib/git.js`;
- turn anything it can't establish into an `unknown` entry;
- include malformed and adversarial fixtures in its tests.
