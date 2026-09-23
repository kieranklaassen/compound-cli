# compound-cli

The one command-line tool for compound docs: the learnings under `docs/solutions/`, Compound Pack rules, the frontmatter that makes both findable, recall over them with TypeSafe's Jev, and the benches that keep recall measurable. It replaces the repo-local scripts that did these jobs one repository at a time. Compound Engineering works without it; a skill uses `compound` when `command -v compound` finds it, and a repository that wants its docs checked in CI pins one version and runs `compound audit --strict`.

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
| `compound bench --cases <file>` | Run a gold set and report recall, a precision lower bound, negatives, cost, and latency; replays from cassettes in CI |
| `compound doctor` | The key, the corpus, declared packs and their drift, known sources, audit counts, config errors |

Planned, per the compound-docs tooling design: `compound schema` (the effective schema and where each value came from), `audit <file>...`, `packs resolve --declared-only`, `bench build --from-citations` and `bench audit` (replacing the scripts under `bench/scripts/`), exit code 7 for an unreadable schema, and the npm release. Nothing here depends on them.

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

Start at [docs/README.md](docs/README.md). One page per command under [docs/commands](docs/commands/); the [JSON contract](docs/json-schema.md), [exit codes](docs/exit-codes.md), [schema and configuration](docs/configuration.md), [CI setup](docs/ci.md), [benches and gold sets](docs/gold-sets.md), [how judging works and what it costs](docs/judging.md), the [numbers from the optimize runs](docs/results.md), and [development](docs/development.md). Changes are in the [changelog](CHANGELOG.md).

## License

MIT
