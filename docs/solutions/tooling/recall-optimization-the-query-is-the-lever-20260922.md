---
title: Optimizing a Jev recall pipeline, the query channel is the lever and tier one is a faithful proxy
date: 2026-09-22
module: judge
problem_type: tooling_decision
component: tooling
severity: medium
tags: [recall, jev, optimization, bench, tier-one, plan-channel, calibration]
applies_when:
  - "Trying to raise recall of a two-tier Jev judge (frontmatter first, body second) over a learnings corpus"
  - "Choosing what a skill should pass to compound find: a sentence, a summary, or the whole plan"
  - "Picking a primary metric for an optimization loop over a positive-only labelled gold set"
  - "Deciding whether to skip the cheap frontmatter tier and judge every body"
  - "Reading a bench number and asking whether the judge or the input is the weak side"
---

# Optimizing a Jev recall pipeline: the query channel is the lever and tier one is a faithful proxy

## Context

A ce-optimize run over `compound find` against a private gold set built from Cora's plans (216 plans citing 468 learnings dated before the plan, split 60/40 into dev and held-out). Nineteen experiments, serial, cassette-backed. Four kept.

## What moved the number

1. **Give the judge the plan, not a digest of it.** Passing the plan body (bounded to 8,000 characters, code fences stripped) through the plan channel lifted held-out micro recall from 52.2 to 64.0 percent with precision up. Title plus summary as an activity sentence sat ten points lower; title alone lost another ten. Nothing on the judge side came close. Skills that have a plan must pass `--plan`.
2. **A graded rubric beats a yes/no in tier two.** A four-level Score (unrelated, same area only, relevant background, directly applies) normalized to 0..1 separated the top of the distribution better than a Noul. It also shifts the whole distribution up, so the default threshold had to move (0.5 to 0.6) and pack suggestions, which stay on the Noul scale, needed their own bar.
3. **Section headings help tier one a little** (plus 1.6 points micro recall for 7 percent more tokens). The body lead did not.

## What did not move it, and why that matters

- **Score fusion** (geometric or arithmetic mean of tier one and tier two, or tier one alone) sharpens the top and F0.5 but drops cited learnings whose frontmatter scored low. Tier two alone is the score.
- **Wording** (stricter or looser criteria in either tier) moves calibration, not ranking. A stricter tier-two rubric met the floor at a lower threshold with the same recall; a "could this change how the work is done" tier one let 50 percent more candidates through at lower precision and broke the cost gate.
- **Tier one is a faithful proxy.** 59 percent of misses never reached tier two, which looked like headroom. Removing tier one entirely (every candidate gets a body read) changed recall by zero on a 20-case sample and cost 5.3 times more. The candidates tier one rejects, tier two rejects too. A lexical rescue of the top keyword matches added 0.3 points.
- **Batch size and state ordering**: batch 24 lost 0.65 points for 9 percent more cost; ordering is invisible to a canonical-JSON cassette key and would need paired live runs to measure.

## The metric

Recall at a precision lower bound of at least 0.30 over a threshold sweep resists the degenerate win (lower the threshold) and the wording win (shift the distribution). It has one failure mode: a graded score compresses near the top and a 0.05 grid can miss the floor by a hair, which made the metric reject a Pareto improvement at the operating point. Pair it with an operating-point rule (micro recall up more than two points, precision not lower, every gate green) and state both before the loop starts.

## Reading the ceiling

Hand-classifying 48 held-out misses: 48 percent were label noise (a learning cited as process boilerplate, or a grab-bag plan no judge could resolve), 29 percent real misses with weak or missing frontmatter (no title, no `applies_when`), 23 percent real misses with good frontmatter that Jev rejected. Excluding the noise, recall on held-out through the plan channel is about 68 percent against a raw-label ceiling near 77 percent. Weak frontmatter is the largest fixable share, and it is fixed by authors, not by the judge.

## Prevention

- Measure the input channel before touching the judge. Run the same gold set with the whole plan, the summary, and the title, and look at the spread.
- Keep every experiment cassette-backed in `auto` mode so unchanged requests are free and deterministic, and run the latency probe live.
- Never let the floored metric be the only keep rule.
