/** The commander program and the built binary (`node dist/index.js`). */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';
import { packageRoot } from '../../src/assets.js';
import { buildProgram, handleError } from '../../src/cli.js';
import { SecretRefusedError } from '../../src/commands/common.js';
import { ExitCode, ThoughtsError } from '../../src/types.js';
import { capture } from './helpers.js';

const run = promisify(execFile);
const root = packageRoot();
const bin = path.join(root, 'dist', 'index.js');

async function cli(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const r = await run(process.execPath, [bin, ...args], { cwd: root, env: { ...process.env, THOUGHTS_DEBUG: '' } });
    return { code: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof e.code === 'number' ? e.code : 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

describe('buildProgram', () => {
  it('registers the shipped commands, the planned placeholders and help', () => {
    const names = buildProgram()
      .commands.map((c) => c.name())
      .sort();
    expect(names).toEqual(['attach-all', 'doctor', 'help', 'init', 'kit', 'new', 'scan', 'search', 'status', 'sync', 'worktree']);
  });

  it('handleError prints masked findings in the specs/15 form and maps exit codes', () => {
    const cap = capture();
    try {
      const finding = { path: '/repos/x/specs/a.md', line: 3, kind: 'github token', severity: 'block' as const, masked: 'ghp_' + '*'.repeat(16), fingerprint: 'sha256:0' };
      expect(handleError(new SecretRefusedError([finding], 'create file'))).toBe(ExitCode.SecretFound);
      const err = cap.stderr.join('');
      expect(err).toContain('✗ secret found — refusing to create file');
      expect(err).toContain('  repos/x/specs/a.md:3\n    github token           ghp_****************');
      expect(err).toContain('Fix:  edit the lines above');
      expect(cap.stdout.join('')).toBe('');
      expect(handleError(new ThoughtsError('x', ExitCode.Conflict, { hint: 'do y' }))).toBe(ExitCode.Conflict);
      expect(cap.stderr.join('')).toContain('error: x\ndo y\n');
      expect(handleError(new SecretRefusedError([finding], 'commit', { silent: true }))).toBe(ExitCode.SecretFound);
    } finally {
      cap.restore();
    }
  });
});

describe('built binary', () => {
  beforeAll(async () => {
    if (!fs.existsSync(bin)) {
      await run('npx', ['tsc', '-p', 'tsconfig.build.json'], { cwd: root });
    }
  }, 120_000);

  it('--help, --version and per-command help exit 0', async () => {
    const help = await cli('--help');
    expect(help.code).toBe(0);
    for (const c of ['init', 'sync', 'new', 'scan']) expect(help.stdout).toContain(c);
    expect((await cli('--version')).stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    for (const c of ['init', 'sync', 'new']) {
      const h = await cli(c, '--help');
      expect(h.code).toBe(0);
      expect(h.stdout).toContain(`Usage: thoughts ${c}`);
    }
    expect((await cli('init', '--help')).stdout).toContain('--dry-run');
  });

  it('unknown command exits 1', async () => {
    const r = await cli('bogus');
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("unknown command 'bogus'");
  });
});
