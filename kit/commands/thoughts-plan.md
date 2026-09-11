<!-- thoughts-kit v{{kit_version}} -->
# /thoughts-plan <goal>

Write a plan for the goal in $ARGUMENTS using the project brain in `thoughts/`.

1. Run `thoughts search "<goal keywords>"` and read the matching specs, decisions, and research under `thoughts/shared/` and `thoughts/repos/*/`.
2. Summarise the cross-repo impact: which other repos are affected and what they must change.
3. Run `thoughts new plan "<title>"` and fill every section of the file it prints (Goal, Context, Approach, Steps with the owning repo per step, Risks & dependencies, Done when, Out of scope).
4. End by listing which other repos must be told about this plan. Leave `status: draft`.

If `thoughts/` is missing, not a symlink, or empty, stop and tell the user to run `thoughts init`; do not work around it.
