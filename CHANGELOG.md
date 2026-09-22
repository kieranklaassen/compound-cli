# Changelog

All notable changes to compound-cli. The format follows Keep a Changelog, and the project follows semantic versioning.

## Unreleased

### Changed

- Tier two judges each candidate on a four-level rubric (unrelated, same area only, relevant background, directly applies) instead of a yes/no question, and the expected level, normalized to 0..1, is the hit score. Measured against a private gold set built from Cora (216 plans citing 468 learnings): recall at a precision lower bound of 0.30 went from 22.8 to 23.5 percent on the dev split and from 14.9 to 18.0 percent on the held-out split; the public set went from 98.7 to 100 percent recall at the old threshold.
- The default hit threshold is 0.6 (was 0.5) to match the new score scale. Pack suggestions, which are tier-one probabilities, keep their own 0.5 threshold.
- The candidate cap is a hard bound. Candidates without `applies_when` are still cut first, but when the candidates that carry `applies_when` alone exceed the cap the weakest keyword matches are cut too, with a warning that names the count and `--candidate-cap`. A 5,001-learning corpus went from 106 requests and $0.036 per `find` to 10 requests and $0.003.
- The `compound` and `compound-cli` bins run through `bin/compound.js`, which uses `dist/cli.js` when built, runs the TypeScript source directly under Bun otherwise (so `bunx --bun github:kieranklaassen/compound-cli` works before the npm release), and prints one line saying how to get a build under Node.

### Added

- `bench --jobs <n>` runs cases concurrently with a judge per case; `--precision-floor <p>` reports the best recall whose precision lower bound meets `p` and the threshold that reaches it, and the report carries F0.5.
- A bench case's `query` may name a `plan` file (relative to the corpus root) or a `diff` file (relative to the cases file).
- `COMPOUND_CASSETTE_MODE=auto` replays a recording when one exists and records a live answer when it does not.
- `bench/scripts/measure-recall.ts`, the flat-JSON measurement harness an optimization loop consumes (Cora dev recall at a precision floor, a live latency probe, the public set as a regression gate).
- Subprocess tests honor `RECORD_CASSETTES=1` through a shared `cassetteEnv` helper.

### Fixed

- `bench --enforce-floor` in replay mode fails when the recording has no `manifest.json`, since without the pin a threshold change could pass unnoticed. `auto` mode writes the pin for a fresh recording, never rewrites an existing one, and fails the gate when the threshold disagrees with it.

## 0.1.0

First release.

- `find` recalls learnings under `docs/solutions/` and declared Compound Pack rules relevant to a work context, judged by TypeSafe's Jev in two tiers (frontmatter, then a body excerpt with passage selection), with calibrated scores, a threshold, and `nothing_relevant` as a real answer.
- Input channels: an activity sentence, repeatable `--concept`, `--decision`, `--domain`, `--module`, and `--path` flags, and `--diff`, `--plan`, and `--doc` artifacts the CLI reads itself.
- `--gate` answers with one probability for spawn decisions; `--overlap --doc` judges a draft learning against existing ones on five dimensions.
- `--json` (schema version 1), `--compact`, and a terminal report. Distinct exit codes for success, usage error, not configured, missing corpus, and judge failure.
- `packs resolve` and `packs list` with the semantics and JSON shape of the plugin's `packs-resolve.py`, sharing its git cache. `packs suggest` judges undeclared packs from known sources; `packs add` writes the declaration.
- `bench` runs a gold set and reports macro and micro recall, a precision lower bound, negative correctness, cost, and latency, with a threshold sweep. The public gold set from the Compound Engineering plugin's learnings ships with recorded cassettes so CI runs without a key.
- `doctor` reports key presence, corpus health, pack drift, and source reachability.
- Document text (titles, headings, bodies) only ever reaches the judge as state, never inside a question or a choice label, so a pack author cannot steer the judgment from inside a document. A failed batch aborts its siblings so a judge failure never keeps billing. Symlinks that leave the repository or a pack source are refused on every read path.
