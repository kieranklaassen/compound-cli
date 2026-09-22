---
title: "Pass paths, not content, when dispatching subagents"
date: 2026-03-26
module: orchestration
problem_type: design_pattern
component: tooling
severity: low
applies_when:
  - "Dispatching subagents with large inputs"
  - "A worker prompt would embed a whole file"
tags:
  - orchestration
  - subagent
  - token-efficiency
---

# Pass paths, not content, when dispatching subagents

## Rule

Give a subagent the path and let it read what it needs. Embedding the content in the prompt doubles the tokens and goes stale.

## Exception

Pass content when the worker cannot read the file system.
