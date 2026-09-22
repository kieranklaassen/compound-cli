---
title: Retry budget - Plan
type: feat
date: 2026-09-22
topic: retry-budget
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
execution: code
---

# Retry budget - Plan

## Goal Capsule

- **Objective:** Add a retry budget to the HTTP client so a throttled batch job backs off instead of hammering the API.

## Product Contract

### Summary

The client retries 429 and 5xx responses with exponential backoff and honors Retry-After. Exhausted retries fail the batch.

### Key Decisions

- **Six retries, capped at twenty seconds.** (session-settled: user-directed, chosen over unbounded retries: a stuck job must fail.)

### Requirements

- R1. Retry 429, 529, and 5xx responses with exponential backoff.
- R2. Honor the Retry-After header when present.
- R3. Exhausted retries fail the batch and never report partial results as complete.
