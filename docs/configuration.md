# Schema and configuration

compound-cli reads two things from a repository: the Compound Engineering config it already has, and, inside it, one `compound:` block that only the CLI reads. This page covers where the default schema comes from, how a repository extends or narrows it, and the audit's policy keys. `compound audit` is the consumer; `compound schema`, which will print the effective schema with each value's source, is planned.

## The `compound:` block

compound-cli reads the same two files Compound Engineering already uses, `.compound-engineering/config.yaml` and `.compound-engineering/config.local.yaml`, with the same layering: the local file sits on top of the shared one. `docs_root:`, `packs:`, and `pack_sources:` stay top level because the plugin reads them. Everything only the CLI reads sits under one `compound:` key, so it never collides with a plugin key.

```yaml
compound:
  schema:
    fields:                     # the repository's schema, layered over the CLI's defaults
      component:
        mode: replace
        closed: true
        values: [rails_model, brief_system, email_processing]
      applies_when:
        required: true
        max_items: 5
      record_type:              # a field the defaults do not know
        type: enum
        values: [decision, rule, observation]
        required: true
        kinds: [pack_rule]
  audit:
    exclude: [docs/solutions/patterns/critical-patterns.md]
    ignore: [title.weak]
    pack_dirs: [packs]
    strict: true
```

A problem anywhere in the block (an unknown key, a value of the wrong shape, a declaration that cannot mean anything) is an error naming the file and line, and `compound audit` refuses to run until it is fixed. A silently ignored typo would loosen a rule without anyone noticing, which is worse than a failing check.

## Where the defaults come from

The CLI ships defaults: the plugin's `skills/ce-compound/references/schema.yaml` for learnings, and the compound-packs rule set for pack rules and pack READMEs. Today they are transcribed into the CLI (`src/audit/schema.ts`, at plugin commit `c152896`); a later release loads the plugin schema from a pinned ref (`compound.schema.ref`) or a local path (`compound.schema.path`) and embeds one generated copy per release. The `fields:` block below layers over whichever defaults are in effect, so nothing written against it changes when the loader lands. Keys under `compound.schema` other than `fields` are errors in this release rather than being ignored, so a config written for the later loader fails loudly on an older CLI instead of running with half its meaning.

The defaults, per document kind:

| Kind | Fields (type, requirement, bounds) |
|---|---|
| `solution` (a learning under `docs/solutions/`) | `title` string required; `date` date required; `problem_type` enum required; `module` string required; `component` string required, suggestions from the schema; `severity` enum required; `symptoms` list, required on the bug track, at most 5 items of 300 chars; `root_cause` string, required on the bug track, suggestions from the schema; `resolution_type` enum, required on the bug track; `rails_version` string, bug track only, `X.Y.Z`; `framework_version` string, bug track only; `applies_when` list, recommended (a warning when missing), at most 5 items of 300 chars; `tags` list, recommended, at most 8 items matching `^[a-z0-9][a-z0-9:.-]*$` |
| `pack_rule` (a top-level Markdown file in a pack) | `title` string required; `applies_when` list required, 1 to 8 items; `tags` list required, 1 to 8 lowercase items; `module` string required; `problem_type` enum required |
| `pack_readme` (a pack's `README.md`) | `title` string required; `applies_when` list required, 3 to 8 items; `tags` list required, 1 to 8 items, the pack id among them |

The track comes from `problem_type`: the schema's nine bug values make a learning bug-track, its eight knowledge values make it knowledge-track. Fields with requirement `bug` are required on the first and allowed on the second; `bug track only` fields are an error on the second.

## `compound.schema.fields`

One entry per frontmatter field. Attributes left out keep their default value. Every attribute records which layer set it, and a finding names that layer (`[rule from config.yaml]` in the text report, `"source": "config.yaml"` in JSON), so a failing check is traceable to the line that made the rule.

| Attribute | Applies to | Meaning |
|---|---|---|
| `type` | custom fields only | `string`, `enum`, `list`, or `date`. A field the defaults know keeps its type; naming one is an error. |
| `values` | string and enum fields | Values for the field. For an enum, and for a string field with `closed: true`, they are the only values that pass. For an open string field they are suggestions the Jev fixer offers when the corpus has none of its own. |
| `mode` | with `values` | `extend` (the default) adds the values to the default list; `replace` uses only this list. |
| `closed` | string fields | `true` turns an open vocabulary into a closed one: a value outside `values` is an error. An enum is always closed and cannot be opened. |
| `required` | any field | `true`: a missing or empty value is an error. `false`: the field is optional and its absence is not reported. Left out, the default stands (for `applies_when` and `tags` on learnings that is a warning). |
| `min_items`, `max_items` | list fields | Item count bounds. Too many items is a warning, too few an error. |
| `max_chars` | list fields | The longest item; over it is a warning (the judge truncates longer items). |
| `pattern` | string and list fields | A regular expression each value (or each list item) must match. For `tags` this replaces the default lowercase-hyphen pattern. |
| `kinds` | any field | Which document kinds the declaration applies to: `solution`, `pack_rule`, `pack_readme`. Left out, the declaration applies to learnings. |

Layering: `config.local.yaml` declarations apply after `config.yaml`'s. A scalar attribute (`required`, `max_items`, `pattern`, `closed`) set in both takes the local value. `values` accumulate across layers unless the later declaration says `mode: replace`, which starts over from its own list.

What a declaration cannot do: change a default field's type, open an enum, set values or `closed` on a list or date field, put a pattern on an enum or date, close a field with no values, or set `min_items` above `max_items`. Parser-safety rules (`frontmatter.*`) are not schema fields and cannot be relaxed; a bare `null` in a string field is an error whatever the config says.

## `compound.audit`

| Key | Meaning |
|---|---|
| `exclude` | Repo-relative paths under `docs/solutions/` that are not learnings (an index, a patterns page). A path ending in `/` excludes a directory. Excluded files are listed under `excluded` in the JSON report and counted in the text summary. |
| `ignore` | Rule ids dropped from the report entirely (for example `title.weak` when a repository does not want that findability check). Ignored rules are not fixed either. |
| `pack_dirs` | Repo-relative directories of packs to audit in pack-authoring mode, as `--pack-dir` would; CI can then run plain `compound audit`. |
| `strict` | `true` makes `--strict` the default for this repository: warnings fail the check. |

`exclude`, `ignore`, and `pack_dirs` accumulate across layers; `strict` takes the local value.

## Two repositories, as the proof

Cora's `docs/solutions/` check, previously a 479-line repo-local script with the lists hard-coded:

```yaml
compound:
  schema:
    fields:
      component:
        mode: replace
        closed: true
        values:
          - rails_model
          - rails_controller
          - rails_view
          - service_object
          - background_job
          - database
          - frontend_stimulus
          - hotwire_turbo
          - email_processing
          - brief_system
          - assistant
          - authentication
          - payments
          - development_workflow
          - testing_framework
          - documentation
          - tooling
      root_cause:
        mode: replace
        closed: true
        values:
          - missing_association
          - missing_include
          - missing_index
          - wrong_api
          - scope_issue
          - thread_violation
          - async_timing
          - memory_leak
          - config_error
          - logic_error
          - test_isolation
          - missing_validation
          - missing_permission
          - missing_workflow_step
          - inadequate_documentation
          - missing_tooling
          - incomplete_setup
      applies_when:
        required: true
        max_items: 5
        max_chars: 300
      tags:
        required: false
        max_items: 8
        pattern: "^[a-z0-9][a-z0-9._:#/-]*$"
      related_components:       # Cora's own list field: items are checked for quoting hazards
        type: list
  audit:
    exclude: [docs/solutions/patterns/critical-patterns.md]
    ignore: [title.weak]
    strict: true
```

compound-packs' pack check, previously `tools/validate-packs.py` with a plugin checkout and PyYAML in the workflow:

```yaml
packs:
  - source: packs

compound:
  schema:
    fields:
      record_type:
        type: enum
        values: [decision, rule, observation]
        required: true
        kinds: [pack_rule]
  audit:
    pack_dirs: [packs]
    strict: true
```

Everything else those two scripts checked (frontmatter shape, quoting hazards, bare literals, enums, tracks, bounds, duplicates, item length, README situations and the pack id tag, a pack with no rules) is the CLI's default behaviour.

## The Jev fixers use the effective values

`compound audit --fix --jev` chooses a value for a missing or invalid field from the list in effect for this repository: a closed field's list (the schema's, or the one the config replaced it with), else the values the corpus already uses, else the schema's suggestions. Cora's `component` fixer therefore picks among Cora's seventeen values, and compound-packs' `record_type` fixer among its three; neither ever offers a default the repository replaced.
