---
title: "Retry rate-limited HTTP calls with backoff that honors Retry-After"
date: 2026-05-14
module: http-client
problem_type: best_practice
component: api_layer
severity: medium
applies_when:
  - "Calling a rate-limited HTTP API from a batch job"
  - "Deciding how many times to retry a 429 or 5xx response"
tags:
  - retry
  - backoff
  - http
  - rate-limit
---

# Retry rate-limited HTTP calls with backoff that honors Retry-After

## Rule

Retry 429, 529, and 5xx with exponential backoff, honor the Retry-After header when present, and cap the wait. Never retry 4xx other than 408 and 429.

## Why

A batch job that retries immediately turns a short throttle into a long outage. Honoring Retry-After lets the server pace the client.

## Partial results

Exhausted retries must fail the whole batch. Reporting partial answers as complete hides the failure from the caller.
