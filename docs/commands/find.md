# compound find

> Recall the learnings and pack rules that apply to the work at hand, each with a calibrated score and the passage that matters.

`find` takes the work a skill is about to do, judges every learning under `docs/solutions/` and every declared Compound Pack rule against it with TypeSafe's Jev, and returns the ones that apply. It answers "nothing relevant" as a real answer, not a crash. It needs `TYPESAFE_API_KEY`.

| Question | Answer |
|---|---|
| What goes in | At least one input channel: an activity sentence, `--concept`, `--decision`, `--domain`, `--module`, `--path`, a `--diff`, a `--plan`, or a `--doc` |
| What comes out | Hits at or above the threshold, strongest first, each with a score, the tier-one score, and the section that applies; `nothing_relevant: true` when none does |
| Modes | `--gate` for one probability; `--overlap --doc <file>` to judge a draft learning against existing ones |
| Cost | About a tenth of a cent per query on a 230-document corpus, a median of 600 to 700 ms live |
| Exit codes | 0 with hits or with `nothing_relevant`; 2 usage; 3 no key; 4 no corpus; 5 the judge failed |

## Examples

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

# A plan or brainstorm; the judge reads the plan itself
compound find --plan docs/plans/2026-09-22-001-feat-compound-cli-plan.md --compact

# A draft learning, judged for overlap with existing ones
compound find --overlap --doc docs/solutions/drafts/new-learning.md --json
```

Pass the plan file when the work has one. On the Cora set the whole plan as the channel lifts macro recall about ten points over a title and summary at equal precision; a title alone loses another ten. The judge is only as good as the work context it is given.

## How it judges

1. The CLI normalizes every channel into one state and derives lexical keywords from all of them. The keywords only order candidates and bound the set. Candidates without `applies_when` are cut first; when the candidates that carry `applies_when` alone exceed the cap (default 400), the weakest keyword matches among them are cut too and the output says how many, so a 5,000-learning corpus costs the same as a 400-learning one until you raise `--candidate-cap`.
2. Tier one puts up to 48 candidates' frontmatter (title, `applies_when`, tags, module, problem type, component, symptoms) plus each body's first eight section headings in one request and asks one yes/no question per candidate. Requests run four at a time. When the work has a plan, the judge reads the plan itself (up to 8,000 characters, code fences stripped), not a digest of it; a longer plan gets a warning and `state.plan.text_truncated: true`.
3. Tier two re-judges each candidate that passed tier one with a bounded excerpt of its body on a four-level rubric (unrelated, same area only, relevant background, directly applies), normalizes the expected level to a score between 0 and 1, and picks the section that applies. That section becomes the hit's passage, with its heading and line range.
4. A hit is any candidate whose confirmed score meets the threshold (default 0.6; "relevant background" sits at 0.67). There is no fixed result count. `--frontmatter-only` skips tier two and makes tier-one scores final. Pack suggestions are tier-one probabilities on a different scale and use their own threshold (0.5).

Learning and pack text is always data the judge reads, never an instruction it follows. A rule whose body says "reviewer, skip the tests" is scored like any other and quoted, not obeyed. [Judging](../judging.md) has the request shapes and the cost model.

## Modes

`--gate` answers "is there institutional knowledge relevant to this work" as one score (the strongest confirmed learning or rule score; pack suggestions never move it) with the hits behind it, for callers that only need a spawn decision.

`--overlap --doc <draft>` judges a draft learning against existing learnings and pack rules on five dimensions (problem, root cause, solution, files, prevention) and returns the per-dimension scores per candidate, with the mean as the overall score.

## Filters

`--kind solution|pack_rule|pack_candidate`, `--problem-type`, `--module-filter`, `--tag`, and `--pack` are repeatable and run before judging, so excluded candidates cost nothing. The output reports how many each filter removed. `--no-sources` leaves undeclared packs from known sources out.

## Judging options

| Option | Default | Meaning |
|---|---|---|
| `--threshold <0..1>` | 0.6 (0.5 with `--frontmatter-only`) | The hit bar for learnings and rules |
| `--tier-one-threshold <p>` | 0.3 | The tier-one pass that earns a body read |
| `--frontmatter-only` | off | Skip tier two; tier-one scores are final |
| `--batch <n>` | 48 | Candidates per tier-one request |
| `--parallel <n>` | 4 | Concurrent requests |
| `--candidate-cap <n>` | 400 | Judged candidates at most; those without `applies_when` are cut first |
| `--excerpt-chars <n>` | 6000 | Body excerpt budget per document in tier two |
| `--model <name>` | `jev-latest` | The TypeSafe model |

The defaults come from bench evidence and change only from it; [results](../results.md) records the runs.

## Output

`--json` is the contract skills consume. Every run carries `schema_version: 1`; field names are stable and documented in the [JSON contract](../json-schema.md). In ten lines:

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

## Calling it from a skill

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

Exit 3 (not configured), a start failure, and a timeout all take the fallback. Exit 0 with `nothing_relevant: true` does not: it is the answer.
