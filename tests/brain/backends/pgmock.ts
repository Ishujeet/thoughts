/**
 * Shared state of the `pg` module mock used by the psql command tests: the
 * store every mocked client shares, and a `refusing` switch that simulates an
 * unreachable server. Tests import this directly and the `vi.mock('pg')`
 * factory imports it too.
 */
import { FakePgStore } from './fakepg.js';

export const pgMock = {
  refusing: false,
  store: new FakePgStore(),
};
