/**
 * The ready-to-run docker snippet for an unreachable store (specs/16
 * "Provisioning", specs/02 step 1). It is CLI-owned output — a convenience the
 * user runs themselves; `init` never starts anything. The password placeholder
 * is not a credential: the real one arrives through the connection reference
 * (specs/10), outside the brain and outside any committed file.
 */
import fs from 'node:fs';
import path from 'node:path';
import { thoughtsHome } from '../../paths.js';

/** `~/.thoughts/backends/<brain-id>/docker-compose.yml` */
export function dockerSnippetPath(brainId: string): string {
  return path.join(thoughtsHome(), 'backends', brainId, 'docker-compose.yml');
}

/** Compose file text for a psql brain. */
export function dockerComposeSnippet(brainId: string, database: string): string {
  return [
    `# thoughts: ready-to-run PostgreSQL for brain "${brainId}" (specs/16).`,
    '# Written by `thoughts init`; the CLI never starts it itself.',
    `# Run:  docker compose -f ${path.join('~/.thoughts/backends', brainId, 'docker-compose.yml')} up -d`,
    `# Then: export THOUGHTS_BRAIN_PG='postgres://thoughts:CHANGE-ME@localhost:5432/${database}'`,
    'services:',
    '  postgres:',
    '    image: postgres:16',
    '    environment:',
    `      POSTGRES_DB: ${database}`,
    '      POSTGRES_USER: thoughts',
    '      POSTGRES_PASSWORD: CHANGE-ME',
    '    ports:',
    '      - "5432:5432"',
    '    volumes:',
    '      - thoughts-pgdata:/var/lib/postgresql/data',
    'volumes:',
    '  thoughts-pgdata:',
    '',
  ].join('\n');
}

/**
 * Compose file text for a nebula brain (specs/16 "Provisioning"): a
 * three-service NebulaGraph cluster behind the HTTP gateway the CLI's nGQL
 * transport talks to. The password placeholder is not a credential — the real
 * one arrives through the connection reference (specs/10).
 */
export function nebulaComposeSnippet(brainId: string, space: string, envVar = 'THOUGHTS_NEBULA'): string {
  const dir = path.join('~/.thoughts/backends', brainId, 'docker-compose.yml');
  return [
    `# thoughts: ready-to-run NebulaGraph for brain "${brainId}" (specs/16).`,
    '# Written by `thoughts init`; the CLI never starts it itself.',
    `# Run:  docker compose -f ${dir} up -d`,
    '# Wait ~20s after the first start (the cluster needs two heartbeats before',
    '# it accepts CREATE TAG), then re-run: thoughts init',
    `# Then: export ${envVar}='nebula://thoughts:CHANGE-ME@localhost:9669/${space}'`,
    'services:',
    '  metad:',
    '    image: vesoft/nebula-metad:v3.8.0',
    '    command: ["--meta_server_addrs=metad:9559", "--local_ip=metad", "--ws_ip=metad:1979"]',
    '    volumes:',
    '      - thoughts-nebula-meta:/data',
    '  storaged:',
    '    image: vesoft/nebula-storaged:v3.8.0',
    '    command: ["--meta_server_addrs=metad:9559", "--local_ip=storaged", "--ws_ip=storaged:1979"]',
    '    depends_on: [metad]',
    '    volumes:',
    '      - thoughts-nebula-storage:/data',
    '  graphd:',
    '    image: vesoft/nebula-graphd:v3.8.0',
    '    command: ["--meta_server_addrs=metad:9559", "--local_ip=graphd", "--ws_ip=graphd:1979"]',
    '    depends_on: [storaged]',
    '    ports:',
    '      - "9669:9669"',
    '  gateway:',
    '    image: vesoft/nebula-http-gateway:v3.8.0',
    '    depends_on: [graphd]',
    '    environment:',
    `      NEBULA_ADDRESS: graphd:9669`,
    '    ports:',
    '      - "8080:8080"',
    'volumes:',
    '  thoughts-nebula-meta:',
    '  thoughts-nebula-storage:',
    '',
  ].join('\n');
}

/** Write the snippet for one brain; returns the path it was written to. */
export function writeDockerSnippet(brainId: string, kind: 'psql' | 'nebula', name: string, envVar?: string): string {
  const file = dockerSnippetPath(brainId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = kind === 'nebula' ? nebulaComposeSnippet(brainId, name, envVar) : dockerComposeSnippet(brainId, name);
  fs.writeFileSync(file, text, 'utf8');
  return file;
}
