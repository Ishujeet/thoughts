<!-- thoughts-kit v{{kit_version}} -->
# /thoughts-sync

Synchronise the project brain.

1. Run `thoughts sync`.
2. Summarise what arrived from other repos (the report is grouped by `repos/<id>`) and anything that affects this repo.
3. If it exits 7 (secret found): show the masked findings to the user and ask how to fix them. Never allow-list a finding on the user's behalf and never edit `.thoughts-allow.yml` yourself.
4. If it exits 4 (conflict): name the conflicted files and let the user resolve them with git before running `thoughts sync` again.

If `thoughts/` is missing, not a symlink, or empty, stop and tell the user to run `thoughts init`; do not work around it.
