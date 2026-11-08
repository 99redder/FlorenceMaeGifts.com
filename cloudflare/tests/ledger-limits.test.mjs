// Ledger completeness: the admin adds up whatever /api/tax/transactions and /api/accounts/journal
// return, so those lists must hold the whole year (until 2026-11-08 they stopped at 500 rows and
// the 2026 Tax Ledger snapshot left out ~560 expenses), and the admin's loader must refuse a
// partial year. These tests run a year bigger than the old cap through the worker and through
// the loader code copied out of admin.html.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import worker from '../src/worker.js';
import { createD1 } from './d1.mjs';

const MIGRATIONS = new URL('../migrations/', import.meta.url);
const TOTP_SECRET = 'JBSWY3DPEHPK3PXP';
const SITE = 'https://www.florencemaegifts.com';
const ctx = { waitUntil() {} };

function baseEnv() {
  const DB = createD1();
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
    DB.sqlite.exec(readFileSync(new URL(file, MIGRATIONS), 'utf8'));
  }
  return {
    DB,
    ALLOWED_ORIGINS: SITE,
    ADMIN_PASS: 'admin-test-password',
    ADMIN_SESSION_SECRET: 'session-secret-test-only-0123456789',
    TOTP_SECRET
  };
}

function totp(secret, now = Date.now()) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, value = 0; const bytes = [];
  for (const ch of secret) { value = (value << 5) | alphabet.indexOf(ch); bits += 5; if (bits >= 8) { bits -= 8; bytes.push((value >>> bits) & 0xff); } }
  const step = Math.floor(now / 1000 / 30);
  const counter = new DataView(new ArrayBuffer(8));
  counter.setUint32(0, Math.floor(step / 2 ** 32)); counter.setUint32(4, step >>> 0);
  return crypto.subtle.importKey('raw', new Uint8Array(bytes), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'])
    .then((key) => crypto.subtle.sign('HMAC', key, counter.buffer))
    .then((mac) => { const s = new Uint8Array(mac); const o = s[s.length - 1] & 0x0f; const n = ((s[o] & 0x7f) << 24) | (s[o + 1] << 16) | (s[o + 2] << 8) | s[o + 3]; return String(n % 1e6).padStart(6, '0'); });
}

async function adminCookie(env) {
  const res = await worker.fetch(new Request('https://worker.example/api/admin/login', {
    method: 'POST',
    headers: { Origin: SITE, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin-test-password', code: await totp(TOTP_SECRET) })
  }), env, ctx);
  assert.equal(res.status, 200, await res.clone().text());
  return (res.headers.get('Set-Cookie') || '').split(';')[0];
}

function quietConsole(t) {
  for (const level of ['error', 'warn', 'log']) {
    const original = console[level];
    console[level] = () => {};
    t.after(() => { console[level] = original; });
  }
}

const EXPENSES_2026 = 1200; // well past the old 500-row cap
const INCOME_2026 = 40;
const expenseCents = (i) => 20 + (i % 7) * 113; // varied amounts, so a dropped row changes the total

function seedLedger(env) {
  const db = env.DB.sqlite;
  const addExpense = db.prepare('INSERT INTO tax_expenses (expense_date, vendor, category, amount_cents, paid_via, notes) VALUES (?, ?, ?, ?, ?, ?)');
  for (let i = 0; i < EXPENSES_2026; i++) {
    const day = String(1 + (i % 28)).padStart(2, '0');
    const month = String(1 + (i % 12)).padStart(2, '0');
    addExpense.run(`2026-${month}-${day}`, 'Etsy', i % 2 ? 'Etsy Listing Fees' : 'Shipping Costs', expenseCents(i), 'etsy', `Fee ${i}`);
  }
  addExpense.run('2025-12-31', 'Etsy', 'Etsy Listing Fees', 20, 'etsy', 'Other year');
  const addIncome = db.prepare('INSERT INTO tax_income (income_date, source, category, amount_cents, notes) VALUES (?, ?, ?, ?, ?)');
  for (let i = 0; i < INCOME_2026; i++) addIncome.run(`2026-06-${String(1 + (i % 28)).padStart(2, '0')}`, 'Etsy', 'Product Sale', 2500 + i, `Order #${4000000000 + i}`);
  const expected = { count: EXPENSES_2026, cents: 0 };
  for (let i = 0; i < EXPENSES_2026; i++) expected.cents += expenseCents(i);
  return expected;
}

function seedJournal(env, entries) {
  const db = env.DB.sqlite;
  const [a, b] = db.prepare('SELECT id FROM accounts ORDER BY id LIMIT 2').all().map((r) => r.id);
  const addEntry = db.prepare("INSERT INTO journal_entries (entry_date, memo, source_type, source_id) VALUES (?, ?, 'tax_expense', ?)");
  const addLine = db.prepare('INSERT INTO journal_lines (entry_id, account_id, debit_cents, credit_cents) VALUES (?, ?, ?, ?)');
  for (let i = 0; i < entries; i++) {
    const { lastInsertRowid } = addEntry.run(`2026-${String(1 + (i % 12)).padStart(2, '0')}-15`, `Entry ${i}`, i + 1);
    addLine.run(lastInsertRowid, a, 100, 0);
    addLine.run(lastInsertRowid, b, 0, 100);
  }
}

const get = (path, cookie) => new Request(`https://worker.example${path}`, { headers: { Origin: SITE, Cookie: cookie } });

test('tax transactions return the whole year, with database totals, past the old 500-row cap', async (t) => {
  quietConsole(t);
  const env = baseEnv();
  const expected = seedLedger(env);
  const cookie = await adminCookie(env);

  let res = await worker.fetch(get('/api/tax/transactions?year=2026&type=all', cookie), env, ctx);
  let body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.expenses.length, EXPENSES_2026);
  assert.equal(body.income.length, INCOME_2026);
  assert.deepEqual(body.totals.expenses, expected);
  assert.equal(body.totals.income.count, INCOME_2026);
  assert.equal(body.expenses.reduce((s, r) => s + r.amount_cents, 0), expected.cents);
  assert.deepEqual(body.complete, { expenses: true, income: true });

  // The admin used to ask for limit=5000 and silently get 500; a big limit now means what it says.
  res = await worker.fetch(get('/api/tax/transactions?year=2026&type=all&limit=5000', cookie), env, ctx);
  body = await res.json();
  assert.equal(body.expenses.length, EXPENSES_2026);

  // A deliberate small limit is still honoured, and the response says it is partial.
  res = await worker.fetch(get('/api/tax/transactions?year=2026&type=expense&limit=100', cookie), env, ctx);
  body = await res.json();
  assert.equal(body.expenses.length, 100);
  assert.equal(body.totals.expenses.count, EXPENSES_2026);
  assert.equal(body.complete.expenses, false);
  assert.equal(body.complete.income, true, 'income was not asked for, so it is not "missing"');

  // Other years stay out of the totals.
  res = await worker.fetch(get('/api/tax/transactions?year=2025&type=all', cookie), env, ctx);
  body = await res.json();
  assert.deepEqual(body.totals.expenses, { count: 1, cents: 20 });
});

test('journal list returns every entry by default and reports the total when limited', async (t) => {
  quietConsole(t);
  const env = baseEnv();
  seedJournal(env, 650);
  const cookie = await adminCookie(env);

  let res = await worker.fetch(get('/api/accounts/journal?year=2026', cookie), env, ctx);
  let body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.entries.length, 650);
  assert.equal(body.total_entries, 650);
  assert.equal(body.complete, true);
  assert.ok(body.entries.every((e) => e.lines.length === 2));

  res = await worker.fetch(get('/api/accounts/journal?year=2026&limit=200', cookie), env, ctx);
  body = await res.json();
  assert.equal(body.entries.length, 200);
  assert.equal(body.total_entries, 650);
  assert.equal(body.complete, false);
});

// The loader block from admin.html, run against the worker (or a stand-in for an old one).
function adminLoaders(fetchImpl) {
  const html = readFileSync(new URL('../../admin.html', import.meta.url), 'utf8');
  const start = html.indexOf('    // ===== Complete-ledger loading =====');
  const end = html.indexOf('    // ===== DOM Refs =====');
  assert.ok(start > 0 && end > start, 'loader block found in admin.html');
  const code = html.slice(start, end);
  return new Function('fetch', 'TAX_TX_API_URL', 'ACCOUNTS_JOURNAL_API_URL',
    `${code}\nreturn { TaxDataIncompleteError, taxDataIntegrity, loadTaxYear, loadLedgerForDates, loadFullJournal };`
  )(fetchImpl, 'https://worker.example/api/tax/transactions', 'https://worker.example/api/accounts/journal');
}

test("admin loader accepts a complete year and refuses a partial one", async (t) => {
  quietConsole(t);
  const env = baseEnv();
  seedLedger(env);
  seedJournal(env, 650);
  const cookie = await adminCookie(env);
  const viaWorker = (url) => worker.fetch(get(new URL(url).pathname + new URL(url).search, cookie), env, ctx);

  const live = adminLoaders(viaWorker);
  const data = await live.loadTaxYear(2026);
  assert.equal(data.expenses.length, EXPENSES_2026);
  assert.equal(data.integrity.ok, true);
  assert.equal(data.integrity.checked, true);
  const journal = await live.loadFullJournal(2026);
  assert.equal(journal.entries.length, 650);

  // Imports check every year their file touches, not just the year on screen.
  const both = await live.loadLedgerForDates(['2026-03-01', '2025-12-31', '', null, '2026-07-04']);
  assert.equal(both.expenses.length, EXPENSES_2026 + 1);

  // A response that is short of the database's totals (here, one row quietly dropped).
  const dropsARow = adminLoaders(async (url) => {
    const res = await viaWorker(url);
    const body = await res.json();
    body.expenses = body.expenses.slice(1);
    return Response.json(body);
  });
  await assert.rejects(dropsARow.loadTaxYear(2026), (e) => e instanceof dropsARow.TaxDataIncompleteError && /loaded 1199 of 1200 rows/.test(e.message));
  const partial = await dropsARow.loadTaxYear(2026, { allowIncomplete: true });
  assert.equal(partial.integrity.ok, false);

  // A worker from before this check: 500 rows and no totals is treated as cut off.
  const oldWorker = adminLoaders(async () => Response.json({
    ok: true,
    expenses: Array.from({ length: 500 }, (_, i) => ({ id: i, amount_cents: 20 })),
    income: []
  }));
  await assert.rejects(oldWorker.loadTaxYear(2026), oldWorker.TaxDataIncompleteError);
  const oldJournal = adminLoaders(async () => Response.json({ ok: true, entries: Array.from({ length: 500 }, (_, i) => ({ id: i, lines: [] })) }));
  await assert.rejects(oldJournal.loadFullJournal(2026), oldJournal.TaxDataIncompleteError);

  // Journal limited below its total.
  const shortJournal = adminLoaders(async () => Response.json({ ok: true, entries: [{ id: 1, lines: [] }], total_entries: 650, complete: false }));
  await assert.rejects(shortJournal.loadFullJournal(2026), /1 of 650 entries/);
});

test('tax summary leaves owner-funded income out of income and net', async (t) => {
  quietConsole(t);
  const env = { ...baseEnv(), TAX_READ_TOKEN: 'tax-read-test-token' };
  const db = env.DB.sqlite;
  const addIncome = db.prepare('INSERT INTO tax_income (income_date, source, category, amount_cents, notes, is_owner_funded) VALUES (?, ?, ?, ?, ?, ?)');
  addIncome.run('2026-05-01', 'Etsy', 'Product Sale', 10000, 'sale', 0);
  addIncome.run('2026-05-02', 'Card issuer', 'Credit Card Bonus', 2000, 'bonus', 0);
  addIncome.run('2026-02-14', 'Stripe', 'Owner Funded (Non-Revenue)', 1000, 'test purchase', 1);      // flagged
  addIncome.run('2026-02-15', 'Stripe', 'Owner Funded (Non-Revenue)', 500, 'unflagged category', 0);  // by category
  addIncome.run('2026-02-16', 'Stripe (owner test payment)', 'Service Revenue', 100, 'by source', 0); // by source
  addIncome.run('2025-12-31', 'Etsy', 'Product Sale', 9999, 'other year', 0);
  db.prepare('INSERT INTO tax_expenses (expense_date, vendor, category, amount_cents) VALUES (?, ?, ?, ?)').run('2026-05-03', 'Store', 'Supplies', 3000);

  const summary = (token) => worker.fetch(new Request('https://worker.example/api/tax/summary?year=2026', {
    headers: { Origin: SITE, 'X-Tax-Read-Token': token }
  }), env, ctx);
  const res = await summary('tax-read-test-token');
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.incomeCents, 12000, 'sale + card bonus, no owner money');
  assert.equal(body.ownerFundedCents, 1600);
  assert.equal(body.expenseCents, 3000);
  assert.equal(body.netCents, 9000);
  assert.equal((await summary('wrong-token')).status, 401);
});

test('year-end close sums only its own year and a re-run replaces it', async (t) => {
  quietConsole(t);
  const env = baseEnv();
  const cookie = await adminCookie(env);
  const db = env.DB.sqlite;
  // The migrations only add a few accounts (production's chart was seeded by the worker), so add
  // the ones this test posts to.
  db.exec(`INSERT OR IGNORE INTO accounts (code, name, account_type, normal_side, is_system, active) VALUES
    ('1000', 'Cash on Hand', 'asset', 'debit', 1, 1), ('4000', 'Sales Revenue', 'income', 'credit', 1, 1)`);
  const id = (code) => db.prepare('SELECT id FROM accounts WHERE code = ?').get(code).id;
  const entry = (date, debitCode, creditCode, cents) => {
    const { lastInsertRowid } = db.prepare("INSERT INTO journal_entries (entry_date, memo, source_type, source_id) VALUES (?, 'test', 'manual', 0)").run(date);
    db.prepare('INSERT INTO journal_lines (entry_id, account_id, debit_cents, credit_cents) VALUES (?, ?, ?, 0), (?, ?, 0, ?)')
      .run(lastInsertRowid, id(debitCode), cents, lastInsertRowid, id(creditCode), cents);
  };
  entry('2026-06-01', '1000', '4000', 80000); // 2026 sale
  entry('2026-06-02', '5800', '1000', 30000); // 2026 shipping
  entry('2027-01-05', '1000', '4000', 99900); // January 2027 sale: not part of the 2026 close
  entry('2027-01-06', '5800', '1000', 11100);

  const close = async (apply) => {
    const res = await worker.fetch(new Request('https://worker.example/api/accounts/year-close', {
      method: 'POST',
      headers: { Origin: SITE, Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ year: '2026', apply })
    }), env, ctx);
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    return Object.fromEntries(body.preview.steps.map((s) => [s.step, s.amount_cents]));
  };
  assert.deepEqual(await close(false), { 1: 80000, 2: 30000, 3: 50000 });
  // The close needs the year's stock count first; nothing set aside is a count of 0.
  const saved = await worker.fetch(new Request('https://worker.example/api/accounts/inventory-count', {
    method: 'POST',
    headers: { Origin: SITE, Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ year: 2026, lines: [] })
  }), env, ctx);
  assert.equal(saved.status, 200, await saved.clone().text());
  assert.deepEqual(await close(true), { 1: 80000, 2: 30000, 3: 50000 });
  assert.deepEqual(await close(true), { 1: 80000, 2: 30000, 3: 50000 }, 'a re-run sees the same balances');
  const open = db.prepare(`
    SELECT SUM(jl.debit_cents - jl.credit_cents) AS net FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.entry_id JOIN accounts a ON a.id = jl.account_id
    WHERE je.entry_date BETWEEN '2026-01-01' AND '2026-12-31' AND a.account_type IN ('income', 'expense')`).get();
  assert.equal(open.net, 0, '2026 revenue and expenses closed to zero, once');
});

// ---- Year-end stock count (made-ahead Halloween stock) ----
const postJson = (path, cookie, body) => new Request(`https://worker.example${path}`, {
  method: 'POST', headers: { Origin: SITE, Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body)
});

test('stock count: the close is refused until it is saved, even as all zeros', async (t) => {
  quietConsole(t);
  const env = baseEnv();
  const cookie = await adminCookie(env);
  const closeEntries = () => env.DB.sqlite.prepare("SELECT COUNT(*) AS n FROM journal_entries WHERE source_type = 'year_close'").get().n;

  let res = await worker.fetch(postJson('/api/accounts/year-close', cookie, { year: '2026', apply: false }), env, ctx);
  let body = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual(body.preview.stockCount, { saved: false, required: true });

  res = await worker.fetch(postJson('/api/accounts/year-close', cookie, { year: '2026', apply: true }), env, ctx);
  body = await res.json();
  assert.equal(res.status, 409, JSON.stringify(body));
  assert.match(body.error, /Save the 2026 Year-End Stock Count first/);
  assert.equal(closeEntries(), 0, 'nothing written');

  // A year with no yarn bought at all still needs one: the rule is every year.
  res = await worker.fetch(postJson('/api/accounts/year-close', cookie, { year: '2031', apply: true }), env, ctx);
  assert.equal(res.status, 409);

  res = await worker.fetch(postJson('/api/accounts/inventory-count', cookie, { year: 2026, lines: [{ item: 'Crochet Luffy Inspired Baby Straw Hat', qty: 0, unitCents: 250 }] }), env, ctx);
  body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.count.totalCents, 0);
  assert.deepEqual(body.count.lines, []);
  assert.equal(env.DB.sqlite.prepare("SELECT COUNT(*) AS n FROM journal_entries WHERE source_type = 'inventory_count'").get().n, 0, 'a zero count posts nothing');

  res = await worker.fetch(postJson('/api/accounts/year-close', cookie, { year: '2026', apply: true }), env, ctx);
  assert.equal(res.status, 200, await res.clone().text());
});

test('stock count: set-aside stock moves out of the year it was made and into the year it sells', async (t) => {
  quietConsole(t);
  const env = { ...baseEnv(), TAX_READ_TOKEN: 'tax-read-test-token' };
  const cookie = await adminCookie(env);
  const db = env.DB.sqlite;
  db.prepare('INSERT INTO tax_income (income_date, source, category, amount_cents, notes) VALUES (?, ?, ?, ?, ?)').run('2026-10-01', 'Etsy', 'Product Sale', 1000000, 'sale');
  db.prepare('INSERT INTO tax_expenses (expense_date, vendor, category, amount_cents) VALUES (?, ?, ?, ?)').run('2026-07-01', 'Joann', 'Yarn', 50000);

  const lines = [
    { item: 'Crochet Luffy Inspired Baby Straw Hat (Multiple Sizes Available)', qty: 40, unitCents: 250, basis: '$50.00 avg price × 5.00%' },
    { item: 'Egg Baby Photo Set', qty: 20, unitCents: 450, basis: '$90.00 avg price × 5.00%' }
  ];
  // Made-up figures throughout: this repo is public, so no real FMG totals.
  let res = await worker.fetch(postJson('/api/accounts/inventory-count', cookie, { year: 2026, countDate: '2026-12-31', lines, notes: 'Materials share 5.00% (yarn and craft materials ÷ sales in the 2026 Tax Ledger)' }), env, ctx);
  let body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  const total = 40 * 250 + 20 * 450;
  assert.equal(body.count.totalCents, total);
  assert.equal(body.count.lines[0].basis, '$50.00 avg price × 5.00%');
  assert.match(body.count.notes, /Materials share 5\.00%/);

  const pair = db.prepare(`SELECT je.entry_date, a.code, jl.debit_cents, jl.credit_cents FROM journal_entries je
    JOIN journal_lines jl ON jl.entry_id = je.id JOIN accounts a ON a.id = jl.account_id
    WHERE je.source_type = 'inventory_count' ORDER BY je.entry_date, a.code`).all().map((r) => ({ ...r }));
  assert.deepEqual(pair, [
    { entry_date: '2026-12-31', code: '1200', debit_cents: total, credit_cents: 0 },
    { entry_date: '2026-12-31', code: '5200', debit_cents: 0, credit_cents: total },
    { entry_date: '2027-01-01', code: '1200', debit_cents: 0, credit_cents: total },
    { entry_date: '2027-01-01', code: '5200', debit_cents: total, credit_cents: 0 }
  ]);

  const summary = async (year) => (await worker.fetch(new Request(`https://worker.example/api/tax/summary?year=${year}`, {
    headers: { Origin: SITE, 'X-Tax-Read-Token': 'tax-read-test-token' }
  }), env, ctx)).json();
  let s = await summary(2026);
  assert.equal(s.ledgerExpenseCents, 50000);
  assert.equal(s.expenseCents, 50000 - total);
  assert.equal(s.netCents, 1000000 - (50000 - total));
  assert.deepEqual(s.stockOnHand, { startOfYearCents: 0, endOfYearCents: total });
  s = await summary(2027);
  assert.equal(s.expenseCents, total);

  res = await worker.fetch(new Request('https://worker.example/api/accounts/inventory-count?year=2027', { headers: { Origin: SITE, Cookie: cookie } }), env, ctx);
  body = await res.json();
  assert.equal(body.previousYearCents, total);
  assert.equal(body.count, null);

  res = await worker.fetch(postJson('/api/accounts/inventory-count/delete', cookie, { year: 2026 }), env, ctx);
  assert.equal(res.status, 200);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM journal_entries WHERE source_type = 'inventory_count'").get().n, 0);
  assert.equal((await summary(2026)).expenseCents, 50000);
});

test("stock count: the admin's materials share comes from the year's yarn and sales", () => {
  const html = readFileSync(new URL('../../admin.html', import.meta.url), 'utf8');
  const start = html.indexOf('    // ===== Stock count materials share =====');
  const end = html.indexOf('    // Journal entries for a year, all of them');
  assert.ok(start > 0 && end > start, 'materials share block found in admin.html');
  const saleCategories = new Set(['product sale', 'service revenue']);
  const { stockMaterialsShare, averageListingPriceCents } = new Function('isStatsSaleIncomeRow',
    `${html.slice(start, end)}\nreturn { stockMaterialsShare, averageListingPriceCents };`
  )((r) => saleCategories.has(String(r.category || '').toLowerCase()));

  const mix = stockMaterialsShare({
    expenses: [
      { category: 'Yarn', amount_cents: 40000 },
      { category: 'Other Craft Materials', amount_cents: 10000 },
      { category: 'Shipping Costs', amount_cents: 99999 } // not materials
    ],
    income: [
      { category: 'Product Sale', amount_cents: 950000 },
      { category: 'Service Revenue', amount_cents: 50000 },
      { category: 'Owner Funded (Non-Revenue)', amount_cents: 5000, is_owner_funded: 1 }, // not a sale
      { category: 'Credit Card Bonus', amount_cents: 20000 } // not a sale
    ]
  });
  assert.equal(mix.materialsCents, 50000);
  assert.equal(mix.salesCents, 1000000);
  assert.equal(mix.share, 0.05);
  assert.equal(stockMaterialsShare({ expenses: [{ category: 'Yarn', amount_cents: 100 }], income: [] }).share, 0, 'no sales, no share');
  assert.equal(averageListingPriceCents({ sizes: [{ price: '49.99' }, { price: '52.99' }, { price: '54.99' }] }), 5266);
});
