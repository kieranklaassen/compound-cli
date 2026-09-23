---
title: compound audit - Plan
type: feat
date: 2026-09-22
topic: compound-audit
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: kieran-brief
execution: code
---

# compound audit - Plan

## Goal Capsule

- **Objective:** Add `compound audit`, the `lint` item deferred from v1: validate every learning under `docs/solutions/**` (and declared pack rules with `--packs`) against the plugin's frontmatter schema and parser-safety rules, report per file with house exit codes, and with `--fix` repair what can be repaired: deterministic fixes first, then Jev-judged categorisation for enum and vocabulary fields, then extracted-and-judged `applies_when` lines, never invented text and never a body edit.
- **Authority hierarchy:** Kieran owns product decisions; the brief's shape (flags, fix order, TypeSafe-only judging, `needs_author` over invention, diffs for every fix, CI use) is settled. Everything else is the implementer's judgment and is marked as such.
- **Execution profile:** Same repository, TypeScript on Bun, branch stacked on PR #8 (`e4e77d1`). Five units in dependency order; every unit ships tests that run without a key, using the fake judge for plumbing and recorded cassettes for Jev wording.
- **Stop conditions:** Stop and report if the `yaml` library cannot rewrite a frontmatter block without disturbing untouched keys and comments (the diff-first contract depends on it), or if Jev cannot produce a Choice over 17 enum values in one request.
- **Tail ownership:** LFG owns simplification, review, PR, and CI watching.

---

## Product Contract

### Summary

Learnings compound only when their frontmatter lets the next run find them, and the optimization run showed that learnings without a title or `applies_when` are the largest fixable class of misses. `compound audit` makes the schema enforceable in CI and `compound audit --fix` closes the gap for existing corpora without a human rewriting each file.

### Problem Frame

The plugin ships a schema (`skills/ce-compound/references/schema.yaml`) and a parser-safety validator (`validate-frontmatter.py`) that checks one file for quoting hazards. The packs repository ships `tools/validate-packs.py` for pack frontmatter. Nothing validates a whole `docs/solutions/` tree against the schema, nothing reports findability gaps (`applies_when` missing or generic, weak titles), and nothing repairs them. Cora's corpus has 187 learnings; on the held-out set 14 of 48 hand-read misses were learnings with no title or `applies_when`.

### Key Decisions

- **D1 (settled): `audit` never edits bodies.** Only the frontmatter block between the delimiters changes; body bytes are preserved exactly.
- **D2 (settled): fixes are deterministic first, Jev second, `needs_author` last.** No fixer writes text Jev did not judge against the document, and no fixer invents an `applies_when` line: candidates come from the body and are judged; when none pass, the file is marked `needs_author`.
- **D3 (settled): TypeSafe is the only judge (plan Q7).** `--fix` without a key exits 3 with the not-configured message even though the deterministic fixers could run; the contract stays simple.
- **D4 (settled): every fix is a diff.** `--dry-run` writes nothing, `--yes` skips the prompt, a non-TTY run without `--yes` or `--dry-run` is a usage error rather than a hang.
- **D5 (agent-recommended): the schema is embedded in the CLI** (`src/audit/schema.ts`), a transcription of the plugin's `schema.yaml` with its file and commit named in a comment. Locating an installed plugin at runtime is brittle across hosts; a drift test in the plugin repository is the follow-up.
- **D6 (agent-recommended): two severities.** `error` is a schema or parser-safety violation (the file would be misread or fails the schema); `warning` is a findability gap (`applies_when` missing or generic, tags missing or malformed, weak title). Exit 6 when any error; `--strict` makes warnings count.
- **D7 (agent-recommended): `title` is required.** The schema omits it because it predates the rule; CE discovery and this CLI both key on it.
- **D8 (agent-recommended): open-vocabulary fields follow the corpus-first rule.** `module`, `component`, and `root_cause` are judged as a Choice over the values the corpus already uses (most-used spelling), falling back to the schema's suggested values only when the corpus has none; a corpus with a single candidate value is not a choice and the field is `needs_author`.
- **D9 (agent-recommended): pack rules are audited, never fixed.** Declared packs live in the shared git cache; `--fix` reports them and skips writes.

### Requirements

- R1. `compound audit [--root <dir>] [--json] [--strict] [--packs] [--report <file>]` walks `<docs_root>/solutions/**/*.md` (same boundary rules as `find`: symlinks that leave the repository are refused) and reports per file.
- R2. Rules (each has an id, a severity, a field, a message, and whether a fixer exists):
  - `frontmatter.missing` (error): no `---` block at the top.
  - `frontmatter.unterminated` (error): opening delimiter without a closing `---` line.
  - `frontmatter.invalid_yaml` (error): the block does not parse or is not a mapping.
  - `frontmatter.unsafe_scalar` (error, fixable): an unquoted scalar or list item containing `: ` or ` #`, or starting with a YAML reserved indicator, per `validate-frontmatter.py` and the schema's quoting rule.
  - `title.missing` (error, fixable from the first H1), `title.weak` (warning): under three words, equal to the file slug, or a placeholder (`untitled`, `notes`, `todo`, `learning`).
  - `date.missing` (error, fixable from git history or a date in the file name), `date.invalid` (error, fixable when a parseable date is present).
  - `problem_type.missing` and `problem_type.invalid` (error, fixable: casing and separator normalisation, else Jev Choice).
  - `module.missing` (error, fixable: Jev Choice over corpus values).
  - `component.missing` (error, fixable: Jev Choice over corpus values, then suggested values).
  - `severity.missing` and `severity.invalid` (error, fixable: normalisation, else Jev Choice).
  - Bug track only (problem_type in the bug list): `symptoms.missing` (error, fixable: extraction and Jev), `root_cause.missing` (error, fixable: Jev Choice, corpus-first), `resolution_type.missing` and `resolution_type.invalid` (error, fixable: normalisation, else Jev Choice).
  - `applies_when.missing` (warning, fixable: extraction and Jev), `applies_when.generic` (warning, fixable the same way): an item under four words, a placeholder (`always`, `any time`, `general`, `when applicable`, `working on this codebase`), or a restatement of the title; `applies_when.too_many` (warning): over 5 items; `applies_when.item_too_long` (warning): over 300 characters; `applies_when.not_a_list` (error, fixable: wrap a scalar).
  - `tags.missing` (warning, fixable: Jev Nouls over the corpus vocabulary), `tags.format` (warning, fixable: lowercase, hyphenate, dedupe), `tags.too_many` (warning, fixable: keep the first 8), `tags.not_a_list` (error, fixable).
  - `list.duplicate` (warning, fixable) for any array field with case-insensitive duplicates.
- R3. Pack rules (`--packs`) use the pack rule set from `validate-packs.py`: title, `applies_when` 1 to 8, tags 1 to 8 lowercase, `module`, `problem_type` enum, `record_type` in decision/rule/observation; pack READMEs are not audited (they are not rules).
- R4. Output: a terminal report grouped by file with one line per finding (`error` or `warning`, rule id, field, message), a summary line (files, passing, errors, warnings, fixable, needs_author), and `--json` with `schema_version: 1` and the same data. `--report <file>` writes the JSON regardless of the terminal format.
- R5. Exit codes: 0 when no error (and no warning under `--strict`); 6 when findings fail; 2 usage; 3 `--fix` without a key; 4 no `docs/solutions/` and no packs. Exit 6 is a new documented code, "audit found files that fail", so 1 keeps meaning an internal error.
- R6. `compound audit --fix [--dry-run] [--yes]`: for every file with fixable findings, apply deterministic fixers, then Jev fixers, produce a unified diff of the frontmatter block, and either print the diffs and stop (`--dry-run`), print and write (`--yes`), or print, prompt once `Apply N fixes to M files? [y/N]` on a TTY, and write on `y`. Non-TTY without `--yes` or `--dry-run` is exit 2 with a one-line explanation. The exit code after `--fix` reflects the findings that remain.
- R7. Deterministic fixers: `date` (first commit date of the file from `git log --diff-filter=A --follow --format=%as`, else a `YYYY-MM-DD` or `YYYYMMDD` in the file name); enum normalisation for `problem_type`, `severity`, `resolution_type` (case, whitespace, hyphen versus underscore); `tags` normalisation; scalar to list for `applies_when`, `tags`, `symptoms`; `title` from the first H1; quoting hazards (the writer quotes as needed); duplicate removal.
- R8. Jev fixers: `problem_type` as a Choice over the 17 schema values; `severity` and `resolution_type` as Choices over their enums; `module`, `component`, `root_cause` as Choices over corpus values (D8); `tags` as one Noul per vocabulary entry (vocabulary: every tag used by at least two files in the corpus, most frequent first, at most 60), keeping items at or above 0.6 to a total of 8 with existing valid tags kept; `applies_when` and `symptoms` by extraction and judgment (R9). Every Jev fixer sends the document's title, existing frontmatter, and a bounded body excerpt as state; document text never enters a question or a Choice label (KTD19 of the v1 plan).
- R9. Extraction for `applies_when`: candidate sentences from H2 and H3 headings, sentences starting with When, If, Whenever, Before, After, or Deciding, sentences containing symptom or failure phrasing (`error`, `fails`, `hangs`, `times out`, `regression`, `silently`), and the first sentence under Problem, Context, or Rule headings; each candidate trimmed to a sentence of 6 to 200 characters, deduplicated, at most 12. Jev answers one Noul per candidate, "a situation in which someone should read this learning before proceeding". The top items at or above 0.7, at most 5, become `applies_when`; existing non-generic items are kept and count toward the 5. No candidate at 0.7 marks the file `needs_author` with the reason. Symptoms use the same machinery with the symptom phrasing set and the question "an observable symptom of the problem this learning records".
- R10. The report lists every applied fix with its source (`deterministic`, `jev`, and the score for Jev fixes) and every `needs_author` field with the reason. A second `--fix` run on a fixed corpus changes nothing (idempotency).
- R11. `doctor` runs the audit rules (no Jev) and adds an `audit` block: files, errors, warnings, and a hint to run `compound audit`; `doctor --json` carries the counts.
- R12. Documentation: README section with the CI snippet (`compound audit --strict`), the rule table, the fixer table with which fixers need Jev, and the `--fix` workflow; CHANGELOG; `docs/json-schema.md` for the audit JSON and exit 6.
- R13. Measurement: `bench/scripts/audit-agreement.ts` strips chosen fields from a copy of a corpus whose frontmatter is trusted, runs the fixers, and reports agreement: exact match for `problem_type`, `severity`, `module`, `component`; Jaccard and precision for `tags`; Jev-judged equivalence for `applies_when` (one Noul per file, "do these two lists describe the same situations", against the hand-written list). Corpora: Cora's hand-optimised rewrites when the report at `docs/cora-solutions-optimize.md` in the store has landed, else the plugin's 63 learnings and the compound-packs PR 24 rule rewrites, stated as such.

### Acceptance Examples

- AE1. A corpus with one clean file: `compound audit` exits 0 and prints `1 file, 1 passing, 0 errors, 0 warnings`.
- AE2. A file with `problem_type: Best Practice`, no `date`, tags `[Rails, rails, Active Record]`: `audit` reports three findings, all fixable; `audit --fix --dry-run` shows one diff that sets `problem_type: best_practice`, adds `date:` from git history, and rewrites tags to `[rails, active-record]`; nothing is written; `audit --fix --yes` writes it; a second `audit --fix --yes` prints `nothing to fix` and exits 0.
- AE3. A file with no `applies_when` and a body whose Problem section reads "When the sync job runs twice for one mailbox, the second run raises a unique index error": `--fix` writes an `applies_when` with that sentence (Jev at or above 0.7) and reports the score; a file whose body is a bare table gets `needs_author: applies_when` and no invented text.
- AE4. `TYPESAFE_API_KEY` unset: `compound audit` runs and reports; `compound audit --fix` exits 3 naming the variable before reading any file.
- AE5. A file whose body contains `## Not a heading` inside a code fence and a title with a colon: `--fix` quotes the title and never proposes the fenced line as `applies_when`; the body is byte-identical after writing.
- AE6. 1,001 files: `audit` finishes in under ten seconds without a key; `--fix --dry-run` with a key batches Jev questions (at most 200 per request) and stays under one request per file on average for the Choice fixers.

### Success Criteria

- Every rule and every fixer has a unit test; the fixture corpus covers every failure class; the golden diff test pins the diff format; the idempotency test passes.
- On the plugin's 63 learnings with `problem_type`, `module`, `component`, and `tags` stripped, agreement is measured and reported in the PR body, with `applies_when` equivalence judged by Jev.
- `bun test`, typecheck, lint green without a key; CI green on the stacked PR.

### Scope Boundaries

- No body edits, no file renames, no duplicate-learning detection (that is `find --overlap`).
- Pack rules are audited, not fixed (D9).
- No schema download from the plugin at runtime (D5).
- No `--fix` without a key (D3).

### Dependencies / Assumptions

- The `yaml` package already in the dependency set can round-trip a document (`parseDocument`, `set`, `toString`) preserving key order and comments.
- Git is available for the date fixer; without it the fixer falls back to the file name and then `needs_author`.
- The Cora frontmatter report may or may not exist at measurement time; R13 names the fallback.

---

## Planning Contract

### Key Technical Decisions

- **KTD1.** `src/audit/` owns the feature: `schema.ts` (enums, limits, tracks), `document.ts` (split a file into frontmatter text, parsed data, body, and delimiter lines), `rules.ts` (pure: document in, findings out), `fixers/deterministic.ts`, `fixers/jev.ts`, `fixers/extract.ts`, `writer.ts` (apply field changes through `yaml`'s Document API and produce the new file text plus a unified diff of the frontmatter block), `report.ts` (types and renderers). `src/commands/audit.ts` is dispatch and prompting only.
- **KTD2.** Findings are data: `{ rule, severity, field, message, fixable }`. Fixers return `{ field, value, source, score?, note? }` changes or a `needs_author` marker. The command composes them; nothing in `rules.ts` knows about Jev.
- **KTD3.** Jev requests reuse `Judge.ask` and the question helpers in `src/judge/questions.ts`; Choice fixers batch one request per file (all enum and vocabulary Choices for that file), Noul fixers (tags, applies_when candidates) batch across the file's questions and rely on `planBatches` for the 200-question limit. State per file: `{ task, document: { title, frontmatter, excerpt }, vocabulary }`; questions refer to tags only.
- **KTD4.** The writer edits the frontmatter as a `yaml` Document so untouched keys, order, and comments survive; it then reassembles `---\n<yaml>---\n<body>` with the original body bytes and the original delimiter and line-ending style. The unified diff covers the frontmatter block only, with the file path as the header.
- **KTD5.** Exit 6 `FINDINGS` joins `src/exit-codes.ts` and the README table.
- **KTD6.** `doctor` imports `auditCorpus` (rules only) and reports counts; it does not import fixers.
- **KTD7.** Generic-`applies_when` detection is a pure function with a fixed phrase list and a title-restatement check (Jaccard of word sets at or above 0.8), so it is testable and cheap.
- **KTD8.** The agreement script lives in `bench/scripts/` beside `measure-recall.ts`, uses the same cassette conventions, and prints one JSON object.

### High-Level Technical Design

`audit` -> load config (`openWorkspace`) -> enumerate files (learnings walker from `src/corpus/learnings.ts`, plus pack rule roots from `resolvePacks` when `--packs`) -> `splitDocument` -> `runRules(document, context)` where context carries the corpus vocabulary (module, component, root_cause, tags counts) -> collect `FileAudit { path, findings, kind }` -> render or JSON -> exit code. With `--fix`: `judgeFromEnv` first (exit 3 without a key), then per fixable file: deterministic fixers -> Jev fixers (one Choice request, then Noul batches) -> writer -> diff; collect `FileFix { path, changes, needs_author, diff }`; show; prompt or not; write; re-run rules on the new text to report what remains.

### Output Structure

```
src/audit/schema.ts            enums, limits, tracks, suggested values
src/audit/document.ts          splitDocument, hazards (unsafe scalars)
src/audit/rules.ts             runRules, generic applies_when, weak title
src/audit/vocabulary.ts        corpus vocabulary (module, component, root_cause, tags)
src/audit/fixers/deterministic.ts
src/audit/fixers/extract.ts    candidate sentences for applies_when and symptoms
src/audit/fixers/jev.ts        Choice and Noul fixers
src/audit/writer.ts            apply changes, diff
src/audit/report.ts            types, renderText, renderJson
src/commands/audit.ts          command
src/judge/questions.ts         auditChoiceRequest, auditNoulRequest
src/exit-codes.ts              FINDINGS = 6
tests/audit-rules.test.ts      one test per rule
tests/audit-fixers.test.ts     one test per fixer, extraction, needs_author
tests/audit-writer.test.ts     golden diffs, body untouched, idempotency
tests/audit-command.test.ts    end to end over tests/fixtures/audit/, exit codes, prompt, robustness
tests/fixtures/audit/          one file per failure class plus a clean file
bench/scripts/audit-agreement.ts
```

### Sequencing

U1 rules and schema; U2 command, report, doctor; U3 deterministic fixers and writer; U4 Jev fixers and extraction; U5 measurement and docs.

### Deferred to Follow-Up Work

- A drift test in the plugin repository that fails when `schema.yaml` and `src/audit/schema.ts` disagree.
- Fixing pack rules in place (needs a writable pack source).
- Body edits of any kind.

---

## Implementation Units

| U-ID | Title | Key files | Depends on |
|---|---|---|---|
| U1 | Schema, document splitter, rules | `src/audit/schema.ts`, `document.ts`, `rules.ts`, `vocabulary.ts` | none |
| U2 | `audit` command, report, exit 6, doctor block | `src/commands/audit.ts`, `src/audit/report.ts`, `src/commands/doctor.ts` | U1 |
| U3 | Deterministic fixers, writer, diffs, `--fix --dry-run --yes` | `src/audit/fixers/deterministic.ts`, `writer.ts` | U2 |
| U4 | Jev fixers, extraction, `needs_author` | `src/audit/fixers/jev.ts`, `extract.ts`, `src/judge/questions.ts` | U3 |
| U5 | Agreement measurement, README, CHANGELOG, schema doc | `bench/scripts/audit-agreement.ts`, docs | U4 |

### U1. Schema, document splitter, rules

- **Goal:** Pure validation: a file's text in, findings out, for learnings and pack rules.
- **Requirements:** R2, R3; KTD1, KTD2, KTD7; D6, D7.
- **Test scenarios:** one fixture string per rule producing exactly that finding; a clean learning producing none; a bug-track doc missing `symptoms` flagged, a knowledge-track doc without them not; generic `applies_when` phrases and a title restatement flagged, a specific situation not; unsafe scalars with `: `, ` #`, and a leading backtick flagged, quoted ones not; the pack rule set applied to a pack file.

### U2. `audit` command, report, exit 6, doctor block

- **Goal:** `compound audit` over a corpus with text and JSON output, `--strict`, `--packs`, `--report`, and the doctor block.
- **Requirements:** R1, R4, R5, R11; KTD5, KTD6.
- **Test scenarios:** fixture corpus with every failure class: exit 6, one finding per class in JSON, summary counts; a clean corpus exits 0; `--strict` turns a warnings-only corpus into exit 6; `--report` writes the JSON; no `docs/solutions/` exits 4; `doctor` shows the audit counts; 1,001 files finish under ten seconds.

### U3. Deterministic fixers, writer, diffs, `--fix --dry-run --yes`

- **Goal:** Every fix that needs no judgment, shown as a diff, written only on consent, idempotent.
- **Requirements:** R6, R7, R10; D1, D4; KTD4.
- **Test scenarios:** each fixer on a minimal document; golden diff for AE2; body bytes identical after writing (including a body with a fenced `---`); `--dry-run` leaves mtime and content unchanged; non-TTY without `--yes` exits 2; second run reports nothing to fix; a file with CRLF line endings keeps them.

### U4. Jev fixers, extraction, `needs_author`

- **Goal:** Categorisation and `applies_when` repair through Jev with recorded cassettes.
- **Requirements:** R8, R9, R10; D2, D3, D8; KTD3.
- **Test scenarios:** extraction on a body with headings, When and If sentences, error phrasing, and fenced code (fenced lines excluded, at most 12 candidates, 6 to 200 chars); Choice request shape (labels are enum values, document text only in state); tags Nouls keep items at or above 0.6, cap 8, keep existing valid tags; `needs_author` when no candidate reaches 0.7 (fake judge at 0.1) and when the corpus has fewer than two values for `module`; `--fix` without a key exits 3 before any file is read; recorded cassette for one real file end to end.

### U5. Agreement measurement, docs

- **Goal:** Numbers in the PR body and the documentation for users and CI.
- **Requirements:** R12, R13; KTD8.
- **Test scenarios:** the agreement script's comparison functions (exact, Jaccard, precision) are unit tested; the script runs against the fixture corpus with the fake judge and prints valid JSON.

---

## Verification Contract

| Gate | Command | Passes when |
|---|---|---|
| Tests | `bun test` | all pass with no key |
| Types | `bun run typecheck` | zero errors |
| Lint | `bun run lint` | zero errors |
| Public bench | `bun run bench:ci` | unchanged floors |
| Audit on this repo | `compound audit --strict` | exit 0 on `docs/solutions/` here |
| Live agreement (not CI) | `bun run bench/scripts/audit-agreement.ts` with the key | JSON printed, numbers in the PR body |

---

## Definition of Done

- U1 to U5 implemented with their test scenarios as tests; the Verification Contract passes; CI green on the stacked PR.
- `compound --help` lists `audit` and exit 6; README documents rules, fixers, and the CI snippet.
- Agreement numbers against hand-written frontmatter are in the PR body, with the corpus named.
- No key material in the repository, cassettes, or logs.
