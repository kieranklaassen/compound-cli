# Results

The numbers behind the defaults and the claims. Every figure here came from a `bench` run, an optimize run, or a measurement script in this repository; the dates are 2026-09-22 unless said otherwise. Jev was `jev-1.13.0` behind `jev-latest` throughout.

## The public gold set

`bench/cases/ce-plugin.json`, the Compound Engineering plugin's own 63 learnings, 37 positive and 6 negative cases, at the default threshold 0.6:

| Measure | Value |
|---|---|
| Macro recall | 98.7 percent (37 positive cases) |
| Micro recall | 97.5 percent (40 expected paths) |
| Negatives correct | 100 percent (6 cases) |
| Precision lower bound | 26.7 percent |
| F0.5 | 0.313 |
| Median latency per case | 668 ms live (p90 949 ms) |
| Cost per case | $0.0015 (314 requests, 1.51 million input tokens in total) |

The one miss is a second learning for one case that scored 0.57. Recall is 100 percent at 0.5 and below; precision rises to 45 percent at 0.8 with recall unchanged. CI replays this set from cassettes and fails under floors of 0.85 macro recall, 100 percent negatives, and 0.25 precision.

## The Cora optimize run that set the defaults

A ce-optimize run over compound-cli against a private set built from Cora, where 216 plans cite 468 learnings dated before the plan, measured through the plan channel with the citation lines removed, split 60/40 into dev and held-out by hash. The primary metric was recall at a precision lower bound of at least 0.30 (a threshold sweep, so lowering the threshold cannot win), paired with an operating-point rule, and gated on negatives, live latency, cost per case, and the public set not regressing.

Nineteen experiments ran and four were kept: the graded tier-two rubric in place of a yes/no question, the 0.6 threshold that matches its scale, the plan text itself in the channel (up to 8,000 characters), and each body's first eight section headings in tier one. On the held-out split, live, micro recall at the default threshold went from 35.4 percent (title and summary as the query, yes/no tier two) to 63.3 percent (whole plan, graded tier two) at equal precision. Score fusion with tier one, four wordings, a body lead, one question per `applies_when` line, a lexical rescue, higher tier-one passes, a 12,000-character window, a smaller batch, and skipping tier one altogether were all measured and reverted. Two learnings under `docs/solutions/tooling/` record why the query channel is the lever and how a citation gold set leaks its labels; a hand classification of the remaining misses put about half down to label noise. Merged as compound-cli #8.

## The compound-packs findability run

A ce-optimize run over `EveryInc/compound-packs` (12 packs, 167 rules), editing frontmatter only, measured with `find --kind pack_rule` and `packs suggest` against 123 hand-written work contexts (105 positive, 8 negatives, 10 adversarial near-misses; 66 dev, 57 held-out), three live runs per experiment read as the median. The primary metric, the mean of find and suggest macro recall at 0.5:

| Measure | Dev before | Dev after | Held-out before | Held-out after |
|---|---|---|---|---|
| Primary | 0.904 | 0.996 | 0.849 | 0.984 |
| find macro recall | 0.991 | 0.991 | 0.979 | 0.979 |
| suggest macro recall | 0.816 | 1.000 | 0.719 | 0.990 |
| find precision lower bound | 0.190 | 0.240 | 0.188 | 0.241 |

The README is the whole suggest channel: writing each README's `applies_when` as the union of its rules' situations moved suggest recall from 0.82 to 0.99 on dev and 0.72 to 0.99 held-out, and grep recall over the same lines from 0.75 to 0.97. Ten experiments, five kept; about $3.20 of Jev calls. The run landed as compound-packs PR 24, whose CI now runs `compound audit --pack-dir packs --strict`.

## Cora's frontmatter pass, and what the audit's fixers reach

Cora PR 3276 rewrote the frontmatter of all 187 learnings by hand against the same citation set (83 held-out plans, 161 pairs). Four states of that corpus, measured on the held-out set:

| State | Files passing `compound audit` (default schema) | Lexical recall, grep top 25 over frontmatter | Judge micro recall at 0.6 | Judge macro | Precision lower bound | Perfect cases |
|---|---|---|---|---|---|---|
| Cora `main` before the pass | 91 of 187 | 55.3 percent | 64.6 | 63.7 | 10.7 | 42 of 86 |
| `main` plus deterministic `audit --fix` (no key) | 114 of 187 | 55.9 percent | not run | | | |
| `main` plus `audit --fix --jev` | 158 of 187 | 57.8 percent | 61.5 | 61.1 | 10.3 | 41 |
| The hand-written pass | 187 of 187 (with Cora's config) | 67.7 percent | 64.6 | 66.3 | 11.4 | 44 |

Deterministic-only moves grep by half a point: titles and tag spelling are what it adds, and grep already saw the titles in the body. With the judge, the auto-fix buys a fifth of the grep gain the hand-written pass bought and costs three points of judge recall, because its extracted `applies_when` are fewer and terser (1.7 items per file against 4.6 written), which makes tier two stricter without the precision the hand-written situations bring. Frontmatter moves grep far more than it moves the judge. The auto-fix is a floor a corpus reaches for three cents; the hand-written pass is the ceiling; `compound audit --strict` keeps a corpus at either.

## Agreement with hand-written frontmatter

How close `audit --fix --jev` gets to what a person wrote, measured leave-one-out (the file's own value never in the vocabulary offered) with `bench/scripts/audit-agreement.ts`. Deterministic-only cannot supply a stripped value, so these are the judge's numbers.

| Field | Plugin, all six fields stripped (n=43) | Plugin, `problem_type` and `severity` stripped (n=62) | compound-packs rules (n=167) |
|---|---|---|---|
| `problem_type` exact | 32.6 percent (majority baseline 55.8; track agreement 95.3) | 56.5 (baseline 45.2) | 38.3 (baseline 35.3; track 80.2) |
| `severity` exact | 67.4 (baseline 62.8) | 66.1 (baseline 64.5) | not in the corpus |
| `module` exact | 9.3 (baseline 14; 21 of 43 hand-written values existed elsewhere in the corpus; 19 percent among those) | | 49.7 (baseline 6; 55 percent among reachable) |
| `component` exact | 34.9 (baseline 51.2) | | not in the corpus |
| tags | precision 29 percent, recall of reachable tags 66 percent | | precision 61, recall of reachable 73 |
| `applies_when`, per-item precision | 67 percent of proposed sentences belong on the author's list; 8 of 43 `needs_author` | | 71 percent; 148 of 167 `needs_author` |
| `applies_when`, whole list equivalent | 3 percent | | 0 |

Against Cora's hand-written pass, per field (`bench/scripts/audit-compare.ts`): `problem_type` 87 percent agreement on 47 proposals, `resolution_type` 98 on 44, `date` and `title` 100 on 11 and 49, `severity` 58 on 24 (`medium` where the person wrote `high`), `root_cause` 59 on 22 (the person coined values outside the schema), `module` 46 on 13, `component` 1 of 25 (a house decision in the PR against the corpus's own value; with Cora's config the Choice is now over Cora's closed list), tags 84 percent precision and recall on 39 files, `applies_when` 92 percent of items accepted per item on 96 files, `symptoms` 100 percent per item on 19.

Reading: `problem_type` labels on the knowledge track are near-synonyms and agreement depends on how much other frontmatter remains as a cue; `module` is a free label in the plugin corpus (44 distinct values over 63 files) and consistent in the packs corpus, and agreement follows. What the audit writes, a person agrees with; it writes less than a person does, and hands back the rest. Treat categorical fixes as proposals to read in the diff; treat the deterministic fixes and the extracted sentences as safe.
