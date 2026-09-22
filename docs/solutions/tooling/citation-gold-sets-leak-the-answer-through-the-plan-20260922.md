---
title: A citation-built gold set leaks its labels through the plan text unless the citation lines are removed
date: 2026-09-22
module: bench
problem_type: logic_error
component: tooling
severity: high
tags: [gold-set, bench, leakage, plan-channel, evaluation]
symptoms:
  - "Recall jumps twelve points the moment the whole plan file becomes the query"
  - "Cited learnings are found with score 1.0 whose frontmatter scored near zero in tier one"
root_cause: logic_error
resolution_type: test_fix
applies_when:
  - "Building a recall gold set from documents that cite the items they are supposed to retrieve"
  - "Switching a bench query from a summary to the full source document"
  - "A bench number improves far more than any judge-side change ever did"
---

# A citation-built gold set leaks its labels through the plan text unless the citation lines are removed

## Problem

The Cora gold set labels a plan with the learnings it cites (`docs/solutions/...md` paths in the plan body). When the plan channel started sending the whole plan text to the judge, micro recall went from 55.7 to 75.9 percent on dev in one experiment. Too good: the plan text contained the very paths and titles the labels were derived from, and the candidate view carries `path`, so the judge matched strings.

## Why it is wrong

At recall time a plan does not yet carry those citations; the learnings researcher adds them afterwards. A judge that scores well only because the answer is in the question tells you nothing about the case the tool exists for.

## Fix

The builder writes a redacted copy of each plan (every line that references a `solutions/...md` path is dropped, 673 lines across 227 plans) and points the plan channel at the copy. On the redacted set the same experiment scored 63.8 percent: still the largest gain of the run, honest this time.

## Prevention

- When labels come from text, strip that text from the query before measuring. Assert in the builder that no label token survives.
- Treat any single-experiment jump larger than the sum of everything before it as a leak until proven otherwise.
- Keep the redaction in the builder, not in the CLI: the tool should read real plans as they are.
