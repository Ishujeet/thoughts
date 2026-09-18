/**
 * Shared types for the `thoughts` CLI.
 *
 * OWNERSHIP: this file is supervisor-owned. Developers MUST NOT edit it.
 * If a shared shape needs to change, report it; package-private types go in
 * the package's own files.
 *
 * Vocabulary follows specs/00-overview.md: brain, thought, repo, zone, kind,
 * adapter, template, standard kit.
 */

// ---------------------------------------------------------------------------
// Exit codes (specs/02, 03, 06, 15)
// ---------------------------------------------------------------------------

export enum ExitCode {
  /** Success, including no-op re-runs and "nothing to do". */
  Ok = 0,
  /** User aborted, validation error (OKF lint error, bad flags, bad template). */
  Validation = 1,
  /** Brain remote unreachable (clone/fetch/pull/push failed). Local commit may still exist. */
  RemoteUnreachable = 2,
  /** Filesystem conflict: existing `thoughts/` path, unwritable instruction file. */
  FsConflict = 3,
  /** Git conflict requiring manual resolution (sync rebase). */
  Conflict = 4,
  /** Repo is attached (has .thoughts.yml) but not initialised on this machine. */
  NotInitialised = 5,
  /** A block-severity secret finding. Nothing was written/committed. */
  SecretFound = 7,
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export interface ThoughtsErrorOptions {
  /** One-line remedy printed after the message, e.g. "Run: thoughts init". */
  hint?: string;
  cause?: unknown;
}

/**
 * The only error type the CLI entry maps to an exit code. Anything else that
 * escapes a command is a bug and exits 1 with a stack trace when THOUGHTS_DEBUG=1.
 */
export class ThoughtsError extends Error {
  readonly exitCode: ExitCode;
  readonly hint: string | undefined;

  constructor(message: string, exitCode: ExitCode = ExitCode.Validation, options: ThoughtsErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ThoughtsError';
    this.exitCode = exitCode;
    this.hint = options.hint;
  }
}

/**
 * Thrown by every write path when the scanner returns a block-severity
 * finding. Carries the findings so the CLI entry can print them (masked).
 * `message` MUST NOT contain an unmasked value.
 */
export class SecretFoundError extends ThoughtsError {
  readonly findings: Finding[];

  constructor(findings: Finding[], message = 'secret found') {
    super(message, ExitCode.SecretFound, {
      hint: 'Fix: edit the lines above, or run   thoughts scan --fix   to redact them.\nThen: rotate any real credential that was exposed. Scanning does not un-leak it.',
    });
    this.name = 'SecretFoundError';
    this.findings = findings;
  }
}

// ---------------------------------------------------------------------------
// Configuration (specs/01-brain-repo.md)
// ---------------------------------------------------------------------------

/** `~/.config/thoughts/config.yml` */
export interface GlobalConfig {
  /** User id used for `human:<id>` actors. Default: git user.email local part. */
  user_id?: string;
  /** Brain id used when a command runs outside any repo and no --brain is given. */
  default_brain?: string;
  /** Per-brain user options, keyed by brain id. */
  brains: Record<string, GlobalBrainEntry>;
  /** Every initialised repo path on this machine. */
  attached: AttachedRepo[];
  /** Unknown keys are preserved on rewrite. */
  [key: string]: unknown;
}

export interface GlobalBrainEntry {
  remote?: string;
  store_commits?: boolean;
  [key: string]: unknown;
}

export interface AttachedRepo {
  /** Absolute path of the code repo root. */
  path: string;
  repo_id: string;
  /** Brain id. */
  brain: string;
  /** ISO 8601. */
  initialised_at: string;
}

/** `<repo>/.thoughts.yml` — committed to the code repo. */
export interface RepoConfig {
  /** Brain remote URL (or, for a brain created locally without remote, a filesystem path). */
  brain: string;
  repo_id: string;
  /** Union of tools any teammate set up. `init` appends, never removes. */
  tools: string[];
  /** CLI version that last installed/updated the kit. */
  kit_version?: string;
  /** Reserved for org brains; ignored in v1. */
  project?: string;
  [key: string]: unknown;
}

export type BrainKind = 'project' | 'org';

/** Which store a brain lives in (specs/16 "Backend kinds"). git is the default. */
export type BackendKind = 'git' | 'psql' | 'nebula';

/**
 * Non-secret `backend:` block of `brain.yml` (specs/16). Only the *names* of
 * database/space objects; a connection string here is a scanner finding.
 */
export interface BackendDescriptor {
  kind: BackendKind;
  /** psql only: database name. */
  database?: string;
  /** nebula only: space name. */
  space?: string;
}

export type TemplateSource = 'builtin' | 'brain' | `path:${string}` | `git:${string}`;
export type CustomPatternSeverity = 'block' | 'warn';

export interface CustomPattern {
  name: string;
  regex: string;
  severity: CustomPatternSeverity;
}

export interface BrainRepoEntry {
  id: string;
  remote?: string;
  /**
   * The repo's package name, used to match cross-repo codegraph edges
   * (specs/17 "Cross-repo edges"). Optional; a manifest name is a fallback.
   */
  package?: string;
  [key: string]: unknown;
}

export interface KindConfig {
  template: string;
  [key: string]: unknown;
}

/** `<brain>/brain.yml` */
export interface BrainConfig {
  okf_version: string;
  /** Defaults to `project` when absent. */
  kind: BrainKind;
  name: string;
  description?: string;
  /** Store backend (specs/16). Absent means the git default. */
  backend?: BackendDescriptor;
  repos: BrainRepoEntry[];
  /** Kinds in declared order. Defaults to DEFAULT_KINDS when absent. */
  kinds: Record<string, KindConfig>;
  integrations?: Record<string, unknown>;
  templates: { source: TemplateSource; [key: string]: unknown };
  security?: {
    patterns?: CustomPattern[];
    entropy?: boolean;
    [key: string]: unknown;
  };
  hooks?: { pre_sync?: string; post_sync?: string; [key: string]: unknown };
  [key: string]: unknown;
}

/** Default kinds in `brain.yml` order (specs/01). */
export const DEFAULT_KINDS: Record<string, KindConfig> = {
  plans: { template: 'plan' },
  specs: { template: 'spec' },
  research: { template: 'research' },
  decisions: { template: 'decision' },
  prs: { template: 'pr' },
};

/** OKF `type` for each built-in template name (specs/07, 09). */
export const BUILTIN_TYPES: Record<string, string> = {
  plan: 'Plan',
  spec: 'Spec',
  research: 'Research',
  decision: 'Decision',
  pr: 'Pull Request',
  commit: 'Commit',
};

export const OKF_VERSION = '0.2';

/**
 * Result of the config lookup chain: repo -> project brain -> (org brain, no-op in v1) -> global.
 * Each link is present only when found on disk.
 */
export interface ResolvedConfig {
  global: GlobalConfig;
  globalPath: string;
  repo?: RepoConfig;
  repoPath?: string;
  brain?: BrainConfig;
  brainPath?: string;
}

// ---------------------------------------------------------------------------
// Brain layout (specs/01)
// ---------------------------------------------------------------------------

export type Zone = 'shared' | 'repos' | 'users';
export const ZONES: readonly Zone[] = ['shared', 'repos', 'users'];
export const GENERATED_FILENAMES: readonly string[] = ['index.md', 'log.md'];

/** Where a bundle-relative path sits in the brain. */
export interface ThoughtLocation {
  /** Bundle-relative path with a leading slash, e.g. `/repos/payments-api/specs/2026-09-08-x.md`. */
  path: string;
  zone: Zone;
  /** `repo_id` for `repos/`, `user-id` for `users/`, undefined for `shared/`. */
  owner?: string;
  /** Kind directory name, e.g. `specs`. Undefined when the file is directly under a zone/owner dir. */
  kind?: string;
  /** `YYYY-MM-DD` parsed from the filename prefix, if present. */
  date?: string;
}

// ---------------------------------------------------------------------------
// OKF concept frontmatter (specs/09)
// ---------------------------------------------------------------------------

export type ThoughtStatus = 'draft' | 'stable' | 'deprecated';

export interface Actor {
  by: string;
  at: string;
  [key: string]: unknown;
}

export interface SourceRef {
  resource: string;
  title?: string;
  id?: string;
  [key: string]: unknown;
}

export interface ThoughtLinks {
  ticket?: string;
  pr?: string;
  branch?: string;
  work_item?: string;
  [key: string]: unknown;
}

/**
 * Frontmatter as parsed. Required fields are typed as optional here because
 * parse never fails on missing fields; `validate` reports them. Unknown fields
 * MUST be preserved on rewrite.
 */
export interface Frontmatter {
  type?: string;
  title?: string;
  description?: string;
  resource?: string;
  tags?: string[];
  status?: ThoughtStatus | string;
  stale_after?: string;
  generated?: Actor;
  verified?: Actor[];
  sources?: SourceRef[];
  /** Owning `repo_id`, `shared`, or `user:<id>`. */
  repo?: string;
  links?: ThoughtLinks;
  supersedes?: string;
  superseded_by?: string;
  [key: string]: unknown;
}

export type TrustTier = 'unverified' | 'machine-confirmed' | 'human-reviewed';

/** A parsed concept file. */
export interface Thought {
  location: ThoughtLocation;
  absPath: string;
  frontmatter: Frontmatter;
  /** Markdown after the closing `---`, verbatim. */
  body: string;
  /** True when a frontmatter block was found and parsed as YAML. */
  hasFrontmatter: boolean;
  /** Raw YAML text between the fences (for error messages). */
  rawFrontmatter?: string;
}

export type LintSeverity = 'error' | 'warning';

export interface LintIssue {
  severity: LintSeverity;
  /** Bundle-relative path with leading slash. */
  path: string;
  line?: number;
  /** Stable rule id, e.g. `okf/missing-field`, `okf/frontmatter`, `layout/repo-templates`. */
  rule: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Generated files (specs/09)
// ---------------------------------------------------------------------------

export type LogChange = 'added' | 'updated' | 'removed';

/** One line of `log.md`, computed by the caller from git state. */
export interface LogEntry {
  change: LogChange;
  /** Bundle-relative path with leading slash. */
  path: string;
  title: string;
  /** Actor id (`generated.by`), shown as `by <actor>` for `added`. */
  by?: string;
  /** Free-text note appended after an em dash, e.g. `status draft → stable`. */
  note?: string;
}

/** Output of a regeneration pass. Paths are bundle-relative with leading slash. */
export interface RegenerateResult {
  /** Every generated file and its full content, deterministic. */
  files: Record<string, string>;
  /** Subset of `files` whose content differs from what was on disk. */
  changed: string[];
  thoughts: Thought[];
  issues: LintIssue[];
}

// ---------------------------------------------------------------------------
// Secret scanning (specs/15)
// ---------------------------------------------------------------------------

export type FindingSeverity = 'block' | 'warn' | 'unscannable';

export interface Finding {
  /** Path as given to the scanner (bundle-relative with leading slash for brain files; `--set <key>` for CLI values). */
  path: string;
  /** 1-based line; 0 when the finding is about the whole file (blocklisted name, unscannable). */
  line: number;
  /** Human-readable detector name, e.g. `stripe secret key`, `blocked filename`. */
  kind: string;
  severity: FindingSeverity;
  /** First 4 characters of the match followed by `*` for each remaining character (max 16 stars). NEVER the raw value. */
  masked: string;
  /** `sha256:<hex>` of `path + "\n" + kind + "\n" + masked`. */
  fingerprint: string;
}

export interface AllowEntry {
  fingerprint: string;
  reason: string;
  by: string;
  at: string;
  [key: string]: unknown;
}

export interface ScanOptions {
  /** Entries from `<brain>/.thoughts-allow.yml`. Matching fingerprints are dropped. */
  allow?: AllowEntry[];
  /** `brain.yml` `security.patterns`, additive to built-ins. */
  customPatterns?: CustomPattern[];
  /** `brain.yml` `security.entropy`; default false. May be a stub in milestone 1. */
  entropy?: boolean;
}

// ---------------------------------------------------------------------------
// Runtime context and preflight (specs/02 "Attached, not initialised")
// ---------------------------------------------------------------------------

export type ContextMode =
  /** cwd is inside a code repo with `.thoughts.yml`, initialised on this machine. */
  | 'repo'
  /** cwd is inside a brain clone (brain.yml in ancestry, no .thoughts.yml). */
  | 'brain'
  /** neither; commands may still work with --brain / default_brain. */
  | 'none';

export interface Context {
  mode: ContextMode;
  cwd: string;
  /** Code repo root (directory containing `.thoughts.yml`). Present in `repo` mode. */
  repoRoot?: string;
  repoConfig?: RepoConfig;
  /** Absolute brain root. Present in `repo` and `brain` modes. */
  brainRoot?: string;
  brainId?: string;
  brainConfig?: BrainConfig;
  global: GlobalConfig;
  /** Warnings the caller should print once (e.g. kit outdated). */
  warnings: string[];
}

export interface PreflightOptions {
  /** Command name; `init`, `doctor`, `help`, `version` are exempt from the exit-5 rule. */
  command: string;
  /** `--brain <url|id>` when given. */
  brain?: string;
  /** CLI version, used for the kit_version drift warning. */
  cliVersion?: string;
}

/**
 * Signature of the preflight shared by all commands.
 * Throws ThoughtsError(ExitCode.NotInitialised) when the repo is attached but
 * not initialised and `command` is not exempt.
 */
export type PreflightFn = (cwd: string, options: PreflightOptions) => Promise<Context>;

// ---------------------------------------------------------------------------
// Templates (specs/06, 07)
// ---------------------------------------------------------------------------

/** Variables available to templates (specs/06 table). */
export interface TemplateVars {
  title: string;
  slug: string;
  /** YYYY-MM-DD */
  date: string;
  /** ISO 8601 timestamp */
  now: string;
  kind: string;
  type: string;
  repo_id: string;
  brain_name: string;
  author: string;
  branch?: string;
  commit?: string;
  ticket?: string;
  pr?: string;
  from?: { path: string; [key: string]: unknown };
  [key: string]: unknown;
}

export const ALLOWED_HELPERS: readonly string[] = ['date', 'slug', 'upper', 'lower', 'join'];

// ---------------------------------------------------------------------------
// Standard kit / adapters (specs/08, 11) — milestone 1: claude-code only
// ---------------------------------------------------------------------------

export const MANAGED_BLOCK_BEGIN = '<!-- thoughts:begin (managed by `thoughts init`; edit outside this block) -->';
export const MANAGED_BLOCK_END = '<!-- thoughts:end -->';

export type KitFileState = 'created' | 'updated' | 'up-to-date' | 'modified locally' | 'outdated' | 'skipped' | 'missing';

export interface StepReport {
  step: string;
  state: KitFileState | 'done' | 'dry-run';
  detail?: string;
}
