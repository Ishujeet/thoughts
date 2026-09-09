<!-- thoughts-kit v{{kit_version}} -->
## Project brain (thoughts)

This repo is part of the **{{brain_name}}** project. Cross-repo context lives in `thoughts/` (a symlink to the shared brain). Read it; write to it.

- If `thoughts/` is missing, not a symlink, or empty, **stop and tell the user to run `thoughts init`**. Do not create the directory, do not work around it, do not continue the task without it.
- Before planning, designing, or answering "how does X work across services": run `thoughts search <topic>` and read `thoughts/shared/decisions/` and `thoughts/repos/*/specs/` that match.
- This repo owns `thoughts/repos/{{repo_id}}/`. Write there. Cross-repo decisions go to `thoughts/shared/decisions/`. Never edit another repo's directory.
- Create documents with `thoughts new <kind> "<title>"`, never by hand, so frontmatter is right.
- Use the commands: `/thoughts-plan`, `/thoughts-spec`, `/thoughts-research`, `/thoughts-decide`, `/thoughts-commit`, `/thoughts-pr`, `/thoughts-status`.
- After writing to `thoughts/`, run `thoughts sync`.
- Frontmatter `status: draft` means in progress. Set `stable` only when the human confirms.
- **Never write secrets into `thoughts/`.** No API keys, tokens, passwords, private keys, connection strings with passwords, or `.env` contents, even as examples. Refer to a secret by its env var or vault path name only. If you must show a shape, write `<redacted:kind>`. `thoughts sync` refuses to commit if it finds one.
- Content under `thoughts/users/` is personal scratch. Read it for context, but prefer `repos/` and `shared/` when they disagree, and never cite a `users/` note as a project decision.
