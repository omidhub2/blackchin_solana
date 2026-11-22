/**
 * In-memory PostgreSQL substitute for deterministic repository/service tests.
 *
 * It does not execute SQL. Instead, each test registers a handler for a
 * substring of the statement text, which keeps tests explicit about the
 * statements the code under test is expected to issue.
 */
export function createFakePool({ connect = true } = {}) {
  const handlers = [];
  const calls = [];

  const pool = {
    calls,
    handlers,
    released: 0,

    onQuery(match, handler) {
      handlers.push({ match, handler });
      return pool;
    },

    async query(sql, params) {
      const text = String(sql).trim();
      const call = { sql: text, params };
      calls.push(call);

      const entry = handlers.find(({ match }) => text.includes(match));

      if (!entry) {
        const error = new Error(`Unexpected query in fake pool: ${text.slice(0, 120)}`);
        error.code = 'FAKE_POOL_NO_HANDLER';
        throw error;
      }

      const result = await entry.handler(params, call);

      if (result === undefined) {
        return { rows: [], rowCount: 0 };
      }

      return { rows: [], rowCount: 0, ...result };
    },

    sqlCalls(match) {
      return calls.filter((call) => call.sql.includes(match));
    }
  };

  if (connect) {
    pool.connect = async () => ({
      async query(sql, params) {
        return pool.query(sql, params);
      },
      release() {
        pool.released += 1;
      }
    });
  }

  return pool;
}
