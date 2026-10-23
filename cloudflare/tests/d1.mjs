// D1 test double backed by Node's built-in SQLite, so tests run the worker's
// real SQL. Covers the parts of the D1 API the workers use.
import { DatabaseSync } from 'node:sqlite';

export function createD1() {
  const db = new DatabaseSync(':memory:');
  const param = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);
  const plain = (row) => (row ? { ...row } : null);

  function statement(sql, params = []) {
    return {
      bind: (...args) => statement(sql, args.map(param)),
      async first(column) {
        const row = plain(db.prepare(sql).get(...params));
        if (!row) return null;
        return column ? (row[column] ?? null) : row;
      },
      async all() {
        return { results: db.prepare(sql).all(...params).map(plain), success: true, meta: {} };
      },
      async raw() {
        return db.prepare(sql).all(...params).map((row) => Object.values(row));
      },
      async run() {
        const info = db.prepare(sql).run(...params);
        return { success: true, meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } };
      }
    };
  }

  return {
    prepare: (sql) => statement(sql),
    async batch(statements) {
      const out = [];
      for (const s of statements) out.push(await s.run());
      return out;
    },
    async exec(sql) { db.exec(sql); return { count: 1 }; },
    sqlite: db
  };
}
