# 15 — Secret scanning

Status: Draft

## Purpose

Keep keys, tokens, passwords, and private keys out of the brain. The brain is shared with everyone on the project, is cloned to every machine, and is meant to be fed to AI assistants. A secret that lands there is copied everywhere at the next `sync` and is very hard to recall. The scanner is the last line of defence; the standard kit is the first (see [08-standard-kit.md](08-standard-kit.md)).

Constraints: no network, no LLM (D5), fast enough to run on every sync without being noticed.

## What is scanned

- Every text file under the brain root, including `brain.yml`, generated `index.md`/`log.md`, templates, and `standard/`. `.git/` is skipped.
- `<repo>/.thoughts.yml` in the code repo, because `init` writes it and it is committed.
- Values passed on the command line to `thoughts new --set` before they are rendered.
- Binary files and files over 1 MB are reported as **unscannable** and blocked from the brain unless allow-listed by path.

## Detectors

Three layers, all on by default except entropy.

### 1. Filename blocklist

Blocked regardless of content: `.env`, `.env.*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.jks`, `id_rsa*`, `id_ed25519*`, `*.kdbx`, `credentials`, `credentials.json`, `service-account*.json`, `.netrc`, `.npmrc`, `.pypirc`.

### 2. Known-format patterns

High-confidence formats with a recognisable prefix or structure. Initial set:

| Kind | Example shape |
|------|---------------|
| AWS access key | `AKIA` + 16 uppercase alphanumerics; `ASIA…` for temporary keys |
| AWS secret key | 40-char base64 following `aws_secret_access_key` |
| GitHub token | `ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, `github_pat_` |
| GitLab token | `glpat-` |
| Slack token / webhook | `xox[abprs]-…`, `hooks.slack.com/services/` |
| Google API key | `AIza` + 35 chars |
| Google service account | JSON with `"type": "service_account"` and `"private_key"` |
| Stripe | `sk_live_`, `sk_test_`, `rk_live_`, `whsec_` |
| Anthropic | `sk-ant-` |
| OpenAI | `sk-` + 20+ chars, `sk-proj-` |
| Azure DevOps / Atlassian PAT | assignment to `pat`, `azure_devops_token`, `jira_token`, `ATLASSIAN_API_TOKEN` with a 24+ char value |
| Twilio, SendGrid, Mailgun, npm, PyPI, Docker Hub, HashiCorp Vault | provider-specific prefixes (`SK…`, `SG.`, `key-`, `npm_`, `pypi-`, `dckr_pat_`, `hvs.`) |
| JWT | `eyJ` + `.` + `eyJ` + `.` + signature |
| Private key block | `-----BEGIN (RSA\|EC\|DSA\|OPENSSH\|PGP\|ENCRYPTED)? PRIVATE KEY-----` |
| Connection string with password | `<scheme>://<user>:<password>@<host>` for `postgres`, `mysql`, `mongodb(+srv)`, `redis`, `amqp`, `mssql`, `jdbc:` |
| Cloud connection strings | `AccountKey=`, `SharedAccessSignature=`, `DefaultEndpointsProtocol=` |

### 3. Generic assignment pattern

Catches secrets without a known prefix:

```
(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|auth|bearer|private[_-]?key|client[_-]?secret)
\s*[:=]\s*['"]?  [A-Za-z0-9/+=_\-.]{12,}
```

Case-insensitive. Placeholder values are **not** flagged: `<...>`, `${...}`, `{{...}}`, `xxx…`, `***`, `changeme`, `example`, `your-…-here`, `REDACTED`, and any value shorter than 12 characters.

### 4. Entropy (opt-in)

`security.entropy: true` in `brain.yml` adds a Shannon-entropy check on quoted strings of 20+ characters. Off by default because it is noisy on hashes, IDs, and base64 diagrams. When on, entropy hits are **warnings**, not blocks.

### Custom patterns

`brain.yml` MAY add project-specific detectors. They are additive; built-ins cannot be disabled, only allow-listed per finding.

```yaml
security:
  patterns:
    - name: internal-service-token
      regex: 'svc_[A-Za-z0-9]{32}'
      severity: block        # block | warn
  entropy: false
```

## Where the scan runs

| Point | Mode | On failure |
|-------|------|------------|
| `thoughts sync`, before validate | staged and modified files | **Refuses to commit.** Exit 7. No bypass flag. |
| `pre-commit` hook in the **brain clone** | staged files | Refuses the commit. Installed by `init` when it clones the brain; this clone is CLI-owned, so the hook is not opt-in (unlike hooks in code repos). Protects against raw `git commit` inside `~/.thoughts/brains/`. |
| `thoughts new --set k=v` | the values | Refuses to create the file. |
| `thoughts init`, after writing `.thoughts.yml` and `brain.yml` | those two files | Refuses to continue. |
| `thoughts scan` | whole brain (`--history` walks every commit) | Reports; exit 7 if any block-severity finding. |
| `thoughts lint` | whole working tree | Same as `scan` without `--history`. |
| `thoughts templates lint` | template files | Fails lint. |

## Output

```
✗ secret found — refusing to commit

  repos/payments-api/research/2026-09-08-stripe-webhooks.md:41
    stripe secret key      sk_live_4eC3****************
  shared/decisions/2026-09-01-db-access.md:18
    connection string      postgres://app:****@db.internal:5432/orders

Fix:  edit the lines above, or run   thoughts scan --fix   to redact them.
Then: rotate any real credential that was exposed. Scanning does not un-leak it.
```

The matched value is masked to its first 4 characters. The full value MUST never be printed, logged, or written to the cache.

`--json` emits `{ path, line, kind, severity, masked, fingerprint }` per finding.

## Fixing and allow-listing

- `thoughts scan --fix` replaces each block-severity match with `<redacted:<kind>>` after per-finding confirmation. Then the user rotates the credential; the CLI reminds them and cannot do it for them.
- **False positives** are allow-listed by fingerprint, never by disabling a detector:

  ```yaml
  # <brain>/.thoughts-allow.yml  (committed)
  allow:
    - fingerprint: sha256:9f1c…        # hash of (path + kind + masked value)
      reason: example key in the onboarding doc, not real
      by: human:ishujeet
      at: 2026-09-09T10:12:00Z
  ```

  `thoughts scan --allow <fingerprint> --reason "..."` writes the entry. An allow-list entry is itself a reviewed change in the brain's git history.

- Inline `<!-- thoughts:allow-secret reason="..." -->` on the line above a match does the same for that line. Both mechanisms MUST record a reason.

## If a secret was already pushed

`thoughts scan --history` walks every commit in the brain and reports findings with the commit hash and author. The CLI prints the recovery order and stops:

1. Rotate the credential now. Assume it is compromised.
2. Redact in the working tree and sync.
3. If history rewriting is wanted, do it with git tooling and force-push, then every teammate re-clones the brain (`thoughts doctor --reclone`).

The CLI MUST NOT rewrite history itself.

## Performance

- Incremental: `sync` and the hook scan only changed files. `scan` on a full brain of 5,000 files MUST finish in under 3 seconds on a laptop.
- Detectors are compiled once per process. The generic pattern runs only on lines that contain one of its keywords.

## Acceptance criteria

- A thought containing `sk_live_…` → `sync` exits 7, nothing committed, value masked in output.
- `git commit` by hand inside the brain clone with the same file → pre-commit hook refuses.
- `thoughts new research "X" --set token=ghp_abc…` → refuses, no file created.
- `password: <your-password>` and `token: ${API_TOKEN}` → no finding.
- Allow-listed fingerprint → `sync` passes; changing the value invalidates the allow-list entry.
- `scan --history` on a brain with a secret in an old commit → finding with commit hash, exit 7, recovery steps printed.
- No detector can be disabled through any config; only allow-listed per fingerprint.

## Open questions

- Should the scanner also run on `thoughts search` output to mask anything that slipped through history? Cheap and defensive; leaning yes, as a display-time mask only.
- Pattern set maintenance: vendor the list in the CLI and bump with releases, or allow `security.patterns_url` to fetch a shared list? The latter needs network; keep vendored for v1.
