<!-- thoughts-kit v{{kit_version}} -->
# /thoughts-spec <feature>

Write a spec for the feature in $ARGUMENTS using the project brain in `thoughts/`.

1. Run `thoughts search "<feature keywords>"` and read related specs, decisions, and plans across all repos.
2. Run `thoughts new spec "<title>"` and fill every section of the file it prints.
3. The **Cross-repo impact** table MUST be filled in, even if the answer is "none" for every repo.
4. Link the plan or ticket in **Motivation**. Leave `status: draft` until the human confirms.

If `thoughts/` is missing, not a symlink, or empty, stop and tell the user to run `thoughts init`; do not work around it.
