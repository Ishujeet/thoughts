/**
 * The nGQL client seam of the nebula backend (specs/16 "Provisioning",
 * "Backend kinds": the transport is "nGQL statements").
 *
 * Route taken (specs/16 testing constraint, D23's optional-dependency rule):
 * there is no maintained Node client for NebulaGraph — `nebula-client` on npm
 * is unpublished, and the community `@nebula-contrib/nebula-nodejs` speaks the
 * Thrift daemon protocol, which drags in a thrift runtime and generated stubs
 * for a package that would be installed by every user and exercised by none of
 * them in CI. So the transport here is a thin, dependency-free nGQL client over
 * the NebulaGraph HTTP gateway protocol (`nebula-http-gateway`: `POST
 * /execute`, JSON in and out, one statement per call). It uses the global
 * `fetch` of Node >= 22, so there is nothing to install, nothing to fail at
 * install time, and nothing to load lazily — the module is only ever reached
 * when a nebula brain connects. The `NebulaClientLike` seam is the swap point
 * for a Thrift/WebSocket driver if one is ever wanted.
 *
 * Statements: writes are batched into single multi-row nGQL statements with
 * values embedded through `nqLit` (nGQL has no bulk binding); reads use named
 * `$param` placeholders filled in by `substituteParams` — the one place string
 * escaping lives. A statement a read issues always starts with a
 * `# thoughts:<op>` comment line, which is the tag fakes (and log readers)
 * dispatch on; nGQL comments are `#`-to-end-of-line.
 */
import fs from 'node:fs';
import { assetPath } from '../../assets.js';
import { maskConnectionString } from './credref.js';
import { ExitCode, ThoughtsError } from '../../types.js';
import { nqLit, opOf, substituteParams, tagged } from './nebula-ngql.js';

export { nqLit, opOf, substituteParams, tagged };

/** What one nGQL statement returns, normalised to rows of properties. */
export interface NebulaResult {
  rows: Record<string, unknown>[];
}

/** The slice of a NebulaGraph client this backend uses; fakes implement exactly this. */
export interface NebulaClientLike {
  execute(stmt: string, params?: Record<string, unknown>): Promise<NebulaResult>;
  end?(): Promise<void>;
}

/** A parsed connection string: the gateway base URL and the space, if any. */
export interface NebulaConnection {
  /** Absolute URL the `POST /execute` goes to. */
  base: string;
  space?: string;
  /** Authorization header value, when the connection string carried userinfo. */
  authorization?: string;
}

/**
 * Accepted connection-string forms (specs/16: the cred-ref holds the string,
 * never brain.yml):
 *
 *   nebula://host:9669[/<space>]     the HTTP gateway on host:port (the default)
 *   nebula+http://host:9669/<space>  the same, explicit
 *   nebula+https://host/<space>      gateway behind TLS
 *   http://host:9669/<space>         an already-formed gateway URL
 *
 * Userinfo (`nebula://user:pw@host/`) becomes an Authorization header and is
 * never echoed: diagnostics go through `maskConnectionString`.
 */
export function parseNebulaConnectionString(connectionString: string): NebulaConnection {
  const raw = connectionString.trim();
  const m = /^nebula\+(https?):\/\//i.exec(raw);
  const scheme = m ? m[1]!.toLowerCase() : /^nebula:\/\//i.test(raw) ? 'http' : /^(https?):\/\//i.test(raw) ? (/^https:/i.test(raw) ? 'https' : 'http') : undefined;
  if (scheme === undefined) {
    throw new ThoughtsError('invalid Nebula connection string', ExitCode.Validation, {
      hint: 'use nebula://host:9669/<space> or nebula+https://host/<space> — the cred-ref holds the string, never brain.yml',
    });
  }
  const rest = raw.replace(/^nebula(\+[a-z]+)?:\/\//i, `${scheme}://`);
  let url: URL;
  try {
    url = new URL(rest);
  } catch (err) {
    throw new ThoughtsError(`invalid Nebula connection string: ${maskConnectionString(raw)}`, ExitCode.Validation, {
      hint: 'use nebula://host:9669/<space>',
      cause: err,
    });
  }
  const space = url.pathname.replace(/^\/+/, '').replace(/\/+$/, '') || undefined;
  const authorization = url.username.length > 0 || url.password.length > 0 ? `Basic ${Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString('base64')}` : undefined;
  const base = `${url.protocol}//${url.host}${url.search}`;
  return { base, space, authorization };
}

/** Normalise a gateway response body into rows, whatever shape it came back in. */
function rowsOf(body: unknown): Record<string, unknown>[] {
  const rec = (v: unknown): Record<string, unknown> | undefined => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
  const root = rec(body);
  if (root === undefined) return [];
  // nebula-http-gateway: { results: [ { data: [ { rows: [ [...] ], columns: [...] } ] } ] }
  const results = Array.isArray(root['results']) ? root['results'] : undefined;
  const data = results !== undefined && results.length > 0 ? rec(results[0])?.['data'] : undefined;
  if (Array.isArray(data) && data.length > 0) {
    const first = rec(data[0]);
    const rows = first !== undefined && Array.isArray(first['rows']) ? first['rows'] : [];
    const columns = first !== undefined && Array.isArray(first['columns']) ? (first['columns'] as unknown[]).map(String) : [];
    return rows.map((row) => {
      const cells = Array.isArray(row) ? row : [row];
      const out: Record<string, unknown> = {};
      columns.forEach((c, i) => {
        out[c] = cells[i];
      });
      return out;
    });
  }
  // { rows: [ {...}] } · { records: [...] } · { tables: [...], records: [[...]] }
  for (const key of ['rows', 'records']) {
    if (Array.isArray(root[key])) return root[key] as Record<string, unknown>[];
  }
  if (Array.isArray(root['tables']) && Array.isArray(root['records'])) {
    const columns = (root['tables'] as unknown[]).map(String);
    return (root['records'] as unknown[]).map((cells) => {
      const out: Record<string, unknown> = {};
      columns.forEach((c, i) => {
        out[c] = Array.isArray(cells) ? cells[i] : cells;
      });
      return out;
    });
  }
  return [];
}

/** The thin client: one nGQL statement per `POST <base>/execute`. */
export class NebulaHttpClient implements NebulaClientLike {
  readonly connection: NebulaConnection;

  constructor(connectionString: string) {
    this.connection = parseNebulaConnectionString(connectionString);
  }

  async execute(stmt: string, params?: Record<string, unknown>): Promise<NebulaResult> {
    const gql = substituteParams(stmt, params);
    let response: Response;
    try {
      response = await fetch(`${this.connection.base}/execute`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.connection.authorization !== undefined ? { authorization: this.connection.authorization } : {}),
        },
        body: JSON.stringify({ gql }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw unreachable(this.connection, err);
    }
    if (!response.ok) {
      throw unreachable(this.connection, new Error(`nebula gateway responded ${response.status}`));
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch (err) {
      throw unreachable(this.connection, err);
    }
    const errors = typeof body === 'object' && body !== null ? (body as Record<string, unknown>)['errors'] : undefined;
    if (errors !== undefined && errors !== null && errors !== false && !(Array.isArray(errors) && errors.length === 0)) {
      const text = typeof errors === 'string' ? errors : JSON.stringify(errors);
      throw new ThoughtsError(`nebula rejected a statement: ${maskConnectionString(text).slice(0, 400)}`, ExitCode.RemoteUnreachable, {
        hint: 'check the space and schema of this brain; re-run after fixing',
      });
    }
    return { rows: rowsOf(body) };
  }
}

/** Every transport failure is exit 2, masked (specs/16 failure table). */
function unreachable(connection: NebulaConnection, cause: unknown): ThoughtsError {
  const message = cause instanceof Error ? cause.message : String(cause);
  return new ThoughtsError(`nebula brain is unreachable: ${maskConnectionString(message)}`, ExitCode.RemoteUnreachable, {
    hint: 'check the connection reference and that the gateway is running, then re-run',
    cause,
  });
}

// ---------------------------------------------------------------------------
// Schema (specs/16 "Provisioning")
// ---------------------------------------------------------------------------

/** The token the shipped schema uses for the per-brain space name. */
export const NEBULA_SPACE_TOKEN = 'THOUGHTS_SPACE';

/** Apply the shipped DDL with the brain's space substituted in. */
export function schemaStatements(space: string): string[] {
  const name = /^[A-Za-z0-9_]+$/.test(space) ? space : `\`${space}\``;
  return splitNgqlStatements(loadNebulaSchema().replaceAll(NEBULA_SPACE_TOKEN, name));
}

/** Split an .ngql script into statements on `;` outside quotes and comments. */
export function splitNgqlStatements(script: string): string[] {
  const statements: string[] = [];
  let current = '';
  let inSingle = false;
  for (let i = 0; i < script.length; i += 1) {
    const ch = script[i]!;
    // Line comments: nGQL's `#`, and the `--` this file is written with.
    // They are dropped: a statement a server sees is never half comment.
    if (!inSingle && (ch === '#' || (ch === '-' && script[i + 1] === '-')) && (current.trim().length === 0 || current.trimEnd().endsWith('\n'))) {
      const end = script.indexOf('\n', i);
      i = end === -1 ? script.length : end; // the for-loop's increment lands on the next line's first char
      continue;
    }
    if (ch === "'") inSingle = !inSingle;
    if (!inSingle && ch === ';') {
      const statement = current.trim();
      if (statement.length > 0) statements.push(statement + ';');
      current = '';
      continue;
    }
    current += ch;
  }
  const tail = current.trim();
  if (tail.length > 0) statements.push(tail);
  return statements;
}

/** The shipped DDL (specs/16 "Provisioning"): from `dist/` or from `src/`. */
export function loadNebulaSchema(): string {
  for (const rel of ['src/brain/backends/schema/nebula.ngql', 'dist/brain/backends/schema/nebula.ngql']) {
    const p = assetPath(...rel.split('/'));
    try {
      return fs.readFileSync(p, 'utf8');
    } catch {
      // try the next location
    }
  }
  throw new ThoughtsError('the nebula schema file (schema/nebula.ngql) is missing from this installation', ExitCode.Validation, {
    hint: 'reinstall the thoughts CLI',
  });
}
