/**
 * Optional smoke test against a REAL PostgreSQL server (specs/16 "Testing
 * constraint" makes this never required). It runs only when a connection
 * string is provided, and skips otherwise:
 *
 *   THOUGHTS_PG_SMOKE='postgres://thoughts:pw@localhost:5432/thoughts_smoke' npm test
 *
 * The database must already exist (the docker snippet of `init` creates it).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PgBackend } from '../../../src/brain/backends/pg.js';

const connection = process.env['THOUGHTS_PG_SMOKE'];

const DOC = [
  '---',
  'type: Spec',
  'title: Smoke refund endpoint',
  'status: draft',
  'repo: payments-api',
  'generated:',
  '  by: human:qa',
  '  at: 2026-09-10T00:00:00.000Z',
  '---',
  '# Smoke refund endpoint',
  '',
  'Idempotent refunds, for real.',
  '',
].join('\n');

describe.skipIf(connection === undefined)('pg backend against a real server (opt-in)', () => {
  it('provisions, round-trips a thought and serves it from the store', { timeout: 60_000 }, async () => {
    const workspace = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'thoughts-pg-smoke-'));
    const brainId = `smoke-${path.basename(workspace).replace(/[^a-z0-9]/gi, '')}`;
    const backend = new PgBackend({ brainId, workspace, connectionRef: 'env:THOUGHTS_PG_SMOKE' });
    try {
      const health = await backend.health();
      if (!health.ok) throw new Error(health.detail);
      expect(health.ok).toBe(true);

      const provisioned = await backend.provision();
      expect(provisioned.applied).toBe(true);
      await backend.provision(); // idempotent

      await backend.write('repos/payments-api/specs/2026-09-10-smoke.md', DOC);
      const rev = await backend.commit('thoughts(payments-api): smoke');
      expect(rev).toBeDefined();
      expect(await backend.read('repos/payments-api/specs/2026-09-10-smoke.md')).toBe(DOC);

      const rows = await backend.searchThoughts({ text: 'idempotent refunds' });
      expect(rows.map((r) => r.path)).toContain('repos/payments-api/specs/2026-09-10-smoke.md');
      const byRepo = await backend.searchThoughts({ repoId: 'payments-api', kind: 'specs' });
      expect(byRepo.length).toBeGreaterThan(0);

      const peer = new PgBackend({ brainId, workspace: workspace + '-peer', connectionRef: 'env:THOUGHTS_PG_SMOKE' });
      const changes = await peer.pull('0');
      expect(changes).toContainEqual({ path: 'repos/payments-api/specs/2026-09-10-smoke.md', change: 'added' });
      expect(await peer.read('repos/payments-api/specs/2026-09-10-smoke.md')).toBe(DOC);
    } finally {
      await fs.promises.rm(workspace, { recursive: true, force: true });
      await fs.promises.rm(workspace + '-peer', { recursive: true, force: true });
    }
  });
});
