import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudeCode, classifyKitFile } from '../../src/adapters/claude-code.js';
import { detectAdapters, getAdapter, KNOWN_TOOLS } from '../../src/adapters/index.js';
import { compareVersions, KIT_COMMAND_NAMES, kitFileVersion, renderInstructions, renderKitFile } from '../../src/adapters/kit.js';
import { readAsset } from '../../src/assets.js';
import { cleanupMachines, makeMachine, read, write } from '../commands/helpers.js';

const vars = { brain_name: 'acme', repo_id: 'payments-api', kit_version: '0.1.0' };
let repo: string;
beforeEach(async () => {
  repo = path.join((await makeMachine('kit')).root, 'repo');
  fs.mkdirSync(repo, { recursive: true });
});
afterEach(cleanupMachines);

describe('kit assets', () => {
  it('instructions.md renders the specs/08 block with brain name and repo id', () => {
    const block = renderInstructions(undefined, vars);
    expect(block.split('\n')[0]).toBe('<!-- thoughts-kit v0.1.0 -->');
    expect(block).toContain('## Project brain (thoughts)');
    expect(block).toContain('This repo is part of the **acme** project.');
    expect(block).toContain('This repo owns `thoughts/repos/payments-api/`.');
    expect(block).toContain('**Never write secrets into `thoughts/`.**');
    expect(block).toContain('`/thoughts-plan`, `/thoughts-spec`, `/thoughts-research`, `/thoughts-decide`, `/thoughts-commit`, `/thoughts-pr`, `/thoughts-status`');
    expect(block).not.toContain('{{');
  });

  it('ships one command file per kit command, each with the version comment', () => {
    expect(KIT_COMMAND_NAMES).toEqual(['thoughts-plan', 'thoughts-spec', 'thoughts-research', 'thoughts-decide', 'thoughts-commit', 'thoughts-pr', 'thoughts-status', 'thoughts-sync']);
    for (const name of KIT_COMMAND_NAMES) {
      const raw = readAsset('kit', 'commands', name + '.md');
      expect(raw.startsWith('<!-- thoughts-kit v{{kit_version}} -->')).toBe(true);
      const rendered = renderKitFile(undefined, vars, 'commands', name + '.md');
      expect(kitFileVersion(rendered)).toBe('0.1.0');
      expect(rendered).toContain('thoughts init');
    }
  });

  it('prefers <brain>/standard/ overrides', () => {
    const brainRoot = path.join(repo, '..', 'brain');
    write(path.join(brainRoot, 'standard', 'instructions.md'), '<!-- thoughts-kit v{{kit_version}} -->\n## Org block {{repo_id}}\n');
    expect(renderInstructions(brainRoot, vars)).toBe('<!-- thoughts-kit v0.1.0 -->\n## Org block payments-api');
  });

  it('compares versions numerically', () => {
    expect(compareVersions('0.1.0', '0.1.0')).toBe(0);
    expect(compareVersions('0.0.9', '0.1.0')).toBe(-1);
    expect(compareVersions('1.0.0', '0.9.9')).toBe(1);
    expect(classifyKitFile(undefined, 'x', '0.1.0')).toBe('missing');
    expect(classifyKitFile('no comment\n', 'x', '0.1.0')).toBe('modified locally');
    expect(classifyKitFile('<!-- thoughts-kit v0.0.1 -->\nold\n', '<!-- thoughts-kit v0.1.0 -->\nnew\n', '0.1.0')).toBe('outdated');
    expect(classifyKitFile('<!-- thoughts-kit v0.1.0 -->\nedited\n', '<!-- thoughts-kit v0.1.0 -->\nnew\n', '0.1.0')).toBe('modified locally');
  });
});

describe('claude-code adapter', () => {
  it('is registered and detects CLAUDE.md or .claude/', () => {
    expect(getAdapter('claude-code')).toBe(claudeCode);
    expect(KNOWN_TOOLS).toContain('codex');
    expect(getAdapter('codex')).toBeUndefined();
    expect(claudeCode.name()).toBe('claude-code');
    expect(claudeCode.instructionFile(repo)).toBe(path.join(repo, 'CLAUDE.md'));
    expect(detectAdapters(repo)).toEqual([]);
    write(path.join(repo, '.claude', 'settings.json'), '{}');
    expect(detectAdapters(repo)).toEqual(['claude-code']);
  });

  it('installs commands under .claude/commands, is re-runnable, never overwrites user files', async () => {
    const first = await claudeCode.installCommands(repo, { kitVersion: '0.1.0', vars });
    expect(first.map((r) => r.state)).toEqual(Array(8).fill('created'));
    expect(first[0]!.file).toBe(path.join('.claude', 'commands', 'thoughts-plan.md'));
    for (const r of first) expect(kitFileVersion(read(path.join(repo, r.file)))).toBe('0.1.0');

    const second = await claudeCode.installCommands(repo, { kitVersion: '0.1.0', vars });
    expect(second.map((r) => r.state)).toEqual(Array(8).fill('up-to-date'));

    // A user file without the kit comment is left alone.
    const userFile = path.join(repo, '.claude', 'commands', 'thoughts-plan.md');
    write(userFile, '# my own plan command\n');
    const third = await claudeCode.installCommands(repo, { kitVersion: '0.1.0', vars });
    expect(third[0]).toMatchObject({ state: 'modified locally' });
    expect(read(userFile)).toBe('# my own plan command\n');

    // An older kit copy is reported outdated, updated only with force.
    const old = path.join(repo, '.claude', 'commands', 'thoughts-sync.md');
    write(old, '<!-- thoughts-kit v0.0.1 -->\nold\n');
    const fourth = await claudeCode.installCommands(repo, { kitVersion: '0.1.0', vars });
    expect(fourth.find((r) => r.file.endsWith('thoughts-sync.md'))).toMatchObject({ state: 'outdated' });
    expect(read(old)).toBe('<!-- thoughts-kit v0.0.1 -->\nold\n');
    const forced = await claudeCode.installCommands(repo, { kitVersion: '0.1.0', vars, force: true });
    expect(forced.find((r) => r.file.endsWith('thoughts-sync.md'))).toMatchObject({ state: 'updated' });
    expect(forced[0]).toMatchObject({ state: 'updated', detail: 'was modified locally' });
    expect(kitFileVersion(read(old))).toBe('0.1.0');
  });

  it('dryRun reports without writing; skills and agents are stubs', async () => {
    const r = await claudeCode.installCommands(repo, { kitVersion: '0.1.0', vars, dryRun: true });
    expect(r.map((x) => x.state)).toEqual(Array(8).fill('created'));
    expect(fs.existsSync(path.join(repo, '.claude'))).toBe(false);
    expect((await claudeCode.installSkills(repo, { kitVersion: '0.1.0', vars }))[0]).toMatchObject({ state: 'skipped' });
    expect((await claudeCode.installAgents(repo, { kitVersion: '0.1.0', vars }))[0]).toMatchObject({ state: 'skipped' });
    const v = await claudeCode.verify(repo, { kitVersion: '0.1.0', vars });
    expect(v.map((x) => x.state)).toEqual(Array(8).fill('missing'));
  });
});
