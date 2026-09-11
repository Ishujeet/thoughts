/**
 * Test helpers shared by tests/brain and tests/security. Every test runs
 * against fs.mkdtemp directories; HOME / THOUGHTS_HOME / THOUGHTS_CONFIG_DIR
 * point inside them so nothing touches the real home directory.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface TempEnv {
  /** Temp root; HOME points here. */
  root: string;
  /** THOUGHTS_HOME */
  thoughtsHome: string;
  /** THOUGHTS_CONFIG_DIR */
  configDir: string;
  restore(): Promise<void>;
}

const ENV_KEYS = ['HOME', 'THOUGHTS_HOME', 'THOUGHTS_CONFIG_DIR', 'XDG_CONFIG_HOME'] as const;

export async function makeTempEnv(): Promise<TempEnv> {
  const saved: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  const root = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'thoughts-test-')));
  const thoughtsHome = path.join(root, '.thoughts');
  const configDir = path.join(root, '.config', 'thoughts');
  process.env.HOME = root;
  process.env.THOUGHTS_HOME = thoughtsHome;
  process.env.THOUGHTS_CONFIG_DIR = configDir;
  delete process.env.XDG_CONFIG_HOME;
  return {
    root,
    thoughtsHome,
    configDir,
    async restore() {
      for (const k of ENV_KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
      await fs.promises.rm(root, { recursive: true, force: true });
    },
  };
}

export async function writeFile(root: string, rel: string, content: string): Promise<string> {
  const abs = path.join(root, rel);
  await fs.promises.mkdir(path.dirname(abs), { recursive: true });
  await fs.promises.writeFile(abs, content, 'utf8');
  return abs;
}

export async function readFile(root: string, rel: string): Promise<string> {
  return fs.promises.readFile(path.join(root, rel), 'utf8');
}

export function exists(root: string, rel: string): boolean {
  return fs.existsSync(path.join(root, rel));
}

/** Build a concept file with valid frontmatter; `extra` is appended verbatim to the YAML block. */
export function concept(opts: {
  type?: string;
  title: string;
  description?: string;
  status?: string;
  repo: string;
  by?: string;
  at?: string;
  extra?: string;
  body?: string;
}): string {
  const lines = [
    '---',
    'type: ' + (opts.type ?? 'Spec'),
    'title: ' + opts.title,
  ];
  if (opts.description !== undefined) lines.push('description: ' + opts.description);
  lines.push('status: ' + (opts.status ?? 'draft'));
  lines.push('generated:', '  by: ' + (opts.by ?? 'human:tester'), '  at: ' + (opts.at ?? '2026-09-08T10:00:00Z'));
  lines.push('repo: ' + opts.repo);
  if (opts.extra) lines.push(opts.extra);
  lines.push('---', '');
  return lines.join('\n') + (opts.body ?? '# ' + opts.title + '\n');
}
