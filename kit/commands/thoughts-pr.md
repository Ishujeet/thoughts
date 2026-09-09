<!-- thoughts-kit v{{kit_version}} -->
# /thoughts-pr

Produce a pull request description from the active plan or spec.

1. Identify the plan or spec this branch implements under `thoughts/repos/<this repo>/`; ask if unclear.
2. Run `thoughts new pr --from <bundle path of that plan or spec>` and fill the file it prints: Summary, Why, What changed, Cross-repo notes (does another service deploy first?), Testing, Checklist.
3. Output the finished body so the user can paste it into the PR; create the PR through the configured integration only if asked.
4. Run `thoughts sync` afterwards.

If `thoughts/` is missing, not a symlink, or empty, stop and tell the user to run `thoughts init`; do not work around it.
