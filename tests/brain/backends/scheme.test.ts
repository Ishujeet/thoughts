/**
 * Scheme-aware brain refs and the `brain.yml` backend block (specs/16
 * "Credential references", "brain.yml backend block").
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  brainIdFromRemote,
  loadBrainConfig,
  resolveConfig,
  saveBrainConfig,
} from '../../../src/brain/config.js';
import { kindFromRef, resolveBackend } from '../../../src/brain/backends/resolve.js';
import { parseBackendDescriptor } from '../../../src/brain/backends/types.js';
import { scaffoldBrain } from '../../../src/brain/layout.js';
import { brainCloneDir } from '../../../src/paths.js';
import { DEFAULT_KINDS, ExitCode, ThoughtsError, type BrainConfig } from '../../../src/types.js';
import { expectThoughtsError } from '../../commands/helpers.js';
import { makeTempEnv, readFile, writeFile, type TempEnv } from '../helpers.js';

let env: TempEnv;
beforeEach(async () => {
  env = await makeTempEnv();
});
afterEach(async () => {
  await env.restore();
});

describe('brainIdFromRemote is scheme-aware', () => {
  it('strips a postgres:/nebula: scheme and yields the id directly', () => {
    expect(brainIdFromRemote('postgres:acme-checkout')).toBe('acme-checkout');
    expect(brainIdFromRemote('nebula:acme-brain')).toBe('acme-brain');
    expect(brainIdFromRemote(' postgres:acme-brain ')).toBe('acme-brain');
  });

  it('still derives the repo name from every git remote form', () => {
    expect(brainIdFromRemote('git@github.com:acme/acme-brain.git')).toBe('acme-brain');
    expect(brainIdFromRemote('https://x/y/z.git')).toBe('z');
    expect(brainIdFromRemote('/tmp/foo/my-brain')).toBe('my-brain');
    expect(brainIdFromRemote('file:///a/b')).toBe('b');
    expect(brainIdFromRemote('acme-brain')).toBe('acme-brain');
  });

  it('rejects a scheme with no id after it', () => {
    expect(() => brainIdFromRemote('postgres:')).toThrow(ThoughtsError);
  });
});

describe('kindFromRef', () => {
  it('maps the schemes to backend kinds', () => {
    expect(kindFromRef('postgres:acme')).toBe('psql');
    expect(kindFromRef('nebula:acme')).toBe('nebula');
    expect(kindFromRef('git@github.com:acme/brain.git')).toBeUndefined();
    expect(kindFromRef(undefined)).toBeUndefined();
  });
});

describe('parseBackendDescriptor', () => {
  it('is undefined when the block is absent', () => {
    expect(parseBackendDescriptor(undefined)).toBeUndefined();
  });

  it('parses kind plus the non-secret names', () => {
    expect(parseBackendDescriptor({ kind: 'git' })).toEqual({ kind: 'git' });
    expect(parseBackendDescriptor({ kind: 'psql', database: 'acme_brain' })).toEqual({ kind: 'psql', database: 'acme_brain' });
    expect(parseBackendDescriptor({ kind: 'nebula', space: 'acme_brain' })).toEqual({ kind: 'nebula', space: 'acme_brain' });
    // unknown extra keys are not part of the descriptor, and a wrong-typed name is dropped
    expect(parseBackendDescriptor({ kind: 'psql', database: 3, host: 'h' })).toEqual({ kind: 'psql' });
  });

  it('refuses a non-mapping block and an unknown kind with exit 1', async () => {
    for (const bad of ['psql', 42, { database: 'x' }, { kind: 'mysql' }]) {
      const err = await expectThoughtsError(async () => parseBackendDescriptor(bad));
      expect(err.exitCode).toBe(ExitCode.Validation);
    }
  });

  it('loadBrainConfig validates the block and keeps it through save', async () => {
    await writeFile(env.root, 'brain.yml', 'name: acme\nbackend:\n  kind: mysql\n');
    await expect(loadBrainConfig(env.root)).rejects.toMatchObject({ exitCode: ExitCode.Validation });
    await writeFile(env.root, 'brain.yml', 'name: acme\nbackend:\n  kind: psql\n  database: acme_brain\n');
    const cfg = await loadBrainConfig(env.root);
    expect(cfg.backend).toEqual({ kind: 'psql', database: 'acme_brain' });
    await saveBrainConfig(env.root, cfg);
    expect((await loadBrainConfig(env.root)).backend).toEqual({ kind: 'psql', database: 'acme_brain' });
  });
});

describe('saveBrainConfig orders backend: per the known keys', () => {
  it('writes backend after the identity keys and before repos', async () => {
    const cfg: BrainConfig = {
      okf_version: '0.2',
      kind: 'project',
      name: 'acme',
      description: 'd',
      backend: { kind: 'psql', database: 'acme_brain' },
      repos: [{ id: 'r' }],
      kinds: DEFAULT_KINDS,
      templates: { source: 'builtin' },
    };
    await saveBrainConfig(env.root, cfg);
    const text = await readFile(env.root, 'brain.yml');
    const keys = text.split('\n').filter((l) => /^[a-z_]+:/.test(l)).map((l) => l.split(':')[0]);
    expect(keys.indexOf('backend')).toBeGreaterThan(keys.indexOf('description'));
    expect(keys.indexOf('backend')).toBeLessThan(keys.indexOf('repos'));
  });
});

describe('resolveConfig with a scheme brain ref', () => {
  it('resolves a postgres:-scheme brain value to the same clone dir as a git ref', async () => {
    await scaffoldBrain(brainCloneDir('acme-checkout'), { name: 'Acme' });
    const repo = path.join(env.root, 'code', 'svc');
    await writeFile(repo, '.thoughts.yml', 'brain: postgres:acme-checkout\nrepo_id: svc\n');
    const r = await resolveConfig(repo);
    expect(r.repo?.brain).toBe('postgres:acme-checkout');
    expect(r.brain?.name).toBe('Acme');
    expect(r.brainPath).toBe(path.join(brainCloneDir('acme-checkout'), 'brain.yml'));
  });

  it('still resolves plain git remotes unchanged', async () => {
    await scaffoldBrain(brainCloneDir('plain-brain'), { name: 'Plain' });
    const repo = path.join(env.root, 'code', 'svc');
    await writeFile(repo, '.thoughts.yml', 'brain: git@h:o/plain-brain.git\nrepo_id: svc\n');
    expect((await resolveConfig(repo)).brain?.name).toBe('Plain');
  });
});

describe('resolveBackend', () => {
  it('returns the git backend by default and for git remotes', async () => {
    expect((await resolveBackend({ brainId: 'b', workspace: '/tmp/w' })).kind).toBe('git');
    expect((await resolveBackend({ brainId: 'b', workspace: '/tmp/w', brainRef: 'git@h:o/b.git' })).kind).toBe('git');
  });

  it('prefers brain.yml backend.kind over the ref scheme', async () => {
    const cfg = {
      okf_version: '0.2',
      kind: 'project' as const,
      name: 'acme',
      backend: { kind: 'git' as const },
      repos: [],
      kinds: DEFAULT_KINDS,
      templates: { source: 'builtin' as const },
    };
    expect((await resolveBackend({ brainId: 'b', workspace: '/tmp/w', brain: cfg, brainRef: 'postgres:x' })).kind).toBe('git');
  });

  it('refuses nebula without a connection ref: exit 1 naming the env var (specs/16 exit codes)', async () => {
    const brainRef = 'nebula:acme-brain';
    const err = await expectThoughtsError(() => resolveBackend({ brainId: 'acme-checkout', workspace: '/tmp/w', brainRef }));
    expect(err).toBeInstanceOf(ThoughtsError);
    expect(err.exitCode).toBe(ExitCode.Validation);
    expect(`${err.message} ${err.hint}`).toContain('THOUGHTS_NEBULA');
  });

  it('returns a NebulaBackend for a nebula: ref when a connection ref is configured', async () => {
    process.env['THOUGHTS_TEST_NEBULA'] = 'nebula://localhost:9669/acme';
    try {
      const backend = await resolveBackend({ brainId: 'acme-checkout', workspace: '/tmp/w', brainRef: 'nebula:acme-checkout', connectionRef: 'env:THOUGHTS_TEST_NEBULA' });
      expect(backend.kind).toBe('nebula');
    } finally {
      delete process.env['THOUGHTS_TEST_NEBULA'];
    }
  });

  it('returns a PgBackend for a postgres: ref when a connection ref is configured', async () => {
    process.env['THOUGHTS_TEST_PG'] = 'postgres://qa@localhost:5432/qa';
    try {
      const backend = await resolveBackend({ brainId: 'acme-checkout', workspace: '/tmp/w', brainRef: 'postgres:acme-checkout', connectionRef: 'env:THOUGHTS_TEST_PG' });
      expect(backend.kind).toBe('psql');
    } finally {
      delete process.env['THOUGHTS_TEST_PG'];
    }
  });

  it('refuses psql without a connection ref: exit 1 naming the env var (specs/16 exit codes)', async () => {
    const err = await expectThoughtsError(() => resolveBackend({ brainId: 'acme-checkout', workspace: '/tmp/w', brainRef: 'postgres:acme-checkout' }));
    expect(err.exitCode).toBe(ExitCode.Validation);
    expect(err.message).toContain('acme-checkout');
    expect(`${err.message} ${err.hint}`).toContain('THOUGHTS_BRAIN_PG');
  });

  it('refuses a psql descriptor in brain.yml the same way', async () => {
    await writeFile(env.root, 'brain.yml', 'name: acme\nbackend:\n  kind: psql\n  database: acme_brain\n');
    const brain = await loadBrainConfig(env.root);
    const err = await expectThoughtsError(() => resolveBackend({ brainId: 'acme-checkout', workspace: env.root, brain }));
    expect(err.exitCode).toBe(ExitCode.Validation);
  });

  it('writes nothing to the workspace', async () => {
    const dir = path.join(env.root, 'untouched');
    fs.mkdirSync(dir, { recursive: true });
    await resolveBackend({ brainId: 'x', workspace: dir });
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});
