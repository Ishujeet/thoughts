# 10 — Integrations

Status: Draft

## Purpose

Link thoughts to the systems where work is tracked and reviewed, so `status` can show live state and `/thoughts-pr` can open PRs. v1 targets GitHub, Azure DevOps, and Jira.

## Common contract

Every integration implements:

```
setup()                      # interactive; stores credentials outside the brain
resolve(link) -> Item        # e.g. "CHK-142" → { id, title, state, url, assignee, updated }
open_pr(repo, body, meta)    # optional; GitHub & Azure DevOps only
list_open(repo_id) -> [Item] # PRs/tickets referencing this repo, for `status`
```

- Credentials: OS keychain via the platform's standard store, or an env var name referenced from `~/.config/thoughts/config.yml`. MUST NOT be written to `brain.yml` or `.thoughts.yml`; `init` scans both after writing them ([15-secret-scanning.md](15-secret-scanning.md)). Integration `resolve()` output that is cached MUST strip any token fields from the provider response before writing the cache.
- All network calls are cached for 5 minutes under `~/.thoughts/cache/`; `--no-integrations` bypasses.
- Integrations are optional. Their absence MUST NOT break any command.

## Link keys in frontmatter

```yaml
links:
  ticket: CHK-142            # Jira issue key
  work_item: 4521            # Azure DevOps work item id
  pr: acme/payments-api#88   # GitHub, or ADO "project/repo!88"
  branch: feat/refund-v2
```

`status` resolves each key through the matching integration.

## GitHub

- Auth: reuse `gh` CLI auth if present; else a PAT with `repo` scope.
- `open_pr`: create PR from current branch with the rendered `pr` template as body; write the resulting `pr` key back into the thought.
- `list_open`: open PRs in the repo's GitHub repository; match to thoughts by branch name or by a `Plan:`/`Spec:` line in the PR body.
- Setup writes `integrations.github.org` into `brain.yml`.

## Azure DevOps

- Auth: PAT with Code (read/write) and Work Items (read).
- Work items map to `links.work_item`; PRs to `links.pr`.
- Setup writes `integrations.azure_devops.{org, project}` into `brain.yml`.

## Jira

- Auth: Atlassian API token + email; Cloud only in v1.
- `resolve("CHK-142")` returns summary, status category (To Do / In Progress / Done), assignee.
- Setup writes `integrations.jira.{site, project_keys}` into `brain.yml`.
- No write operations in v1 (no comments, no transitions).

## Behaviour in `status`

- Item state is shown inline next to the thought (`CHK-142 In Progress`, `PR #88 open`).
- A thought with `status: stable` but a linked open PR is flagged: "stable but PR still open".
- A thought with `status: draft` whose ticket is Done is flagged: "ticket closed, thought still draft".

## Open questions

- GitLab and Linear are frequent asks; the common contract is designed so they are additive.
- Should integrations be plugins (separate binaries) or built in? Built in for v1; three is manageable.
