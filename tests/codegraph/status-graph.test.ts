/**
 * The Codegraph section of `thoughts status` (specs/04 "Codegraph", specs/17
 * "Status integration"): counts, staleness from git only, --no-graph, --json.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runInit } from '../../src/commands/init.js';
import { runStatus } from '../../src/commands/status.js';
import { makeBareBrain, makeCodeRepo, makeMachine, capture, cleanupMachines, commitAll, type Captured } from '../commands/helpers.js';

let cap: Captured;
beforeEach(async () => {
  cap = capture();
});
afterEach(async () => {
  cap.restore();
  await cleanupMachines();
});

interface Rig {
  repo: string;
  brain: string;
}

/** One machine, one repo attached to a bare brain; the graph is built at init. */
async function rig(label: string): Promise<Rig> {
  const host = await makeMachine(label + '-host');
  const bare = await makeBareBrain(host.root);
  const machine = await makeMachine(label);
  const repo = await makeCodeRepo(path.join(machine.root, 'payments-api'));
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src/index.ts'), "export function main(): number { return 1; }\n");
  await commitAll(repo, 'code');
  const r = await runInit({ yes: true, brain: bare }, repo);
  cap.stdout.length = 0;
  cap.stderr.length = 0;
  return { repo, brain: r.brainRoot };
}

describe('status: codegraph section', () => {
  it('a fresh graph shows counts and fresh', async () => {
    const { repo } = await rig('cg-fresh');
    const res = await runStatus({}, repo);
    expect(res.graph).toHaveLength(1);
    expect(res.graph[0]).toMatchObject({ repo_id: 'payments-api', fresh: true, staleness: 'fresh', deps: [] });
    // src/index.ts is one of the graph's files; the kit's markdown files are file nodes too.
    expect(res.graph[0]?.files).toBeGreaterThanOrEqual(2);
    expect(res.graph[0]?.symbols).toBe(1);
    expect(res.graph[0]?.codeCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(cap.stdout.join('')).toContain('codegraph');
    expect(cap.stdout.join('')).toContain('symbols · ');
    expect(cap.stdout.join('')).toMatch(/fresh/);
    expect(cap.stdout.join('')).toContain('fresh');
  });

  it('a repo whose HEAD moved shows stale — n commits ahead', async () => {
    const { repo } = await rig('cg-stale');
    fs.writeFileSync(path.join(repo, 'src/extra.ts'), 'export const x = 1;\n');
    await commitAll(repo, 'more code');
    const res = await runStatus({}, repo);
    expect(res.graph[0]).toMatchObject({ staleness: 'stale', fresh: false, code_ahead: 1 });
    expect(cap.stdout.join('')).toContain('stale — 1 commit ahead');
  });

  it('--no-graph skips the section', async () => {
    const { repo } = await rig('cg-nograph');
    await runStatus({ graph: false }, repo);
    expect(cap.stdout.join('')).not.toContain('codegraph');
  });

  it('--json carries the graph array with the specs/04 fields', async () => {
    const { repo } = await rig('cg-json');
    const res = await runStatus({ json: true }, repo);
    expect(cap.stdout.join('').trim().startsWith('{')).toBe(true);
    expect(res.graph[0]).toMatchObject({ repo_id: 'payments-api', fresh: true });
    expect(Object.keys(res.graph[0] ?? {}).sort()).toEqual(['codeCommit', 'code_ahead', 'deps', 'edges', 'files', 'fresh', 'repo_id', 'staleness', 'symbols']);
  });

  it('a repo whose graph was never built shows absent', async () => {
    const host = await makeMachine('cg-absent-host');
    const bare = await makeBareBrain(host.root);
    const machine = await makeMachine('cg-absent');
    const repo = await makeCodeRepo(path.join(machine.root, 'payments-api'));
    await runInit({ yes: true, brain: bare }, repo);
    // No graph: the store never received one (e.g. grammars unavailable).
    const graphPath = path.join(machine.root, 'payments-api', 'thoughts', 'repos', 'payments-api', 'codegraph');
    fs.rmSync(graphPath, { recursive: true, force: true });
    await commitAll(path.join(machine.root, 'payments-api', 'thoughts'), 'remove graph');
    const res = await runStatus({}, repo);
    expect(res.graph[0]).toMatchObject({ repo_id: 'payments-api', staleness: 'absent', fresh: false, files: 0 });
    // The section renders even when every row is absent (specs/04 acceptance).
    expect(cap.stdout.join('')).toContain('codegraph');
    expect(cap.stdout.join('')).toMatch(/payments-api\s+absent/);
  });
});
