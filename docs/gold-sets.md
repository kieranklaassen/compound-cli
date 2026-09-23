# Gold sets and cassettes

A gold set is a file of work contexts, each with the learnings or pack rules a person doing that work should have read. `compound bench` runs it and scores the result. Cassettes are recorded judge answers, so a gold set replays in CI without a key and without cost.

## The cases file

```json
{
  "name": "ce-plugin",
  "description": "Where the cases came from and how they were written",
  "corpus": { "git": "https://github.com/EveryInc/compound-engineering-plugin.git", "ref": "c152896...", "docs_root": "docs" },
  "floor": { "macro_recall": 0.85, "negatives_correct": 1, "precision_lower_bound": 0.25 },
  "cases": [
    {
      "id": "exit-code-for-expected-empty-result",
      "query": { "activity": "Add a distinct exit code so a caller can tell an expected empty result from a real read failure" },
      "expected": ["docs/solutions/agent-friendly-cli-principles.md"],
      "note": "No applies_when on this learning; recall must come from title and tags."
    },
    {
      "id": "neg-tls-certificate",
      "query": { "activity": "Rotate the TLS certificate on the production load balancer before it expires" },
      "expected": [],
      "negative": true
    }
  ]
}
```

`corpus` pins the checkout by git URL and commit; `bench` clones that commit through the pack cache, or `--root <checkout>` overrides it. A case's `query` carries any of `find`'s channels: `activity`, `concepts`, `decisions`, `domains`, `modules`, `paths`, a `plan` file (relative to the corpus root), or a `diff` file (relative to the cases file). `expected` lists paths as `find` reports them (repo-relative for learnings, `<pack-id>/<file>` for pack rules). `negative: true` expects `nothing_relevant`. `floor` holds the three gates `--enforce-floor` checks.

Write cases the way a skill would phrase the work, never as a learning's title or an `applies_when` line: a case that quotes the label measures nothing. Labels are positive-only, so an unlisted hit is unjudged rather than wrong, and precision is a lower bound.

## The public gold set

`bench/cases/ce-plugin.json` is built from the Compound Engineering plugin's own learnings: 37 positive cases and 6 negative cases about work the corpus does not cover. Its cassettes are under `bench/fixtures/cassettes/ce-plugin` (315 files). `bun run bench:ci` replays it and enforces its floors; `bun run bench:record` re-records it after a change to question wording. The recorded numbers are in [results](results.md#the-public-gold-set).

## Citation gold sets from a repository's plans

A repository's own plans are its best labels: a plan that cites a learning dated on or before it is a positive case, phrased the way the plan phrases the work. `bench/scripts/build-citation-gold.py --root <checkout>` walks `docs/plans/`, keeps every citation of a `docs/solutions/` file whose learning is dated on or before the plan, and writes `bench/cases/{dev,heldout}.json` inside that checkout. The primary query is the plan file itself through the plan channel, from a copy with every citation line removed: those lines are where the labels come from, so leaving them in would hand the judge the answer (a learning under `docs/solutions/tooling/` records how that leak was found). Title-plus-summary and title-only variants measure noisy inputs; uncited plans are a diagnostic, never a gate. Plans split 60/40 into dev and held-out by hash.

```bash
python3 bench/scripts/build-citation-gold.py --root ~/src/cora --floor-macro 0.55 --floor-precision 0.08
compound bench --cases ~/src/cora/bench/cases/dev.json --root ~/src/cora --jobs 4 --precision-floor 0.30 --json --out /tmp/cora-bench.json
```

The Cora set never leaves a Cora checkout: 216 plans citing 468 learnings, split into a dev set (133 plans, 307 pairs) and a held-out set (83 plans, 161 pairs). The held-out set is measured at the start and end of a run only, so it stays honest.

`compound bench build --from-citations` is the planned replacement for the script.

## The held-out replay in CI

The `bench-heldout` job clones Cora at the commit the cassettes were recorded against (a `CORA_READ_TOKEN` repository secret with read access; without it the job says so and skips), rebuilds the cases with the same script, and replays `bench/fixtures/cassettes/cora-heldout/` with `--enforce-floor` (macro recall at least 0.55, precision lower bound at least 0.08, negatives at 100 percent; the recorded live values are 62.5, 10.5, and 100). Those 2,211 cassettes hold only answers (probabilities, the rubric legend, section tags), no plan or learning text. `CORA_ROOT=~/src/cora bun run bench:heldout` does the same locally. Re-record with `COMPOUND_CASSETTE_MODE=record` after a change to question wording or the judge state, then bump `CORA_COMMIT` in the workflow if Cora moved.

## Cassettes

`COMPOUND_CASSETTE_MODE=record` records every TypeSafe response under `COMPOUND_CASSETTE_DIR`, one file per request keyed by a hash of the request body; `replay` answers from those files and never touches the network (a miss is exit 5); `auto` replays a recording when one exists and records a live answer when it does not, which is what an optimization loop wants: unchanged requests stay deterministic and free, only new wording costs money. A cassette holds the request hash, the response status and body, and a little metadata, never headers or the key. Recorded answers do not depend on the threshold, so a replay alone cannot notice a threshold change; the cassette directory carries a threshold pin and `--enforce-floor` checks it.

Tests use the same mechanism from `tests/fixtures/cassettes/`; see [development](development.md).
