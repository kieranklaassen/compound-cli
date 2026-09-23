# Development

## Repository commands

```bash
bun install
bun test              # runs without a key, from recorded cassettes
bun run typecheck
bun run lint          # biome; bun run lint:fix rewrites
bun run build         # dist/cli.js, runs under node too
bun run src/bin.ts <command>   # run from source
bun run bench:ci      # replay the public gold set and enforce its floors
bun run bench:record  # re-record it (needs a key)
```

CI runs tests, typecheck, and lint, then `compound audit --strict` on this repository's own learnings under `docs/solutions/`, then the two bench replays. All of it runs without a key; the Cora held-out job skips when the `CORA_READ_TOKEN` secret is absent.

## Tests and cassettes

Tests that talk to TypeSafe replay from `tests/fixtures/cassettes/` and a fake TypeSafe server for the shapes a recording cannot cover (a judge that rejects everything, a judge that always picks the first option). To re-record after changing question wording or fixtures, set `RECORD_CASSETTES=1` with a real `TYPESAFE_API_KEY` and run the tests; nothing about the key is written. A cassette holds the request hash and the response body, never headers.

The audit's fixtures are a small corpus under `tests/fixtures/audit/docs/solutions/` with one file per failure class, plus Cora's twenty validator self-test fixtures as a test table and compound-packs' pack layout built in temporary directories.

## Where things live

| What | Where |
|---|---|
| Every question the CLI asks Jev | `src/judge/questions.ts` |
| Judging defaults, changed only from bench evidence | `src/find/defaults.ts` |
| The default schema values (the plugin's `schema.yaml` transcribed) | `src/audit/schema.ts` |
| Where the defaults meet a repository's `compound.schema.fields` | `src/audit/effective-schema.ts` |
| The audit rules, pure functions over a parsed document | `src/audit/rules.ts` |
| The fixers | `src/audit/fixers/deterministic.ts`, `src/audit/fixers/jev.ts` |
| The frontmatter writer | `src/audit/writer.ts` |
| Pack resolution, the port of `packs-resolve.py` | `src/corpus/packs.ts` |
| Exit codes | `src/exit-codes.ts` |
| Help text | `src/help.ts` |
| Measurement scripts (to be replaced by `bench build` and `bench audit`) | `bench/scripts/` |

## Contract discipline

`--json` output carries `schema_version`. Adding a field keeps the version; renaming or removing one bumps it and gets a CHANGELOG entry and a note under "Changes within schema 1" in the [JSON contract](json-schema.md). Exit codes are stable; a new one is added, never reused. A judging default changes only with a bench run recorded in [results](results.md).

## Releasing

Not yet on npm. Until then the pinned invocation is `bunx --bun github:kieranklaassen/compound-cli#<sha>`; `bin/compound.js` runs the TypeScript source directly under Bun and `dist/cli.js` when built. `bun run build` produces the Node build; `prepublishOnly` runs it.
