# compound eval

> Run a collection of cases against pinned corpora and report whether compounding works: what should surface does, and nothing surfaces when nothing applies.

`eval` runs every case under a directory (`evals/` in the current repository by default, or a collection's `cases/`), fetches each suite's corpus at its pinned SHA, judges each case through `find` and `packs suggest`, and prints one row per case, a totals line, and the floors. It replaces `bench --cases <json>`, which stays for one release and prints a deprecation line.

| Question | Answer |
|---|---|
| Input | A tree of case directories, each `query.md` plus `expect.yaml`, with `suite.yaml` files pinning corpora and floors |
| Output | Per case: PASS, FAIL, or SKIP, a score, time, cost, notes. Totals per channel, near misses, floors. `--json` for the whole thing |
| Channels | `find` (learnings and pack rules) and `suggest` (packs); a case runs whichever its expectation names |
| Modes | `--replay` from cassettes with no key; `--record`; `--live`; default replay without a key, auto with one |
| Exit codes | 0 floors hold; 6 a floor failed under `--enforce-floor`; 2 malformed case; 3 no key for a live run; 4 corpus unreachable; 5 replay miss |

## The format

A case is a directory. `query.md` carries the work context: frontmatter for the structured channels and metadata, the activity sentence as the body. `expect.yaml` carries the expectation.

```text
cases/cora/
├── suite.yaml
├── 2026-02-11-refactor-gemini-model-migration/
│   ├── query.md
│   └── expect.yaml
└── miss-ruby-native-gem-react-package-upgrade/
    ├── query.md
    └── expect.yaml
```

```markdown
---
tags: [heldout, plan]
plan: docs/plans/2026-02-11-refactor-gemini-model-migration-flash-lite-plan.md
redact_citations: true
---
```

```yaml
hits:
  - docs/solutions/best-practices/flipper-shadow-mode-gradual-rollout-20250204.md
```

`query.md` frontmatter keys: `kind` (`find` or `packs`; inferred from the expectation when absent), `tags`, `note`, `source`, `plan` (a file relative to the corpus root), `redact_citations` (drop every plan line that names a learning by path before the judge reads it, since those lines are where citation labels come from), `diff` (a file relative to the case), `concepts`, `decisions`, `domains`, `modules`, `paths`, and `corpus` (a case-level pin that overrides the suite's). The body is the activity sentence; a case needs at least one channel.

`expect.yaml` keys: `hits` (learnings by repo-relative path, pack rules as `<pack-id>/<file>`), `packs` (pack ids `suggest` must propose), `near_miss` (paths or pack ids that must not surface), `nothing_relevant: true`. A case expects something: hits, packs, or nothing. A `nothing_relevant` case with a `near_miss` list is an adversarial negative and is scored apart from the clear negatives.

`suite.yaml` at any level sets, for the cases below it: `corpus` (`git` and `ref`, a commit SHA, cloned through the pack cache; or `path`, a local directory; plus `docs_root` and an informational `token` naming the secret CI reads it with), `floors` (`macro_recall`, `negatives_correct`, `precision_lower_bound`, `suggest_macro_recall`, `near_miss_correct`), `cassettes` (a directory relative to the file), `kinds` (`solution`, `pack_rule`: restrict the find channel; a repository of packs uses `pack_rule`), `packs_source` (the directory `suggest` judges, for a repository of packs), `threshold`, `suggest_threshold`, `channels` (what a `nothing_relevant` case runs). The nearest file wins per key; floors merge with the stricter value.

A case is a pointer plus an expectation. The corpus is fetched at its SHA when the case runs, so no plan or learning text is copied into the collection, and a pin that moves is a different case.

## Running

```bash
compound eval                                   # evals/ in this repository
compound eval cases/cora --replay --enforce-floor
compound eval cases --tag heldout --jobs 4 --sweep 0.5,0.6,0.7
compound eval cases/compound-packs --kind packs
compound eval cases --live --max-cost-usd 2 --tag drift-sample
compound eval cases --root ~/src/cora           # one checkout as every suite's corpus
```

`--case <id>` (the directory name or its path under the root) and `--tag <tag>` select cases; `--kind find|packs` selects a channel. `--sweep` re-scores the find channel at other thresholds from the same judgments. `--max-cost-usd` stops starting cases once the run's estimated cost passes the cap; the rest are SKIP and `cost_cap.reached` is true, and floors are computed over what ran. `--json` and `--out` write the [report](../json-schema.md#eval---json).

Scoring per case: a positive case scores its recall (hits found over hits expected, per channel, averaged when both ran) and passes at 1; a negative case passes when nothing surfaced; a near-miss item that surfaces fails the case whatever else happened; an expected path that is not in the corpus is a labeling error and fails the gate. Totals: find macro and micro recall, a precision lower bound (labels are positive-only), clear negatives correct, suggest macro recall and negatives, and the share of near-miss cases that held.

## The channels

The find channel runs `find` against the pinned corpus with the checkout's own `.compound-engineering/config.yaml`, so its declared packs are in play, and no known pack source, so a run is reproducible. A repository of packs sets `kinds: [pack_rule]` (its own config declares its `packs/` directory) so only rules are judged.

The suggest channel judges the packs under `packs_source` from the point of view of a repository that declares nothing and knows only that source: what a repository adopting these packs would be offered. The built-in sources are never consulted.

## Import and add

```bash
compound eval import bench/cases/ce-plugin.json --out cases/compound-engineering-plugin --cassettes bench/fixtures/cassettes/ce-plugin
compound eval import cora/bench/cases/heldout.json --out cases/cora --plans-from bench/plans --plans-to docs/plans \
  --corpus-git https://github.com/EveryInc/cora.git --corpus-ref <sha> --tag heldout
compound eval import tools/findability-bench/cases.json --out cases/compound-packs --packs \
  --corpus-git https://github.com/EveryInc/compound-packs.git --corpus-ref <sha>
```

`import` converts compound-cli's bench JSON or compound-packs' findability cases into case directories and a `suite.yaml`, and copies a cassette directory as it is: the same request has the same hash, so nothing is re-recorded. A bench suite gets `kinds: [solution]` because the bench never loaded declared packs. `--plans-from` and `--plans-to` turn pointers at redacted plan copies back into the originals with `redact_citations: true`; the judge then reads byte-identical text, so the recorded answers still match. Splits become tags (`dev`, `heldout`), as do `title-summary`, `title-only`, `uncited`, `negative`, `near-miss`, and `pack:<id>`.

```bash
compound eval add --miss --out ../compound-evals/cases/cora --id miss-ruby-native-gem-react-package-upgrade \
  --plan docs/plans/2026-08-27-cursor-update-ruby-native-gem-b259-plan.md --redact-citations \
  --expect docs/solutions/developer-experience/ruby-native-released-gem-react-package-upgrade.md \
  --note "The plan re-derived bump both halves together without citing the learning"
```

`add --miss` harvests a real miss from the repository you are in: the work context in hand (an activity, `--plan`, the channel flags), the repository's origin URL (credentials stripped) and HEAD as the case's corpus pin, what should have surfaced (`--expect`, `--expect-pack`, `--near-miss`), and a one-line `--note`. It writes the case directory for a pull request into the collection.

## Cassettes and modes

A suite's `cassettes` directory holds Jev's answers keyed by request hash, never plan or learning text. `--replay` answers from them and needs no key (a request with no recording is exit 5); `--record` records every answer; `--live` ignores them; with no flag, a run replays when it has no key and runs in `auto` (replay what exists, record the rest) when it has one. Re-record after a change to question wording or the judge state; [gold sets and cassettes](../gold-sets.md) has the detail.

## What is not here yet

Audit agreement suites (`--kind audit`, leave-one-out `audit --fix` scoring with per-field floors), `eval anonymize` and `check-anonymized` for a public export, a vendored mirror corpus, and `bench build --from-citations` (the citation builder is still `bench/scripts/build-citation-gold.py`, whose JSON `import` converts). The collection today is the private repository `kieranklaassen/compound-evals`.
