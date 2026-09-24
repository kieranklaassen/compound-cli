# compound-cli

The optional command-line tool for working on compound docs: the learnings under `docs/solutions/`, Compound Pack rules, the frontmatter that makes both findable, recall over them with TypeSafe's Jev, and the benches that keep recall measurable. Compound Engineering does not need it. Each command is useful on its own: a repository can run `audit` and `audit --fix` in CI to keep its corpus in shape without ever using `find`, and skills pick up better recall when `compound` is installed.

## Works without it, better with it

The compound-engineering plugin works with plain grep and its own small helpers, and keeps working that way. This tool adds to that, one command at a time:

- Repositories use `compound audit --strict` in CI to check every learning's frontmatter against the schema, with their own field rules in `.compound-engineering/config.yaml`. This is the one place a repo-local validator script gets replaced; Cora and compound-packs did that.
- `compound audit --fix` repairs a corpus deterministically with no key; `--fix --jev` adds the judge for the fields that need one.
- Skills get better recall when `compound` is on `PATH`: `compound find` judges every learning and pack rule against the work with calibrated scores, where the grep path shortlists by keyword. A skill checks `command -v compound` and falls back to grep when it is absent.
- `compound packs resolve` gives a skill the same JSON the plugin's `packs-resolve.py` gives, from one implementation shared with `find`; `packs suggest` and `packs add` find packs a repository should adopt.
- `compound eval` makes compounding measurable: a collection of cases, each a work context pinned to a corpus SHA with what should surface, so a change to frontmatter or to judging is a number, not a feeling.

## Install

```bash
bunx compound-cli --help                                   # once it is on npm
bunx --bun github:kieranklaassen/compound-cli --help       # from GitHub until then; --bun runs the source as is
bun add -g compound-cli                                    # or: npm install -g compound-cli
```

The binary is `compound` (also `compound-cli`). It runs on Bun and on Node 20 or newer. `find`, `packs suggest`, `bench`, and `audit --fix --jev` judge with Jev and need a key; everything else runs without one.

```bash
export TYPESAFE_API_KEY=...
```

## Commands

| Command | What it does |
|---|---|
| `compound find [activity] [channels]` | Recall the learnings and pack rules that apply to the work at hand, each with a calibrated score and the passage that matters; `--gate` for one probability, `--overlap --doc` to judge a draft learning |
| `compound audit [--strict] [--packs] [--pack-dir <dir>] [--stats]` | Validate learning and pack frontmatter against the schema in effect for the repository, with rule ids and the layer each rule came from |
| `compound audit --fix [--jev] [--dry-run \| --yes]` | Repair frontmatter: deterministic fixes with no key, the judge's fixes with `--jev`; every change a diff, bodies never touched |
| `compound packs resolve \| list \| suggest \| add` | Declared pack roots in the plugin's JSON shape, their rules, packs the repository should adopt, and the `packs:` entry that declares one |
| `compound eval [path]` | Run a collection of cases against pinned corpora: what should surface does, nothing surfaces when nothing applies; per-case rows, totals, floors; replays from cassettes in CI. `eval import` converts the old JSON suites, `eval add --miss` harvests a real miss |
| `compound bench --cases <file>` | Deprecated for one release: the JSON form of the same measurement; `eval import` converts it |
| `compound doctor` | The key, the corpus, declared packs and their drift, known sources, audit counts, config errors |

Planned, per the compound-docs tooling design: `compound schema` (the effective schema and where each value came from), `audit <file>...`, `packs resolve --declared-only`, `eval --kind audit` (fix agreement suites), `eval anonymize` and `check-anonymized` for a public export, `bench build --from-citations` (the citation builder is still `bench/scripts/build-citation-gold.py`), exit code 7 for an unreadable schema, and the npm release. Nothing here depends on them.

## Copy and paste

A skill recalling learnings for the work it is about to do, with today's grep path as the fallback:

```bash
if command -v compound >/dev/null 2>&1 && [ -n "$TYPESAFE_API_KEY" ]; then
  timeout 30 compound find "$ACTIVITY" ${PLAN_FILE:+--plan "$PLAN_FILE"} --json > "$RUN_DIR/recall.json" \
    || rm -f "$RUN_DIR/recall.json"   # exit 3, a start failure, or a timeout: fall back and say so once
fi
```

A repository checking its docs on every pull request:

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0                 # the date fixer reads a file's first commit
- uses: oven-sh/setup-bun@v2
- run: bunx --bun github:kieranklaassen/compound-cli#<sha> audit --strict
  # bunx compound-cli@<version> audit --strict, once it is on npm
```

A skill resolving declared packs, in the same JSON shape as the plugin's `packs-resolve.py`:

```bash
compound packs resolve --json
```

## Documentation

Start at [docs/README.md](docs/README.md). One page per command under [docs/commands](docs/commands/); the [JSON contract](docs/json-schema.md), [exit codes](docs/exit-codes.md), [schema and configuration](docs/configuration.md), [CI setup](docs/ci.md), [cases, gold sets, and cassettes](docs/gold-sets.md), [how judging works and what it costs](docs/judging.md), the [numbers from the optimize runs](docs/results.md), and [development](docs/development.md). Changes are in the [changelog](CHANGELOG.md).

## License

MIT
