# Exit codes

Every outcome a caller switches on keeps its own code. The table is `src/exit-codes.ts`, printed by `compound --help`.

| Code | Name | Meaning |
|---|---|---|
| 0 | ok | Success, including `nothing_relevant: true` from `find` and a clean audit |
| 1 | internal | Unexpected error |
| 2 | usage | Bad arguments or missing input; for `audit`, a `compound:` config block with a problem |
| 3 | not-configured | A command that judges ran without `TYPESAFE_API_KEY`: `find`, `packs suggest`, `bench` live, `audit --fix --jev`; also `doctor --strict` |
| 4 | missing-corpus | No `<root>/solutions/` directory, no declared packs, and no `--pack-dir` |
| 5 | judge-failure | TypeSafe failed after retries, or a cassette replay missed. During `audit --fix --jev` nothing is written |
| 6 | findings | `audit` found files that fail: an error, or a warning under `--strict` |

Exit 1 also covers one environment case: running the `compound` bin from a git checkout under Node with no `dist/` build. The message says to use `bunx --bun` or `bun run build`.

## What a skill does with them

Exit 3, a start failure, and a timeout take the fallback (the plugin's grep-first path, `packs-resolve.py`, `validate-frontmatter.py`), and the skill says so once. Exit 0 with `nothing_relevant: true` does not: it is the answer. Exit 4 means the repository has nothing to search or check yet, which a setup skill can report rather than fall back on. Exit 6 is the CI signal: the check fails, and the report says which file, which rule, and which config layer set the rule.

## Planned

The compound-docs tooling design renames 6 to `check-failed` and extends it to a bench floor not met under `--enforce-floor` (which exits 1 today), and adds 7, `schema-unavailable`, for a pinned schema that cannot be read or a config whose schema declarations are invalid (exit 2 today). Both land with the schema loader.
