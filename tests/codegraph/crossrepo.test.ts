/**
 * Cross-repo edges end to end (specs/17 "Cross-repo edges"): repo A imports
 * `@acme/payments-api`, which is `package:` of repo B → after a sync the
 * `imports_repo` edge exists in A's stored graph and `status` shows it;
 * removing the `package:` field removes the edge on the next sync.
 */
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { crossRepoEdges, deserialize } from '../../src/codegraph/graph.js';
import { resolveBackend } from '../../src/brain/backends/resolve.js';
import { runInit } from '../../src/commands/init.js';
import { runStatus } from '../../src/commands/status.js';
import { runSync } from '../../src/commands/sync.js';
import * as git from '../../src/git.js';
import { makeBareBrain, makeCodeRepo, makeMachine, capture, cleanupMachines, commitAll, type Captured } from '../commands/helpers.js';

let cap: Captured;
beforeEach(async () => {
  cap = capture();
});
afterEach(async () => {
  cap.restore();
  await cleanupMachines();
});

const IMPORTER = [
  "import { Client } from '@acme/payments-api';",
  'export function place(): string {',
  '  return Client.call();',
  '}',
].join('\n');

/** Two repos on one brain: orders-service imports the package of payments-api. */
async function twoRepos(): Promise<{ orders: string; payments: string; brain: string; useOrders: () => void }> {
  const host = await makeMachine('xr-host');
  const bare = await makeBareBrain(host.root);
  const a = await makeMachine('orders');
  const orders = await makeCodeRepo(path.join(a.root, 'orders-service'));
  fs.mkdirSync(path.join(orders, 'src'), { recursive: true });
  fs.writeFileSync(path.join(orders, 'src/index.ts'), IMPORTER);
  await commitAll(orders, 'code');
  await runInit({ yes: true, brain: bare }, orders);

  const b = await makeMachine('payments');
  const payments = await makeCodeRepo(path.join(b.root, 'payments-api'));
  fs.mkdirSync(path.join(payments, 'src'), { recursive: true });
  fs.writeFileSync(path.join(payments, 'src/client.ts'), 'export class Client { static call(): string { return ""; } }\n');
  await commitAll(payments, 'code');
  const rPayments = await runInit({ yes: true, brain: bare }, payments);

  // Declare the packages in brain.yml (hand-edited, as a user would), pushed
  // from the payments clone, whose tip is the store's tip after its init.
  const brain = rPayments.brainRoot;
  await declarePackages(brain, { 'orders-service': '@acme/orders-service', 'payments-api': '@acme/payments-api' });
  // Payments syncs once more so its graph carries its own (now named) module.
  const s = await runSync({}, payments);
  expect(s.pushed).toBe(true);
  return { orders, payments: path.join(b.root, 'payments-api'), brain, useOrders: () => a.use() };
}

/** Hand-edit `brain.yml` in the clone: set (or drop) `package:` per repo. */
async function declarePackages(brain: string, packages: Record<string, string | undefined>): Promise<void> {
  const yml = path.join(brain, 'brain.yml');
  const doc = YAML.parseDocument(fs.readFileSync(yml, 'utf8'));
  for (const [repoId, pkg] of Object.entries(packages)) {
    for (const repo of (doc.get('repos') as YAML.YAMLSeq | undefined)?.items ?? []) {
      if (!YAML.isMap(repo) || repo.get('id') !== repoId) continue;
      if (pkg === undefined) repo.delete('package');
      else repo.set('package', pkg);
    }
  }
  fs.writeFileSync(yml, doc.toString({ lineWidth: 0 }));
  await commitAll(brain, 'declare packages');
  await git.git(['push', '--quiet', 'origin', 'HEAD'], { cwd: brain });
}

async function graphOf(brain: string, repoId: string) {
  const backend = await resolveBackend({ brainId: path.basename(brain), workspace: brain, brain: undefined, brainRef: undefined });
  const doc = await backend.loadGraph(repoId);
  return doc !== undefined ? deserialize(doc) : undefined;
}

describe('cross-repo edges', () => {
  it('an imports_repo edge appears once both graphs and the package names are in the brain', async () => {
    const { orders, brain, useOrders } = await twoRepos();
    useOrders();
    // Sync orders again: payments' graph is now in the store.
    const s = await runSync({}, orders);
    expect(s.pushed).toBe(true);

    const g = await graphOf(path.join(orders, 'thoughts'), 'orders-service');
    expect(g).toBeDefined();
    const importsRepo = g!.edges.filter((e) => e.type === 'imports_repo');
    expect(importsRepo).toHaveLength(1);
    const paymentsGraph = await graphOf(brain, 'payments-api');
    expect(importsRepo[0]?.target).toBe(paymentsGraph!.nodes.find((n) => n.kind === 'module' && n.name === '@acme/payments-api')!.id);
    expect(paymentsGraph!.nodes.some((n) => n.kind === 'module' && n.manifest !== undefined)).toBe(true);
  });

  it('status lists the cross-repo deps of the current repo', async () => {
    const { orders, useOrders } = await twoRepos();
    useOrders();
    await runSync({}, orders);
    cap.stdout.length = 0;
    cap.stderr.length = 0;
    const res = await runStatus({}, orders);
    expect(res.graph.find((g) => g.repo_id === 'orders-service')?.deps).toEqual(['payments-api']);
    expect(cap.stdout.join('')).toContain('cross-repo deps into orders-service: payments-api');
  });

  it('removing the package field makes the edge disappear on the next sync, without an error', async () => {
    const { orders, brain, useOrders } = await twoRepos();
    useOrders();
    await runSync({}, orders);
    await git.git(['pull', '--rebase', '--quiet', 'origin'], { cwd: brain });
    await declarePackages(brain, { 'payments-api': undefined });

    const s = await runSync({}, orders);
    expect(s.pushed).toBe(true);
    const g = await graphOf(path.join(orders, 'thoughts'), 'orders-service');
    expect(g!.edges.filter((e) => e.type === 'imports_repo')).toHaveLength(0);
    // ...and the pure matcher agrees (fail soft: no name, no edge, no warning).
    const payments = await graphOf(brain, 'payments-api');
    expect([...crossRepoEdges([g!, payments!], {}).get('orders-service') ?? []]).toEqual([]);
  });

  it('a sibling manifest name alone matches, with no package: field (specs/17)', async () => {
    const host = await makeMachine('xr-manifest-host');
    const bare = await makeBareBrain(host.root);
    // Importer first, so its graph is stored before the sibling exists.
    const a = await makeMachine('xr-manifest-orders');
    const orders = await makeCodeRepo(path.join(a.root, 'orders-service'));
    fs.mkdirSync(path.join(orders, 'src'), { recursive: true });
    fs.writeFileSync(path.join(orders, 'src/index.ts'), IMPORTER);
    await commitAll(orders, 'code');
    await runInit({ yes: true, brain: bare }, orders);

    // The sibling names itself only in its manifest — no `package:` in brain.yml.
    const b = await makeMachine('xr-manifest-payments');
    const payments = await makeCodeRepo(path.join(b.root, 'payments-api'));
    fs.writeFileSync(path.join(payments, 'package.json'), JSON.stringify({ name: '@acme/payments-api', version: '1.0.0' }, null, 2) + '\n');
    fs.mkdirSync(path.join(payments, 'src'), { recursive: true });
    fs.writeFileSync(path.join(payments, 'src/client.ts'), 'export class Client { static call(): string { return ""; } }\n');
    await commitAll(payments, 'code');
    const rPayments = await runInit({ yes: true, brain: bare }, payments);

    // The payments clone pushed its graph (and its manifest-named module); one
    // more sync on orders picks it up and makes the edge.
    b.use();
    const paymentsGraph = await graphOf(rPayments.brainRoot, 'payments-api');
    expect(paymentsGraph!.nodes.some((n) => n.kind === 'module' && n.name === '@acme/payments-api' && n.manifest === 'package.json')).toBe(true);

    a.use();
    const s = await runSync({}, orders);
    expect(s.pushed).toBe(true);
    const g = await graphOf(path.join(orders, 'thoughts'), 'orders-service');
    const importsRepo = g!.edges.filter((e) => e.type === 'imports_repo');
    expect(importsRepo).toHaveLength(1);
    expect(importsRepo[0]?.target).toBe(paymentsGraph!.nodes.find((n) => n.kind === 'module' && n.name === '@acme/payments-api')!.id);
  });
});
