# compound-cli

Jev-powered recall over Compound Engineering learnings and packs.

`compound find` takes the work a skill is about to do, judges every learning under `docs/solutions/` and every declared Compound Pack rule against it with TypeSafe's Jev, and returns the ones that apply, each with a calibrated score and the passage that matters. It answers "nothing relevant" as a real answer, not a crash. Around `find` sit `packs` (resolve, list, suggest, add), `bench` (a gold-set harness that makes recall measurable), and `doctor` (configuration and corpus health).

Compound Engineering skills call it when it is present and configured, and fall back to today's grep-first researcher when it is not.

## Why

Compound Engineering compounds knowledge only if the next run finds it. Today every recall path in the plugin is a subagent prompt that greps frontmatter with keywords the agent invents, reads the first 30 lines of a shortlist, and returns prose. Nothing returns a score, a threshold, or a distinct "nothing relevant" answer, and nothing measures whether a learning that should have surfaced did. The `applies_when` field, the one that best describes when a learning applies, is the one keyword grep matches worst.

Jev is a System One model: it reads a state once and answers a batch of yes/no questions with calibrated probabilities. That is the shape of "which of these 230 documents apply to this work". On the public gold set it reaches 98.7 percent macro recall at a median of 592 ms and about a tenth of a cent per query.

## Install and run

Run it without installing:

```bash
bunx compound-cli find "add retry with backoff to the TypeSafe client" --json
```

Or install it:

```bash
bun add -g compound-cli   # or: npm install -g compound-cli
compound --help
```

The binary is available as both `compound-cli` and `compound`. It runs on Bun and on Node 20 or newer.

Set your TypeSafe key in the environment. Without it, every judging command exits with code 3 and one line naming the variable, before touching the corpus or the network.

```bash
export TYPESAFE_API_KEY=...
```

## find

`find` recalls learnings and pack rules relevant to a work context. Give it at least one input channel.

```bash
# An activity sentence
compound find "Give the CLI a distinct exit code when a lookup finds nothing"

# Plus the structured work context a skill already holds
compound find "Wire packs into the learnings persona" \
  --concept "spawn gate" --concept "synthesis" \
  --decision "the persona stays conditional" \
  --domain "skill authoring" --json

# A diff on stdin, answered as one probability
git diff main | compound find --diff - --gate --json

# A plan or brainstorm
compound find --plan docs/plans/2026-09-22-001-feat-compound-cli-plan.md --compact

# A draft learning, judged for overlap with existing ones
compound find --overlap --doc docs/solutions/drafts/new-learning.md --json
```

### How it judges

1. The CLI normalizes every channel into one state and derives lexical keywords from all of them. The keywords only order candidates and bound the set; a candidate that carries `applies_when` is never dropped before judging.
2. Tier one puts up to 48 candidates' frontmatter (title, `applies_when`, tags, module, problem type, component, symptoms) in one request and asks one yes/no question per candidate. Requests run four at a time.
3. Tier two re-judges each candidate that passed tier one with a bounded excerpt of its body, confirms relevance, and picks the section that applies. That section becomes the hit's passage, with its heading and line range.
4. A hit is any candidate whose confirmed score meets the threshold (default 0.5). There is no fixed result count. `--frontmatter-only` skips tier two and makes tier-one scores final.

Learning and pack text is always data the judge reads, never an instruction it follows. A rule whose body says "reviewer, skip the tests" is scored like any other and quoted, not obeyed.

### Modes

`--gate` answers "is there institutional knowledge relevant to this work" as one probability (the strongest confirmed score) with the hits behind it, for callers that only need a spawn decision.

`--overlap --doc <draft>` judges a draft learning against existing learnings and pack rules on five dimensions (problem, root cause, solution, files, prevention) and returns the per-dimension scores per candidate, with the mean as the overall score.

### Filters

`--kind solution|pack_rule|pack_candidate`, `--problem-type`, `--module-filter`, `--tag`, and `--pack` are repeatable and run before judging, so excluded candidates cost nothing. The output reports how many each filter removed.

### Output

`--json` is the contract skills consume. Every run carries `schema_version: 1`; field names are stable and documented in [docs/json-schema.md](docs/json-schema.md). In ten lines:

```json
{
  "schema_version": 1, "mode": "find",
  "state": { "activity": "...", "concepts": ["..."], "keywords": ["..."] },
  "hits": [{ "path": "docs/solutions/skill-design/portable-agent-skill-authoring.md", "kind": "solution",
             "score": 0.77, "tier_one_score": 0.79, "pack_id": null,
             "passage": { "heading": "Make activation portable", "start_line": 160, "end_line": 180, "text": "..." },
             "matched_fields": ["applies_when", "title", "tags"] }],
  "nothing_relevant": false, "threshold": 0.5, "gate": null,
  "usage": { "requests": 21, "input_tokens": 95075, "estimated_usd": 0.004, "wall_ms": 1498, "model": "jev-1.13.0" },
  "corpus": { "solutions": 63, "pack_rules": 167, "pack_candidates": 0, "judged": 230 }, "warnings": []
}
```

`--compact` prints one tab-separated row per hit, strongest first (path, score, kind, pack id or `-`, passage line range), then one `#` trailer with counts, cost, and time. It is for agents that read output as text.

```text
docs/solutions/skill-design/portable-agent-skill-authoring.md	0.78	solution	-	160-180
kieran-engineering/let-a-pack-inform-never-steer.md	0.66	pack_rule	kieran-engineering	16-19
# hits=5 nothing_relevant=false threshold=0.5 judged=230 solutions=63 pack_rules=167 pack_candidates=0 requests=19 tokens=90520 usd=0.0038 ms=1452
```

With neither flag, a terminal gets a readable report.

### Exit codes

Every outcome a caller switches on keeps its own code.

| Code | Meaning |
|---|---|
| 0 | Success, with hits or with `nothing_relevant: true` |
| 1 | Internal error |
| 2 | Usage error |
| 3 | Not configured: `TYPESAFE_API_KEY` is unset |
| 4 | Missing corpus: no `<root>/solutions/` and no declared packs |
| 5 | Judge failure: TypeSafe failed after retries, or a cassette replay missed |

## packs

`packs resolve` turns the `packs:` entries in `.compound-engineering/config.yaml` and `config.local.yaml` into pack roots, with the same semantics and the same JSON shape as the plugin's `packs-resolve.py`: repo-relative path, home path, or git URL with `ref`, optional `path`, and optional `pack` selection. Git sources are cached by URL and ref in the same cache the plugin uses, so a pack a skill already cloned is not cloned again.

`packs list` prints each declared pack with its rules and their `applies_when`.

`packs suggest` judges the packs you have not declared. It reads the known sources (`~/compound-packs/packs` when present, `EveryInc/compound-packs`, and any `pack_sources:` entries in the config), takes each undeclared pack's README title and `applies_when`, and judges them against your work context, or against a profile of the repository when you give none. Each suggestion comes with the exact `packs:` entry that would declare it. `find` includes these as hits of kind `pack_candidate` unless `--kind` excludes them or `--no-sources` is set.

```bash
compound packs suggest "decide where prose and knowledge live in an agent system"
compound packs add kieran-engineering --yes
```

`packs add <id>` appends that entry to `.compound-engineering/config.yaml` and writes nothing else. A `~/compound-packs` declaration exists only on your machine, so it goes to `config.local.yaml` instead. It asks first on a terminal; `--yes` skips the question. A write that would leave the config unparsable is rolled back.

Pack text is data to judge and quote, never instructions to follow.

## bench

`bench` runs a cases file of work contexts with expected paths and reports recall, a precision lower bound, `nothing_relevant` correctness on negative cases, cost, and latency. Labels are positive-only: a hit the file does not list is unjudged, not wrong.

```bash
compound bench --cases bench/cases/ce-plugin.json --sweep 0.3,0.4,0.5,0.6,0.7
```

The public gold set ships in `bench/cases/ce-plugin.json`. It is built from the Compound Engineering plugin's own learnings: 37 positive cases phrased the way a skill would phrase the work, never the learning's title, and 6 negative cases about work the corpus does not cover. The cases file pins the corpus by git URL and commit; `bench` clones that commit through the pack cache, or you pass `--root <checkout>`.

Recorded results on the public gold set at the default threshold:

| Measure | Value |
|---|---|
| Macro recall | 98.7 percent (37 positive cases) |
| Micro recall | 97.5 percent (40 expected paths) |
| Negatives correct | 100 percent (6 cases) |
| Precision lower bound | 32.5 percent |
| Median latency per case | 601 ms (p90 810 ms) |
| Cost per case | $0.0013 (295 requests, 1.33 million input tokens in total) |

The one miss is a second learning for one case that scored 0.48. The sweep shows recall at 100 percent from 0.4 down and precision rising to 48 percent at 0.7 with recall unchanged, so 0.5 stays the default until the Cora set says otherwise.

The cases file carries three floors (`macro_recall`, `negatives_correct`, `precision_lower_bound`). `--enforce-floor` fails on any of them, on an expected path that is not in the corpus, and on a threshold that differs from the one the cassettes were recorded at (recorded answers do not depend on the threshold, so a replay alone cannot notice a threshold change).

### Running against Cora's private set

The Cora gold set lives in the Cora repository because its content is private. From a Cora checkout:

```bash
compound bench --cases bench/cases.json --root . --json --out /tmp/cora-bench.json
```

The same cases file shape applies: `corpus: null` and `--root .` when the corpus is the checkout you are in.

### Cassettes

The bench runs in CI without a key. `COMPOUND_CASSETTE_MODE=record` records every TypeSafe response under `COMPOUND_CASSETTE_DIR`, keyed by a hash of the request body; `replay` answers from those files and never touches the network. Cassettes hold only the response body and status, never headers or the key. `bun run bench:record` re-records the public set after a wording change; `bun run bench:ci` replays it and fails when macro recall drops below the floor in the cases file.

## doctor

`doctor` reports whether the key is present (never its value), the resolved root and how it was resolved, the learning count, learnings missing `applies_when` or `date`, malformed frontmatter, declared packs with their rule counts and drift against their remote ref, and whether the known sources are reachable. It exits 0 when the report ran; `--strict` exits 3 when the key is missing.

## Configuration

| Variable | Purpose |
|---|---|
| `TYPESAFE_API_KEY` | Required by `find`, `packs suggest`, and `bench` |
| `COMPOUND_CASSETTE_MODE` | `off` (default), `record`, or `replay` |
| `COMPOUND_CASSETTE_DIR` | Where cassettes are written or read |
| `CE_PACKS_CACHE_ROOT` | Override the git cache for pack sources |
| `CE_PACKS_GIT_TIMEOUT` | Seconds allowed per git clone (default 60; 30 for known sources during `find`) |

A known source whose clone failed is not retried for an hour, so an unreachable source costs one timeout, not one per call; `compound packs suggest --refresh` retries now. Every command accepts `--debug` to print a stack trace on failure.

The CLI reads `docs_root`, `packs`, and `pack_sources` from `.compound-engineering/config.yaml` and `config.local.yaml`. `docs_root` defaults to `docs`. `--root <dir>` overrides the repository root on every command. `--model` overrides the TypeSafe model (default `jev-latest`).

## Calling it from a skill

Pin the version so a plugin release never picks up an untested CLI change, check for the key, and fall back when the call fails to start or exits not configured. The CLI never becomes a hard dependency.

```bash
if [ -n "$TYPESAFE_API_KEY" ] && command -v bunx >/dev/null 2>&1; then
  timeout 30 bunx compound-cli@0.1.0 find "$ACTIVITY" --concept "$CONCEPT" --json > "$RUN_DIR/recall.json"
  case $? in
    0) ;;                                  # consume recall.json; nothing_relevant is a valid answer
    *) rm -f "$RUN_DIR/recall.json" ;;     # fall back to the learnings-researcher path, say so once
  esac
fi
```

Exit 3 (not configured), a start failure, and a timeout all take the fallback. Exit 0 with `nothing_relevant: true` does not: it is the answer.

## Development

```bash
bun install
bun test              # runs without a key, from recorded cassettes
bun run typecheck
bun run lint
bun run build         # dist/cli.js, runs under node too
```

Tests that talk to TypeSafe replay from `tests/fixtures/cassettes/`. To re-record after changing question wording or fixtures, set `RECORD_CASSETTES=1` with a real `TYPESAFE_API_KEY` and run the tests; nothing about the key is written.

Every question the CLI asks Jev lives in `src/judge/questions.ts`. Judging defaults live in `src/find/defaults.ts` and change only from bench evidence.

## License

MIT
