---
type: {{type}}
title: "{{title}}"
description: 
status: draft
tags: []
repo: {{repo_id}}
generated:
  by: {{author}}
  at: {{now}}
sources: []
links:
  ticket: {{ticket}}
  pr: {{pr}}
  branch: {{branch}}
---

# {{title}}

## Summary

{{#if from}}
<!-- Pre-filled from {{from.path}} -->
{{from.title}}

{{from.description}}
{{else}}
<!-- One paragraph: what this PR does. -->
{{/if}}

## Why

<!-- Link the plan or spec this implements. -->
{{#if from}}
- Source: {{from.path}}
{{/if}}

## What changed

- 

## Cross-repo notes

<!-- Does another service need to deploy first? Any contract change other repos must pick up? -->

## Testing

- 

## Checklist

- [ ] Spec / plan updated in `thoughts/`
- [ ] Cross-repo impact reviewed
- [ ] No secrets in this PR or in `thoughts/`
