---
title: "Keep the Ruby Native gem and React package aligned"
date: 2026-06-01
module: frontend
problem_type: convention
component: frontend
severity: medium
applies_when:
  - "Updating Ruby Native Inertia React components"
  - "Bumping a gem that ships a matching npm package"
tags:
  - inertia
  - ruby-native
  - react
  - dependencies
---

# Keep the Ruby Native gem and React package aligned

## Rule

Bump the gem and the npm package to the same version in one change. A mismatch renders blank pages with no error.

## How to check

Compare the version in Gemfile.lock with the one in package.json before merging.
