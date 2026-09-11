<!-- thoughts-kit v{{kit_version}} -->
# /thoughts-status

Show what is in flight across the project.

1. Run `thoughts status --json`.
2. Present the result grouped by repo: drafts, recently updated thoughts, stale thoughts.
3. Highlight items that affect this repo (its own directory and any shared decision or spec that names it).

If `thoughts/` is missing, not a symlink, or empty, stop and tell the user to run `thoughts init`; do not work around it.
