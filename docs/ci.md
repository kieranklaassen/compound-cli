# CI setup

A repository that wants its compound docs checked on every pull request runs `compound audit --strict` in a workflow and pins the CLI. The plugin never pins the CLI; repositories do. Two repositories run it today: Cora on its `docs/solutions/`, and compound-packs on its `packs/`.

## A repository of learnings

```yaml
name: Docs solutions frontmatter

on:
  pull_request:          # not path-filtered, so the check can be required
  push:
    branches: [main]
    paths:
      - "docs/solutions/**"
      - ".compound-engineering/config.yaml"
      - ".github/workflows/docs-solutions.yml"

permissions:
  contents: read

jobs:
  validate-frontmatter:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0   # only if you also run --fix here: the date fixer reads a file's first commit
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest
      # Pinned to a compound-cli commit on main. Switch to `bunx compound-cli@<version>` once it is on npm.
      - run: bunx --bun github:kieranklaassen/compound-cli#<sha> audit --strict
```

The repository's own rules live in `.compound-engineering/config.yaml` under `compound:`; see [schema and configuration](configuration.md). `--strict` makes findability warnings fail too, or set `compound.audit.strict: true` and run plain `compound audit`. The job takes a few seconds: Bun fetches the pinned commit once per runner and the audit itself runs in well under a second on a few hundred files.

## A repository of packs

```yaml
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest
      - run: bunx --bun github:kieranklaassen/compound-cli#<sha> audit --pack-dir packs --strict --stats
```

`--pack-dir packs` audits every child of `packs/` as a pack (README with 3 to 8 situations and the pack id tag, the rules beside it, a pack with no README or no rules). `--stats` adds the README coverage report to the log without changing the exit code. A custom field such as compound-packs' `record_type` is declared in the config, scoped to `pack_rule`.

## Pinning

Until the npm release the pin is a commit SHA on `kieranklaassen/compound-cli` `main`; afterwards it is `bunx compound-cli@<version>`. Pin, and move the pin on purpose: a workflow that floats on `main` picks up rule changes the moment they merge. A config written for a newer CLI fails loudly on an older one (unknown keys under `compound:` are errors, not ignored), so a config change and a pin bump travel together.

## What a failing check looks like

```text
docs/solutions/best-practices/account-scoped-feature-checklist-20260216.md
  error   component.invalid            component "gremlins" is not in this repository's list (rails_model, rails_controller, ...)  [rule from config.yaml]

compound audit: 187 files, 186 passing, 1 error, 0 warnings, 1 fixable, strict, 1 excluded by config
```

Exit 6. The rule id, the message, and the layer that set the rule are in the log; `--json` or `--report audit.json` gives the same as data for a bot to post. `--fix --dry-run` in the log shows the diffs a maintainer could apply.

## Evals in CI

A repository that keeps cases (the collection, or an `evals/` directory of its own) replays them on every pull request with no key:

```yaml
      - uses: oven-sh/setup-bun@v2
      - run: bunx --bun github:kieranklaassen/compound-cli#<sha> eval cases/cora --replay --enforce-floor
```

When the cases pin a private corpus, the job checks that repository out first with a read token; the collection's matrix does this per corpus with a `CORPUS_READ_TOKEN` secret and passes the checkout with `--root`, or lets the CLI clone the pinned SHA through the pack cache with the token in the URL. A scheduled job runs a sample live with `--live --max-cost-usd 2` and a `TYPESAFE_API_KEY` secret, so Jev drift shows up as a failed floor rather than a surprise. See [cases, gold sets, and cassettes](gold-sets.md).

## This repository's own CI

The `ci` workflow runs tests, typecheck, and lint, then `compound audit --strict` on this repository's two learnings, then `compound eval evals --replay --enforce-floor` over the smoke suite (ten of the plugin's cases, cassettes in the repository). All of it runs without a key. The full collections live in `kieranklaassen/compound-evals`.
