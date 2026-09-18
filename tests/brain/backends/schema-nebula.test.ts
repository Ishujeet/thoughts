/**
 * Structural test of the shipped nebula DDL (specs/16 "Provisioning",
 * specs/16 "Representation", D22, specs/17 "Storage", D23). CI has no
 * NebulaGraph server, so the schema is checked structurally: balanced
 * statements, the required tags/edges, idempotency, the fixed space defaults,
 * and the Representation requirements (frontmatter fields as vertex
 * properties + relation edges, not one markdown property).
 */
import { describe, expect, it } from 'vitest';
import { NEBULA_SCHEMA_VERSION } from '../../../src/brain/backends/nebula.js';
import { NEBULA_SPACE_TOKEN, loadNebulaSchema, schemaStatements, splitNgqlStatements } from '../../../src/brain/backends/nebula-client.js';

const ddl = loadNebulaSchema();
const statements = splitNgqlStatements(ddl);

describe('schema/nebula.ngql: structure', () => {
  it('splits into balanced statements', () => {
    expect(statements.length).toBeGreaterThan(15);
    let depth = 0;
    for (const ch of ddl) {
      if (ch === '(') depth += 1;
      if (ch === ')') depth -= 1;
      expect(depth).toBeGreaterThanOrEqual(0);
    }
    expect(depth).toBe(0);
    for (const statement of statements) expect(statement.trimEnd().endsWith(';')).toBe(true);
  });

  it('creates the space with fixed partition/replica defaults, then uses it', () => {
    expect(statements[0]).toMatch(/^CREATE SPACE IF NOT EXISTS THOUGHTS_SPACE \(partition_num = 10, replica_factor = 1, vid_type = FIXED_STRING\(64\)\);$/);
    expect(statements[1]).toBe('USE THOUGHTS_SPACE;');
  });

  it('carries the thought schema tags and the codegraph tags/edges (specs/16, specs/17, D23)', () => {
    for (const tag of ['thought', 'bundle_file', 'change_log', 'brain_commit', 'brain_meta', 'code_file', 'code_symbol', 'code_module', 'codegraph_meta']) {
      expect(ddl).toContain(`CREATE TAG IF NOT EXISTS ${tag} `);
    }
    for (const edge of ['LINKS_TO', 'SUPERSEDES', 'CONTAINS', 'IMPORTS', 'CALLS', 'IMPORTS_REPO']) {
      expect(ddl).toContain(`CREATE EDGE IF NOT EXISTS ${edge} `);
    }
  });

  it('indexes what serving needs (specs/16 Representation rule 3)', () => {
    for (const index of ['thought_repo_idx', 'thought_kind_idx', 'thought_status_idx', 'thought_rev_idx', 'change_rev_idx', 'commit_id_idx', 'cmodule_repo_idx']) {
      expect(ddl).toContain(`CREATE TAG INDEX IF NOT EXISTS ${index} `);
    }
    expect(ddl).toContain('CREATE EDGE INDEX IF NOT EXISTS contains_repo_idx');
  });

  it('is idempotent: every statement is IF NOT EXISTS', () => {
    for (const statement of statements.slice(2)) {
      expect(statement).toMatch(/CREATE (TAG|EDGE|TAG INDEX|EDGE INDEX|SPACE) IF NOT EXISTS|^USE /);
    }
  });

  it('substitutes the brain space at provision time', () => {
    expect(ddl).toContain(NEBULA_SPACE_TOKEN);
    const applied = schemaStatements('acme_brain');
    expect(applied[0]).toContain('CREATE SPACE IF NOT EXISTS acme_brain');
    expect(applied.join('\n')).not.toContain(NEBULA_SPACE_TOKEN);
  });

  it('never offers a home for credentials', () => {
    expect(ddl).not.toMatch(/password|secret|token|api[_-]?key|postgres:\/\//i);
    expect(NEBULA_SCHEMA_VERSION).toMatch(/^\d{4}$/);
  });

  it('represents thoughts natively: filterable fields as vertex properties, relations as edges (D22)', () => {
    const thought = /CREATE TAG IF NOT EXISTS thought \(([^;]*)\);/.exec(ddl)![1]!;
    for (const field of ['path', 'repo_id', 'kind', 'zone', 'title', 'status', 'created', 'updated', 'supersedes', 'stale_after', 'body', 'revision']) {
      expect(thought).toContain(`${field} `);
    }
    // full frontmatter travels as JSON (the analogue of psql's jsonb), the
    // byte-exact document rides along for materialisation
    expect(thought).toContain('frontmatter string');
    expect(thought).toContain('document string');
  });
});
