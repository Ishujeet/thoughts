/**
 * Workspace file operations shared by every file-backed backend (specs/16
 * "Workspace vs store"): the working set is an ordinary directory of OKF
 * markdown for all kinds, so read/write/list are backend-independent.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Paths a backend never reports or touches. */
function isInternal(rel: string): boolean {
  return rel.startsWith('.git/') || rel === '.git' || rel.includes('/.git/') || rel.split('/').includes('codegraph');
}

/** Walk the workspace for `.md` files, workspace-relative, sorted. */
export async function listWorkspaceThoughts(workspace: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return; // missing zone directories are normal in a fresh workspace
    }
    for (const e of entries) {
      const rel = path.relative(workspace, path.join(dir, e.name)).split(path.sep).join('/');
      if (isInternal(rel)) continue;
      if (e.isDirectory()) await walk(path.join(dir, e.name));
      else if (e.isFile() && e.name.endsWith('.md')) found.push(rel);
    }
  };
  await walk(workspace);
  return found.sort();
}

export async function readWorkspaceFile(workspace: string, rel: string): Promise<string | undefined> {
  try {
    return await fs.promises.readFile(path.join(workspace, rel), 'utf8');
  } catch {
    return undefined;
  }
}

export async function writeWorkspaceFile(workspace: string, rel: string, doc: string): Promise<void> {
  const abs = path.join(workspace, rel);
  await fs.promises.mkdir(path.dirname(abs), { recursive: true });
  await fs.promises.writeFile(abs, doc, 'utf8');
}

export async function deleteWorkspaceFile(workspace: string, rel: string): Promise<void> {
  await fs.promises.rm(path.join(workspace, rel), { force: true });
}

/** specs/17 "Storage": the generated graph document of one repo. */
export function graphRelPath(repoId: string): string {
  return path.posix.join('repos', repoId, 'codegraph', 'graph.json');
}

/** specs/17 "Storage": the graph metadata (generated-at, counts, codeCommit). */
export function graphMetaRelPath(repoId: string): string {
  return path.posix.join('repos', repoId, 'codegraph', 'meta.yml');
}

/** specs/17 "Storage": the generated human-readable index of one repo. */
export function graphIndexRelPath(repoId: string): string {
  return path.posix.join('repos', repoId, 'codegraph', 'index.md');
}
