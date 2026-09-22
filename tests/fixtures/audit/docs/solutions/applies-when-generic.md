---
title: Learning with generic and missing situations
date: 2026-01-01
module: http
component: api
problem_type: best_practice
severity: low
applies_when:
  - always
  - "Learning with generic and missing situations"
tags: [retry]
---
# Generic applies_when

## Problem

When the API answers 429 the client hammers it. If the retry has no jitter every worker retries at once.
