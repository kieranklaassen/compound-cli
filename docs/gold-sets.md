# Cases, gold sets, and cassettes

A case is a work context, the corpus it runs against pinned to a commit, and what should surface (or that nothing should). A collection of cases is what `compound eval` runs. Cassettes are recorded judge answers, so a collection replays in CI without a key and without cost.

## The collection

Cases live away from their corpora, in one private repository, `kieranklaassen/compound-evals`, grouped by corpus: `cases/cora/`, `cases/baby-agent/`, `cases/compound-packs/`, `cases/compound-engineering-plugin/`, with `cassettes/<corpus>/` beside them. A `suite.yaml` per corpus pins the repository and SHA; each case is a directory with `query.md` and `expect.yaml`. The corpus is fetched at the SHA when the cases run, so no plan or learning text is copied into the collection; a case whose corpus pin moves is a different case. The format is on the [eval page](commands/eval.md#the-format). compound-cli keeps only a smoke suite under `evals/` (ten of the plugin's cases) for its own CI.

The collection's CI is a matrix over `cases/<corpus>/`: each job checks out the pinned corpus with a read token and runs `compound eval cases/<corpus> --replay --enforce-floor` with no TypeSafe key; a scheduled job runs a sample live under `--max-cost-usd` to notice Jev drift. A public export (anonymized cases over a rewritten mirror corpus, `eval anonymize`, `check-anonymized`) is designed and deferred.

## The JSON form, deprecated

The bench's cases file (`name`, `corpus`, `floor`, `cases` of `{ id, query, expected, negative }`) is what `compound eval import` converts. `bench/cases/ce-plugin.json` stays for one release as the deprecated `bench --cases` input; its content is the plugin suite in the collection and the smoke suite under `evals/`.

Write cases the way a skill would phrase the work, never as a learning's title or an `applies_when` line: a case that quotes the label measures nothing. Labels are positive-only, so an unlisted hit is unjudged rather than wrong, and precision is a lower bound.

## The public gold set

The Compound Engineering plugin's own learnings: 37 positive cases and 6 negative cases about work the corpus does not cover, pinned at plugin commit `c152896`. All 43 are `cases/compound-engineering-plugin/` in the collection; ten of them are the smoke suite under `evals/compound-engineering-plugin/` here, replayed from `evals/cassettes/compound-engineering-plugin` (315 files) by `bun run eval:ci`. The recorded numbers are in [results](results.md#the-public-gold-set).

## Citation gold sets from a repository's plans

A repository's own plans are its best labels: a plan that cites a learning dated on or before it is a positive case, phrased the way the plan phrases the work. `bench/scripts/build-citation-gold.py --root <checkout>` walks `docs/plans/`, keeps every citation of a `docs/solutions/` file whose learning is dated on or before the plan, and writes `bench/cases/{dev,heldout}.json` inside that checkout. The primary query is the plan file itself through the plan channel, from a copy with every citation line removed: those lines are where the labels come from, so leaving them in would hand the judge the answer (a learning under `docs/solutions/tooling/` records how that leak was found). Title-plus-summary and title-only variants measure noisy inputs; uncited plans are a diagnostic, never a gate. Plans split 60/40 into dev and held-out by hash.

```bash
python3 bench/scripts/build-citation-gold.py --root ~/src/cora --floor-macro 0.55 --floor-precision 0.08
compound bench --cases ~/src/cora/bench/cases/dev.json --root ~/src/cora --jobs 4 --precision-floor 0.30 --json --out /tmp/cora-bench.json
```

The Cora set never leaves a Cora checkout: 216 plans citing 468 learnings, split into a dev set (133 plans, 307 pairs) and a held-out set (83 plans, 161 pairs). The held-out set is measured at the start and end of a run only, so it stays honest.

The builder's JSON output becomes pointer cases with `compound eval import <split>.json --out cases/cora --plans-from bench/plans --plans-to docs/plans --corpus-git <url> --corpus-ref <sha>`: each case points at the original plan with `redact_citations: true`, the judge reads the same redacted text at run time, and the recorded cassettes still match. `compound bench build --from-citations` is the planned replacement for the script itself.

## The held-out replay

Cora's held-out split (83 plans, 161 pairs, 3 synthetic negatives) is `cases/cora/` tagged `heldout` in the collection, with its 2,211 answer-only cassettes moved from this repository; the floors are macro recall at least 0.55, precision lower bound at least 0.08, negatives at 100 percent (recorded live: 62.5, 10.5, 100). The collection's CI replays it; the job that did so here is gone with the cassettes.

## Cassettes

`COMPOUND_CASSETTE_MODE=record` records every TypeSafe response under `COMPOUND_CASSETTE_DIR`, one file per request keyed by a hash of the request body; `replay` answers from those files and never touches the network (a miss is exit 5); `auto` replays a recording when one exists and records a live answer when it does not, which is what an optimization loop wants: unchanged requests stay deterministic and free, only new wording costs money. A cassette holds the request hash, the response status and body, and a little metadata, never headers or the key. Recorded answers do not depend on the threshold, so a replay alone cannot notice a threshold change; the cassette directory carries a threshold pin and `--enforce-floor` checks it.

Under `compound eval`, a suite names its cassette directory in `suite.yaml` and the flags choose the mode: `--replay`, `--record`, `--live`, or the default (replay without a key, auto with one). The `manifest.json` pin beside the cassettes carries both the hit threshold and the suggest threshold, and `--enforce-floor` refuses a replay that disagrees with it. Tests use the same mechanism from `tests/fixtures/cassettes/`; see [development](development.md).
