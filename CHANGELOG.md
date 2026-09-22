# Changelog

All notable changes to compound-cli. The format follows Keep a Changelog, and the project follows semantic versioning.

## Unreleased

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
