/**
 * The help system (specs/18-cli-help.md): grouped command list, planned
 * commands, per-command Examples, help topics, and error-path suggestions.
 *
 * Runs against the built binary, like cli.test.ts, because the layouts under
 * test are what commander writes to stdout/stderr.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';
import { packageRoot } from '../../src/assets.js';
import { HELP_TOPICS } from '../../src/help-topics.js';

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

const SHIPPED = ['init', 'new', 'status', 'sync', 'scan'] as const;
const PLANNED = ['search', 'attach-all', 'worktree', 'doctor', 'kit'] as const;
const GROUP_HEADINGS = ['Getting started', 'Daily', 'Maintenance', 'Planned (not in this version)'] as const;
const MARKER = 'not in this version';

beforeAll(async () => {
  if (!fs.existsSync(bin)) {
    await run('npx', ['tsc', '-p', 'tsconfig.build.json'], { cwd: root });
  }
}, 120_000);

describe('grouped command list', () => {
  it.each([
    ['thoughts --help', ['--help']],
    ['thoughts help', ['help']],
    ['thoughts (no arguments)', []],
  ])('%s exits 0 and prints the four groups in order', async (_label, args) => {
    const r = await cli(...args);
    expect(r.code).toBe(0);
    const positions = GROUP_HEADINGS.map((h) => r.stdout.indexOf(h));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);

    // Global options block sits after the groups, before the typical session.
    const lastGroup = r.stdout.indexOf(GROUP_HEADINGS[GROUP_HEADINGS.length - 1]);
    const globalOptions = r.stdout.indexOf('Global options:');
    expect(globalOptions).toBeGreaterThan(lastGroup);
    expect(r.stdout.indexOf('Typical session:')).toBeGreaterThan(globalOptions);
    expect(r.stdout).toContain('thoughts help <topic>');
  });

  it('lists status under Daily (shipped), not under Planned', async () => {
    const r = await cli('--help');
    const planned = r.stdout.indexOf(GROUP_HEADINGS[3]);
    const status = r.stdout.indexOf('  status');
    expect(status).toBeGreaterThan(0);
    expect(status).toBeLessThan(planned);
  });

  it('lists every planned command under the Planned group with the marker', async () => {
    const r = await cli('--help');
    const planned = r.stdout.slice(r.stdout.indexOf(GROUP_HEADINGS[3]));
    for (const name of PLANNED) expect(planned).toContain(name);
    // The group heading itself carries the literal marker (specs/18 block).
    expect(planned.startsWith(`Planned (${MARKER})`)).toBe(true);
  });
});

describe('planned commands', () => {
  it.each([...PLANNED])('thoughts %s exits 1 with the marker', async (name) => {
    const r = await cli(name);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`thoughts ${name}: ${MARKER}`);
  });
});

describe('thoughts help <topic>', () => {
  it('help backends exits 0 and mentions psql and nebula', async () => {
    const r = await cli('help', 'backends');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('psql');
    expect(r.stdout).toContain('nebula');
    expect(r.stdout).toContain('specs/16-brain-backends.md');
  });

  it.each([...HELP_TOPICS.map((t) => t.name)])('help %s exits 0', async (topic) => {
    const r = await cli('help', topic);
    expect(r.code).toBe(0);
    expect(r.stdout.length).toBeGreaterThan(200);
  });

  it('an unknown topic exits 1 and lists the valid topics', async () => {
    const r = await cli('help', 'backendsx');
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('unknown topic "backendsx"');
    expect(r.stderr).toContain('brain, backends, secrets, okf');
  });

  it('help <command> and <command> --help are equivalent and exit 0', async () => {
    const a = await cli('help', 'status');
    const b = await cli('status', '--help');
    expect(a.code).toBe(0);
    expect(b.code).toBe(0);
    expect(a.stdout).toBe(b.stdout);
  });
});

describe('per-command Examples', () => {
  it.each([...SHIPPED])('%s --help exits 0 and ends with an Examples block', async (name) => {
    const r = await cli(name, '--help');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Examples:');
    expect(r.stdout.indexOf('Examples:')).toBeGreaterThan(r.stdout.indexOf('Options:'));
    // The examples are the command's own after-text, so they end the help.
    expect(r.stdout.trim().split('\n').slice(-1)[0]).toMatch(/^\s+(thoughts|#)/);
  });
});

describe('version and error paths', () => {
  it('--version still works', async () => {
    const r = await cli('--version');
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('a mistyped command suggests the nearest name and exits 1', async () => {
    const r = await cli('statu');
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("unknown command 'statu'");
    expect(r.stderr).toContain('Did you mean status?');
  });
});
