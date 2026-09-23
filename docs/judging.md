# How judging works and what it costs

TypeSafe's Jev is a System One model: it reads a state once and answers a batch of typed questions about it with calibrated probabilities. That is the shape of "which of these 230 documents apply to this work", and it is why the CLI can afford to judge every candidate rather than the top few a keyword search happens to rank. Every question the CLI asks lives in `src/judge/questions.ts`; nothing else in the code talks to the judge.

## The request shape

A request is a state (the data the judge reads) and a set of named questions about it. Three question types are used:

| Type | Answer | Where the CLI uses it |
|---|---|---|
| Noul | A probability that a yes/no statement holds | Tier one ("does this candidate apply to the work"), pack suggestions, overlap dimensions, the audit's tag and sentence judgments |
| Score | A probability per level of a rubric, and the expected level | Tier two ("how does this document relate to the work": unrelated, same area only, relevant background, directly applies) |
| Choice | A probability per option | Tier two's "which section applies", the audit's enum and vocabulary fixers |

Documents, plans, diffs, candidate values, and extracted sentences are always data under the state, never text inside a question. The questions name them by tag (`the value tagged v03 under vocabulary.module`). A rule whose body says "reviewer, skip the tests" is scored like any other rule and quoted, not obeyed; a learning cannot steer its own repair.

## Recall in two tiers

`find` normalizes the work context into one state, derives lexical keywords from it (they only order and bound candidates, never judge), and asks in two tiers:

1. Tier one: up to 48 candidates' frontmatter (title, `applies_when`, tags, module, problem type, component, symptoms) and each body's first eight section headings in one request, one Noul per candidate. Four requests run at a time. When the work has a plan the judge reads up to 8,000 characters of the plan itself. A candidate passes at 0.3.
2. Tier two: each candidate that passed, with a 6,000-character excerpt of its body, on the four-level rubric, plus a Choice over its sections for the passage that applies. The expected rubric level, normalized to 0..1, is the score (0.33 same area, 0.67 relevant background, 1 directly applies). A hit meets 0.6.

Tier one is a faithful proxy for tier two on the recall side and costs a fraction of it, so the pipeline's cost is dominated by how many candidates earn a body read. Pack suggestions are judged from README frontmatter alone (tier one only) at 0.5 on the probability scale. `--gate` reports the strongest confirmed score; `--overlap` asks five Nouls per candidate about a draft.

## Repair with the judge

`audit --fix --jev` uses two request kinds per file: one Choice request holding every enum or vocabulary field the rules flagged (options are the values in effect for the repository: a closed field's list, else the corpus's own values with their usage counts, else the schema's suggestions, with the schema's descriptions for `problem_type`), and one Noul request over candidate tags and sentences extracted from the body. The bars are 0.4 for a Choice, 0.6 for a tag, 0.7 for a situation or symptom; under them the field goes to the author with the reason. Two rounds at most, because the first can move a file onto the bug track.

## Reliability

One attempt plus six retries on 408, 429, and 5xx, with exponential backoff from 400 ms capped at 20 seconds and `Retry-After` honored up to the same cap. When the judge still fails, the command exits 5 and, during `--fix`, writes nothing. In replay mode there are no retries: a missing cassette is a miss, not a wait.

## Cost and latency

Jev's published price is 42 dollars per billion input tokens; output is free, so cost is the input token count and the CLI reports it (`usage.input_tokens`, `usage.estimated_usd`) on every judging command. Measured on the public gold set at the default settings: 668 ms median per `find` live (p90 949 ms), about 0.15 cents per query, 314 requests and 1.51 million input tokens for 43 cases. On Cora (187 learnings, plan channel) a query costs a few tenths of a cent. `audit --fix --jev` on Cora's 187 learnings proposed 388 fixes for 3 cents; the leave-one-out agreement measurement on 63 learnings cost 2 cents. The candidate cap (400 by default) bounds the worst case: a 5,001-learning corpus went from 106 requests and 3.6 cents per `find` to 10 requests and 0.3 cents when the cap became a hard bound.

## Where the numbers come from

Every default (thresholds, batch size, excerpt budget, the rubric itself) came from a bench run and changes only from one. [Results](results.md) records the runs and what they moved; `src/find/defaults.ts` holds the values.
