/**
 * Directory walkers for a brain (specs/01, 09).
 */
import fs from 'node:fs';
import path from 'node:path';
import { GENERATED_FILENAMES, ZONES, type Thought } from '../types.js';
import { parseThought } from './okf.js';

const SKIP_DIRS = new Set(['.git']);

async function walkDir(root: string, dir: string, out: string[], skipDirNames: ReadonlySet<string>): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (skipDirNames.has(entry.name)) continue;
      await walkDir(root, full, out, skipDirNames);
    } else if (entry.isFile()) {
      out.push('/' + path.relative(root, full).split(path.sep).join('/'));
    } else if (entry.isSymbolicLink()) {
      // Follow symlinks to regular files only; symlinked directories are skipped to avoid loops.
      try {
        const st = await fs.promises.stat(full);
        if (st.isFile()) out.push('/' + path.relative(root, full).split(path.sep).join('/'));
      } catch {
        /* dangling symlink: ignore */
      }
    }
  }
}

/** Every regular file under `root` except `.git/`, as sorted bundle-relative paths with a leading slash. */
export async function listTextFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  await walkDir(root, root, out, SKIP_DIRS);
  out.sort();
  return out;
}

/** Bundle-relative paths of every concept file (unparsed), sorted. */
export async function listThoughtPaths(brainRoot: string): Promise<string[]> {
  const out: string[] = [];
  for (const zone of ZONES) {
    await walkDir(brainRoot, path.join(brainRoot, zone), out, new Set([...SKIP_DIRS, 'references']));
  }
  const paths = out.filter((p) => {
    if (!p.endsWith('.md')) return false;
    const base = p.slice(p.lastIndexOf('/') + 1);
    return !GENERATED_FILENAMES.includes(base);
  });
  paths.sort();
  return paths;
}

/**
 * Every `.md` under `shared/`, `repos/`, `users/` except `index.md`/`log.md`
 * and anything under a `references/` or `.git/` directory. Sorted by path.
 */
export async function listThoughts(brainRoot: string): Promise<Thought[]> {
  const paths = await listThoughtPaths(brainRoot);
  const thoughts: Thought[] = [];
  for (const rel of paths) {
    thoughts.push(await parseThought(path.join(brainRoot, rel.slice(1)), rel));
  }
  return thoughts;
}
