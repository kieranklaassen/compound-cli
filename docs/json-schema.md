# JSON output, schema version 1

`compound find --json` prints one object. Field names below are the contract skills consume. Additive changes keep `schema_version` at 1; a rename or removal bumps it and gets a CHANGELOG entry.

## Top level

| Field | Type | Meaning |
|---|---|---|
| `schema_version` | number | Always `1` for this document |
| `mode` | `"find"`, `"gate"`, or `"overlap"` | Which mode ran |
| `state` | object | The normalized work context, see below |
| `hits` | array | Candidates at or above the threshold, strongest first |
| `nothing_relevant` | boolean | `true` when `hits` is empty |
| `threshold` | number | The relevance threshold used |
| `tier_one_threshold` | number | The tier-one pass that earned a body read |
| `frontmatter_only` | boolean | Whether tier two was skipped |
| `gate` | object or null | `{ probability, threshold, hits }` in gate mode, else `null` |
| `usage` | object | `{ requests, input_tokens, output_tokens, estimated_usd, wall_ms, model }` |
| `corpus` | object | Counts, see below |
| `warnings` | array of strings | Skipped files, unreachable sources, filter notes |

## state

| Field | Type | Meaning |
|---|---|---|
| `activity` | string or null | The positional sentence |
| `concepts`, `decisions`, `domains`, `modules`, `paths` | arrays of strings | The structured flags |
| `diff` | object or null | `{ files, symbols, hunks, added_lines, removed_lines, excerpt }` |
| `plan` | object or null | `{ path, title, topic, summary, requirements, decisions }` |
| `doc` | object or null | `{ path, title, applies_when, tags, excerpt }` |
| `keywords` | array of strings | Lexical keywords derived from every channel, used only by the prefilter |

## hits[]

| Field | Type | Meaning |
|---|---|---|
| `path` | string | Repo-relative for learnings; `<pack-id>/<file>` for pack items |
| `kind` | `"solution"`, `"pack_rule"`, or `"pack_candidate"` | What the candidate is |
| `score` | number | Confirmed relevance probability (tier two, or tier one with `--frontmatter-only`; the overlap mean in overlap mode) |
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
| `prefilter_dropped` | Candidates without `applies_when` cut by `--candidate-cap` |
| `filtered_out` | `{ by_kind, by_problem_type, by_module, by_tag, by_pack, total }` |

## packs suggest --json

`{ schema_version, mode: "suggest", state, repository, suggestions, considered, declared, threshold, usage, warnings }`. `suggestions` are the packs at or above the threshold, each `{ pack_id, title, applies_when, score, declaration }`; `considered` lists every judged pack with its score; `repository` is the repo profile used when no work context was given.

## bench --json

`{ schema_version, name, threshold, aggregate, sweep, cases, latency_ms, cost, corpus, model, cassette_mode, warnings }`. `aggregate` and each `sweep` entry carry `macro_recall`, `micro_recall`, `precision_lower_bound`, `negatives_correct`, `perfect_cases`, and `labeling_errors`. Each case carries its `hits`, `found`, `missed` (with the missed path's score, tier-one score, and rank), `recall`, `precision_lower_bound`, `correct_negative`, and its own latency and cost.
