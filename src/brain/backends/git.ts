/**
 * The git backend (specs/16): the workspace is the store clone, the transport
 * is `git pull --rebase` / `git push`. Wraps src/git.ts — no other module may
 * drive the brain store through git directly.
 */
import path from 'node:path';
import { regenerate } from '../generate.js';
import * as git from '../../git.js';
import { GENERATED_FILENAMES } from '../../types.js';
import { deleteWorkspaceFile, graphMetaRelPath, graphRelPath, listWorkspaceThoughts, readWorkspaceFile, writeWorkspaceFile } from './workspace.js';
import {
  conflictError,
  type BackendHealth,
  type BrainBackend,
  type ConflictContext,
  type ConflictInfo,
  type PushInput,
  type PushResult,
  type StoreChange,
  type WorkspaceChange,
} from './types.js';

/** Generated files never need a human in a conflict (specs/03). */
function isGeneratedFile(relPath: string): boolean {
  return GENERATED_FILENAMES.includes(path.posix.basename(relPath));
}

export class GitBackend implements BrainBackend {
  readonly kind = 'git' as const;
  readonly brainId: string;
  readonly workspace: string;

  constructor(opts: { brainId: string; workspace: string }) {
    this.brainId = opts.brainId;
    this.workspace = opts.workspace;
  }

  async health(): Promise<BackendHealth> {
    if (!(await git.isInsideWorkTree(this.workspace))) {
      return { ok: false, detail: this.workspace + ' is not a git work tree' };
    }
    // The URL itself is never echoed (SEC-F6); presence is enough here.
    const hasRemote = await git.hasRemote(this.workspace);
    return { ok: true, detail: hasRemote ? 'remote configured' : 'no remote; local-only brain' };
  }

  listThoughts(): Promise<string[]> {
    return listWorkspaceThoughts(this.workspace);
  }

  async read(relPath: string, opts: { revision?: string } = {}): Promise<string | undefined> {
    if (opts.revision !== undefined) {
      try {
        const r = await git.git(['show', `${opts.revision}:${relPath.replace(/^\//, '')}`], { cwd: this.workspace });
        return r.stdout;
      } catch {
        return undefined;
      }
    }
    return readWorkspaceFile(this.workspace, relPath);
  }

  async write(relPath: string, doc: string): Promise<void> {
    await writeWorkspaceFile(this.workspace, relPath, doc);
  }

  async delete(relPath: string): Promise<void> {
    // `git rm` also stages the deletion; fall back to a plain unlink for
    // paths git does not track yet.
    try {
      await git.git(['rm', '--quiet', '--force', '--', relPath], { cwd: this.workspace });
      return;
    } catch {
      await deleteWorkspaceFile(this.workspace, relPath);
    }
  }

  async dirty(): Promise<WorkspaceChange[]> {
    const status = await git.statusPorcelain(this.workspace);
    return status
      .filter((e) => !e.path.startsWith('.git/'))
      .map((e) => ({ path: e.path, code: e.code, deleted: e.code[0] === 'D' || e.code[1] === 'D' }));
  }

  async revision(): Promise<string | undefined> {
    return (await git.hasHead(this.workspace)) ? await git.headSha(this.workspace) : undefined;
  }

  upstreamRevision(): Promise<string | undefined> {
    return git.upstreamSha(this.workspace);
  }

  remoteUrl(): Promise<string | undefined> {
    return git.remoteUrl(this.workspace);
  }

  async diff(from: string, to?: string): Promise<WorkspaceChange[]> {
    const entries = await git.diffNameStatus(this.workspace, from, to ?? 'HEAD');
    return entries.map((e) => ({ path: e.path, code: e.code, deleted: e.code[0] === 'D' }));
  }

  async commit(message: string): Promise<string | undefined> {
    await git.addAll(this.workspace);
    if ((await git.statusPorcelain(this.workspace)).length === 0) return undefined;
    return git.commit(this.workspace, message);
  }

  /**
   * The transport step. The commit itself already carries the paths, message
   * and log entries (specs/03 format), so they are not repeated here.
   */
  async push(_input: PushInput): Promise<PushResult> {
    await git.push(this.workspace);
    return { pushed: true, revision: await git.headSha(this.workspace) };
  }

  async pull(lastRev?: string, ctx?: ConflictContext): Promise<StoreChange[]> {
    const before = lastRev ?? (await git.upstreamSha(this.workspace));
    try {
      await git.pullRebase(this.workspace);
    } catch (err) {
      const info = await this.conflictInfo();
      if (info.conflicted.length === 0 && !info.inProgress) throw err;
      // specs/16: generated files settle on their own; concept files do not.
      const remaining = ctx ? await this.resolveConflicts(ctx) : info.conflicted;
      if (remaining.length > 0) throw conflictError(remaining);
    }
    const after = await git.upstreamSha(this.workspace);
    if (before === undefined || after === undefined || before === after) return [];
    const entries = await git.diffNameStatus(this.workspace, before, after);
    return entries.map((e) => ({
      path: e.path,
      change: e.code[0] === 'D' ? ('removed' as const) : e.code[0] === 'A' ? ('added' as const) : ('updated' as const),
    }));
  }

  async conflictInfo(): Promise<ConflictInfo> {
    return {
      conflicted: await git.conflictedFiles(this.workspace),
      inProgress: await git.isRebaseInProgress(this.workspace),
    };
  }

  /**
   * Resolve rebase conflicts that touch only generated files by taking the
   * upstream side and regenerating (re-appending this run's log entries).
   * Returns the conflicted concept files when a human must resolve them.
   */
  async resolveConflicts(ctx: ConflictContext): Promise<string[]> {
    const { workspace } = this;
    const brain = ctx.brain;
    const log = ctx.log;
    for (let guard = 0; guard < 50; guard += 1) {
      const conflicted = await git.conflictedFiles(workspace);
      if (conflicted.length === 0) {
        if (!(await git.isRebaseInProgress(workspace))) return [];
        // Resolved but not continued (or an empty step): continue the rebase;
        // a replayed commit that became empty is skipped.
        try {
          await git.git(['-c', 'core.editor=true', 'rebase', '--continue'], { cwd: workspace });
        } catch {
          try {
            await git.git(['rebase', '--skip'], { cwd: workspace });
          } catch {
            return await git.conflictedFiles(workspace);
          }
        }
        continue;
      }
      const concept = conflicted.filter((p) => !isGeneratedFile(p));
      if (concept.length > 0) {
        // Generated files never need a human (specs/03): settle them on the
        // upstream side so `git rebase --continue` only waits for the concept
        // files. The next `sync` regenerates them from the resolved content.
        for (const p of conflicted) {
          if (isGeneratedFile(p)) {
            try {
              await git.git(['checkout', '--ours', '--', p], { cwd: workspace });
              await git.git(['add', '--', p], { cwd: workspace });
            } catch {
              // leave it to the user
            }
          }
        }
        return concept;
      }
      // `ours` during a rebase is the upstream side; regenerate re-adds our entries.
      for (const p of conflicted) {
        try {
          await git.git(['checkout', '--ours', '--', p], { cwd: workspace });
        } catch {
          // deleted on one side: fall back to whatever is in the tree
        }
      }
      await regenerate(workspace, brain, { log });
      await git.addAll(workspace);
      try {
        await git.git(['-c', 'core.editor=true', 'rebase', '--continue'], { cwd: workspace });
      } catch {
        // a further conflict in the next replayed commit; loop
      }
    }
    return await git.conflictedFiles(workspace);
  }

  async revisionsSince(since: string): Promise<string[]> {
    // '' (or the seed '0') means the whole history: `scan --history` walks
    // every commit, not just those past a revision the caller names.
    if (since.trim() === '' || since.trim() === '0') {
      const r = await git.git(['rev-list', 'HEAD'], { cwd: this.workspace });
      return r.stdout.split('\n').filter((l) => l.length > 0);
    }
    return git.revList(this.workspace, since);
  }

  async behindCount(): Promise<number | undefined> {
    const upstream = await git.upstreamSha(this.workspace);
    if (upstream === undefined) return undefined;
    return (await git.revList(this.workspace, 'HEAD', upstream)).length;
  }

  async modifiedAt(relPath: string): Promise<Date | undefined> {
    // git backend: the last store revision that touched the file, not the
    // workspace mtime (a pull updates the file without new information).
    try {
      const r = await git.git(['log', '-1', '--format=%cI', '--', relPath.replace(/^\//, '')], { cwd: this.workspace });
      const line = r.stdout.trim().split('\n').filter((l) => l.length > 0).pop();
      return line ? new Date(line) : undefined;
    } catch {
      return undefined;
    }
  }

  async messageOf(revision: string): Promise<string> {
    return git.messageOf(this.workspace, revision);
  }

  async saveGraph(repoId: string, doc: string): Promise<void> {
    await writeWorkspaceFile(this.workspace, graphRelPath(repoId), doc);
  }

  async loadGraph(repoId: string): Promise<string | undefined> {
    return readWorkspaceFile(this.workspace, graphRelPath(repoId));
  }

  async saveGraphMeta(repoId: string, doc: string): Promise<void> {
    await writeWorkspaceFile(this.workspace, graphMetaRelPath(repoId), doc);
  }

  async loadGraphMeta(repoId: string): Promise<string | undefined> {
    return readWorkspaceFile(this.workspace, graphMetaRelPath(repoId));
  }
}
