# Milestone 1 contract — thoughts CLI

Both developers MUST follow this. Specs in `specs/` are the source of truth for behaviour; this file fixes the seams between the two work packages so they can be built in parallel in one working tree. `src/types.ts` is the code form of this contract and is supervisor-owned: do not edit it. If a shared type must change, report it.

## 1. Packages and ownership

| Package | Owner | Owned paths (create/edit only here) |
|---------|-------|--------------------------------------|
| **core** | dev-core | `src/brain/**`, `src/security/**`, `tests/brain/**`, `tests/security/**` |
| **commands** | dev-commands | `src/commands/**`, `src/templates/**`, `src/adapters/**`, `src/git.ts`, `src/cli.ts`, `src/index.ts`, `templates/**`, `kit/**`, `tests/commands/**`, `tests/templates/**`, `tests/adapters/**` |

Supervisor-owned, read-only for both: `package.json`, `package-lock.json`, `tsconfig*.json`, `vitest.config.ts`, `.gitignore`, `src/types.ts`, `src/paths.ts`, `src/assets.ts`, `src/output.ts`, `tests/scaffold.test.ts`, `CONTRACT.md`, `specs/**`, `CLAUDE.md`.

No new dependencies without reporting it. Nothing is committed to git by developers. No global installs.

## 2. Module layout and import direction

```
src/index.ts          bin entry (shebang) -> cli.main()
src/cli.ts            commander program; registers commands; maps errors to exit codes
src/commands/*.ts     init, sync, new  (+ optional scan --staged)
src/templates/        template resolution (specs/07) + restricted Handlebars renderer
src/adapters/         claude-code adapter (specs/11): CLAUDE.md managed block, .claude/commands
src/git.ts            execFile wrapper around git
src/brain/            config chain, layout, OKF parse/validate, index/log generation, lint, preflight
src/security/         secret scanner (specs/15)
src/{types,paths,assets,output}.ts   shared, supervisor-owned
templates/*.md        built-in templates (embedded assets)
kit/                  standard kit assets: kit/instructions.md, kit/commands/thoughts-*.md
```

Import rules:
- `commands` -> `brain`, `security`, `templates`, `adapters`, `git`, shared. 
- `brain` and `security` -> shared only. They MUST NOT import from `commands`, `templates`, `adapters`, or `git.ts`. The only git use allowed in `brain` is `git config --get user.email` for the default user id.
- Nothing imports `cli.ts` except `index.ts` and tests.
- ESM everywhere: relative imports end in `.js` (`import { x } from './okf.js'`).

## 3. Public API of `src/brain/` (core provides, commands consumes)

Every function is exported from the named file; `src/brain/index.ts` MAY re-export but the per-file names are the contract.

`src/brain/config.ts`
- `loadGlobalConfig(): Promise<GlobalConfig>` — missing file → `{ brains: {}, attached: [] }`. Never throws for a missing file.
- `saveGlobalConfig(cfg: GlobalConfig): Promise<void>` — creates the directory; preserves unknown keys.
- `loadRepoConfig(repoRoot: string): Promise<RepoConfig | undefined>` — `undefined` when `.thoughts.yml` is absent; `ThoughtsError(Validation)` when unparsable or missing `brain`/`repo_id`.
- `saveRepoConfig(repoRoot: string, cfg: RepoConfig): Promise<void>`
- `loadBrainConfig(brainRoot: string): Promise<BrainConfig>` — applies defaults: `kind: 'project'`, `kinds: DEFAULT_KINDS`, `templates.source: 'builtin'`, `repos: []`. Throws `ThoughtsError(Validation)` if `brain.yml` is missing or `name` is absent.
- `saveBrainConfig(brainRoot: string, cfg: BrainConfig): Promise<void>` — preserves unknown keys, stable key order.
- `brainIdFromRemote(remote: string): string` — last path segment without `.git`, for ssh/https/file URLs and plain paths. `git@github.com:acme/acme-brain.git` → `acme-brain`; `/tmp/x/my-brain` → `my-brain`.
- `resolveConfig(cwd: string, opts?: { brain?: string }): Promise<ResolvedConfig>` — the lookup chain repo → project brain → (org: no-op slot) → global. `brain` opt is a brain id or remote URL; when given it wins over `.thoughts.yml`.
- `defaultUserId(global: GlobalConfig): Promise<string>` — `global.user_id`, else git `user.email` local part, else OS username.

`src/brain/layout.ts`
- `locate(relPath: string): ThoughtLocation | undefined` — accepts with or without leading slash; returns `undefined` for paths outside the three zones and for `index.md`/`log.md`. Fills `zone`, `owner`, `kind`, `date`.
- `findRepoRoot(cwd: string): string | undefined` — nearest ancestor (inclusive) containing `.thoughts.yml`.
- `findBrainRoot(cwd: string): string | undefined` — nearest ancestor (inclusive) containing `brain.yml`.
- `scaffoldBrain(root: string, opts: { name: string; description?: string; now?: Date }): Promise<string[]>` — creates `brain.yml`, root `index.md` (with `okf_version` frontmatter), `log.md`, `shared/{plans,specs,research,decisions}/.gitkeep`, `repos/.gitkeep`, `users/.gitkeep`. Does NOT run git. Returns created relative paths. Idempotent: never overwrites an existing file.
- `ensureRepoDirs(brainRoot: string, repoId: string, kinds: Record<string, KindConfig>): Promise<string[]>` — `repos/<id>/<kind>/.gitkeep` for every kind. Returns created paths.
- `registerRepo(brainRoot: string, entry: BrainRepoEntry): Promise<boolean>` — appends to `brain.yml` `repos[]` if the id is missing; the only automated edit to `brain.yml` besides `templates.source`. Returns `true` if changed.
- `kitOutdated(repo: RepoConfig, cliVersion: string): boolean` — semver-ish comparison; `kit_version` missing counts as outdated.

`src/brain/okf.ts`
- `parseFrontmatter(text: string): { frontmatter: Frontmatter; body: string; hasFrontmatter: boolean; raw?: string; error?: string }` — never throws. YAML errors land in `error`. Unknown fields preserved.
- `parseThought(absPath: string, relPath: string): Promise<Thought>` — `relPath` bundle-relative; `location` via `locate` (a thought outside a zone gets `zone` from `locate` or throws `ThoughtsError(Validation)`).
- `serializeThought(frontmatter: Frontmatter, body: string): string` — `---\n<yaml>\n---\n<body>`; round-trips unknown keys; body verbatim.
- `validateThought(t: Thought, opts?: { knownTypes?: string[] }): LintIssue[]` — the E/W rules of specs/09 that need only the file (frontmatter missing/unparsable; `type`, `title`, `status`, `generated`, `repo` missing; `repo` disagrees with zone/owner; `description` empty on `stable`; `stale_after` past and not `deprecated`). Rule ids: `okf/frontmatter`, `okf/missing-field`, `okf/repo-mismatch`, `okf/empty-description`, `okf/stale`.
- `trustTier(fm: Frontmatter): TrustTier`

`src/brain/walk.ts`
- `listThoughts(brainRoot: string): Promise<Thought[]>` — every `.md` under `shared/`, `repos/`, `users/` except `index.md`/`log.md` and anything under `references/` or `.git/`. Sorted by path.
- `listTextFiles(root: string): Promise<string[]>` — every file under root except `.git/`, relative paths with leading slash. Used by lint/scan.

`src/brain/generate.ts`
- `renderIndexes(thoughts: Thought[], brain: BrainConfig): Record<string, string>` — pure. Keys are `/index.md`, `/shared/index.md`, `/repos/<id>/index.md` (one per repo dir that exists in `thoughts` OR is listed in `brain.repos`), `/users/<id>/index.md`. Format exactly as specs/09 "Generated index.md": `# <heading>`, `## <Kind>` sections in `brain.kinds` order (empty omitted; heading = kind name capitalised), entries `* [title](/abs/path) - description` plus `` `status` `` suffix when status ≠ `stable`, sorted date desc then title. Root index: frontmatter `okf_version: "0.2"`, `# <brain name>`, a **Zones** list with counts, a **Repos** list with counts, then **Recently updated** (last 20 by date desc, title). Byte-identical for identical inputs; trailing newline; LF only.
- `appendLog(existing: string, date: string, entries: LogEntry[]): string` — newest date first; `## YYYY-MM-DD` sections; line format `* **Added**: [title](/path) by <by>` / `* **Updated**: [title](/path) — <note>` / `* **Removed**: [title](/path)`. If a section for `date` exists, new lines are inserted at the top of it and exact duplicates are dropped. Past dates are never modified. Empty `entries` returns `existing` unchanged (a fresh brain gets `# Log\n\n`).
- `regenerate(brainRoot: string, brain: BrainConfig, opts?: { log?: { date: string; entries: LogEntry[] }; dryRun?: boolean }): Promise<RegenerateResult>` — lists thoughts, renders indexes (+ log when given), writes only files whose content changed (none in `dryRun`), returns `files`, `changed`, `thoughts`, and validation `issues`.

`src/brain/lint.ts`
- `lintBrain(brainRoot: string, brain: BrainConfig): Promise<LintIssue[]>` — `validateThought` for every thought + layout rules: `layout/repo-templates` (error: `repos/<id>/templates/` exists, D19), `okf/broken-link` (warning: `sources[].resource`, `supersedes`, `superseded_by` bundle-relative paths that do not exist).
- `formatIssues(issues: LintIssue[]): string` — `path:line: error|warning: message (rule)` one per line.
- `hasErrors(issues: LintIssue[]): boolean`

`src/brain/preflight.ts`
- `preflight: PreflightFn` (see `src/types.ts`). Algorithm:
  1. `global = loadGlobalConfig()`.
  2. `repoRoot = findRepoRoot(cwd)`. If found: load repo config; `brainId = brainIdFromRemote(repo.brain)`; `expected = brainCloneDir(brainId)`. The repo is **attached-not-initialised** when `<repoRoot>/thoughts` is missing, not a symlink, does not resolve to `expected` (compare `fs.realpath` of both), or `expected/brain.yml` does not exist. In that state, unless `command` ∈ {`init`,`doctor`,`help`,`version`}, throw `ThoughtsError('This repo is attached to brain <brainId> but not initialised on this machine.', ExitCode.NotInitialised, { hint: 'Run: thoughts init' })`. Otherwise return mode `repo` with `brainRoot = expected`, `brainConfig` loaded. Push `Kit is outdated (installed <v>, CLI <cli>). Run: thoughts kit update` into `warnings` when `kitOutdated`.
  3. Else `brainRoot = findBrainRoot(cwd)` → mode `brain`.
  4. Else if `opts.brain` or `global.default_brain` names a clone under `brainsDir()` → mode `none` with `brainRoot` set. Else mode `none` with no brain.
  Never throws for a missing brain in `none` mode; commands decide.

## 4. Public API of `src/security/` (core provides)

`src/security/scanner.ts`
- `scanText(text: string, displayPath: string, opts?: ScanOptions): Finding[]` — runs known-format patterns, generic assignment pattern (with placeholder exclusions), custom patterns, entropy when enabled (stub allowed). Honours inline `<!-- thoughts:allow-secret reason="..." -->` on the previous line and `opts.allow` fingerprints.
- `scanFile(absPath: string, displayPath: string, opts?: ScanOptions): Promise<Finding[]>` — filename blocklist first (`kind: 'blocked filename'`, `line: 0`, `masked: ''`), then size > 1 MB or binary (NUL byte in first 8 KB) → one `unscannable` finding, else `scanText`.
- `scanFiles(root: string, relPaths: string[], opts?: ScanOptions): Promise<Finding[]>` — `relPaths` with or without leading slash; missing files (deleted) are skipped; display path is `/`-prefixed relative path.
- `scanTree(root: string, opts?: ScanOptions): Promise<Finding[]>` — every file except `.git/`.
- `hasBlocking(findings: Finding[]): boolean` — any `block` or `unscannable`.
- `mask(value: string): string` — first 4 chars + `*` × min(len−4, 16); values ≤ 4 chars → `****`.
- `fingerprint(path: string, kind: string, masked: string): string` — `sha256:` + hex of `path + '\n' + kind + '\n' + masked`.
- `src/security/allowlist.ts`: `loadAllowList(brainRoot: string): Promise<AllowEntry[]>` (missing file → `[]`).
- `src/security/format.ts`: `formatFindings(findings: Finding[], opts?: { json?: boolean; verb?: string }): string` — human form exactly as specs/15 "Output" (header `✗ secret found — refusing to <verb>`; default verb `commit`); `json` → JSON array of `{ path, line, kind, severity, masked, fingerprint }`.
- Every detector is compiled once at module load. The raw matched value MUST NOT appear in any returned object, log line, error message, or test snapshot.

## 5. What `commands` builds on top

- Every command file exports `register(program: Command): void` and a `run<Name>(opts, cwd): Promise<...>` that tests call directly (no process spawn needed).
- Every command except `init` starts with `await preflight(cwd, { command, brain: opts.brain, cliVersion: cliVersion() })` and prints `ctx.warnings` via `out.warn` once.
- `init` calls `preflight(cwd, { command: 'init' })` only to reuse detection; it never receives exit 5.
- **Sync pipeline** (specs/03) in `src/commands/sync.ts`: `git status --porcelain` in the brain → changed paths → `scanFiles(brainRoot, changed, { allow: await loadAllowList(brainRoot), customPatterns: brain.security?.patterns, entropy: brain.security?.entropy })` → if `hasBlocking` print `formatFindings` and throw `SecretFoundError` (nothing committed) → for each changed concept `.md` under a zone: `parseThought` + `validateThought`; errors → print `formatIssues`, exit 1 unless `--allow-invalid` → build `LogEntry[]` (`??`/`A` → added with `by = generated.by`; `M` → updated, note `status <old> → <new>` when it changed, old frontmatter via `git show HEAD:<path>` + `parseFrontmatter`; `D` → removed) → `regenerate(brainRoot, brain, { log: { date, entries } })` → `git add -A` + commit (message format from specs/03; repo id from context, `brain` when in brain mode) → `git pull --rebase` → `git push` → report incoming changes grouped by `repos/<id>`.
- **Template variables** are built by `new` as `TemplateVars`; secrets in `--set` values are checked with `scanText(value, '--set ' + key)` before rendering and the rendered file with `scanText(rendered, '/'+bundlePath)` after.
- `init`'s secret check on written config: `scanFiles(repoRoot, ['.thoughts.yml'])` and `scanFiles(brainRoot, ['brain.yml'])`.

## 6. Exit codes and error handling

- Exit codes are `ExitCode` in `src/types.ts`; no literal numbers in commands.
- The only way to exit non-zero is to throw `ThoughtsError` (or `SecretFoundError`). `cli.ts` maps it. Commands do not call `process.exit`.
- Message style: lower-case first word, one line, no trailing period; remedy in `hint`. Example: `ThoughtsError('brain unreachable: ' + remote, ExitCode.RemoteUnreachable, { hint: 'check the remote URL and your network' })`.
- Git failures: `git.ts` throws `GitError { args, stderr, exitCode }`; commands translate: clone/fetch/pull/push network failure → `RemoteUnreachable`; rebase conflict (`git status` shows `UU`/`AA`) → `Conflict` naming the files; anything else → `Validation` with stderr in the message.
- Never print a secret unmasked, anywhere. Findings carry only `masked`.

## 7. Output and logging

- Use `src/output.ts`: `info` (stdout, silenced by `--quiet`), `print` (stdout, always; use for `--json` and `--print-path`), `warn`/`error`/`debug` (stderr). No `console.log` in `src/`.
- `--json` output is a single JSON document on stdout and nothing else on stdout.
- Debug is on with `THOUGHTS_DEBUG=1`.

## 8. Embedded assets

- Built-in templates: `templates/{plan,spec,research,decision,pr,commit}.md` at the package root. Standard kit: `kit/instructions.md` (the managed-block content from specs/08 with `{{brain_name}}`/`{{repo_id}}`), `kit/commands/thoughts-*.md`. Kit files carry a first-line HTML comment `<!-- thoughts-kit v<version> -->` so `init` can compare versions.
- Read them only via `src/assets.ts` (`readAsset('templates', 'plan.md')`). Never with cwd-relative paths. They are shipped by `package.json` `files`.

## 9. Paths, time, determinism, environment

- Bundle-relative paths always carry a leading slash (`/repos/payments-api/specs/x.md`) in `Thought`, `Finding`, `LogEntry`, `LintIssue`, and generated links. Filesystem paths are absolute. Convert at the boundary with `path.join(brainRoot, rel.slice(1))`.
- Any function that emits a timestamp or date accepts `now?: Date` (default `new Date()`); dates are `YYYY-MM-DD` UTC, timestamps ISO 8601 UTC with seconds.
- Generated files: LF line endings, single trailing newline, deterministic ordering.
- Locations come from `src/paths.ts`; tests set `HOME`, `THOUGHTS_HOME`, `THOUGHTS_CONFIG_DIR` to temp dirs (`fs.mkdtemp` under `os.tmpdir()`) and set git identity via `GIT_AUTHOR_NAME/EMAIL`, `GIT_COMMITTER_NAME/EMAIL` env or `git config` in the temp repos. Tests never touch the real home directory or the network.

## 10. Verification

`npm run typecheck` and `npm test` must pass at every hand-off. `npm run build && node dist/index.js --help` must work. Tests live under `tests/<package>/**/*.test.ts` and use `vitest` imports (no globals).
