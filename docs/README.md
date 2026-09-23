# compound-cli documentation

The README says what the tool is and how to call it. These pages hold the detail: what each command does and why, the contracts skills and CI depend on, where the schema comes from, how the judge works and what it costs, and the numbers behind the defaults. The source of truth for behaviour is the code and its tests; these pages describe it for people who use the tool.

## Works without it, better with it

compound-cli is optional and supporting. The compound-engineering plugin works without it, with plain grep and its own small helpers (`packs-resolve.py`, `validate-frontmatter.py`, `validate-doc-claims.py`), and nothing in the plugin depends on the CLI. Each command is modular and useful on its own: a repository can run `audit` and `audit --fix` to improve a corpus without ever using `find`, and a skill can call `packs resolve` without judging anything. Where the plugin and the CLI both do a job they share a contract (the same `packs:` config, the same JSON for resolved packs, the same frontmatter schema), so a skill that finds `compound` on `PATH` gets better recall and says so once when it does not. The one place a repository's own script is replaced is CI: `compound audit --strict` took over the repo-local frontmatter validators in Cora and compound-packs.

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
| Measure whether compounding works | | | [`compound eval`](commands/eval.md) over a cases collection pinned to corpus SHAs; `bench --cases` is the deprecated JSON form |

## Commands

| Page | Covers |
|---|---|
| [find](commands/find.md) | Input channels, the two judging tiers, modes (`--gate`, `--overlap`), filters, output formats, calling it from a skill |
| [audit](commands/audit.md) | The rules and their fixers, `--fix` and `--fix --jev`, pack modes, `--stats`, what the report means |
| [packs](commands/packs.md) | `resolve`, `list`, `suggest`, `add`; the `packs:` config; known sources and the cache |
| [eval](commands/eval.md) | The case and suite format, channels, modes, floors, `import` from the JSON suites, `add --miss` |
| [bench](commands/bench.md) | Deprecated: the JSON gold set runner, kept for one release |
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
| [Cases, gold sets, and cassettes](gold-sets.md) | The cases collection and where it lives, building citation cases from a repository's plans, the smoke suite, cassettes |
| [Judging](judging.md) | How Jev is asked, the two tiers, the rubric, thresholds, why documents are data and never instructions, cost and latency |
| [Results](results.md) | The public gold set, the Cora optimize run that set the defaults, the compound-packs findability run, and how close `audit --fix` gets to hand-written frontmatter |
| [Development](development.md) | Repository commands, tests and cassettes, where questions and defaults live, releasing |

## Records

`plans/` holds the plans the tool was built from, `solutions/` the learnings the work produced (audited by this repository's own CI), and `residual-review-findings/` the review findings that were noted and not applied.
