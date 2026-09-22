---
title: "Background sync silently dropped rows with null bytes and an unindexed lookup"
date: 2026-07-03
module: sync
problem_type: database_issue
component: background_job
severity: high
symptoms:
  - "SyncGmailDraft timed out on existing_state_by_draft_id"
  - "Rows with null bytes were skipped without logging"
root_cause: data_integrity
resolution_type: migration
tags:
  - gmail
  - sync
  - postgres
  - index
---

# Background sync silently dropped rows with null bytes and an unindexed lookup

## Symptoms

The sync job timed out looking up drafts by id, and rows whose subject contained a null byte were dropped silently.

## Root cause

The lookup column draft_message_id had no index, and Postgres rejects null bytes in text columns.

## Fix

Add the index and strip null bytes before insert.
