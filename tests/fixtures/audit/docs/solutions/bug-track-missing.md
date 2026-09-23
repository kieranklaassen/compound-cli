---
title: Bug learning missing its bug-track fields
date: 2026-01-01
module: sync
component: background_job
problem_type: runtime_error
severity: high
applies_when:
  - "The sync job runs twice for one mailbox"
tags: [sync]
---
# Bug without symptoms

## Problem

When the sync job runs twice for one mailbox, the second run raises a unique index error. The worker then retries forever.

## Fix

Add a lock.
