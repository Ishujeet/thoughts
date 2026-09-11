<!-- thoughts-kit v{{kit_version}} -->
# /thoughts-decide <topic>

Draft an architecture decision record for the topic in $ARGUMENTS.

1. Run `thoughts search "<topic keywords>"` and read prior decisions in `thoughts/shared/decisions/` and `thoughts/repos/*/decisions/`.
2. If more than one repo is affected, run `thoughts new decision "<title>" --shared`; otherwise `thoughts new decision "<title>"`.
3. Fill Context, Decision, Consequences, Affected repos, and list every alternative considered with why it was rejected.
4. Leave `status: draft` and Status "proposed"; a human accepts the decision.

If `thoughts/` is missing, not a symlink, or empty, stop and tell the user to run `thoughts init`; do not work around it.
