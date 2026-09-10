/**
 * Helpers for the commands/templates/adapters tests. Every test runs against
 * fs.mkdtemp directories; HOME / THOUGHTS_HOME / THOUGHTS_CONFIG_DIR point
 * inside them so nothing touches the real home directory or the network.
 *
 * A "machine" is one temp root with its own ~/.thoughts and config dir, so
 * two-teammate scenarios switch machines between calls.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';
import { scaffoldBrain } from '../../src/brain/layout.js';
import * as git from '../../src/git.js';
import { ThoughtsError } from '../../src/types.js';

// Git identity for every commit made by the tests (never the real user).
process.env.GIT_AUTHOR_NAME = 'qa';
process.env.GIT_AUTHOR_EMAIL = 'qa@example.com';
process.env.GIT_COMMITTER_NAME = 'qa';
process.env.GIT_COMMITTER_EMAIL = 'qa@example.com';
delete process.env.VISUAL;
delete process.env.EDITOR;

const ENV_KEYS = ['HOME', 'THOUGHTS_HOME', 'THOUGHTS_CONFIG_DIR', 'XDG_CONFIG_HOME'] as const;
const savedEnv: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) savedEnv[k] = process.env[k];

export interface Machine {
  root: string;
  thoughtsHome: string;
  configDir: string;
  /** Point the process env at this machine. */
  use(): void;
}

const roots: string[] = [];

export async function makeMachine(label = 'm'): Promise<Machine> {
  const root = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), `thoughts-cmd-${label}-`)));
  roots.push(root);
  const m: Machine = {
    root,
    thoughtsHome: path.join(root, '.thoughts'),
    configDir: path.join(root, '.config', 'thoughts'),
    use() {
      process.env.HOME = root;
      process.env.THOUGHTS_HOME = m.thoughtsHome;
      process.env.THOUGHTS_CONFIG_DIR = m.configDir;
      delete process.env.XDG_CONFIG_HOME;
    },
  };
  m.use();
  return m;
}

/** Remove every temp root created so far and restore the env. */
export async function cleanupMachines(): Promise<void> {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  while (roots.length > 0) {
    const r = roots.pop()!;
    await fs.promises.rm(r, { recursive: true, force: true });
  }
}

/** A code repo with one commit. */
export async function makeCodeRepo(dir: string, opts: { commit?: boolean } = {}): Promise<string> {
  await fs.promises.mkdir(dir, { recursive: true });
  await git.init(dir);
  await fs.promises.writeFile(path.join(dir, 'README.md'), '# ' + path.basename(dir) + '\n');
  if (opts.commit !== false) {
    await git.addAll(dir);
    await git.commit(dir, 'initial');
  }
  return dir;
}

export async function commitAll(dir: string, message: string): Promise<string> {
  await git.addAll(dir);
  return git.commit(dir, message);
}

/** A bare brain remote seeded with a scaffolded brain (one commit). Returns the bare path. */
export async function makeBareBrain(root: string, name = 'acme-brain'): Promise<string> {
  const seed = path.join(root, 'seed-' + name);
  await fs.promises.mkdir(seed, { recursive: true });
  await git.init(seed);
  await scaffoldBrain(seed, { name, now: new Date('2026-09-01T00:00:00Z') });
  await commitAll(seed, `thoughts: create brain ${name}`);
  const bare = path.join(root, name + '.git');
  await git.git(['clone', '--bare', '--quiet', seed, bare], { cwd: root });
  return bare;
}

export function write(abs: string, content: string): void {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

export function read(abs: string): string {
  return fs.readFileSync(abs, 'utf8');
}

export interface Captured {
  stdout: string[];
  stderr: string[];
  restore(): void;
}

/** Capture everything written to stdout/stderr while the test runs. */
export function capture(): Captured {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const so = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
    stdout.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  const se = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);
  return {
    stdout,
    stderr,
    restore() {
      so.mockRestore();
      se.mockRestore();
    },
  };
}

/** Run `fn` and return the ThoughtsError it throws; fails when it does not throw. */
export async function expectThoughtsError(fn: () => Promise<unknown>): Promise<ThoughtsError> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof ThoughtsError) return err;
    throw err;
  }
  throw new Error('expected a ThoughtsError, nothing was thrown');
}

/** A secret-looking value built at runtime so no real-looking credential sits in a literal. */
export function fakeGithubToken(): string {
  return 'ghp_' + 'a'.repeat(36);
}

export function fakeStripeKey(): string {
  return 'sk_live_' + 'b'.repeat(24);
}
