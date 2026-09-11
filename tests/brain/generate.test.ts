import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendLog, regenerate, renderIndexes } from '../../src/brain/generate.js';
import { scaffoldBrain } from '../../src/brain/layout.js';
import { parseFrontmatter } from '../../src/brain/okf.js';
import { DEFAULT_KINDS, type BrainConfig, type LogEntry, type Thought } from '../../src/types.js';
import { concept, makeTempEnv, readFile, writeFile, type TempEnv } from './helpers.js';

let env: TempEnv;
beforeEach(async () => {
  env = await makeTempEnv();
});
afterEach(async () => {
  await env.restore();
});

const brain: BrainConfig = {
  okf_version: '0.2',
  kind: 'project',
  name: 'acme-checkout',
  repos: [{ id: 'payments-api' }, { id: 'empty-repo' }],
  kinds: DEFAULT_KINDS,
  templates: { source: 'builtin' },
};

function thought(rel: string, fm: Record<string, unknown>): Thought {
  const parts = rel.slice(1).split('/');
  const zone = parts[0] as Thought['location']['zone'];
  const t: Thought = {
    location: { path: rel, zone },
    absPath: '/nowhere' + rel,
    frontmatter: fm,
    body: '',
    hasFrontmatter: true,
  };
  if (zone !== 'shared') {
    t.location.owner = parts[1];
    if (parts.length >= 4) t.location.kind = parts[2];
  } else if (parts.length >= 3) {
    t.location.kind = parts[1];
  }
  const m = /^(\d{4}-\d{2}-\d{2})-/.exec(parts[parts.length - 1] as string);
  if (m) t.location.date = m[1];
  return t;
}

const fixtures: Thought[] = [
  thought('/repos/payments-api/specs/2026-09-08-refund-endpoint-v2.md', {
    title: 'Refund endpoint v2',
    description: 'Add v2 refund API with idempotency.',
    status: 'draft',
  }),
  thought('/repos/payments-api/specs/2026-09-07-older.md', { title: 'Older spec', description: 'Old.', status: 'stable' }),
  thought('/repos/payments-api/specs/2026-09-08-alpha.md', { title: 'Alpha same day', status: 'deprecated' }),
  thought('/repos/payments-api/specs/undated.md', { title: 'Undated', description: 'No prefix', status: 'stable' }),
  thought('/repos/payments-api/decisions/2026-09-01-d.md', { title: 'A decision', description: 'Why.', status: 'stable' }),
  thought('/repos/payments-api/runbooks/2026-09-02-r.md', { title: 'Custom kind', status: 'stable' }),
  thought('/shared/decisions/2026-09-01-idempotency-key-format.md', { title: 'Idempotency key format', description: 'Keys.', status: 'stable' }),
  thought('/users/ishujeet/plans/2026-09-03-p.md', { title: 'My plan', status: 'draft' }),
];

describe('renderIndexes', () => {
  it('renders per-repo indexes in the specs/09 format', () => {
    const files = renderIndexes(fixtures, brain);
    expect(files['/repos/payments-api/index.md']).toBe(
      [
        '# payments-api',
        '',
        '## Specs',
        '* [Alpha same day](/repos/payments-api/specs/2026-09-08-alpha.md) `deprecated`',
        '* [Refund endpoint v2](/repos/payments-api/specs/2026-09-08-refund-endpoint-v2.md) - Add v2 refund API with idempotency. `draft`',
        '* [Older spec](/repos/payments-api/specs/2026-09-07-older.md) - Old.',
        '* [Undated](/repos/payments-api/specs/undated.md) - No prefix',
        '',
        '## Decisions',
        '* [A decision](/repos/payments-api/decisions/2026-09-01-d.md) - Why.',
        '',
        '## Runbooks',
        '* [Custom kind](/repos/payments-api/runbooks/2026-09-02-r.md)',
        '',
      ].join('\n'),
    );
  });

  it('produces shared, users and listed-but-empty repo indexes without frontmatter', () => {
    const files = renderIndexes(fixtures, brain);
    expect(Object.keys(files).sort()).toEqual([
      '/index.md',
      '/repos/empty-repo/index.md',
      '/repos/payments-api/index.md',
      '/shared/index.md',
      '/users/ishujeet/index.md',
    ]);
    expect(files['/shared/index.md']).toBe(
      '# shared\n\n## Decisions\n* [Idempotency key format](/shared/decisions/2026-09-01-idempotency-key-format.md) - Keys.\n',
    );
    expect(files['/users/ishujeet/index.md']).toBe('# user:ishujeet\n\n## Plans\n* [My plan](/users/ishujeet/plans/2026-09-03-p.md) `draft`\n');
    expect(files['/repos/empty-repo/index.md']).toBe('# empty-repo\n');
    for (const key of Object.keys(files)) {
      if (key === '/index.md') continue;
      expect(files[key]?.startsWith('---')).toBe(false);
    }
  });

  it('root index declares okf_version and lists zones, repos and recent thoughts', () => {
    const files = renderIndexes(fixtures, brain);
    const root = files['/index.md'] as string;
    const fm = parseFrontmatter(root);
    expect(fm.frontmatter).toEqual({ okf_version: '0.2' });
    expect(root.startsWith('---\nokf_version: "0.2"\n---\n# acme-checkout\n\n## Zones\n')).toBe(true);
    expect(root).toContain('* [shared](/shared/index.md) - 1 thought\n');
    expect(root).toContain('## Repos\n* [empty-repo](/repos/empty-repo/index.md) - 0 thoughts\n* [payments-api](/repos/payments-api/index.md) - 6 thoughts\n');
    const recent = root.slice(root.indexOf('## Recently updated'));
    const lines = recent.split('\n').filter((l) => l.startsWith('* '));
    expect(lines).toHaveLength(8);
    expect(lines[0]).toContain('Alpha same day');
    expect(lines[1]).toContain('Refund endpoint v2');
    expect(lines[lines.length - 1]).toContain('Undated');
    expect(root.endsWith('\n')).toBe(true);
    expect(root.endsWith('\n\n')).toBe(false);
    expect(root).not.toContain('\r');
  });

  it('caps Recently updated at 20 entries', () => {
    const many: Thought[] = [];
    for (let i = 0; i < 25; i += 1) {
      const day = String(1 + (i % 28)).padStart(2, '0');
      many.push(thought('/shared/specs/2026-01-' + day + '-t' + i + '.md', { title: 'T' + i, status: 'stable', description: 'd' }));
    }
    const root = renderIndexes(many, brain)['/index.md'] as string;
    const recent = root.slice(root.indexOf('## Recently updated'));
    expect(recent.split('\n').filter((l) => l.startsWith('* '))).toHaveLength(20);
  });

  it('is deterministic and does not depend on input order', () => {
    const a = renderIndexes(fixtures, brain);
    const b = renderIndexes([...fixtures].reverse(), brain);
    const c = renderIndexes(fixtures, brain);
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).toBe(JSON.stringify(c));
  });
});

describe('appendLog', () => {
  const entries: LogEntry[] = [
    { change: 'added', path: '/repos/payments-api/specs/2026-09-08-refund-endpoint-v2.md', title: 'Refund endpoint v2', by: 'human:ishujeet' },
    { change: 'updated', path: '/shared/decisions/2026-09-01-idempotency-key-format.md', title: 'Idempotency key format', note: 'status draft → stable' },
    { change: 'updated', path: '/shared/decisions/x.md', title: 'No note' },
    { change: 'removed', path: '/repos/payments-api/plans/old.md', title: 'Old plan' },
  ];

  it('creates a section with the exact line formats', () => {
    expect(appendLog('# Log\n\n', '2026-09-08', entries)).toBe(
      [
        '# Log',
        '',
        '## 2026-09-08',
        '* **Added**: [Refund endpoint v2](/repos/payments-api/specs/2026-09-08-refund-endpoint-v2.md) by human:ishujeet',
        '* **Updated**: [Idempotency key format](/shared/decisions/2026-09-01-idempotency-key-format.md) — status draft → stable',
        '* **Updated**: [No note](/shared/decisions/x.md)',
        '* **Removed**: [Old plan](/repos/payments-api/plans/old.md)',
        '',
      ].join('\n'),
    );
  });

  it('keeps newest date first and never rewrites past dates', () => {
    const past = '# Log\n\n## 2026-09-01\n* **Added**: [Old](/shared/specs/old.md) by human:a\n';
    const later = appendLog(past, '2026-09-08', [entries[3] as LogEntry]);
    expect(later).toBe('# Log\n\n## 2026-09-08\n* **Removed**: [Old plan](/repos/payments-api/plans/old.md)\n\n## 2026-09-01\n* **Added**: [Old](/shared/specs/old.md) by human:a\n');
    // an older date is inserted below newer ones, and the newer section is byte-identical afterwards
    const older = appendLog(later, '2026-08-01', [entries[0] as LogEntry]);
    expect(older.indexOf('## 2026-09-08')).toBeLessThan(older.indexOf('## 2026-09-01'));
    expect(older.indexOf('## 2026-09-01')).toBeLessThan(older.indexOf('## 2026-08-01'));
    expect(older).toContain('## 2026-09-01\n* **Added**: [Old](/shared/specs/old.md) by human:a\n');
  });

  it('inserts into an existing section at the top and drops exact duplicates', () => {
    const first = appendLog('# Log\n\n', '2026-09-08', [entries[0] as LogEntry]);
    const second = appendLog(first, '2026-09-08', [entries[0] as LogEntry, entries[3] as LogEntry, entries[3] as LogEntry]);
    const lines = second.split('\n').filter((l) => l.startsWith('* '));
    expect(lines).toEqual([
      '* **Removed**: [Old plan](/repos/payments-api/plans/old.md)',
      '* **Added**: [Refund endpoint v2](/repos/payments-api/specs/2026-09-08-refund-endpoint-v2.md) by human:ishujeet',
    ]);
    expect(second.match(/## 2026-09-08/g)).toHaveLength(1);
  });

  it('adds a # Log header when missing and returns existing unchanged for no entries', () => {
    expect(appendLog('', '2026-09-08', [entries[3] as LogEntry])).toBe('# Log\n\n## 2026-09-08\n* **Removed**: [Old plan](/repos/payments-api/plans/old.md)\n');
    const existing = '# Log\n\n## 2026-09-01\n* x\n';
    expect(appendLog(existing, '2026-09-08', [])).toBe(existing);
  });
});

describe('regenerate', () => {
  it('writes indexes and log, reports changed files, and is byte-identical on re-run', async () => {
    const root = path.join(env.root, 'brain');
    await scaffoldBrain(root, { name: 'acme' });
    await writeFile(root, 'repos/svc/specs/2026-09-08-a.md', concept({ title: 'A', repo: 'svc', description: 'desc' }));
    await writeFile(root, 'repos/svc/specs/2026-09-08-b.md', concept({ title: 'B', repo: 'wrong' }));
    await writeFile(root, 'shared/decisions/2026-09-01-d.md', concept({ title: 'D', repo: 'shared', status: 'stable', description: 'x' }));
    await writeFile(root, 'shared/references/ignored.md', '# not a thought\n');
    const cfg: BrainConfig = { ...brain, repos: [{ id: 'svc' }] };
    const log = { date: '2026-09-08', entries: [{ change: 'added', path: '/repos/svc/specs/2026-09-08-a.md', title: 'A', by: 'human:me' } as LogEntry] };

    const first = await regenerate(root, cfg, { log });
    expect(first.thoughts.map((t) => t.location.path)).toEqual([
      '/repos/svc/specs/2026-09-08-a.md',
      '/repos/svc/specs/2026-09-08-b.md',
      '/shared/decisions/2026-09-01-d.md',
    ]);
    expect(first.changed.sort()).toEqual(['/index.md', '/log.md', '/repos/svc/index.md', '/shared/index.md']);
    expect(first.issues.map((i) => i.rule)).toEqual(['okf/repo-mismatch']);
    expect(await readFile(root, 'repos/svc/index.md')).toBe(first.files['/repos/svc/index.md']);
    expect(await readFile(root, 'log.md')).toContain('* **Added**: [A](/repos/svc/specs/2026-09-08-a.md) by human:me');
    expect(await readFile(root, 'index.md')).toContain('okf_version: "0.2"');

    const before = Object.fromEntries(
      await Promise.all(Object.keys(first.files).map(async (k) => [k, await readFile(root, k.slice(1))] as const)),
    );
    const second = await regenerate(root, cfg, { log });
    expect(second.changed).toEqual([]);
    expect(second.files).toEqual(first.files);
    for (const k of Object.keys(first.files)) expect(await readFile(root, k.slice(1))).toBe(before[k]);
  });

  it('dryRun reports changes without writing', async () => {
    const root = path.join(env.root, 'brain');
    await scaffoldBrain(root, { name: 'acme' });
    await writeFile(root, 'shared/specs/2026-09-08-a.md', concept({ title: 'A', repo: 'shared' }));
    const stat = await fs.promises.stat(path.join(root, 'shared', 'index.md'));
    const before = await readFile(root, 'shared/index.md');
    const res = await regenerate(root, { ...brain, repos: [] }, { dryRun: true });
    expect(res.changed).toContain('/shared/index.md');
    expect(await readFile(root, 'shared/index.md')).toBe(before);
    expect((await fs.promises.stat(path.join(root, 'shared', 'index.md'))).mtimeMs).toBe(stat.mtimeMs);
    expect(fs.existsSync(path.join(root, 'repos', 'svc', 'index.md'))).toBe(false);
  });
});
