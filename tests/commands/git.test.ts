import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { translateGitError } from '../../src/commands/common.js';
import * as git from '../../src/git.js';
import { ExitCode } from '../../src/types.js';
import { cleanupMachines, makeMachine, write } from './helpers.js';

let root: string;
beforeEach(async () => {
  root = (await makeMachine('git')).root;
});
afterEach(cleanupMachines);

describe('git wrapper', () => {
  it('init / status / add / commit / show / head', async () => {
    const dir = path.join(root, 'r');
    await git.init(dir);
    expect(await git.isGitAvailable()).toBe(true);
    expect(await git.isInsideWorkTree(dir)).toBe(true);
    expect(await git.isInsideWorkTree(root)).toBe(false);
    expect(await git.hasHead(dir)).toBe(false);
    expect(await git.remoteUrl(dir)).toBeUndefined();
    expect(await git.hasRemote(dir)).toBe(false);
    write(path.join(dir, 'a.md'), 'one\n');
    expect(await git.statusPorcelain(dir)).toEqual([{ path: 'a.md', code: '??' }]);
    await git.addAll(dir);
    expect(await git.statusPorcelain(dir)).toEqual([{ path: 'a.md', code: 'A ' }]);
    const sha = await git.commit(dir, 'first');
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(await git.headSha(dir)).toBe(sha);
    expect(await git.hasHead(dir)).toBe(true);
    expect(await git.topLevel(path.join(dir))).toBe(fs.realpathSync(dir));
    expect(await git.showAtHead(dir, '/a.md')).toBe('one\n');
    expect(await git.showAtHead(dir, 'missing.md')).toBeUndefined();
    write(path.join(dir, 'a.md'), 'two\n');
    fs.unlinkSync(path.join(dir, 'a.md'));
    write(path.join(dir, 'b.md'), 'b\n');
    const st = await git.statusPorcelain(dir);
    expect(st).toEqual(expect.arrayContaining([{ path: 'a.md', code: ' D' }, { path: 'b.md', code: '??' }]));
    expect(await git.conflictedFiles(dir)).toEqual([]);
    expect(await git.isRebaseInProgress(dir)).toBe(false);
    expect(typeof (await git.currentBranch(dir))).toBe('string');
    expect(await git.userEmail(dir)).toBeUndefined();
    await git.git(['config', 'user.email', 'qa@example.com'], { cwd: dir });
    expect(await git.userEmail(dir)).toBe('qa@example.com');
    const hooks = await git.hooksDir(dir);
    expect(hooks).toBe(path.join(fs.realpathSync(dir), '.git', 'hooks'));
  });

  it('throws GitError with args, stderr and exit code; commands translate it', async () => {
    const dir = path.join(root, 'r');
    await git.init(dir);
    let err: unknown;
    try {
      await git.git(['rev-parse', 'HEAD'], { cwd: dir });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(git.GitError);
    const ge = err as git.GitError;
    expect(ge.args).toEqual(['rev-parse', 'HEAD']);
    expect(ge.exitCode).not.toBe(0);
    expect(ge.stderr.length).toBeGreaterThan(0);
    expect(translateGitError(ge, 'other').exitCode).toBe(ExitCode.Validation);

    let cloneErr: unknown;
    try {
      await git.clone(path.join(root, 'nope', 'x.git'), path.join(root, 'dest'));
    } catch (e) {
      cloneErr = e;
    }
    expect(git.looksLikeRemoteFailure(cloneErr)).toBe(true);
    const t = translateGitError(cloneErr, 'clone', 'x.git');
    expect(t.exitCode).toBe(ExitCode.RemoteUnreachable);
    expect(t.message).toMatch(/^brain unreachable/);
  });

  it('bare repos, diffNameStatus and rename handling', async () => {
    const dir = path.join(root, 'r');
    await git.init(dir);
    write(path.join(dir, 'a.md'), 'a\n');
    await git.addAll(dir);
    const first = await git.commit(dir, 'first');
    fs.renameSync(path.join(dir, 'a.md'), path.join(dir, 'b.md'));
    write(path.join(dir, 'c.md'), 'c\n');
    await git.addAll(dir);
    const second = await git.commit(dir, 'second');
    const diff = await git.diffNameStatus(dir, first, second);
    expect(diff).toEqual(expect.arrayContaining([{ path: 'b.md', code: 'R' }, { path: 'c.md', code: 'A' }]));
    const bare = path.join(root, 'b.git');
    await git.init(bare, { bare: true });
    expect(await git.isBareRepo(bare)).toBe(true);
    expect(await git.isBareRepo(dir)).toBe(false);
  });
});
