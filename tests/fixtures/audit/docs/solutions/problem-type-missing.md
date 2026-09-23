---
title: Learning with no problem type at all
date: 2026-01-01
module: http
component: api
severity: low
applies_when:
  - "Adding retry with backoff to an HTTP client that gets throttled"
tags: [retry]
---
# No problem type

## Problem

When the API answers 429 the client hammers it. Retry with backoff instead.
