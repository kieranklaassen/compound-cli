# compound-cli

Jev-powered recall over Compound Engineering learnings and packs.

`compound find` takes the work a skill is about to do, judges every learning under `docs/solutions/` and every declared Compound Pack rule against it with TypeSafe's Jev, and returns the ones that apply, each with a calibrated score and the passage that matters. It answers "nothing relevant" as a real answer, not a crash. Around `find` sit `packs` (resolve, list, suggest, add), `bench` (a gold-set harness that makes recall measurable), and `doctor` (configuration and corpus health).

The CLI is opt-in. Compound Engineering works without it, with grep and the plugin's own small helpers; a skill uses `compound` only when `command -v compound` finds it on `PATH` (never through `bunx`, which would fetch the CLI on first use), and when it is absent, exits 3, or times out, the skill runs today's path and says so once. `audit` and `audit --fix` stand on their own with no key and no `find` involved.

## Why

Compound Engineering compounds knowledge only if the next run finds it. Today every recall path in the plugin is a subagent prompt that greps frontmatter with keywords the agent invents, reads the first 30 lines of a shortlist, and returns prose. Nothing returns a score, a threshold, or a distinct "nothing relevant" answer, and nothing measures whether a learning that should have surfaced did. The `applies_when` field, the one that best describes when a learning applies, is the one keyword grep matches worst.

Jev is a System One model: it reads a state once and answers a batch of yes/no questions with calibrated probabilities. That is the shape of "which of these 230 documents apply to this work". On the public gold set it reaches 98.7 percent macro recall at a median of 592 ms and about a tenth of a cent per query.

## Where it fits

| Capability | Plain Compound Engineering | Better with the CLI | CLI only |
|---|---|---|---|
| Recall learnings for a plan, brainstorm, or review | Grep-first `learnings-researcher` over `docs/solutions/` and resolved pack roots | `compound find` ranks every candidate with calibrated Jev judgments | |
| Decide whether a review needs the learnings persona | The persona's own heuristics | `compound find --diff - --gate` returns one probability | |
| Check a draft learning against existing ones | The agent reads the related docs it found | `compound find --overlap --doc <file>` scores five dimensions | |
| Resolve declared packs | `packs-resolve.py` | `compound packs resolve`, same JSON, one implementation shared with `find` | |
| Discover packs a repository should adopt | | | `compound packs suggest`, `compound packs add` |
| Parser safety of a learning at write time | `validate-frontmatter.py` | `compound audit` adds schema and findability checks | |
| Grounding of a learning's body | `validate-doc-claims.py` | | |
| Audit a whole corpus | ce-compound-refresh, one document at a time | | `compound audit`, with rule ids, counts, and JSON |
| Repair a corpus | ce-compound-refresh edits by hand | | `compound audit --fix` (deterministic, no key), `--fix --jev` (with the judge) |
| Honor a repository's schema | The corpus-first rule in `yaml-schema.md`; CI catches the rest | | `compound audit` reads `compound.schema.fields` from the repository's config |
| Gate a repository's docs in CI | | | `compound audit --strict`, `--pack-dir` for a repository of packs |
| Measure recall, build gold sets, score fixes | | | `compound bench` and the scripts under `bench/` |

The CLI-only rows are corpus-wide work and pack discovery. Everything a skill does in the middle of a task works without it.

## Install and run

Run it without installing:

```bash
bunx compound-cli find "add retry with backoff to the TypeSafe client" --json
```

Until the package is on npm, run it straight from GitHub. The `--bun` flag matters: a git checkout has no build, and under Bun the TypeScript source runs as is.

```bash
bunx --bun github:kieranklaassen/compound-cli find "add retry with backoff to the TypeSafe client" --json
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

1. The CLI normalizes every channel into one state and derives lexical keywords from all of them. The keywords only order candidates and bound the set. Candidates without `applies_when` are cut first; when the candidates that carry `applies_when` alone exceed the cap (default 400), the weakest keyword matches among them are cut too and the output says how many, so a 5,000-learning corpus costs the same as a 400-learning one until you raise `--candidate-cap`.
2. Tier one puts up to 48 candidates' frontmatter (title, `applies_when`, tags, module, problem type, component, symptoms) plus each body's first eight section headings in one request and asks one yes/no question per candidate. Requests run four at a time. When the work has a plan, the judge reads the plan itself (up to 8,000 characters, code fences stripped), not a digest of it; a longer plan gets a warning and `state.plan.text_truncated: true`.
3. Tier two re-judges each candidate that passed tier one with a bounded excerpt of its body on a four-level rubric (unrelated, same area only, relevant background, directly applies), normalizes the expected level to a score between 0 and 1, and picks the section that applies. That section becomes the hit's passage, with its heading and line range.
4. A hit is any candidate whose confirmed score meets the threshold (default 0.6; "relevant background" sits at 0.67). There is no fixed result count. `--frontmatter-only` skips tier two and makes tier-one scores final. Pack suggestions are tier-one probabilities on a different scale and use their own threshold (0.5).

Learning and pack text is always data the judge reads, never an instruction it follows. A rule whose body says "reviewer, skip the tests" is scored like any other and quoted, not obeyed.

### Modes

`--gate` answers "is there institutional knowledge relevant to this work" as one score (the strongest confirmed learning or rule score; pack suggestions never move it) with the hits behind it, for callers that only need a spawn decision.

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
  "nothing_relevant": false, "threshold": 0.6, "gate": null,
  "usage": { "requests": 21, "input_tokens": 95075, "estimated_usd": 0.004, "wall_ms": 1498, "model": "jev-1.13.0" },
  "corpus": { "solutions": 63, "pack_rules": 167, "pack_candidates": 0, "judged": 230 }, "warnings": []
}
```

`--compact` prints one tab-separated row per hit, strongest first (path, score, kind, pack id or `-`, passage line range), then one `#` trailer with counts, cost, and time. It is for agents that read output as text.

```text
docs/solutions/skill-design/portable-agent-skill-authoring.md	0.78	solution	-	160-180
kieran-engineering/let-a-pack-inform-never-steer.md	0.66	pack_rule	kieran-engineering	16-19
# hits=5 nothing_relevant=false threshold=0.6 judged=230 solutions=63 pack_rules=167 pack_candidates=0 requests=19 tokens=90520 usd=0.0038 ms=1452
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
| 6 | Audit found files that fail: an error, or a warning under `--strict` |

Exit 1 also covers one environment case: running the `compound` bin from a git checkout under Node with no `dist/` build. The message says to use `bunx --bun` or `bun run build`.

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
| Precision lower bound | 26.7 percent |
| F0.5 | 0.313 |
| Median latency per case | 668 ms live (p90 949 ms) |
| Cost per case | $0.0015 (314 requests, 1.51 million input tokens in total) |

The one miss is a second learning for one case that scored 0.57. Recall is 100 percent at 0.5 and below; precision rises to 45 percent at 0.8 with recall unchanged.

The defaults come from an optimization run against a private set built from Cora, where 216 plans cite 468 learnings dated before the plan, measured through the plan channel with the citation lines removed. The primary metric was recall at a precision lower bound of at least 0.30 (a threshold sweep, so lowering the threshold cannot win), paired with an operating-point rule, and gated on negatives, live latency, cost per case, and this public set not regressing. Nineteen experiments ran and four were kept: the graded tier-two rubric, the 0.6 threshold, the plan text in the channel, and the section headings in tier one. On the held-out split, live, micro recall at the default threshold went from 35.4 percent (title and summary as the query, yes/no tier two) to 63.3 percent (whole plan, graded tier two) at equal precision. Score fusion with tier one, four wordings, a body lead, one question per `applies_when` line, a lexical rescue, higher tier-one passes, a 12,000-character window, a smaller batch, and skipping tier one altogether were all measured and reverted; two learnings under `docs/solutions/tooling/` record why, and the hand-classified misses put about half of what remains down to label noise.

`bench` reports F0.5 at the operating threshold and, with `--precision-floor <p>`, the best recall whose precision lower bound meets `p` and the threshold that reaches it. `--jobs <n>` runs cases concurrently; each case gets its own judge so usage is still attributed per case.

The cases file carries three floors (`macro_recall`, `negatives_correct`, `precision_lower_bound`). `--enforce-floor` fails on any of them, on an expected path that is not in the corpus, and on a threshold that differs from the one the cassettes were recorded at (recorded answers do not depend on the threshold, so a replay alone cannot notice a threshold change).

### Running against Cora's private set

The Cora gold set is built from Cora's own plans and never leaves a Cora checkout. `bench/scripts/build-citation-gold.py --root <checkout>` walks `docs/plans/`, keeps every citation of a `docs/solutions/` file whose learning is dated on or before the plan, and writes `bench/cases/{dev,heldout}.json` inside that checkout. The primary query is the plan file itself through the plan channel, from a copy with every citation line removed (those lines are where the labels come from, so leaving them in would hand the judge the answer). Title-plus-summary and title-only variants measure noisy inputs; uncited plans are a diagnostic, never a gate. Plans split 60/40 into dev and held-out by hash.

```bash
python3 bench/scripts/build-citation-gold.py --root ~/src/cora --floor-macro 0.55 --floor-precision 0.08
compound bench --cases ~/src/cora/bench/cases/dev.json --root ~/src/cora --jobs 4 --precision-floor 0.30 --json --out /tmp/cora-bench.json
```

CI replays the held-out split too. The `bench-heldout` job clones Cora at the commit the cassettes were recorded against (a `CORA_READ_TOKEN` repository secret with read access; without it the job says so and skips), rebuilds the cases with the same script, and replays `bench/fixtures/cassettes/cora-heldout/` with `--enforce-floor` (macro recall at least 0.55, precision lower bound at least 0.08, negatives at 100 percent; the recorded live values are 62.5, 10.5, and 100). Those 2,211 cassettes hold only answers (probabilities, the rubric legend, section tags), no plan or learning text. `CORA_ROOT=~/src/cora bun run bench:heldout` does the same locally. Re-record with `COMPOUND_CASSETTE_MODE=record` after a change to question wording or the judge state, then bump `CORA_COMMIT` in the workflow if Cora moved.

A case's `query` may name a `plan` file (relative to the corpus root) or a `diff` file (relative to the cases file) instead of an activity.

### Cassettes

The bench runs in CI without a key. `COMPOUND_CASSETTE_MODE=record` records every TypeSafe response under `COMPOUND_CASSETTE_DIR`, keyed by a hash of the request body; `replay` answers from those files and never touches the network; `auto` replays a recording when one exists and records a live answer when it does not, which is what an optimization loop wants: unchanged requests stay deterministic and free, only new wording costs money. Cassettes hold only the response body and status, never headers or the key. `bun run bench:record` re-records the public set after a wording change; `bun run bench:ci` replays it and fails when macro recall drops below the floor in the cases file.

## audit

Learnings compound only when their frontmatter lets the next run find them. `audit` checks every file under `docs/solutions/` against the schema in effect for the repository (the CLI's defaults, which are the plugin's `skills/ce-compound/references/schema.yaml`, layered with the repository's own `compound.schema.fields`; see [docs/config.md](docs/config.md)), the parser-safety rules of `validate-frontmatter.py`, and the findability rules the optimization run showed matter most. It behaves like a linter: `--fix` repairs what needs no judgment and no key, and `--fix --jev` adds the fixers that ask the judge.

```bash
compound audit                        # report per file, exit 6 when a file fails
compound audit --strict --json        # warnings fail too; the JSON contract for CI
compound audit --fix --dry-run        # deterministic repairs as diffs, nothing written, no key
compound audit --fix --yes            # apply them (off a TTY, --yes or --dry-run is required)
compound audit --fix --jev --dry-run  # add the Jev fixers; needs TYPESAFE_API_KEY
compound audit --packs                # also audit the rules and READMEs of declared packs (never fixed)
compound audit --pack-dir packs       # pack-authoring mode: a repository of packs, each child a pack
compound audit --stats                # field coverage, and README coverage per pack rule
```

Errors are schema and parser-safety violations; warnings are findability gaps. Exit 0 when no file has an error, 6 when one does (`--strict`, or `compound.audit.strict: true` in the config, makes warnings count), 3 for `--fix --jev` without a key, 4 with no corpus, 2 when the `compound:` block of the config has a problem.

Every finding says where its rule came from: the text report appends `[rule from config.yaml]` when a layer set it, and the JSON carries `source` (`default`, `config.yaml`, or `config.local.yaml`), so a failing check traces to the line that made the rule.

| Rule | Severity | Fixer |
|---|---|---|
| `frontmatter.missing`, `frontmatter.unterminated`, `frontmatter.invalid_yaml` | error | none (a hand) |
| `frontmatter.unsafe_scalar` (unquoted `: `, ` #`, or a reserved first character) | error | deterministic: the full raw value is recovered and quoted |
| `frontmatter.bare_literal` (`title: true`, `module: 123`, `tags: [inbox, null]`: a word YAML reads as null, a boolean, or a number) | error | deterministic: the raw word is put back as a string and written quoted |
| `title.missing` | error | deterministic: the first H1 |
| `title.weak` (placeholder, file slug, under three words) | warning | none |
| `date.missing`, `date.invalid` | error | deterministic: the file's first commit, or a date in the file name, or the loosely written value |
| `<field>.missing`, `<field>.invalid` for every enum and closed field (`problem_type`, `severity`, `resolution_type`, a repository's closed `component`, a custom `record_type`) | error | deterministic spelling (`Best Practice`, `ui-bug`), else Jev Choice over the values in effect |
| `module.missing`, `component.missing`, bug track `root_cause.missing` | error | Jev Choice over the values this corpus already uses, then the repository's or the schema's suggested values |
| `<field>.not_a_string`, `<field>.bug_track_only` (`rails_version` on a knowledge-track learning) | error | none |
| bug track: `symptoms.missing` | error | extraction from the body, each sentence judged by Jev |
| `applies_when.missing`, `applies_when.generic` (`always`, under four words, a restatement of the title) | warning (error when the repository requires it) | extraction from the body (headings, When and If sentences, failure phrasing, section leads), each judged by Jev at 0.7; at most 5 |
| `<list>.too_many`, `<list>.item_too_long`, `<list>.empty_item`, `<list>.format` | warning | deterministic for tags; none otherwise |
| `<list>.too_few`, `<list>.not_strings` | error | none |
| `tags.missing` | warning (error when required) | Jev Nouls over the corpus's own tags (used by two or more files), at 0.6, at most 8 |
| `<list>.not_a_list`, `list.duplicate` | error, warning | deterministic |
| `pack.readme_missing`, `pack.no_rules`, `pack.readme_tag_missing` | error | none |

Plain `--fix` is every deterministic fixer: the title from the first heading, the date, enum spelling, tag normalisation, scalars wrapped in lists, duplicates removed, the ` #` recovery, and bare literals quoted. A field only the judge could settle is listed as `needs_author` with the reason `needs the judge: run --fix --jev`. With `--jev`, the Jev fixers add `problem_type`, `severity`, `resolution_type`, `module`, `component`, `root_cause`, and any custom enum as a Choice over the values in effect for the repository; tags as judgments over the corpus's tags; `applies_when` and `symptoms` from sentences extracted from the body and judged one by one. The Jev choices see the document's title, frontmatter, and a 6,000-character excerpt, and how often this corpus uses each candidate value, so they follow the corpus's house style rather than a generic reading. Candidate values and sentences are data under the request state, never part of a question, so a learning cannot steer its own repair. When no candidate clears the bar, the field is marked `needs_author` with the reason. Bodies are never touched: the writer edits the frontmatter block through a YAML document model, keeps key order, comments, and a list's flow style, and reassembles the file with the original body bytes and line endings.

How close the fixers get to hand-written frontmatter, measured leave-one-out (the file's own value never in the vocabulary offered) with `bench/scripts/audit-agreement.ts`. Deterministic-only (`--fix`) cannot supply a stripped value, so the agreement numbers are for `--fix --jev`; what deterministic-only does on a real corpus is in the PR that added it (files passing before and after, on Cora's 187 learnings). With Jev: on the plugin's 63 learnings, `problem_type` 61 percent exact (track 95 percent, majority-class baseline 45), `severity` 71 (baseline 65), `component` 41 (baseline 53; the labels are near-synonyms), `module` 12 (the corpus uses 44 distinct values across 63 files, so the right value is rarely on offer), tags 66 percent recall of the tags that were on offer at 29 percent precision, and 67 percent of extracted `applies_when` sentences judged as belonging on the author's list. On compound-packs' 167 hand-tuned rules, `module` 49 percent (baseline 6), tags 61 percent precision and 73 percent recall of reachable tags, and `applies_when` extraction found no situation sentence in 148 rules (decision records state decisions, not situations), so those stay `needs_author`. Treat categorical fixes as proposals to read in the diff; treat the deterministic fixes and the extracted sentences as safe.

### Packs

`--packs` audits the packs the repository declares in `packs:`: each rule with the pack-rule schema, each `README.md` with the pack-README schema (3 to 8 `applies_when` situations, the pack id among the tags, since `packs suggest` judges a pack from its README). Declared packs live in the shared cache, so `--fix` names the pack's own repository and writes nothing.

`--pack-dir <dir>` (or `compound.audit.pack_dirs` in the config) is pack-authoring mode for a repository of packs such as compound-packs: every child directory of `<dir>` is a pack; a pack without a `README.md` is `pack.readme_missing`, one with a README and no rule file beside it is `pack.no_rules` (Compound Engineering would not publish it). These files are the repository's own, so `--fix` writes them.

`--stats` adds what `validate_solutions_frontmatter.py --stats` and `validate-packs.py --coverage` printed: how many learnings carry `title`, `applies_when`, `symptoms`, and `tags` (the fields the grep path and the judge read), and per pack the rules that share under a quarter of their `applies_when` words with the README's title and situations, with the words the README lacks. Stats never change the exit code.

In CI:

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0   # the date fixer reads the file's first commit; a shallow clone has no history, and the fixer says so
- uses: oven-sh/setup-bun@v2
- run: bunx --bun github:kieranklaassen/compound-cli audit --strict --report audit.json
```

The exit code always describes the files on disk: `--fix --dry-run` and a declined prompt still exit 6 when the corpus fails, and `summary.after_fix` in the JSON says what a `--yes` run would leave. Exit 5 means the judge failed during `--fix --jev`; nothing is written then.

`doctor` carries the audit counts too.

## doctor

`doctor` reports whether the key is present (never its value), the resolved root and how it was resolved, the learning count, learnings missing `applies_when` or `date`, malformed frontmatter, declared packs with their rule counts and drift against their remote ref, and whether the known sources are reachable. It exits 0 when the report ran; `--strict` exits 3 when the key is missing.

## Configuration

| Variable | Purpose |
|---|---|
| `TYPESAFE_API_KEY` | Required by `find`, `packs suggest`, `bench`, and `audit --fix --jev` |
| `COMPOUND_CASSETTE_MODE` | `off` (default), `record`, `replay`, or `auto` |
| `COMPOUND_CASSETTE_DIR` | Where cassettes are written or read |
| `CE_PACKS_CACHE_ROOT` | Override the git cache for pack sources |
| `CE_PACKS_GIT_TIMEOUT` | Seconds allowed per git clone (default 60; 30 for known sources during `find`) |

A known source whose clone failed is not retried for an hour, so an unreachable source costs one timeout, not one per call; `compound packs suggest --refresh` retries now. Every command accepts `--debug` to print a stack trace on failure.

The CLI reads `docs_root`, `packs`, and `pack_sources` from `.compound-engineering/config.yaml` and `config.local.yaml`, the files Compound Engineering already uses, local layered over shared. `docs_root` defaults to `docs`. Everything only the CLI reads sits under one `compound:` key in the same files: the repository's schema (`compound.schema.fields`: extend or replace an enum, close a vocabulary, add a field, change bounds, require or relax a field) and the audit's policy (`compound.audit`: `exclude`, `ignore`, `pack_dirs`, `strict`). The format is documented in [docs/config.md](docs/config.md). `--root <dir>` overrides the repository root on every command. `--model` overrides the TypeSafe model (default `jev-latest`).

## Calling it from a skill

Pass the plan file when the work has one (`--plan docs/plans/...md`). On the Cora set the whole plan as the channel lifts macro recall about ten points over a title and summary at equal precision; a title alone loses another ten. The judge is only as good as the work context it is given.

The presence check is `command -v compound`, not `bunx`: `bunx` would fetch the CLI on first use, which is not opt-in. A skill never pins a CLI release; it checks the `schema_version` in the JSON it reads. When `compound` is absent, exits 3, or times out, the skill runs today's path and says so once. The CLI never becomes a hard dependency; repositories that run `compound audit` in their own CI are the ones that pin a version.

```bash
if command -v compound >/dev/null 2>&1 && [ -n "$TYPESAFE_API_KEY" ]; then
  timeout 30 compound find "$ACTIVITY" --concept "$CONCEPT" ${PLAN_FILE:+--plan "$PLAN_FILE"} --json > "$RUN_DIR/recall.json"
  case $? in
    0) ;;                                  # consume recall.json; nothing_relevant is a valid answer
    *) rm -f "$RUN_DIR/recall.json" ;;     # fall back to the learnings-researcher path, say so once
  esac
fi
```

Exit 3 (not configured), a start failure, and a timeout all take the fallback. Exit 0 with `nothing_relevant: true` does not: it is the answer. `compound packs resolve --json` and `compound audit` follow the same rule: present on `PATH`, or the plugin's own `packs-resolve.py` and `validate-frontmatter.py`.

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
