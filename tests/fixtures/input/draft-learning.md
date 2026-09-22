---
title: "Honor Retry-After before your own backoff"
date: 2026-09-22
module: http-client
problem_type: best_practice
component: api_layer
severity: medium
applies_when:
  - "Calling a rate-limited HTTP API from a batch job"
tags: [retry, backoff, rate-limit]
---

# Honor Retry-After before your own backoff

## Problem

A batch job hammered a throttled API because it retried on its own schedule.

## Root cause

The client ignored the Retry-After header.

## Solution

Sleep for max(Retry-After, backoff) and cap the wait.

## Prevention

Test the 429 path with a fake server that sets Retry-After.
