/**
 * Structural test of the shipped psql DDL (specs/16 "Provisioning",
 * specs/16 "Representation", D22). CI has no PostgreSQL server, so the schema
 * is checked structurally: balanced statements, the required tables, and the
 * Representation requirements (frontmatter as columns/jsonb + FTS, not one
 * markdown blob).
 */
import { describe, expect, it } from 'vitest';
import { PG_SCHEMA_VERSION, loadPgSchema, splitSqlStatements } from '../../../src/brain/backends/pg.js';

const ddl = loadPgSchema();
const statements = splitSqlStatements(ddl);

function bodyOf(name: string): string {
  const m = new RegExp(`CREATE TABLE IF NOT EXISTS ${name} \\(([\\s\\S]*?)\\);`).exec(ddl);
  expect(m, `table ${name} is declared`).not.toBeNull();
  return m![1]!;
}

describe('schema/pg.sql: structure', () => {
  it('splits into balanced statements', () => {
    expect(statements.length).toBeGreaterThan(10);
    let depth = 0;
    for (const ch of ddl) {
      if (ch === '(') depth += 1;
      if (ch === ')') depth -= 1;
      expect(depth).toBeGreaterThanOrEqual(0);
    }
    expect(depth).toBe(0);
    for (const statement of statements) expect(statement.trimEnd().endsWith(';')).toBe(true);
  });

  it('declares every table provisioning requires (specs/16)', () => {
    for (const table of ['thoughts', 'history', 'change_log', 'commits', 'meta', 'bundle_files', 'codegraph_nodes', 'codegraph_edges', 'codegraph_meta', 'schema_migrations']) {
      expect(ddl).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
    expect(ddl).toContain('CREATE VIEW IF NOT EXISTS log_entries');
  });

  it('carries the schema version row provisioning reports', () => {
    expect(ddl).toContain(`INSERT INTO schema_migrations (version) VALUES ('${PG_SCHEMA_VERSION}')`);
  });

  it('is idempotent: every statement is IF NOT EXISTS or ON CONFLICT', () => {
    for (const statement of statements) {
      const body = stripComments(statement);
      expect(body === '' || /IF NOT EXISTS|ON CONFLICT/i.test(body)).toBe(true);
    }
  });
});

describe('schema/pg.sql: Representation (specs/16, D22)', () => {
  const thoughts = bodyOf('thoughts');

  it('keeps filterable frontmatter fields as real columns', () => {
    for (const column of ['repo_id', 'kind', 'zone', 'title', 'status', 'created', 'updated', 'supersedes', 'superseded_by', 'stale_after']) {
      expect(thoughts).toContain(column);
    }
  });

  it('keeps the full frontmatter as jsonb and the body as text', () => {
    expect(thoughts).toContain('frontmatter     jsonb');
    expect(thoughts).toContain('body            text');
  });

  it('indexes title + body with Postgres full-text search', () => {
    expect(ddl).toContain('to_tsvector');
    expect(ddl).toContain('setweight');
    expect(ddl).toMatch(/CREATE INDEX IF NOT EXISTS thoughts_fts ON thoughts USING gin/);
    expect(ddl).toContain("to_tsvector('english'");
  });

  it('is not a markdown dump: the document column is a materialisation cache, queries use the columns', () => {
    expect(thoughts).toContain('document        text');
    // the FTS index and the jsonb frontmatter are the serving path
    expect(ddl).toContain('GENERATED ALWAYS AS');
  });

  it('keys history by path and revision for read-at-revision and scan --history', () => {
    expect(bodyOf('history')).toContain('PRIMARY KEY (path, revision)');
    expect(bodyOf('history')).toContain('document    text NOT NULL');
  });

  it('keys the codegraph tables by repo id and keeps the canonical order', () => {
    expect(bodyOf('codegraph_nodes')).toContain('PRIMARY KEY (repo_id, id)');
    expect(bodyOf('codegraph_edges')).toContain('PRIMARY KEY (repo_id, id)');
    expect(bodyOf('codegraph_nodes')).toContain('ord');
    expect(bodyOf('codegraph_meta')).toContain('repo_id   text PRIMARY KEY');
  });

  it('never offers a home for credentials', () => {
    expect(ddl).not.toMatch(/password|secret|token|api[_-]?key/i);
  });
});

function stripComments(sql: string): string {
  return sql
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('--'))
    .join('\n')
    .trim();
}
