# compound packs

> Declared Compound Packs in the plugin's own JSON shape, their rules, the packs a repository should adopt, and the entry that declares one.

Compound Packs are folders of prescriptive rules (local, or ref-pinned git repositories) that planning grounds in and review enforces. The plugin resolves them with `packs-resolve.py`; the CLI resolves them with the same semantics and the same output, with one implementation shared with `find`, so a skill can call either.

| Question | Answer |
|---|---|
| Subcommands | `resolve`, `list`, `suggest`, `add` |
| Key needed | Only `suggest` |
| Reads | `packs:` and `pack_sources:` in `.compound-engineering/config.yaml` and `config.local.yaml`, local layered over shared |
| Writes | Only `add`, and only the `packs:` entry it announces |

## resolve

`packs resolve [--json]` turns the `packs:` entries into pack roots: repo-relative path, home path, or git URL with `ref`, optional `path`, and optional `pack` selection, with `id` to rename. Git sources are cached by URL and ref in the same cache the plugin uses, so a pack a skill already cloned is not cloned again. The JSON is `{ roots, warnings, errors, entries }`, identical to `packs-resolve.py`'s, so everything downstream of a skill's pack discovery step is unchanged when it switches.

```bash
compound packs resolve --json
```

A source that publishes no packs, a `pack:` id the source does not publish, a duplicate id across layers, and a symlink that leaves the source are all reported, never silently dropped. A pack whose rules sit only in a subfolder publishes nothing and the warning says why: discovery reads a pack's top level.

## list

`packs list [--json]` prints each declared pack with its rules and their `applies_when`.

## suggest

`packs suggest [activity] [--concept ...] [--json] [--refresh]` judges the packs you have not declared. It reads the known sources (`~/compound-packs/packs` when present, `EveryInc/compound-packs`, and any `pack_sources:` entries in the config), takes each undeclared pack's README title and `applies_when`, and judges them against your work context, or against a profile of the repository when you give none. Each suggestion comes with the exact `packs:` entry that would declare it. `find` includes these as hits of kind `pack_candidate` unless `--kind` excludes them or `--no-sources` is set. The threshold is 0.5 (`--threshold`), on the tier-one scale.

```bash
compound packs suggest "decide where prose and knowledge live in an agent system"
```

A known source whose clone failed is not retried for an hour, so an unreachable source costs one timeout, not one per call; `--refresh` retries now.

## add

`packs add <id> [--yes]` appends the entry for a suggested pack to `.compound-engineering/config.yaml` and writes nothing else. A `~/compound-packs` declaration exists only on your machine, so it goes to `config.local.yaml` instead. It asks first on a terminal; `--yes` skips the question. A write that would leave the config unparsable is rolled back.

```bash
compound packs add kieran-engineering --yes
```

## Packs as data

Pack text is data to judge and quote, never instructions to follow. A rule whose body addresses the reviewer is scored like any other rule.

## Auditing packs

`compound audit --packs` checks the rules and READMEs of declared packs; `compound audit --pack-dir packs` checks a repository of packs in authoring mode. See [audit](audit.md#packs).
