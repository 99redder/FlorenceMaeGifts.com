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

// Fake Turnstile siteverify. "pass:…" tokens pass once (a second use is a duplicate);
// "wrong-action:…" / "wrong-host:…" pass for another page or site; anything else fails.
function turnstileStub(seen = new Set()) {
  return {
    'https://challenges.cloudflare.com/turnstile/v0/siteverify': (url, init) => {
      const form = new URLSearchParams(init.body);
      assert.equal(form.get('secret'), 'turnstile-test-secret');
      const token = form.get('response');
      if (seen.has(token)) return { success: false, 'error-codes': ['timeout-or-duplicate'] };
      seen.add(token);
      if (token.startsWith('pass:')) return { success: true, action: 'emergency_code', hostname: 'www.florencemaegifts.com' };
      if (token.startsWith('wrong-action:')) return { success: true, action: 'login', hostname: 'www.florencemaegifts.com' };
      if (token.startsWith('wrong-host:')) return { success: true, action: 'emergency_code', hostname: 'localhost' };
      return { success: false, 'error-codes': ['invalid-input-response'] };
    }
  };
}
let turnstileTokenCount = 0;
const passToken = () => `pass:${++turnstileTokenCount}`;
const emergencyEnv = (overrides = {}) => baseEnv({
  EMERGENCY_ADMIN_EMAIL: 'megan@family.example', EMERGENCY_NOTIFY_EMAIL: 'chris@family.example',
  TURNSTILE_SECRET: 'turnstile-test-secret', TURNSTILE_HOSTNAMES: tomlVar('TURNSTILE_HOSTNAMES'), ...overrides
});

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
  assert.equal(mail.replyTo, 'contact@florencemaegifts.com');
  assert.deepEqual(mail.bcc, ['contact@florencemaegifts.com']);
  assert.match(mail.html, /https:\/\/www\.florencemaegifts\.com\/api\/download\?token=[A-Za-z0-9_-]+/);
  // The plain-text copy carries the same link and terms, with no HTML in it.
  const htmlLink = mail.html.match(/https:\/\/www\.florencemaegifts\.com\/api\/download\?token=[A-Za-z0-9_-]+/)[0];
  assert.ok(mail.text.includes(htmlLink), 'plain-text copy has the same download link');
  assert.match(mail.text, /^Hi Casey Crafter,/);
  assert.match(mail.text, /Your payment for Four Star Ball Crochet Baby Hat Pattern - Beginner Level \(PDF Download Only\) was successful\./);
  assert.match(mail.text, /link valid for 24 hours, up to 3 downloads/);
  assert.match(mail.text, /contact us at contact@florencemaegifts\.com/);
  assert.doesNotMatch(mail.text, /<[a-z]/i);
  const status = JSON.parse(env.DOWNLOAD_TOKENS.map.get('order-confirmation-sent:cs_test_dl_1'));
  assert.equal(status.status, 'sent');

  // Stripe redelivers the event: no second email.
  res = await worker.fetch(await signedWebhook(downloadPurchase('cs_test_dl_1')), env, ctx);
  assert.equal(res.status, 200);
  assert.equal(env.EMAIL.sent.length, 1);
});

test('if the download link cannot be made, both versions tell the buyer how to get the file', async (t) => {
  quietConsole(t);
  guardNetwork(t, stripeStubs);
  const env = baseEnv({ DOWNLOADS_BUCKET: fakeBucket([]) }); // the PDF is missing from R2
  await worker.fetch(await signedWebhook(downloadPurchase('cs_test_dl_nolink')), env, ctx);
  const toBuyer = env.EMAIL.sent.find((m) => m.to.includes('crafter@example.net'));
  assert.ok(toBuyer, 'buyer email still sent');
  assert.match(toBuyer.html, /could not be generated automatically/);
  assert.match(toBuyer.text, /could not be generated automatically/);
  assert.doesNotMatch(toBuyer.text, /api\/download/);
  assert.ok(env.EMAIL.sent.some((m) => m.subject === 'FMG order confirmation email failed'), 'shop is alerted');
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

test('when no provider can send, the order is marked failed (Stripe is not retried; the success page still shows the link)', async (t) => {
  quietConsole(t);
  guardNetwork(t, stripeStubs);
  const env = baseEnv({ EMAIL: fakeEmail({ fail: true }) });
  await worker.fetch(await signedWebhook(downloadPurchase('cs_test_dl_4')), env, ctx);
  assert.equal(JSON.parse(env.DOWNLOAD_TOKENS.map.get('order-confirmation-sent:cs_test_dl_4')).status, 'failed');
});

test('order details: a paid session ID mints a download link only while the order is fresh', async (t) => {
  quietConsole(t);
  const sessions = {};
  guardNetwork(t, { 'https://api.stripe.com/v1/checkout/sessions/': (url) => sessions[url.split('/').pop()] });
  const env = baseEnv({ STRIPE_SECRET_KEY: 'sk_test_only' });
  const paid = (id, ageSeconds) => (sessions[id] = {
    id, payment_status: 'paid', status: 'complete', created: Math.floor(Date.now() / 1000) - ageSeconds,
    amount_subtotal: 499, currency: 'usd', customer_details: { email: 'crafter@example.net' },
    metadata: { checkout_type: 'fmg_shop_item', item_name: PATTERN }
  });
  paid('cs_test_fresh', 60);
  paid('cs_test_old', 3 * 86400);
  const details = async (id) => (await worker.fetch(new Request(`https://worker.example/api/checkout-session-details?session_id=${id}`), env, ctx)).json();

  const fresh = await details('cs_test_fresh');
  assert.match(fresh.downloadUrl || '', /\/api\/download\?token=/);
  assert.equal((await details('cs_test_fresh')).downloadUrl, fresh.downloadUrl, 'a reload gets the same link');
  const old = await details('cs_test_old');
  assert.equal(old.downloadUrl, null, 'an old session ID must not mint a new link');
  assert.equal(old.purchase.transactionId, 'cs_test_old');
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
  assert.equal(mail.subject, 'Florence Mae Gifts: General question from Robin');
});

test('contact form topics carry their extra fields into the email', async (t) => {
  quietConsole(t);
  guardNetwork(t);
  const env = baseEnv();
  let res = await worker.fetch(post('/api/contact', {
    mode: 'contact', topic: 'order', name: 'Robin\nBcc: x@example.com', email: 'robin@example.org',
    orderNumber: '3812345678', message: 'Has my hat shipped yet?'
  }), env, ctx);
  assert.equal(res.status, 200, await res.clone().text());
  let [mail] = env.EMAIL.sent;
  assert.equal(mail.subject, 'Florence Mae Gifts: Question about an order from Robin Bcc: x@example.com (order 3812345678)');
  assert.match(mail.text, /^Topic: Question about an order$/m);
  assert.match(mail.text, /^Order #: 3812345678$/m);
  assert.doesNotMatch(mail.text, /^Phone:/m);

  // The retired custom request form (still in some browsers' caches) keeps its fields.
  res = await worker.fetch(post('/api/contact', {
    mode: 'custom', name: 'Sam', email: 'sam@example.org', phone: '410-555-0100',
    requestType: 'Custom baby hat', message: 'A Totoro hat, please.'
  }), env, ctx);
  assert.equal(res.status, 200, await res.clone().text());
  mail = env.EMAIL.sent[1];
  assert.equal(mail.subject, 'Florence Mae Gifts: Custom piece request from Sam');
  assert.match(mail.text, /^Type of piece: Custom baby hat$/m);
  assert.match(mail.text, /^Phone: 410-555-0100$/m);

  // Bots that fill the hidden field get a quiet success and no email.
  res = await worker.fetch(post('/api/contact', { name: 'Bot', email: 'bot@example.org', message: 'hi', website: 'spam.example' }), env, ctx);
  assert.equal(res.status, 200);
  assert.equal(env.EMAIL.sent.length, 2);
});

test('admin sign-in: one answer for any wrong part, and the lockout is kept in D1', async (t) => {
  quietConsole(t);
  guardNetwork(t);
  const env = baseEnv();
  const login = (body, ip = '203.0.113.7') => worker.fetch(post('/api/admin/login', body, { 'CF-Connecting-IP': ip }), env, ctx);
  const goodCode = await totp(TOTP_SECRET);
  const badCode = String((Number(goodCode) + 500000) % 1000000).padStart(6, '0');

  const wrongPassword = await login({ username: 'admin', password: 'nope', code: badCode });
  const wrongCode = await login({ username: 'admin', password: 'admin-test-password', code: badCode });
  assert.equal(wrongPassword.status, 401);
  assert.equal(wrongCode.status, 401);
  assert.deepEqual(await wrongCode.json(), await wrongPassword.json(), 'a right password with a wrong code must not look different');

  assert.equal((await login({ username: 'admin', password: 'nope', code: badCode })).status, 429, 'third failure locks the IP out');
  assert.equal((await login({ username: 'admin', password: 'admin-test-password', code: goodCode })).status, 429, 'locked out even with the right details');
  assert.equal(env.DB.sqlite.prepare('SELECT count FROM admin_auth_failures WHERE ip = ?').get('203.0.113.7').count, 3);
  assert.equal((await login({ username: 'admin', password: 'admin-test-password', code: goodCode }, '198.51.100.9')).status, 200, 'other IPs still sign in');
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
  assert.deepEqual(shipped.bcc, ['contact@florencemaegifts.com']);
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

  const denyLink = quoteMail.html.match(/https?:\/\/[^"'\s]+\/api\/quote\/deny\?token=[A-Za-z0-9_-]+/)?.[0];
  assert.ok(denyLink, 'decline link in quote email');

  // Opening either link (as an email scanner would) only shows a confirmation page.
  const before = env.EMAIL.sent.length;
  for (const link of [denyLink, acceptLink]) {
    res = await worker.fetch(new Request(link.replace(/^https?:\/\/[^/]+/, 'https://worker.example')), env, ctx);
    assert.equal(res.status, 200, await res.clone().text());
    assert.match(await res.text(), /<form method="post" action="\/api\/quote\/(accept|deny)"/);
  }
  assert.equal(env.EMAIL.sent.length, before, 'opening a link must not send anything');
  assert.equal(env.DB.sqlite.prepare('SELECT status FROM quotes WHERE id = ?').get(id).status, 'sent', 'opening a link must not change the quote');

  // Pressing Accept posts the token back.
  const token = new URL(acceptLink).searchParams.get('token');
  res = await worker.fetch(new Request('https://worker.example/api/quote/accept', {
    method: 'POST', headers: { Origin: SITE, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token })
  }), env, ctx);
  assert.equal(res.status, 200, await res.clone().text());
  assert.match(await res.clone().text(), /Your quote has been accepted/);
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
  const messages = [event('crafter@gmial.com'), event('contact@florencemaegifts.com'), event('orders@florencemaegifts.com')]
    .map((body) => ({ body, acked: false, ack() { this.acked = true; }, retry() { throw new Error('should not retry'); } }));
  await worker.queue({ queue: 'florencemaegifts-email-events', messages }, env);
  assert.equal(env.EMAIL.sent.length, 1, 'shop addresses must not alert');
  const [alert] = env.EMAIL.sent;
  assert.deepEqual(alert.to, ['contact@florencemaegifts.com']);
  assert.deepEqual(alert.from, { email: 'orders@florencemaegifts.com', name: 'Florence Mae Gifts' });
  assert.equal(alert.subject, '[ACTION NEEDED] Email to crafter@gmial.com bounced');
  assert.ok(messages.every((m) => m.acked));
});

test('emergency access: emailed code sets up Megan\'s password, then password + code signs her in', async (t) => {
  quietConsole(t);
  guardNetwork(t, turnstileStub());
  const env = emergencyEnv();
  const codeFrom = (msg) => msg.text.match(/\b(\d{6})\b/)[1];
  const toMegan = () => env.EMAIL.sent.filter((m) => m.to.includes('megan@family.example'));
  const toChris = () => env.EMAIL.sent.filter((m) => m.to.includes('chris@family.example'));

  let status = await (await worker.fetch(new Request('https://worker.example/api/admin/emergency/status', { headers: { Origin: SITE } }), env, ctx)).json();
  assert.deepEqual(status, { ok: true, configured: true, hasAccount: false, sentTo: 'me•••@family.example' });

  let res = await worker.fetch(post('/api/admin/emergency/request', { turnstileToken: passToken() }), env, ctx);
  assert.equal((await res.json()).purpose, 'setup');
  assert.equal(toMegan().length, 1);
  assert.equal(toChris().length, 1, 'Chris is told a setup code went out');
  const setupCode = codeFrom(toMegan()[0]);

  res = await worker.fetch(post('/api/admin/emergency/verify', { code: '000000' === setupCode ? '111111' : '000000', newPassword: 'yarn and coffee forever' }), env, ctx);
  assert.equal(res.status, 401);
  res = await worker.fetch(post('/api/admin/emergency/verify', { code: setupCode, newPassword: 'short' }), env, ctx);
  assert.equal(res.status, 400);
  res = await worker.fetch(post('/api/admin/emergency/verify', { code: setupCode, newPassword: 'yarn and coffee forever' }), env, ctx);
  assert.equal(res.status, 200);
  const cookie = (res.headers.get('Set-Cookie') || '').split(';')[0];
  const verify = await worker.fetch(new Request('https://worker.example/api/admin/verify-session', { headers: { Origin: SITE, Cookie: cookie } }), env, ctx);
  assert.equal(verify.status, 200, 'emergency sign-in gives a working admin session');
  res = await worker.fetch(post('/api/admin/emergency/verify', { code: setupCode, newPassword: 'another long password' }), env, ctx);
  assert.equal(res.status, 401, 'a code works once');

  status = await (await worker.fetch(new Request('https://worker.example/api/admin/emergency/status', { headers: { Origin: SITE } }), env, ctx)).json();
  assert.equal(status.hasAccount, true);

  res = await worker.fetch(post('/api/admin/emergency/request', { password: 'wrong password here', turnstileToken: passToken() }), env, ctx);
  assert.equal(res.status, 401);
  assert.equal(toMegan().length, 1, 'no code without the password');
  res = await worker.fetch(post('/api/admin/emergency/request', { password: 'yarn and coffee forever', turnstileToken: passToken() }), env, ctx);
  assert.equal((await res.json()).purpose, 'login');
  res = await worker.fetch(post('/api/admin/emergency/verify', { code: codeFrom(toMegan().at(-1)) }), env, ctx);
  assert.equal(res.status, 200);
  assert.match(toChris().at(-1).subject, /Megan signed in/);
});

test('emergency access: a code allows 3 tries, even for guesses sent at once', async (t) => {
  quietConsole(t);
  guardNetwork(t, turnstileStub());
  const env = emergencyEnv();
  await worker.fetch(post('/api/admin/emergency/request', { turnstileToken: passToken() }), env, ctx);
  const code = env.EMAIL.sent.find((m) => m.to.includes('megan@family.example')).text.match(/\b(\d{6})\b/)[1];
  const wrong = String((Number(code) + 1) % 1000000).padStart(6, '0');

  const guesses = await Promise.all(Array.from({ length: 10 }, () =>
    worker.fetch(post('/api/admin/emergency/verify', { code: wrong, newPassword: 'yarn and coffee forever' }), env, ctx)));
  assert.deepEqual(guesses.map((r) => r.status).sort(), [401, 401, 401, 429, 429, 429, 429, 429, 429, 429]);
  const right = await worker.fetch(post('/api/admin/emergency/verify', { code, newPassword: 'yarn and coffee forever' }), env, ctx);
  assert.equal(right.status, 429, 'the right code is refused once its tries are used up');
});

test('emergency access: no code is emailed without a passed Turnstile check', async (t) => {
  quietConsole(t);
  let cloudflareDown = false;
  const siteverify = Object.values(turnstileStub())[0];
  guardNetwork(t, { 'https://challenges.cloudflare.com/turnstile/v0/siteverify': (url, init) => {
    if (cloudflareDown) throw new Error('siteverify unreachable');
    return siteverify(url, init);
  } });
  const env = emergencyEnv();
  const request = (body, target = env) => worker.fetch(post('/api/admin/emergency/request', body), target, ctx);
  const codesToMegan = () => env.EMAIL.sent.filter((m) => m.to.includes('megan@family.example')).length;

  for (const body of [{}, { turnstileToken: 'fail:1' }, { turnstileToken: 'wrong-action:1' }, { turnstileToken: 'wrong-host:1' }]) {
    assert.equal((await request(body)).status, 403, JSON.stringify(body));
  }
  assert.equal(codesToMegan(), 0, 'no code without a passed check');

  assert.equal((await request({ turnstileToken: 'pass:once' })).status, 200);
  assert.equal(codesToMegan(), 1);
  assert.equal((await request({ turnstileToken: 'pass:once' })).status, 403, 'a token works once');

  cloudflareDown = true;
  assert.equal((await request({ turnstileToken: 'pass:while-down' })).status, 403, 'refuses when Cloudflare cannot be reached');
  assert.equal(codesToMegan(), 1);

  assert.equal((await request({ turnstileToken: 'pass:x' }, emergencyEnv({ TURNSTILE_SECRET: '' }))).status, 500, 'off without the Turnstile secret');
});

test('emergency access is off without EMERGENCY_ADMIN_EMAIL', async (t) => {
  quietConsole(t);
  guardNetwork(t);
  const env = baseEnv();
  const status = await (await worker.fetch(new Request('https://worker.example/api/admin/emergency/status', { headers: { Origin: SITE } }), env, ctx)).json();
  assert.equal(status.configured, false);
  const res = await worker.fetch(post('/api/admin/emergency/request', {}), env, ctx);
  assert.equal(res.status, 500);
  assert.equal(env.EMAIL.sent.length, 0);
});

// ── Website orders (shop_orders, src/orders.js) ──

const HAT = 'Crochet Shadow Monster Baby Hat (Multiple Sizes Available)';
const HAT_PRICE = 'price_1UEHH5CHBNzHMP0M3pRzQbLj'; // its 3-6 months size in products.json

function hatPurchase(id, email = 'parent@example.org') {
  return {
    id: `evt_${id}`, type: 'checkout.session.completed', created: Math.floor(Date.now() / 1000),
    data: { object: {
      id, payment_intent: `pi_${id}`, amount_total: 5299, payment_status: 'paid',
      customer_details: { email, name: 'Pat Parent' },
      metadata: { checkout_type: 'fmg_shop_item', item_name: HAT, price_id: HAT_PRICE }
    } }
  };
}

test('a hat order gets an order number and one branded confirmation email', async (t) => {
  quietConsole(t);
  guardNetwork(t, stripeStubs);
  const env = baseEnv();
  let res = await worker.fetch(await signedWebhook(hatPurchase('cs_test_hat_1')), env, ctx);
  assert.equal(res.status, 200, await res.clone().text());
  const order = await env.DB.prepare("SELECT * FROM shop_orders WHERE stripe_session_id = 'cs_test_hat_1'").first();
  assert.match(order.order_number, /^FMG-[A-HJKMNP-Z2-9]{6}$/);
  assert.equal(order.item_name, 'Crochet Shadow Monster Baby Hat');
  assert.equal(order.size_label, '3-6 months');
  assert.equal(order.customer_email, 'parent@example.org');
  assert.equal(order.status, 'received');
  assert.equal(order.is_digital, 0);
  assert.ok(order.confirmation_sent_at && order.confirmation_sent_at !== 'sending');

  assert.equal(env.EMAIL.sent.length, 1);
  const [mail] = env.EMAIL.sent;
  assert.deepEqual(mail.from, { email: 'orders@florencemaegifts.com', name: 'Florence Mae Gifts' });
  assert.deepEqual(mail.to, ['parent@example.org']);
  assert.equal(mail.replyTo, 'contact@florencemaegifts.com');
  assert.deepEqual(mail.bcc, ['contact@florencemaegifts.com']);
  assert.equal(mail.subject, `Your Florence Mae Gifts order is confirmed (${order.order_number})`);
  // Same layout as the shipped and invoice emails, and a plain-text copy with the same facts.
  assert.match(mail.html, /images\/banner3\.png/);
  assert.match(mail.html, /Thank You for Your Order!/);
  for (const fact of [order.order_number, 'Crochet Shadow Monster Baby Hat (3-6 months)', 'Estimated Ship Date:']) {
    assert.ok(mail.html.includes(fact) && mail.text.includes(fact), fact);
  }
  assert.doesNotMatch(mail.text, /<[a-z]/i);

  // Stripe redelivers the event: the same order, no second email.
  res = await worker.fetch(await signedWebhook(hatPurchase('cs_test_hat_1')), env, ctx);
  assert.equal(res.status, 200);
  assert.equal(env.EMAIL.sent.length, 1);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM shop_orders').first()).n, 1);
});

test('a pattern order is recorded as digital and its download email carries the order number', async (t) => {
  quietConsole(t);
  guardNetwork(t, stripeStubs);
  const env = baseEnv();
  await worker.fetch(await signedWebhook(downloadPurchase('cs_test_dl_num')), env, ctx);
  const order = await env.DB.prepare("SELECT * FROM shop_orders WHERE stripe_session_id = 'cs_test_dl_num'").first();
  assert.equal(order.is_digital, 1);
  assert.equal(env.EMAIL.sent.length, 1, 'only the download email, no second confirmation');
  assert.ok(env.EMAIL.sent[0].text.includes(`Order number: ${order.order_number}`));
  assert.ok(env.EMAIL.sent[0].html.includes(order.order_number));
});

test('order details show the order number, and a hat is not a download', async (t) => {
  quietConsole(t);
  const session = {
    id: 'cs_test_hat_2', payment_status: 'paid', status: 'complete', created: Math.floor(Date.now() / 1000),
    amount_subtotal: 5299, currency: 'usd', customer_details: { email: 'parent@example.org' },
    metadata: { checkout_type: 'fmg_shop_item', item_name: HAT, price_id: HAT_PRICE }
  };
  guardNetwork(t, { 'https://api.stripe.com/v1/checkout/sessions/': session, ...stripeStubs });
  const env = baseEnv({ STRIPE_SECRET_KEY: 'sk_test_only' });
  await worker.fetch(await signedWebhook(hatPurchase('cs_test_hat_2')), env, ctx);
  const details = await (await worker.fetch(new Request('https://worker.example/api/checkout-session-details?session_id=cs_test_hat_2'), env, ctx)).json();
  const order = await env.DB.prepare("SELECT order_number FROM shop_orders WHERE stripe_session_id = 'cs_test_hat_2'").first();
  assert.equal(details.orderNumber, order.order_number);
  assert.equal(details.isDigital, false, 'the success page must not promise a pattern download for a hat');
  assert.equal(details.downloadUrl, null);
});

test('admin: an order moves through in production, shipped and delivered, emailing the customer at each step', async (t) => {
  quietConsole(t);
  guardNetwork(t, stripeStubs);
  const env = baseEnv();
  await worker.fetch(await signedWebhook(hatPurchase('cs_test_hat_3')), env, ctx);
  await worker.fetch(await signedWebhook(downloadPurchase('cs_test_dl_admin')), env, ctx);
  const admin = await adminCookie(env);
  const list = async (status) => (await (await worker.fetch(new Request(`https://worker.example/api/accounts/orders?status=${status}`, { headers: { Origin: SITE, ...admin } }), env, ctx)).json()).orders;
  assert.equal((await list('all')).length, 2);
  let [order] = await list('open');
  assert.equal(order.status, 'received');
  assert.equal((await list('open')).length, 1, 'patterns are never waiting to ship');
  const sent = () => env.EMAIL.sent.length;
  const before = sent();

  let res = await worker.fetch(post('/api/accounts/orders/email/preview', { id: order.id, status: 'in_production' }, admin), env, ctx);
  assert.match((await res.json()).html, /Your Order Is Being Made/);
  assert.equal(sent(), before, 'a preview sends nothing');

  // The ship date Megan expects replaces the handling-time estimate from here on.
  assert.equal(order.ship_estimate.custom, false);
  res = await worker.fetch(post('/api/accounts/orders/email/preview', { id: order.id, status: 'in_production', shipBy: '2026-11-14' }, admin), env, ctx);
  assert.match((await res.json()).html, /November 14, 2026/, 'the preview shows the date being entered');
  res = await worker.fetch(post('/api/accounts/orders/status', { id: order.id, status: 'in_production', date: '2026-11-03', shipBy: '2026-11-01' }, admin), env, ctx);
  assert.equal(res.status, 400, 'a ship date before production is refused');
  res = await worker.fetch(post('/api/accounts/orders/status', { id: order.id, status: 'in_production', sendEmail: true, date: '2026-11-03', shipBy: '2026-11-14' }, admin), env, ctx);
  assert.equal(res.status, 200, await res.clone().text());
  let mail = env.EMAIL.sent.at(-1);
  assert.deepEqual(mail.to, ['parent@example.org']);
  assert.equal(mail.subject, `Your Florence Mae Gifts order is being made (${order.order_number})`);
  assert.ok(mail.text.includes('Estimated Ship Date: November 14, 2026'));
  [order] = await list('open');
  assert.equal(order.status, 'in_production');
  assert.equal(order.in_production_at, '2026-11-03');
  assert.equal(order.ship_by, '2026-11-14');
  assert.deepEqual(order.ship_estimate, { by: '2026-11-14', label: 'November 14, 2026', custom: true });
  assert.equal(order.last_email_status, 'in_production');

  res = await worker.fetch(post('/api/accounts/orders/shipped', { id: order.id, carrier: 'USPS', trackingNumber: '9400122222222222222222', shipDate: '2026-11-09' }, admin), env, ctx);
  assert.equal(res.status, 200, await res.clone().text());
  mail = env.EMAIL.sent.at(-1);
  assert.equal(mail.subject, `Your Florence Mae Gifts order has shipped (${order.order_number})`);
  assert.match(mail.text, new RegExp(`^Order: ${order.order_number}$`, 'm'));
  assert.match(mail.html, /tools\.usps\.com\/go\/TrackConfirmAction\?tLabels=9400122222222222222222/);
  [order] = await list('shipped');
  assert.equal(order.tracking_number, '9400122222222222222222');
  assert.equal(order.last_email_status, 'shipped');

  const count = sent();
  res = await worker.fetch(post('/api/accounts/orders/status', { id: order.id, status: 'delivered', sendEmail: false, date: '2026-11-13' }, admin), env, ctx);
  assert.equal(res.status, 200);
  assert.equal(sent(), count, 'no email unless asked for');
  [order] = await list('delivered');
  assert.equal(order.delivered_at, '2026-11-13');
  res = await worker.fetch(post('/api/accounts/orders/status', { id: order.id, status: 'delivered', sendEmail: true, date: '2026-11-13' }, admin), env, ctx);
  assert.equal(res.status, 200);
  mail = env.EMAIL.sent.at(-1);
  assert.equal(mail.subject, `Your Florence Mae Gifts order was delivered (${order.order_number})`);
  assert.ok(mail.text.includes('Delivered: November 13, 2026'));

  // Patterns have nothing to ship, and the status endpoint takes only known statuses.
  const pattern = (await list('all')).find((o) => o.is_digital);
  res = await worker.fetch(post('/api/accounts/orders/shipped', { id: pattern.id, carrier: 'USPS', trackingNumber: '1' }, admin), env, ctx);
  assert.equal(res.status, 400);
  res = await worker.fetch(post('/api/accounts/orders/status', { id: order.id, status: 'lost' }, admin), env, ctx);
  assert.equal(res.status, 400);
  res = await worker.fetch(post('/api/accounts/orders/status', { id: order.id, status: 'received' }), env, ctx);
  assert.equal(res.status, 401, 'admin only');
});
