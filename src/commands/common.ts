/**
 * Helpers shared by the command implementations (commands package).
 */
import path from 'node:path';
import { GitError, looksLikeRemoteFailure } from '../git.js';
import * as out from '../output.js';
import { ExitCode, SecretFoundError, ThoughtsError, type Context, type Finding } from '../types.js';

/**
 * A blocking scan result. Carries the verb for `formatFindings` so cli.ts can
 * print the findings exactly once, in the specs/15 "Output" form.
 */
export class SecretRefusedError extends SecretFoundError {
  readonly verb: string;
  /** True when the command already printed the findings (e.g. `--json`); cli.ts prints nothing more. */
  readonly silent: boolean;

  constructor(findings: Finding[], verb: string, opts: { silent?: boolean } = {}) {
    super(findings, `secret found — refusing to ${verb}`);
    this.name = 'SecretRefusedError';
    this.verb = verb;
    this.silent = opts.silent === true;
  }
}

/** Print preflight warnings once. */
export function printWarnings(ctx: Context): void {
  for (const w of ctx.warnings) out.warn(w);
}

export type GitPhase = 'clone' | 'fetch' | 'pull' | 'push' | 'other';

/** Translate a GitError into a ThoughtsError with the exit code from the contract. */
export function translateGitError(err: unknown, phase: GitPhase, detail?: string): ThoughtsError {
  if (err instanceof ThoughtsError) return err;
  if (!(err instanceof GitError)) {
    return new ThoughtsError(err instanceof Error ? err.message : String(err), ExitCode.Validation, { cause: err });
  }
  // Never echo an embedded password: neither the remote we were given nor
  // whatever git printed about it (SEC-F6).
  if (detail !== undefined) detail = redactUrlCredentials(detail);
  const stderr = redactUrlCredentials(
    err.stderr.trim().split('\n').filter((l) => l.length > 0).slice(-1)[0] ?? `git ${err.args[0]} failed`,
  );
  if (err.exitCode === 127) {
    return new ThoughtsError('git is not on PATH', ExitCode.Validation, { hint: 'install git and re-run' });
  }
  if (phase !== 'other' && looksLikeRemoteFailure(err)) {
    return new ThoughtsError(`brain unreachable${detail ? ': ' + detail : ''} (${stderr})`, ExitCode.RemoteUnreachable, {
      hint: 'check the remote URL and your network, then run: thoughts sync',
      cause: err,
    });
  }
  if (phase === 'clone' || phase === 'fetch' || phase === 'pull' || phase === 'push') {
    return new ThoughtsError(`git ${phase} failed${detail ? ' for ' + detail : ''}: ${stderr}`, ExitCode.RemoteUnreachable, {
      hint: 'check the remote URL and your network',
      cause: err,
    });
  }
  return new ThoughtsError(`git ${err.args.join(' ')} failed: ${stderr}`, ExitCode.Validation, { cause: err });
}

/**
 * A single path segment supplied by the user or a config file (repo id, user
 * id, kind): letters, digits, `.`, `_`, `-` only; never `.` or `..`. Anything
 * else could escape the zone directory (SEC-F1), so it is refused with exit 1.
 */
export function assertRepoIdSegment(id: string, source: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(id) || id === '.' || id === '..') {
    throw new ThoughtsError(`invalid ${source} "${id}"`, ExitCode.Validation, { hint: 'use letters, digits, . _ -' });
  }
}

const URL_USERINFO_RE = /^([a-z][a-z0-9+.-]*:\/\/)([^/@\s]*:[^/@\s]*)@/i;

/**
 * True when a `scheme://user:password@host` URL carries a password. A bare
 * username (`ssh://git@host/…`, scp-style `git@host:org/brain.git`) is not a
 * credential.
 */
export function hasUrlCredentials(url: string): boolean {
  return URL_USERINFO_RE.test(url);
}

/** Replace `user:password@` in a URL with `***@` wherever it occurs in `text`. */
export function redactUrlCredentials(text: string): string {
  return text.replace(/([a-z][a-z0-9+.-]*:\/\/)([^/@\s]*:[^/@\s]*)@/gi, '$1***@');
}

/** Bundle-relative path (leading slash) of an absolute path inside the brain. */
export function toBundlePath(brainRoot: string, absPath: string): string {
  const rel = path.relative(brainRoot, absPath).split(path.sep).join('/');
  return '/' + rel.replace(/^\/+/, '');
}

/** Absolute path of a bundle-relative path. */
export function fromBundlePath(brainRoot: string, bundlePath: string): string {
  return path.join(brainRoot, bundlePath.replace(/^\/+/, ''));
}

export function isoTimestamp(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Split a comma-separated flag value into trimmed, non-empty, de-duplicated entries. */
export function splitList(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  const raw = Array.isArray(value) ? value : [value];
  const outList: string[] = [];
  for (const item of raw) {
    for (const part of item.split(',')) {
      const t = part.trim();
      if (t.length > 0 && !outList.includes(t)) outList.push(t);
    }
  }
  return outList;
}

/** Bundle-relative path of a concept that is not a generated file and sits in a zone. */
export function isGeneratedFile(bundlePath: string): boolean {
  const base = path.posix.basename(bundlePath);
  return base === 'index.md' || base === 'log.md';
}
