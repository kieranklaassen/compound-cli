# compound-cli documentation

The README says what the tool is and how to call it. These pages hold the detail: what each command does and why, the contracts skills and CI depend on, where the schema comes from, how the judge works and what it costs, and the numbers behind the defaults. The source of truth for behaviour is the code and its tests; these pages describe it for people who use the tool.

## Where the tool sits

Compound Engineering works without the CLI, with grep and the plugin's own small helpers (`packs-resolve.py`, `validate-frontmatter.py`, `validate-doc-claims.py`). The CLI is opt-in and modular: `audit` and `audit --fix` improve a corpus on their own, and `find` is a recall upgrade a skill uses only when `compound` is on `PATH`. Where the plugin and the CLI both do a job, they share a contract: the same `packs:` config, the same JSON shape for resolved packs, the same frontmatter schema.

| Capability | Plain Compound Engineering | Better with the CLI | CLI only |
|---|---|---|---|
| Recall learnings for a plan, brainstorm, or review | Grep-first `learnings-researcher` | [`compound find`](commands/find.md) ranks every candidate with calibrated Jev judgments | |
| Decide whether a review needs the learnings persona | The persona's own heuristics | `compound find --diff - --gate` returns one probability | |
| Check a draft learning against existing ones | The agent reads the related docs it found | `compound find --overlap --doc <file>` scores five dimensions | |
| Resolve declared packs | `packs-resolve.py` | [`compound packs resolve`](commands/packs.md), same JSON, one implementation shared with `find` | |
| Discover packs a repository should adopt | | | `compound packs suggest`, `compound packs add` |
| Parser safety of a learning at write time | `validate-frontmatter.py` | [`compound audit`](commands/audit.md) adds schema and findability checks | |
| Grounding of a learning's body | `validate-doc-claims.py` | | |
| Audit a whole corpus | ce-compound-refresh, one document at a time | | `compound audit`, with rule ids, counts, and JSON |
| Repair a corpus | ce-compound-refresh edits by hand | | `compound audit --fix` (deterministic, no key), `--fix --jev` (with the judge) |
| Honor a repository's schema | The corpus-first rule in the plugin's `yaml-schema.md`; CI catches the rest | | `compound audit` reads [`compound.schema.fields`](configuration.md) from the repository's config |
| Gate a repository's docs in CI | | | `compound audit --strict`, `--pack-dir` for a repository of packs ([CI setup](ci.md)) |
| Measure recall, build gold sets, score fixes | | | [`compound bench`](commands/bench.md) and the scripts under `bench/` |

## Commands

| Page | Covers |
|---|---|
| [find](commands/find.md) | Input channels, the two judging tiers, modes (`--gate`, `--overlap`), filters, output formats, calling it from a skill |
| [audit](commands/audit.md) | The rules and their fixers, `--fix` and `--fix --jev`, pack modes, `--stats`, what the report means |
| [packs](commands/packs.md) | `resolve`, `list`, `suggest`, `add`; the `packs:` config; known sources and the cache |
| [bench](commands/bench.md) | Running a gold set, sweeps, precision floors, `--enforce-floor`, cassette replay |
| [doctor](commands/doctor.md) | What it reports and how to read it |

## Contracts and configuration

| Page | Covers |
|---|---|
| [JSON contract](json-schema.md) | Every field of `--json` output for `find`, `packs suggest`, `bench`, and `audit`, and the changes within schema version 1 |
| [Exit codes](exit-codes.md) | The codes every caller switches on, and which to fall back on |
| [Schema and configuration](configuration.md) | Where the default schema comes from, the `compound:` block in `.compound-engineering/config.yaml`, extending or replacing enums, custom fields, bounds, the audit's policy, Cora's and compound-packs' configs as worked examples |
| [CI setup](ci.md) | The workflow step for a repository of learnings and for a repository of packs, pinning, and what a failing check looks like |

## Measurement and method

| Page | Covers |
|---|---|
| [Gold sets and cassettes](gold-sets.md) | The cases file format, the public gold set, building a citation gold set from a repository's plans, the held-out replay in CI, cassettes |
| [Judging](judging.md) | How Jev is asked, the two tiers, the rubric, thresholds, why documents are data and never instructions, cost and latency |
| [Results](results.md) | The public gold set, the Cora optimize run that set the defaults, the compound-packs findability run, and how close `audit --fix` gets to hand-written frontmatter |
| [Development](development.md) | Repository commands, tests and cassettes, where questions and defaults live, releasing |

## Records

`plans/` holds the plans the tool was built from, `solutions/` the learnings the work produced (audited by this repository's own CI), and `residual-review-findings/` the review findings that were noted and not applied.
