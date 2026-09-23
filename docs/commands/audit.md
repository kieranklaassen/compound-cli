# compound audit

> Validate learning and pack frontmatter against the schema in effect for the repository, and repair what can be repaired without inventing anything.

Learnings compound only when their frontmatter lets the next run find them. `audit` checks every file under `docs/solutions/` (and pack rules and READMEs, when asked) against the CLI's default schema layered with the repository's own `compound.schema.fields`, the parser-safety rules of the plugin's `validate-frontmatter.py`, a bare-literal check, and the findability rules the optimize runs showed matter most. It behaves like a linter: report by default, `--fix` for the repairs that need no judgment and no key, `--fix --jev` for the ones that ask the judge. It is useful on its own, with no `find` involved: Cora and compound-packs run it in CI in place of the frontmatter validator scripts each repository used to carry, while the plugin's own write-time guard (`validate-frontmatter.py`) stays where it is.

| Question | Answer |
|---|---|
| What it checks | Frontmatter shape and quoting, every field's presence, type, values, bounds, and pattern, the bug and knowledge tracks, `applies_when` specificity, tags, pack READMEs |
| Where the rules come from | The CLI's defaults (the plugin's `schema.yaml`; the compound-packs rule set for packs) plus the repository's [`compound:` config](../configuration.md); each finding names its layer |
| Key needed | No, except `--fix --jev` |
| Exit codes | 0 when no file has an error; 6 when one does (`--strict` counts warnings); 2 for a broken `compound:` block or bad flags; 3 for `--fix --jev` without a key; 4 with no corpus; 5 when the judge fails during `--fix --jev` |
| Writes | Only with `--fix --yes` or a confirmed prompt; frontmatter only, bodies byte for byte unchanged |

## Examples

```bash
compound audit                        # report per file, exit 6 when a file fails
compound audit --strict --json        # warnings fail too; the JSON contract for CI
compound audit --fix --dry-run        # deterministic repairs as diffs, nothing written, no key
compound audit --fix --yes            # apply them (off a TTY, --yes or --dry-run is required)
compound audit --fix --jev --dry-run  # add the Jev fixers; needs TYPESAFE_API_KEY
compound audit --packs                # also audit the rules and READMEs of declared packs (never fixed)
compound audit --pack-dir packs       # pack-authoring mode: a repository of packs, each child a pack
compound audit --stats                # field coverage, and README coverage per pack rule
compound audit --report audit.json    # write the JSON report whatever the terminal format
```

## Rules

Errors are schema and parser-safety violations; warnings are findability gaps. `--strict`, or `compound.audit.strict: true` in the config, makes warnings fail. Every finding says where its rule came from: the text report appends `[rule from config.yaml]` when a layer set it, and the JSON carries `source` (`default`, `config.yaml`, or `config.local.yaml`), so a failing check traces to the line that made the rule.

| Rule | Severity | Fixer |
|---|---|---|
| `frontmatter.missing`, `frontmatter.unterminated`, `frontmatter.invalid_yaml` | error | none (a hand) |
| `frontmatter.unsafe_scalar` (unquoted `: `, ` #`, or a reserved first character) | error | deterministic: the full raw value is recovered and quoted |
| `frontmatter.bare_literal` (`title: true`, `module: 123`, `tags: [inbox, null]`: a word YAML reads as null, a boolean, or a number, in a field the schema types) | error | deterministic: the raw word is put back as a string and written double-quoted |
| `title.missing` | error | deterministic: the first H1 |
| `title.weak` (placeholder, file slug, under three words) | warning | none |
| `date.missing`, `date.invalid` | error | deterministic: the file's first commit, or a date in the file name, or the loosely written value |
| `<field>.missing`, `<field>.invalid` for every enum and closed field (`problem_type`, `severity`, `resolution_type`, a repository's closed `component`, a custom `record_type`) | error | deterministic spelling (`Best Practice`, `ui-bug`), else Jev Choice over the values in effect |
| `module.missing`, `component.missing`, bug track `root_cause.missing` | error | Jev Choice over the values this corpus already uses, then the repository's or the schema's suggested values |
| `<field>.not_a_string`, `<field>.bug_track_only` (`rails_version` on a knowledge-track learning), `rails_version.invalid` (not `X.Y.Z`) | error | none |
| bug track: `symptoms.missing` | error | extraction from the body, each sentence judged by Jev |
| `applies_when.missing`, `applies_when.generic` (`always`, under four words, a restatement of the title) | warning; error when the repository requires it | extraction from the body (headings, When and If sentences, failure phrasing, section leads), each judged by Jev at 0.7; at most the bound |
| `<list>.too_many`, `<list>.item_too_long`, `<list>.empty_item`, `<list>.format` | warning | deterministic for tags; none otherwise |
| `<list>.too_few`, `<list>.not_strings` | error | none |
| `tags.missing` | warning; error when required | Jev Nouls over the corpus's own tags (used by two or more files), at 0.6, at most the bound |
| `<list>.not_a_list`, `list.duplicate` | error, warning | deterministic |
| `pack.readme_missing`, `pack.no_rules`, `pack.readme_tag_missing` | error | none |

The track comes from `problem_type`: the schema's nine bug values make a learning bug-track, its eight knowledge values make it knowledge-track. `symptoms`, `root_cause`, and `resolution_type` are required on the first and allowed on the second; `rails_version` and `framework_version` are an error on the second. [Schema and configuration](../configuration.md) lists the default fields per document kind and how a repository changes them.

## Fixing

Plain `--fix` is every deterministic fixer: the title from the first heading, the date, enum spelling for every closed field, tag normalisation, scalars wrapped in lists, duplicates removed, the ` #` recovery, and bare literals quoted. It needs no key. A field only the judge could settle is listed as `needs_author` with the reason `needs the judge: run --fix --jev`.

`--fix --jev` adds the Jev fixers: `problem_type`, `severity`, `resolution_type`, `module`, `component`, `root_cause`, and any custom enum as a Choice over the values in effect for the repository (a closed field's list, else the corpus's own values, else the schema's suggestions; never a default the repository replaced); tags as judgments over the corpus's tags; `applies_when` and `symptoms` from sentences extracted from the body and judged one by one. The Jev choices see the document's title, frontmatter, and a 6,000-character excerpt, and how often this corpus uses each candidate value, so they follow the corpus's house style rather than a generic reading. Candidate values and sentences are data under the request state, never part of a question, so a learning cannot steer its own repair. When no candidate clears the bar (a Choice below 0.4, a tag below 0.6, a situation or symptom below 0.7; the report echoes these under `thresholds`), the field is marked `needs_author` with the reason. Two Jev rounds at most, because the first can move a file onto the bug track.

Every change is a unified diff of the frontmatter block. The writer edits the block through a YAML document model, keeps key order, comments, and a list's flow style, double-quotes any string a YAML parser would read as another type, and reassembles the file with the original body bytes and line endings. `--dry-run` writes nothing; on a terminal `--fix` shows the diffs and asks; off a terminal `--yes` or `--dry-run` is required. A fixed file is idempotent: a second run changes nothing.

The exit code always describes the files on disk: `--fix --dry-run` and a declined prompt still exit 6 when the corpus fails, and `summary.after_fix` in the JSON says what a `--yes` run would leave. Exit 5 means the judge failed during `--fix --jev`; nothing is written then.

Treat categorical Jev fixes as proposals to read in the diff, and the deterministic fixes and extracted sentences as safe; [results](../results.md#agreement-with-hand-written-frontmatter) has the agreement numbers behind that advice.

## Packs

`--packs` audits the packs the repository declares in `packs:`: each rule with the pack-rule schema, each `README.md` with the pack-README schema (3 to 8 `applies_when` situations, the pack id among the tags, since `packs suggest` judges a pack from its README). Declared packs live in the shared cache, so `--fix` names the pack's own repository and writes nothing.

`--pack-dir <dir>` (or `compound.audit.pack_dirs` in the config) is pack-authoring mode for a repository of packs such as compound-packs: every child directory of `<dir>` is a pack; a pack without a `README.md` is `pack.readme_missing`, one with a README and no rule file beside it is `pack.no_rules` (Compound Engineering would not publish it). These files are the repository's own, so `--fix` writes them, and `--fix --jev` chooses from the packs' own vocabulary.

## Stats

`--stats` adds what Cora's `--stats` and compound-packs' `--coverage` printed: how many learnings carry `title`, `applies_when`, `symptoms`, and `tags` (the fields the grep path and the judge read), and per pack the rules that share under a quarter of their `applies_when` words with the README's title and situations, with the words the README lacks. Stats never change the exit code.

## The report

Text: one block per file with findings, then `compound audit: N files, N passing, N errors, N warnings, N fixable` and, with `--fix`, the changes and `needs_author` entries. JSON: the [contract](../json-schema.md#audit---json) with `summary`, per-file `findings` and `fix`, `excluded`, `stats`, and `usage`. `doctor` carries the counts and any config errors too.
