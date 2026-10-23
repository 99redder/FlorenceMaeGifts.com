// Customer and staff emails, end to end through src/worker.js: a SQLite D1
// with every migration applied, fake KV and R2, signed Stripe webhooks, a real
// admin sign-in (password + authenticator code) and a fake Cloudflare EMAIL
// binding. Any network call other than a stubbed Stripe API fails the test.
// Run from cloudflare/: node --test tests/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import worker from '../src/worker.js';
import { createD1 } from './d1.mjs';

const MIGRATIONS = new URL('../migrations/', import.meta.url);
const WEBHOOK_SECRET = 'whsec_test_only';
const TOTP_SECRET = 'JBSWY3DPEHPK3PXP';
const SITE = 'https://www.florencemaegifts.com';
const PATTERN = 'Four Star Ball Crochet Baby Hat Pattern - Beginner Level (PDF Download Only)';

function createDb() {
  const DB = createD1();
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
    DB.sqlite.exec(readFileSync(new URL(file, MIGRATIONS), 'utf8'));
  }
  return DB;
}

function fakeKV() {
  const map = new Map();
  return {
    map,
    async get(key, type) { const v = map.get(key); return v === undefined ? null : (type === 'json' ? JSON.parse(v) : v); },
    async put(key, value) { map.set(key, String(value)); },
    async delete(key) { map.delete(key); },
    async list() { return { keys: [...map.keys()].map((name) => ({ name })), list_complete: true }; }
  };
}

function fakeBucket(keys) {
  return {
    async head(key) { return keys.includes(key) ? { key, size: 1234, httpMetadata: { contentType: 'application/pdf' } } : null; },
    async get(key) { return keys.includes(key) ? { key, body: new Blob(['%PDF']).stream(), size: 4, httpMetadata: { contentType: 'application/pdf' } } : null; },
    async put() {}
  };
}

function fakeEmail({ fail = false } = {}) {
  const sent = [];
  return {
    sent,
    async send(message) {
      if (fail) throw Object.assign(new Error('service unavailable'), { code: 'E_INTERNAL_SERVER_ERROR' });
      sent.push(message);
      return { messageId: `cf-${sent.length}` };
    }
  };
}

const wrangler = readFileSync(new URL('../wrangler.toml.example', import.meta.url), 'utf8'); // the real wrangler.toml is git-ignored
const tomlVar = (name) => JSON.parse(wrangler.match(new RegExp(`^${name} = ('.*'|".*")$`, 'm'))[1].replace(/^'(.*)'$/, (_, s) => JSON.stringify(s)));

function baseEnv(overrides = {}) {
  return {
    DB: createDb(),
    EMAIL: fakeEmail(),
    DOWNLOAD_TOKENS: fakeKV(),
    DOWNLOADS_BUCKET: fakeBucket(['four-star-ball-crochet-baby-hat-pattern.pdf']),
    DOWNLOAD_FILE_MAP: tomlVar('DOWNLOAD_FILE_MAP'),
    DOWNLOAD_BASE_URL: 'https://www.florencemaegifts.com/api/download',
    DOWNLOAD_TOKEN_TTL_SECONDS: '86400',
    DOWNLOAD_TOKEN_MAX_USES: '3',
    ALLOWED_ORIGINS: SITE,
    RESEND_FROM_EMAIL: tomlVar('RESEND_FROM_EMAIL'),
    SUPPORT_EMAIL: tomlVar('SUPPORT_EMAIL'),
    CONTACT_TO_EMAIL: tomlVar('CONTACT_TO_EMAIL'),
    STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
    ADMIN_PASS: 'admin-test-password',
    ADMIN_SESSION_SECRET: 'session-secret-test-only-0123456789',
    TOTP_SECRET,
    ...overrides
  };
}

function guardNetwork(t, stubs = {}) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input?.url || input);
    calls.push({ url, init });
    for (const [prefix, reply] of Object.entries(stubs)) {
      if (url.startsWith(prefix)) return Response.json(typeof reply === 'function' ? reply(url, init) : reply);
    }
    throw new Error(`unexpected network call in test: ${url}`);
  };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}

function quietConsole(t) {
  for (const level of ['error', 'warn', 'log']) {
    const original = console[level];
    console[level] = () => {};
    t.after(() => { console[level] = original; });
  }
}

let stripeSessionCount = 0;
const stripeStubs = {
  'https://api.stripe.com/v1/checkout/sessions': () => { stripeSessionCount++; return { id: `cs_test_link_${stripeSessionCount}`, url: `https://checkout.stripe.com/c/pay/cs_test_link_${stripeSessionCount}` }; },
  'https://api.stripe.com/v1/payment_intents/': { latest_charge: { balance_transaction: { fee: 100 } } }
};

async function signedWebhook(event) {
  const payload = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(WEBHOOK_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${payload}`));
  const v1 = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return new Request('https://worker.example/api/stripe-webhook', { method: 'POST', headers: { 'Stripe-Signature': `t=${t},v1=${v1}` }, body: payload });
}

function downloadPurchase(id) {
  return {
    id: `evt_${id}`, type: 'checkout.session.completed', created: Math.floor(Date.now() / 1000),
    data: { object: {
      id, payment_intent: `pi_${id}`, amount_total: 499, payment_status: 'paid',
      customer_details: { email: 'crafter@example.net', name: 'Casey Crafter' },
      metadata: { checkout_type: 'fmg_shop_item', item_name: PATTERN, customer_name: 'Casey Crafter' }
    } }
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

const ctx = { waitUntil() {} };
const post = (path, body, headers = {}) => new Request(`https://worker.example${path}`, {
  method: 'POST', headers: { Origin: SITE, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body)
});

async function adminCookie(env) {
  const res = await worker.fetch(post('/api/admin/login', { username: 'admin', password: 'admin-test-password', code: await totp(TOTP_SECRET) }), env, ctx);
  const body = await res.clone().json();
  assert.equal(res.status, 200, JSON.stringify(body));
  const cookie = (res.headers.get('Set-Cookie') || '').split(';')[0];
  assert.ok(cookie, 'admin session cookie');
  return { Cookie: cookie };
}

test('digital pattern purchase emails the buyer a download link, once', async (t) => {
  quietConsole(t);
  guardNetwork(t, stripeStubs);
  const env = baseEnv();
  let res = await worker.fetch(await signedWebhook(downloadPurchase('cs_test_dl_1')), env, ctx);
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal(env.EMAIL.sent.length, 1);
  const [mail] = env.EMAIL.sent;
  assert.deepEqual(mail.from, { email: 'orders@florencemaegifts.com', name: 'Florence Mae Gifts' });
  assert.deepEqual(mail.to, ['crafter@example.net']);
  assert.equal(mail.replyTo, 'florencemaegifts@outlook.com');
  assert.deepEqual(mail.bcc, ['contact@florencemaegifts.com']);
  assert.match(mail.html, /https:\/\/www\.florencemaegifts\.com\/api\/download\?token=[A-Za-z0-9_-]+/);
  const status = JSON.parse(env.DOWNLOAD_TOKENS.map.get('order-confirmation-sent:cs_test_dl_1'));
  assert.equal(status.status, 'sent');

  // Stripe redelivers the event: no second email.
  res = await worker.fetch(await signedWebhook(downloadPurchase('cs_test_dl_1')), env, ctx);
  assert.equal(res.status, 200);
  assert.equal(env.EMAIL.sent.length, 1);
});

test('download link in the email works', async (t) => {
  quietConsole(t);
  guardNetwork(t, stripeStubs);
  const env = baseEnv();
  await worker.fetch(await signedWebhook(downloadPurchase('cs_test_dl_2')), env, ctx);
  const link = env.EMAIL.sent[0].html.match(/https:\/\/www\.florencemaegifts\.com\/api\/download\?token=[A-Za-z0-9_-]+/)[0];
  const res = await worker.fetch(new Request(link.replace('https://www.florencemaegifts.com', 'https://worker.example')), env, ctx);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('Content-Type') || '', /pdf/);
});

test('when Cloudflare fails, the buyer still gets the download email through Resend', async (t) => {
  quietConsole(t);
  const calls = guardNetwork(t, { ...stripeStubs, 'https://api.resend.com/emails': { id: 'resend-1' } });
  const env = baseEnv({ EMAIL: fakeEmail({ fail: true }), RESEND_API_KEY: 're_test_only' });
  const res = await worker.fetch(await signedWebhook(downloadPurchase('cs_test_dl_3')), env, ctx);
  assert.equal(res.status, 200);
  const resend = calls.filter((c) => c.url === 'https://api.resend.com/emails');
  assert.equal(resend.length, 1);
  const body = JSON.parse(resend[0].init.body);
  assert.deepEqual(body.to, ['crafter@example.net']);
  assert.equal(body.from, 'Florence Mae Gifts <orders@florencemaegifts.com>');
  assert.match(body.html, /api\/download\?token=/);
  assert.equal(JSON.parse(env.DOWNLOAD_TOKENS.map.get('order-confirmation-sent:cs_test_dl_3')).status, 'sent');
});

test('when no provider can send, the order is marked failed (and retried by Stripe)', async (t) => {
  quietConsole(t);
  guardNetwork(t, stripeStubs);
  const env = baseEnv({ EMAIL: fakeEmail({ fail: true }) });
  await worker.fetch(await signedWebhook(downloadPurchase('cs_test_dl_4')), env, ctx);
  assert.equal(JSON.parse(env.DOWNLOAD_TOKENS.map.get('order-confirmation-sent:cs_test_dl_4')).status, 'failed');
});

test('contact form emails the shop with the visitor as reply-to', async (t) => {
  quietConsole(t);
  guardNetwork(t);
  const env = baseEnv();
  const res = await worker.fetch(post('/api/contact', { name: 'Robin', email: 'robin@example.org', message: 'Custom hat for a newborn?' }), env, ctx);
  assert.equal(res.status, 200, await res.clone().text());
  const [mail] = env.EMAIL.sent;
  assert.deepEqual(mail.to, ['contact@florencemaegifts.com']);
  assert.equal(mail.replyTo, 'robin@example.org');
  assert.deepEqual(mail.from, { email: 'orders@florencemaegifts.com', name: 'Florence Mae Gifts' });
});

test('admin: invoice email and shipped email reach the customer', async (t) => {
  quietConsole(t);
  guardNetwork(t, stripeStubs);
  const env = baseEnv({ STRIPE_SECRET_KEY: 'sk_test_only' });
  const admin = await adminCookie(env);
  let res = await worker.fetch(post('/api/accounts/invoices', {
    customerName: 'Dana Customer', customerEmail: 'dana@example.com', dueDate: '2026-11-30', descriptionOfWork: 'Two custom baby hats',
    items: [{ description: 'Custom hat', quantity: 2, unitAmount: 25 }]
  }, admin), env, ctx);
  const created = await res.json();
  assert.equal(res.status, 200, JSON.stringify(created));
  const id = created.id || created.invoice?.id || created.invoiceId;
  assert.ok(id, JSON.stringify(created));

  res = await worker.fetch(post('/api/accounts/invoices/send', { id }, admin), env, ctx);
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal(env.EMAIL.sent.length, 1);
  const invoiceMail = env.EMAIL.sent[0];
  assert.deepEqual(invoiceMail.to, ['dana@example.com']);
  assert.match(invoiceMail.html, /checkout\.stripe\.com/);

  res = await worker.fetch(post('/api/accounts/invoices/shipped', { id, carrier: 'USPS', trackingNumber: '9400111111111111111111', shipDate: '2026-11-01' }, admin), env, ctx);
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal(env.EMAIL.sent.length, 2);
  const shipped = env.EMAIL.sent[1];
  assert.deepEqual(shipped.to, ['dana@example.com']);
  assert.deepEqual(shipped.bcc, ['florencemaegifts@outlook.com']);
  assert.match(shipped.html, /9400111111111111111111/);
});

test('quote: emailed to the customer, accepted from the link, invoice sent and shop notified', async (t) => {
  quietConsole(t);
  guardNetwork(t, stripeStubs);
  const env = baseEnv({ STRIPE_SECRET_KEY: 'sk_test_only' });
  const admin = await adminCookie(env);
  let res = await worker.fetch(post('/api/accounts/quotes', {
    customerName: 'Quinn Customer', customerEmail: 'quinn@example.com', descriptionOfWork: 'Blanket',
    items: [{ description: 'Crochet blanket', quantity: 1, unitAmount: 80 }]
  }, admin), env, ctx);
  const created = await res.json();
  assert.equal(res.status, 200, JSON.stringify(created));
  const id = created.id || created.quote?.id || created.quoteId;

  res = await worker.fetch(post('/api/accounts/quotes/send', { id }, admin), env, ctx);
  assert.equal(res.status, 200, await res.clone().text());
  const quoteMail = env.EMAIL.sent.at(-1);
  assert.deepEqual(quoteMail.to, ['quinn@example.com']);
  const acceptLink = quoteMail.html.match(/https?:\/\/[^"'\s]+\/api\/quote\/accept\?token=[A-Za-z0-9_-]+/)?.[0];
  assert.ok(acceptLink, 'accept link in quote email');

  const before = env.EMAIL.sent.length;
  res = await worker.fetch(new Request(acceptLink.replace(/^https?:\/\/[^/]+/, 'https://worker.example')), env, ctx);
  assert.equal(res.status, 200, await res.clone().text());
  const after = env.EMAIL.sent.slice(before);
  assert.ok(after.some((m) => m.to.includes('quinn@example.com')), `customer invoice email missing: ${after.map((m) => m.subject)}`);
  assert.ok(after.some((m) => m.to.includes('contact@florencemaegifts.com') && /Accepted/.test(m.subject)), 'shop notification missing');
});

test('email events queue: a bounced download email alerts the shop', async (t) => {
  quietConsole(t);
  guardNetwork(t);
  const env = baseEnv();
  const event = (recipient) => ({
    type: 'cf.email.sending.message.bounced',
    payload: { messageId: 'm1', sender: 'orders@florencemaegifts.com', recipient, subject: 'Your Florence Mae Gifts download', bounce: { type: 'hard', reason: '550 5.1.1 User unknown' } },
    metadata: { eventTimestamp: '2026-10-23T15:02:00.000Z' }
  });
  const messages = [event('crafter@gmial.com'), event('contact@florencemaegifts.com'), event('florencemaegifts@outlook.com')]
    .map((body) => ({ body, acked: false, ack() { this.acked = true; }, retry() { throw new Error('should not retry'); } }));
  await worker.queue({ queue: 'florencemaegifts-email-events', messages }, env);
  assert.equal(env.EMAIL.sent.length, 1, 'shop addresses must not alert');
  const [alert] = env.EMAIL.sent;
  assert.deepEqual(alert.to, ['contact@florencemaegifts.com']);
  assert.deepEqual(alert.from, { email: 'orders@florencemaegifts.com', name: 'Florence Mae Gifts' });
  assert.equal(alert.subject, '[ACTION NEEDED] Email to crafter@gmial.com bounced');
  assert.ok(messages.every((m) => m.acked));
});
