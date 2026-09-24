# compound bench (deprecated)

> The JSON form of the eval: run a cases file and report recall, a precision lower bound, negatives, cost, and latency.

Deprecated in favour of [`compound eval`](eval.md), which reads a directory of cases pinned to corpus SHAs and covers the suggest channel and near misses too. `bench --cases` stays for one release and prints a deprecation line; convert a file with `compound eval import <file> --out evals/<name> --cassettes <dir>` and nothing is re-recorded.

`bench` runs a cases file of work contexts with expected paths through `find` and scores the result. Labels are positive-only: a hit the file does not list is unjudged, not wrong, which is why precision is a lower bound. It needs a key live, and none when it replays from cassettes.

| Question | Answer |
|---|---|
| Input | A cases file (format in [gold sets](../gold-sets.md)); the corpus it pins, or `--root <checkout>` |
| Output | Macro and micro recall, precision lower bound, negatives correct, perfect cases, F0.5, a threshold sweep, per-case detail, cost and latency |
| Gates | `--enforce-floor` fails on the floors in the cases file |
| Offline | `COMPOUND_CASSETTE_MODE=replay` answers from recorded cassettes |

## Examples

```bash
compound bench --cases bench/cases/ce-plugin.json --sweep 0.3,0.4,0.5,0.6,0.7
compound bench --cases ~/src/cora/bench/cases/dev.json --root ~/src/cora --jobs 4 --precision-floor 0.30 --json --out /tmp/cora-bench.json
bun run bench:ci        # replay the public set from cassettes and enforce its floors
bun run bench:record    # re-record the public set after a wording change
```

## Options

| Option | Meaning |
|---|---|
| `--cases <file>` | The cases file |
| `--root <dir>` | Corpus checkout; overrides the cases file's corpus block |
| `--threshold <0..1>` | The hit bar (default 0.6) |
| `--sweep <p,p,...>` | Re-score the same judgments at several thresholds; judgments do not depend on the threshold, so a sweep costs nothing extra |
| `--frontmatter-only` | Skip tier two |
| `--precision-floor <p>` | Report the best recall whose precision lower bound meets `p`, and the threshold that reaches it, over a 0.05 sweep |
| `--jobs <n>` | Cases to run concurrently; each case gets its own judge so usage is still attributed per case |
| `--enforce-floor` | Exit 1 when a floor in the cases file is not met, when an expected path is not in the corpus, or when a replay's recorded threshold differs from the one in effect |
| `--json`, `--out <file>` | The full result as JSON, to stdout or to a file |

The cases file carries three floors: `macro_recall`, `negatives_correct`, `precision_lower_bound`. Recorded answers do not depend on the threshold, so a replay alone cannot notice a threshold change; the threshold pin in the cassette directory does, and `--enforce-floor` checks it.

## Reading the numbers

Macro recall averages per case; micro recall counts expected paths. The precision lower bound counts expected hits over all hits. `negatives_correct` is the share of negative cases with no hit. F0.5 weights precision over recall at the operating threshold. `recall_at_precision_floor` is the number an optimize run steers by: a threshold sweep is inside it, so lowering the threshold cannot win. Per case, the result lists hits, found and missed paths (with each miss's score, tier-one score, and rank), recall, precision, and its own latency and cost. The [JSON contract](../json-schema.md#bench---json) names every field.

## Gold sets and cassettes

The public gold set ships in `bench/cases/ce-plugin.json` and replays in CI from `bench/fixtures/cassettes/ce-plugin`. A private set can be built from any repository's own plans with `bench/scripts/build-citation-gold.py`, and CI replays Cora's held-out split when a `CORA_READ_TOKEN` secret is present. How the sets are built, what the case format is, and how cassettes work are in [gold sets and cassettes](../gold-sets.md); the recorded numbers are in [results](../results.md).

## Planned

`bench build --from-citations` and `bench audit --strip | --compare` will replace `bench/scripts/build-citation-gold.py`, `audit-agreement.ts`, and `audit-compare.ts`; pack-rule and suggest cases, a lexical baseline, a body-hash gate, a latency probe, and multiple case files are on the same list. Until then the scripts under `bench/scripts/` are the way to run those measurements.
