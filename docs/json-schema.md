# JSON output, schema version 1

`compound find --json` prints one object. Field names below are the contract skills consume. Additive changes keep `schema_version` at 1; a rename or removal bumps it and gets a CHANGELOG entry.

## Top level

| Field | Type | Meaning |
|---|---|---|
| `schema_version` | number | Always `1` for this document |
| `mode` | `"find"`, `"gate"`, or `"overlap"` | Which mode ran |
| `state` | object | The normalized work context, see below |
| `hits` | array | Learnings and pack rules at or above `threshold`, plus pack suggestions at or above `suggest_threshold`, strongest first |
| `nothing_relevant` | boolean | `true` when `hits` is empty |
| `threshold` | number | The hit bar for learnings and pack rules (default 0.6; 0.5 with `--frontmatter-only`) |
| `suggest_threshold` | number | The hit bar for pack suggestions, which are tier-one probabilities on their own scale (0.5) |
| `tier_one_threshold` | number | The tier-one pass that earned a body read |
| `frontmatter_only` | boolean | Whether tier two was skipped |
| `gate` | object or null | `{ probability, threshold, hits }` in gate mode, else `null`. `probability` is the strongest confirmed learning or rule score; pack suggestions never move it |
| `usage` | object | `{ requests, input_tokens, output_tokens, estimated_usd, wall_ms, model }` |
| `corpus` | object | Counts, see below |
| `warnings` | array of strings | Skipped files, unreachable sources, filter notes |

## state

| Field | Type | Meaning |
|---|---|---|
| `activity` | string or null | The positional sentence |
| `concepts`, `decisions`, `domains`, `modules`, `paths` | arrays of strings | The structured flags |
| `diff` | object or null | `{ files, symbols, hunks, added_lines, removed_lines, excerpt }` |
| `plan` | object or null | `{ path, title, topic, summary, requirements, decisions, text_chars, text_truncated }`. The judge also reads the plan body, bounded to 8,000 characters; `text_truncated` says whether it was cut (a warning says so too). The text itself is not echoed back |
| `doc` | object or null | `{ path, title, applies_when, tags, excerpt }` |
| `keywords` | array of strings | Lexical keywords derived from every channel, used only by the prefilter |

## hits[]

| Field | Type | Meaning |
|---|---|---|
| `path` | string | Repo-relative for learnings; `<pack-id>/<file>` for pack items |
| `kind` | `"solution"`, `"pack_rule"`, or `"pack_candidate"` | What the candidate is |
| `score` | number | For learnings and pack rules: the tier-two rubric level normalized to 0..1 (0 unrelated, 0.33 same area only, 0.67 relevant background, 1 directly applies; fractional when the judge is between levels). For pack suggestions, and for everything with `--frontmatter-only`: a tier-one probability. The overlap mean in overlap mode |
| `tier_one_score` | number | The frontmatter judgment |
| `pack_id` | string or null | The pack for pack items |
| `pack_path` | string or null | Pack-relative file for pack items |
| `title` | string | Frontmatter title, or the first heading |
| `frontmatter` | object | The parsed frontmatter as written |
| `passage` | object or null | `{ heading, start_line, end_line, text, probability }`, the section that applies; `null` for pack candidates and in `--frontmatter-only` |
| `matched_fields` | array of strings | Frontmatter fields whose tokens overlap the state keywords. Evidence, not the judgment |
| `declaration` | object or null | For pack candidates, the `packs:` entry that would declare the pack |
| `overlap` | object or null | In overlap mode, `{ problem, root_cause, solution, files, prevention, overall }` |

## corpus

| Field | Meaning |
|---|---|
| `solutions` | Learnings found under `<root>/solutions/` |
| `pack_rules` | Top-level rules across declared packs |
| `pack_candidates` | Undeclared packs from known sources |
| `judged` | Candidates sent to tier one after filters and the prefilter cap |
| `tier_two_judged` | Candidates that earned a body read |
| `prefilter_dropped` | Candidates cut by `--candidate-cap` before judging; those without `applies_when` go first |
| `prefilter_dropped_protected` | Of those, candidates that carry `applies_when`; non-zero means the corpus outgrew the cap and a warning names the count |
| `candidate_cap` | The cap in effect |
| `filtered_out` | `{ by_kind, by_problem_type, by_module, by_tag, by_pack, total }` |

## packs suggest --json

`{ schema_version, mode: "suggest", state, repository, suggestions, considered, declared, threshold, usage, warnings }`. `suggestions` are the packs at or above the threshold, each `{ pack_id, title, applies_when, score, declaration }`; `considered` lists every judged pack with its score; `repository` is the repo profile used when no work context was given.

## bench --json

`{ schema_version, name, threshold, aggregate, f05, recall_at_precision_floor, sweep, cases, latency_ms, cost, corpus, model, cassette_mode, warnings }`. `aggregate` and each `sweep` entry carry `macro_recall`, `micro_recall`, `precision_lower_bound`, `negatives_correct`, `perfect_cases`, and `labeling_errors`. `f05` is F0.5 at the operating threshold. `recall_at_precision_floor` is `null` unless `--precision-floor <p>` was passed, else `{ precision_floor, recall, macro_recall, threshold, precision_lower_bound, negatives_correct, f05 }` for the best recall whose precision lower bound meets `p` over a 0.05 sweep (all `null` inside when no threshold meets it). Each case carries its `hits`, `found`, `missed` (with the missed path's score, tier-one score, and rank), `recall`, `precision_lower_bound`, `correct_negative`, and its own latency and cost.

## audit --json

`{ schema_version: 1, strict, fix, fixers, thresholds, summary, files, excluded, stats, usage, warnings }`. `fix` is `"off"`, `"dry-run"`, `"applied"`, or `"declined"`. `fixers` lists the fixer classes that ran: `[]` without `--fix`, `["deterministic"]` with plain `--fix`, `["deterministic", "jev"]` with `--fix --jev`. `thresholds` is `{ choice, tag, situation, symptom }` with `--fix --jev`, else `null`. `strict` reflects `--strict` or `compound.audit.strict` in the config. `summary` is `{ files, passing, errors, warnings, fixable, files_failing, fixes_applied, fixes_proposed, needs_author, after_fix }`; every count except `after_fix` describes the files on disk (after `--fix --yes`, what remains), and `after_fix` is `{ errors, warnings, files_failing }` for what a write would leave when fixes were proposed but not written (`--dry-run`, a declined prompt), else `null`. Each file is `{ path, kind, findings, fix? }` with `kind` `"solution"`, `"pack_rule"`, or `"pack_readme"`; each finding is `{ rule, severity, field, message, fixable, fixer, source }` where `severity` is `"error"` or `"warning"`, `field` is a string or `null` for whole-file findings (`frontmatter.*`, `pack.*`), `fixer` is `"deterministic"`, `"jev"`, or `null`, and `source` is `"default"` (the CLI's schema) or the config layer that set the rule (`"config.yaml"`, `"config.local.yaml"`). Pack-level findings (`pack.readme_missing`, `pack.no_rules`) ride on the pack's `README.md` entry, which exists in the report even when the file does not. The rule ids are the ones in the README's audit table. With `--fix`, `fix: { changes, needs_author, diff, written, remaining }`: each change is `{ field, value, source, score?, note }` with `value` a string or a list of strings and `source` `"deterministic"` or `"jev"`; `needs_author` items are `{ field, reason }`; `diff` is a unified diff of the frontmatter block with file line numbers (the opening `---` is line 1; the delimiters themselves are not in the hunk); `remaining` lists the findings left after the rewrite. `excluded` lists the repo-relative paths `compound.audit.exclude` left out. `stats` is `null` without `--stats`, else `{ learnings: { total, unparsable, with: { title, applies_when, symptoms, tags } }, readme_coverage: [{ path, ratio, lacking }] }`. `usage` is `null` without `--fix --jev`. Exit 6 when any file on disk has an error, or a warning under `--strict`; exit 5 when the judge fails during `--fix --jev`, in which case nothing is written and no report is produced; exit 2 when the `compound:` block of the config has a problem.

## Changes within schema 1

Field names and types are stable; these are additions and one change of meaning, in order.

- `score` for learnings and pack rules became a normalized rubric level instead of a yes/no probability, and the default `threshold` moved from 0.5 to 0.6 to match. A caller that compared `score` with its own 0.5 bar should compare with 0.6, or read `threshold` from the output.
- Added `suggest_threshold`, `corpus.prefilter_dropped_protected`, `corpus.candidate_cap`, and `state.plan.text_chars` and `text_truncated`.
- `bench --json` gained `f05` and `recall_at_precision_floor`.
- Added `compound audit --json` and exit code 6.
