---
title: "Give an expected empty result its own exit code"
date: 2026-03-26
module: cli
problem_type: best_practice
component: tooling
severity: medium
applies_when:
  - "Adding a distinct exit code for an expected empty result"
  - "A CLI's not-found path serves both a read failure and a caller finding nothing"
tags:
  - agent-cli
  - exit-codes
  - error-handling
---

# Give an expected empty result its own exit code

A CLI's "not found" path often serves two callers: a real read failure and a caller correctly discovering there is nothing there.

## The problem

When the same errno answers both, the routine case is reported as a crash. In one runner 91 of 124 recorded failures were a benign absent artifact logged as an error.

## The fix

Name the outcome rather than the syscall that failed. Keep each outcome on its own documented exit code so callers can switch on it.

## Rejected alternative

Declaring the expected output up front so a job is only done once the artifact exists would relabel every legitimate gate-skip as a failure.
