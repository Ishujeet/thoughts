<!-- thoughts-kit v{{kit_version}} -->
# /thoughts-commit

Review the staged changes and commit them with a message shaped by the `commit` template.

1. Run `git status` and `git diff --cached`; review what is staged and refuse to commit secrets or unrelated changes.
2. Find the active plan, spec, or ticket for this work in `thoughts/repos/<this repo>/` (or ask the user).
3. Write the message as `<scope>: <imperative summary, at most 72 chars>`, a blank line, 1–3 lines of why, then `Refs: <ticket> · Plan: <bundle path> · Spec: <bundle path>`.
4. Commit. Do not push unless asked.

If `thoughts/` is missing, not a symlink, or empty, stop and tell the user to run `thoughts init`; do not work around it.
