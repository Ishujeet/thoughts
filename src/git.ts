/**
 * Thin wrapper around the `git` binary. Owned by the "commands" package.
 *
 * Every call goes through `execFile` (never a shell) with
 * `GIT_TERMINAL_PROMPT=0` so an unreachable or missing remote fails fast
 * instead of asking for credentials. Failures throw `GitError`; commands
 * translate that into `ThoughtsError` with the right exit code.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export class GitError extends Error {
  readonly args: string[];
  readonly stderr: string;
  readonly exitCode: number;

  constructor(args: string[], stderr: string, exitCode: number, message?: string) {
    super(message ?? `git ${args.join(' ')} failed (exit ${exitCode}): ${stderr.trim()}`);
    this.name = 'GitError';
    this.args = args;
    this.stderr = stderr;
    this.exitCode = exitCode;
  }
}

export interface GitResult {
  stdout: string;
  stderr: string;
}

export interface GitOptions {
  cwd: string;
  /** Extra environment entries (identity for tests, etc.). */
  env?: Record<string, string>;
}

export interface StatusEntry {
  /** Path relative to the repo root (rename: the new name). */
  path: string;
  /** Two-character porcelain code, e.g. `??`, ` M`, `A `, `D `, `UU`. */
  code: string;
}

function gitEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  return { ...process.env, GIT_TERMINAL_PROMPT: '0', ...(extra ?? {}) };
}

/** Run `git <args>` in `cwd`. Throws GitError on non-zero exit. */
export function git(args: string[], opts: GitOptions): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd: opts.cwd, env: gitEnv(opts.env), maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err) {
          const code = typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : 1;
          const notFound = (err as { code?: unknown }).code === 'ENOENT';
          reject(new GitError(args, String(stderr ?? ''), notFound ? 127 : code, notFound ? 'git is not on PATH' : undefined));
          return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

/** True when `git --version` succeeds. */
export async function isGitAvailable(): Promise<boolean> {
  try {
    await git(['--version'], { cwd: process.cwd() });
    return true;
  } catch {
    return false;
  }
}

export async function isInsideWorkTree(cwd: string): Promise<boolean> {
  try {
    const r = await git(['rev-parse', '--is-inside-work-tree'], { cwd });
    return r.stdout.trim() === 'true';
  } catch {
    return false;
  }
}

/** Absolute path of the work tree root. */
export async function topLevel(cwd: string): Promise<string> {
  const r = await git(['rev-parse', '--show-toplevel'], { cwd });
  return path.resolve(r.stdout.trim());
}

export async function remoteUrl(cwd: string, name = 'origin'): Promise<string | undefined> {
  try {
    const r = await git(['remote', 'get-url', name], { cwd });
    const url = r.stdout.trim();
    return url.length > 0 ? url : undefined;
  } catch {
    return undefined;
  }
}

export async function hasRemote(cwd: string, name = 'origin'): Promise<boolean> {
  return (await remoteUrl(cwd, name)) !== undefined;
}

export async function clone(remote: string, dest: string): Promise<void> {
  await git(['clone', '--quiet', remote, dest], { cwd: path.dirname(dest) });
}

export async function fetch(cwd: string, remote = 'origin'): Promise<void> {
  await git(['fetch', '--quiet', remote], { cwd });
}

/** `git status --porcelain` parsed into {path, code}. Renames report the new path. */
export async function statusPorcelain(cwd: string): Promise<StatusEntry[]> {
  const r = await git(['status', '--porcelain', '--untracked-files=all', '-z'], { cwd });
  const entries: StatusEntry[] = [];
  const parts = r.stdout.split('\0');
  for (let i = 0; i < parts.length; i += 1) {
    const rec = parts[i]!;
    if (rec.length < 4) continue;
    const code = rec.slice(0, 2);
    const p = rec.slice(3);
    if (code[0] === 'R' || code[0] === 'C') {
      // rename/copy: the next NUL-separated field is the original path.
      i += 1;
    }
    entries.push({ path: p, code });
  }
  return entries;
}

export async function addAll(cwd: string): Promise<void> {
  await git(['add', '-A'], { cwd });
}

export async function commit(cwd: string, message: string): Promise<string> {
  await git(['commit', '--quiet', '--no-verify', '-m', message], { cwd });
  return headSha(cwd);
}

export async function pullRebase(cwd: string, remote = 'origin'): Promise<void> {
  await git(['pull', '--rebase', '--quiet', remote], { cwd });
}

export async function push(cwd: string, remote = 'origin'): Promise<void> {
  await git(['push', '--quiet', remote, 'HEAD'], { cwd });
}

export async function currentBranch(cwd: string): Promise<string | undefined> {
  try {
    const r = await git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
    const b = r.stdout.trim();
    return b.length > 0 ? b : undefined;
  } catch {
    return undefined;
  }
}

export async function headSha(cwd: string): Promise<string> {
  const r = await git(['rev-parse', 'HEAD'], { cwd });
  return r.stdout.trim();
}

/** True when the repo has at least one commit. */
export async function hasHead(cwd: string): Promise<boolean> {
  try {
    await git(['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd });
    return true;
  } catch {
    return false;
  }
}

/** Content of `relPath` at HEAD, or undefined when it does not exist there. */
export async function showAtHead(cwd: string, relPath: string): Promise<string | undefined> {
  try {
    const r = await git(['show', `HEAD:${relPath.replace(/^\//, '')}`], { cwd });
    return r.stdout;
  } catch {
    return undefined;
  }
}

/** Paths with unmerged status (`UU`, `AA`, `DU`, ...). */
export async function conflictedFiles(cwd: string): Promise<string[]> {
  const entries = await statusPorcelain(cwd);
  return entries
    .filter((e) => e.code === 'UU' || e.code === 'AA' || e.code === 'DD' || e.code.includes('U'))
    .map((e) => e.path);
}

export async function init(dir: string, opts: { bare?: boolean } = {}): Promise<void> {
  const args = ['init', '--quiet'];
  if (opts.bare) args.push('--bare');
  args.push(dir);
  await git(args, { cwd: path.dirname(dir) });
}

/** True when `dir` is a bare git repository (push target that accepts a checked-out branch). */
export async function isBareRepo(dir: string): Promise<boolean> {
  try {
    const r = await git(['rev-parse', '--is-bare-repository'], { cwd: dir });
    return r.stdout.trim() === 'true';
  } catch {
    return false;
  }
}

/** Absolute hooks directory of the repository at `cwd`. */
export async function hooksDir(cwd: string): Promise<string> {
  const r = await git(['rev-parse', '--git-path', 'hooks'], { cwd });
  return path.resolve(cwd, r.stdout.trim());
}

export async function userEmail(cwd: string): Promise<string | undefined> {
  try {
    const r = await git(['config', '--get', 'user.email'], { cwd });
    const v = r.stdout.trim();
    return v.length > 0 ? v : undefined;
  } catch {
    return undefined;
  }
}

/** `git diff --name-status <from>..<to>` parsed into {code, path}. */
export async function diffNameStatus(cwd: string, from: string, to = 'HEAD'): Promise<StatusEntry[]> {
  const r = await git(['diff', '--name-status', '-z', `${from}..${to}`], { cwd });
  const parts = r.stdout.split('\0');
  const entries: StatusEntry[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    const code = parts[i]!;
    if (code.length === 0) continue;
    const p = parts[i + 1];
    if (p === undefined) break;
    if (code[0] === 'R' || code[0] === 'C') {
      const newPath = parts[i + 2];
      if (newPath === undefined) break;
      entries.push({ path: newPath, code: code[0]! });
      i += 2;
    } else {
      entries.push({ path: p, code });
      i += 1;
    }
  }
  return entries;
}

/** Sha of the upstream tracking ref (`@{u}`), or undefined when there is none. */
export async function upstreamSha(cwd: string): Promise<string | undefined> {
  try {
    const r = await git(['rev-parse', '--verify', '--quiet', '@{u}'], { cwd });
    const sha = r.stdout.trim();
    return sha.length > 0 ? sha : undefined;
  } catch {
    return undefined;
  }
}

/** Commit shas reachable from `to` but not from `from`, newest first. */
export async function revList(cwd: string, from: string, to = 'HEAD'): Promise<string[]> {
  const r = await git(['rev-list', `${from}..${to}`], { cwd });
  return r.stdout.split('\n').filter((l) => l.length > 0);
}

/** Full commit message (subject + body) of `sha`. */
export async function messageOf(cwd: string, sha: string): Promise<string> {
  const r = await git(['log', '-1', '--format=%B', sha], { cwd });
  return r.stdout.replace(/\n+$/, '');
}

export async function isRebaseInProgress(cwd: string): Promise<boolean> {
  try {
    const r = await git(['rev-parse', '--git-path', 'rebase-merge'], { cwd });
    const dir = path.resolve(cwd, r.stdout.trim());
    if (fs.existsSync(dir)) return true;
    const r2 = await git(['rev-parse', '--git-path', 'rebase-apply'], { cwd });
    return fs.existsSync(path.resolve(cwd, r2.stdout.trim()));
  } catch {
    return false;
  }
}

/** Heuristic: does the stderr of a failed clone/fetch/pull/push look like a network/remote problem? */
export function looksLikeRemoteFailure(err: unknown): boolean {
  if (!(err instanceof GitError)) return false;
  const s = err.stderr.toLowerCase();
  return (
    /could not read from remote|unable to access|could not resolve|does not exist|connection (refused|timed out|reset)|does not appear to be a git repository|repository not found|no such file or directory|failed to connect|network is unreachable|remote: |fatal: unable to|permission denied \(publickey\)|no route to host|not found|failed to push some refs/.test(
      s,
    )
  );
}
