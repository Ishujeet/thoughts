/**
 * A fake NebulaGraph client at the seam src/brain/backends/nebula.ts talks to.
 * Write statements (INSERT/DELETE VERTEX, INSERT EDGE, UPSERT VERTEX) are
 * executed by *parsing the nGQL text* — the thing a real server sees — into an
 * in-memory space of vertices and edges, so the batched multi-row statements
 * are exercised for real. Read statements dispatch on their
 * `# thoughts:<op>` tag and evaluate their filters from the statement's named
 * parameters (nGQL has no bulk binding, so the parameters are the seam); the
 * `search` op additionally asserts the statement really is a LOOKUP.
 */
import { opOf, substituteParams } from '../../../src/brain/backends/nebula-ngql.js';

/** One brain's space, shared by every client that connects to it. */
export class FakeNebulaSpace {
  vertices = new Map<string, Map<string, Record<string, unknown>>>();
  edges = new Map<string, Map<string, Record<string, unknown>>>();
  createdSpaces: string[] = [];

  vertex(tag: string, vid: string): Record<string, unknown> | undefined {
    return this.vertices.get(tag)?.get(vid);
  }

  upsert(tag: string, vid: string, props: Record<string, unknown>): void {
    const map = this.vertices.get(tag) ?? new Map<string, Record<string, unknown>>();
    map.set(vid, { ...map.get(vid), ...props });
    this.vertices.set(tag, map);
  }

  edge(type: string, src: string, dst: string): Record<string, unknown> | undefined {
    return this.edges.get(type)?.get(`${src}->${dst}`);
  }

  /** Store revision counter (the brain_meta vertex). */
  get rev(): number {
    for (const props of this.vertices.get('brain_meta')?.values() ?? []) {
      const n = Number(props['rev']);
      if (Number.isFinite(n)) return n;
    }
    return 0;
  }
}

export interface FakeNebulaCall {
  op: string;
  stmt: string;
}

export class FakeNebulaClient {
  readonly space: FakeNebulaSpace;
  /** Every statement the backend issued, in order. */
  calls: FakeNebulaCall[] = [];
  /** Fail the next statement matching this op with this error. */
  failOn?: { op: string; error: Error };

  constructor(space: FakeNebulaSpace = new FakeNebulaSpace()) {
    this.space = space;
  }

  async execute(stmt: string, params: Record<string, unknown> = {}): Promise<{ rows: Record<string, unknown>[] }> {
    const op = opOf(stmt);
    this.calls.push({ op, stmt });
    if (this.failOn && this.failOn.op === op) {
      const error = this.failOn.error;
      this.failOn = undefined;
      throw error;
    }
    // Reads arrive with named `$param` placeholders; the real client
    // substitutes them (nebula-client.ts) and so does this fake, so the
    // statements are parsed exactly as a server would see them. Writes embed
    // their literals already and carry no parameters.
    const body = stripTag(substituteParams(stmt, params));

    // A bare YIELD (the ping) and other scalar expressions.
    if (/^YIELD\b/i.test(body)) return { rows: [{ ok: 1 }] };

    if (/^(CREATE SPACE|USE|CREATE TAG|CREATE EDGE|CREATE TAG INDEX|CREATE EDGE INDEX|DROP)\b/i.test(body)) {
      const space = /CREATE SPACE IF NOT EXISTS ([A-Za-z0-9_`]+)/i.exec(body)?.[1];
      if (space !== undefined) this.space.createdSpaces.push(space.replaceAll('`', ''));
      return { rows: [] };
    }

    const insertVertex = /^INSERT VERTEX ([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*VALUES\s*([\s\S]*)$/i.exec(body);
    if (insertVertex !== null) {
      const [, tag, cols, values] = insertVertex;
      for (const row of parseValueRows(values!)) {
        this.space.upsert(tag!, row.key, zip(cols!, row.values));
      }
      return { rows: [] };
    }

    const insertEdge = /^INSERT EDGE ([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*VALUES\s*([\s\S]*)$/i.exec(body);
    if (insertEdge !== null) {
      const [, type, cols, values] = insertEdge;
      const map = this.space.edges.get(type!) ?? new Map<string, Record<string, unknown>>();
      for (const row of parseValueRows(values!)) {
        map.set(`${row.src}->${row.dst}`, zip(cols!, row.values));
      }
      this.space.edges.set(type!, map);
      return { rows: [] };
    }

    const deleteVertex = /^DELETE VERTEX ([\s\S]*?) WITH EDGE$/i.exec(body);
    if (deleteVertex !== null) {
      const vids = parseLiterals(deleteVertex[1]!).map(String);
      for (const vid of vids) {
        for (const map of this.space.vertices.values()) map.delete(vid);
        for (const map of this.space.edges.values()) {
          for (const key of [...map.keys()]) {
            const [src, dst] = key.split('->');
            if (src === vid || dst === vid) map.delete(key);
          }
        }
      }
      return { rows: [] };
    }

    const upsert = /^UPSERT VERTEX ON ([A-Za-z_][A-Za-z0-9_]*)\s*('(?:[^'\\]|\\.)*')\s*SET\s*([\s\S]*)$/i.exec(body);
    if (upsert !== null) {
      const [, tag, vid, sets] = upsert;
      const props: Record<string, unknown> = {};
      for (const assignment of splitTopLevel(sets!, ',')) {
        const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([\s\S]*)$/.exec(assignment.trim());
        if (m === null) continue;
        props[m[1]!] = parseLiterals(m[2]!)[0];
      }
      this.space.upsert(tag!, String(parseLiterals(vid!)[0]), props);
      return { rows: [] };
    }

    const fetch = /^FETCH PROP ON ([A-Za-z_][A-Za-z0-9_]*)\s*('(?:[^'\\]|\\.)*')\s*YIELD\s*([\s\S]*)$/i.exec(body);
    if (fetch !== null) {
      const [, tag, vid, yieldClause] = fetch;
      const props = this.space.vertex(tag!, String(parseLiterals(vid!)[0]));
      if (props === undefined) return { rows: [] };
      if (/properties\(vertex\)\s+AS\s+props/i.test(yieldClause!)) return { rows: [{ props: { ...props } }] };
      const row: Record<string, unknown> = {};
      for (const m of yieldClause!.matchAll(/properties\(vertex\)\.([A-Za-z_][A-Za-z0-9_]*)\s+AS\s+([A-Za-z_][A-Za-z0-9_]*)/gi)) {
        row[m[2]!] = props[m[1]!];
      }
      return { rows: [row] };
    }

    const lookup = /^LOOKUP ON ([A-Za-z_][A-Za-z0-9_]*)([^|]*)(?:\|([\s\S]*))?$/i.exec(body);
    if (lookup !== null) {
      const [, tag] = lookup;
      if (op === 'search') {
        // Serving rule (specs/16 Representation rule 3): a queryable question is
        // a LOOKUP, never a walk. The fake refuses anything else.
        if (!/^LOOKUP ON thought\b/i.test(body)) throw new Error(`FakeNebulaClient: search must LOOKUP, got: ${body.slice(0, 60)}`);
        const rows = [...(this.space.vertices.get('thought')?.values() ?? [])].filter((props) => matchesSearch(props, params));
        return { rows: rows.map((props) => ({ ...props, vid: props['id'] })) };
      }
      if (op === 'head') {
        const rows = [...(this.space.vertices.get('brain_meta')?.values() ?? [])].filter((props) => props['brain_id'] === params['brain_id']);
        return { rows: rows.map((props) => ({ rev: props['rev'] })) };
      }
      if (op === 'paths') {
        return { rows: [...(this.space.vertices.get(tag!)?.values() ?? [])].map((props) => ({ path: props['path'] })) };
      }
      if (op === 'rows_all' || op === 'files_all') {
        return { rows: [...(this.space.vertices.get(tag!)?.values() ?? [])].map((props) => ({ path: props['path'], document: props['document'], revision: props['revision'] })) };
      }
      if (op === 'change_at' || op === 'changes_since' || op === 'changes_between' || op === 'changes_older') {
        const rows = [...(this.space.vertices.get('change_log')?.values() ?? [])].filter((props) => matchesRevisionWindow(props, op, params));
        rows.sort((a, b) => Number(a['revision']) - Number(b['revision']) || String(a['path']).localeCompare(String(b['path'])));
        if (op === 'change_at') return { rows: rows.length === 0 ? [] : [{ ...rows[rows.length - 1]! }] }; // ORDER BY revision DESC | LIMIT 1
        return { rows: op === 'changes_older' ? rows.map((props) => ({ vid: vidOf(this.space, 'change_log', props) })) : rows.map((props) => ({ ...props })) };
      }
      if (op === 'revs_since') {
        const rows = [...(this.space.vertices.get('brain_commit')?.values() ?? [])]
          .filter((props) => Number(props['id']) > Number(params['since']))
          .sort((a, b) => Number(b['id']) - Number(a['id']));
        return { rows: rows.map((props) => ({ id: props['id'] })) };
      }
      if (op === 'graph_vids' || op === 'graph_nodes') {
        const rows = [...(this.space.vertices.get(tag!)?.values() ?? [])].filter((props) => props['repo_id'] === params['repo_id']);
        rows.sort((a, b) => Number(a['ord']) - Number(b['ord']));
        return { rows: rows.map((props) => ({ props: { ...props }, vid: vidOf(this.space, tag!, props), ord: props['ord'] })) };
      }
      // Edge LOOKUP (graph_edges): tag is the edge type.
      const edgeRows = [...(this.space.edges.get(tag!)?.entries() ?? [])]
        .filter(([, props]) => props['repo_id'] === params['repo_id'])
        .map(([key, props]) => {
          const [src, dst] = key.split('->');
          return { src, dst, ...props };
        });
      return { rows: edgeRows };
    }

    const go = /^GO FROM ([\s\S]*?) OVER ([A-Za-z_, ]+?)(REVERSELY)?\s*YIELD\s*([\s\S]*)$/i.exec(body);
    if (go !== null) {
      const [, fromLiterals, overClause, reverse, yieldClause] = go;
      const from = parseLiterals(fromLiterals!).map(String);
      const types = overClause!.split(',').map((t) => t.trim().toUpperCase());
      const rows: Record<string, unknown>[] = [];
      for (const type of types) {
        for (const [key] of this.space.edges.get(type)?.entries() ?? []) {
          const [src, dst] = key.split('->');
          if (reverse !== undefined ? !from.includes(dst) : !from.includes(src)) continue;
          const sourceProps = findVertex(this.space, src) ?? {};
          const targetProps = findVertex(this.space, dst) ?? {};
          const row: Record<string, unknown> = { src, dst, type };
          for (const m of yieldClause!.matchAll(/properties\((\$\$|\$\^)\)\.([A-Za-z_][A-Za-z0-9_]*)\s+AS\s+([A-Za-z_][A-Za-z0-9_]*)/gi)) {
            row[m[3]!] = (m[1] === '$$' ? targetProps : sourceProps)[m[2]!];
          }
          rows.push(row);
        }
      }
      return { rows };
    }

    throw new Error(`FakeNebulaClient: no handler for statement "${body.slice(0, 60)}" (op ${op})`);
  }

  async end(): Promise<void> {}

  /** Convenience assertions. */
  thought(path: string): Record<string, unknown> | undefined {
    for (const props of this.space.vertices.get('thought')?.values() ?? []) if (props['path'] === path) return props;
    return undefined;
  }

  get head(): number {
    return this.space.rev;
  }

  /** The `thought` vertices of the space, sorted by path. */
  thoughts(): Record<string, unknown>[] {
    return [...(this.space.vertices.get('thought')?.values() ?? [])].sort((a, b) => String(a['path']).localeCompare(String(b['path'])));
  }

  /** Edges of one type as {src, dst, props}. */
  edgesOf(type: string): { src: string; dst: string; props: Record<string, unknown> }[] {
    return [...(this.space.edges.get(type)?.entries() ?? [])].map(([key, props]) => {
      const [src, dst] = key.split('->');
      return { src, dst, props };
    });
  }
}

// ---------------------------------------------------------------------------
// nGQL parsing helpers
// ---------------------------------------------------------------------------

function stripTag(stmt: string): string {
  return stmt
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('#') && !l.trimStart().startsWith('--'))
    .join('\n')
    .trim();
}

function zip(columns: string, values: unknown[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  columns
    .split(',')
    .map((c) => c.trim())
    .forEach((c, i) => {
      out[c] = values[i];
    });
  return out;
}

/** The rows of an INSERT ... VALUES clause: `'vid':(...)` or `'src'->'dst':(...)`. */
function parseValueRows(text: string): { key: string; src: string; dst: string; values: unknown[] }[] {
  const rows: { key: string; src: string; dst: string; values: unknown[] }[] = [];
  for (const chunk of splitTopLevel(text, ',')) {
    const m = /^\s*('(?:[^'\\]|\\.)*')\s*(?:->\s*('(?:[^'\\]|\\.)*'))?\s*:\s*\(([\s\S]*)\)\s*$/.exec(chunk);
    if (m === null) throw new Error(`FakeNebulaClient: cannot parse VALUES row: ${chunk.slice(0, 60)}`);
    const vid = String(parseLiterals(m[1]!)[0]);
    const dst = m[2] === undefined ? vid : String(parseLiterals(m[2])[0]);
    rows.push({ key: vid, src: vid, dst, values: parseLiterals(m[3] ?? '') });
  }
  return rows;
}

/** Split on `sep` at paren depth 0, outside single-quoted strings. */
function splitTopLevel(text: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  let inSingle = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inSingle) {
      current += ch;
      if (ch === '\\') {
        current += text[i + 1] ?? '';
        i += 1;
      } else if (ch === "'") inSingle = false;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      current += ch;
      continue;
    }
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === sep && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim().length > 0) parts.push(current);
  return parts.filter((p) => p.trim().length > 0);
}

/** Scalar literals, comma-separated: strings, numbers, NULL, booleans. */
function parseLiterals(text: string): unknown[] {
  return splitTopLevel(text, ',').map((token) => {
    const t = token.trim();
    if (/^NULL$/i.test(t)) return null;
    if (/^true$/i.test(t)) return true;
    if (/^false$/i.test(t)) return false;
    if (t.startsWith("'")) return unescape(t.slice(1, -1));
    const n = Number(t);
    return Number.isFinite(n) ? n : t;
  });
}

function unescape(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i]!;
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = s[i + 1]!;
    out += next === 'n' ? '\n' : next === 'r' ? '\r' : next === 't' ? '\t' : next;
    i += 1;
  }
  return out;
}

function matchesSearch(props: Record<string, unknown>, params: Record<string, unknown>): boolean {
  for (const field of ['repo_id', 'zone', 'kind', 'status'] as const) {
    if (params[field] !== undefined && props[field] !== params[field]) return false;
  }
  if (params['since'] !== undefined && Number(props['revision']) <= Number(params['since'])) return false;
  const haystack = `${props['title'] ?? ''} ${props['body'] ?? ''}`.toLowerCase();
  for (const [key, value] of Object.entries(params)) {
    if (!/^term\d+$/.test(key)) continue;
    if (!haystack.includes(String(value).toLowerCase())) return false;
  }
  return true;
}

function matchesRevisionWindow(props: Record<string, unknown>, op: string, params: Record<string, unknown>): boolean {
  const rev = Number(props['revision']);
  if (op === 'change_at') return props['path'] === params['path'] && rev <= Number(params['revision']);
  if (op === 'changes_since') return rev > Number(params['since']);
  if (op === 'changes_between') return rev > Number(params['from']) && rev <= Number(params['to']);
  return rev <= Number(params['cutoff']);
}

function vidOf(space: FakeNebulaSpace, tag: string, props: Record<string, unknown>): string {
  for (const [vid, candidate] of space.vertices.get(tag)?.entries() ?? []) if (candidate === props) return vid;
  return '';
}

function findVertex(space: FakeNebulaSpace, vid: string): Record<string, unknown> | undefined {
  for (const map of space.vertices.values()) {
    const props = map.get(vid);
    if (props !== undefined) return props;
  }
  return undefined;
}
