---
title: "A global core.fsmonitor makes the subprocess-heavy suite slow and flaky"
date: 2026-09-08
module: test-suite
problem_type: test_failure
component: testing_framework
severity: medium
symptoms:
  - "Tests that spawn git time out at exactly the configured limit"
  - "The suite is 2.6x slower on one machine"
root_cause: config_error
resolution_type: config_change
tags:
  - git
  - fsmonitor
  - flaky-tests
---

# A global core.fsmonitor makes the subprocess-heavy suite slow and flaky

## Symptoms

Tests spawning many git subprocesses timed out at exactly the configured limit.

## Fix

Set core.fsmonitor=false for the test environment.
