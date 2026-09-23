# compound doctor

> One report on whether the tool can do its job here: the key, the corpus, the packs, the sources, the audit counts, the config.

`doctor` needs no key and touches no network unless asked to check pack sources. It exits 0 when the report ran; `--strict` exits 3 when the key is missing, for a setup step that wants to fail early.

```bash
compound doctor
compound doctor --json --no-sources
compound doctor --strict
```

| Section | What it says |
|---|---|
| Key | Whether `TYPESAFE_API_KEY` is present (never its value) and the cassette mode in effect |
| Repository | The resolved root and how it was resolved (`--root`, the enclosing git checkout, or the working directory) |
| Docs root | `docs_root` from the config or the default `docs`, the solutions directory, and whether it exists |
| Learnings | The count, the learnings missing `applies_when` or `date`, and malformed frontmatter with the parse error |
| Audit | Files, failing files, errors, warnings, and fixable findings as `compound audit` would report them, plus any errors in the config's `compound:` block (which make `audit` refuse to run) |
| Packs | Declared entries, resolved roots with rule counts, nested rule-shaped files discovery never reads, the cached commit against the remote ref (`current`, `stale`, `unknown`), warnings and errors from resolution |
| Known sources | Each known pack source and whether it is present, cached, reachable, or unreachable (`--no-sources` skips the network) |
| Cache | The git cache directory pack sources are cloned into |

`--json` prints the same report as one object for a setup skill to read.
