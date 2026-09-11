<!-- thoughts-kit v{{kit_version}} -->
# /thoughts-research <question>

Investigate the question in $ARGUMENTS across the code and the project brain.

1. Read the relevant code in this repo and run `thoughts search "<keywords>"` for existing thoughts in other repos.
2. Run `thoughts new research "<title>"` and fill the file it prints: Question, What I looked at, Findings, Recommendation, Confidence, Follow-ups.
3. Fill frontmatter `sources[]` with every file and thought you read (`{ resource: <path>, title: <title> }`).
4. Never paste secrets, tokens, or connection strings into the file; name the env var instead.

If `thoughts/` is missing, not a symlink, or empty, stop and tell the user to run `thoughts init`; do not work around it.
