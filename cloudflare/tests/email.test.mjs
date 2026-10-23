// Tests for email.js (shared with eastern-shore-ai/worker and
// FlorenceMaeGifts.com/cloudflare). Run from cloudflare/: node --test tests/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { sendEmail, emailConfigured, toCloudflareMessage, parseAddress } from '../src/email.js';

const payload = {
  from: 'Shop Orders <orders@shop.example>',
  to: ['buyer@example.net'],
  cc: ['owner@shop.example'],
  bcc: ['"Copy, Inbox" <copy@shop.example>'],
  reply_to: ['help@shop.example'],
  subject: 'Your order',
  html: '<p>Thanks</p>',
  text: 'Thanks',
  headers: { 'List-Unsubscribe': '<mailto:help@shop.example>', 'X-Source': 'test' },
  attachments: [{ filename: 'call.ics', content: 'QkVHSU46VkNBTEVOREFS', content_type: 'text/calendar' }]
};

function stubFetch(t, response = new Response(JSON.stringify({ id: 'resend-1' }), { status: 200 })) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return response; };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}

function quietConsole(t) {
  for (const level of ['error', 'warn']) {
    const original = console[level];
    console[level] = () => {};
    t.after(() => { console[level] = original; });
  }
}

test('parseAddress splits display names and leaves bare addresses alone', () => {
  assert.equal(parseAddress('a@b.example'), 'a@b.example');
  assert.deepEqual(parseAddress('Just In Case <noreply@b.example>'), { email: 'noreply@b.example', name: 'Just In Case' });
  assert.deepEqual(parseAddress('"Copy, Inbox" <copy@b.example>'), { email: 'copy@b.example', name: 'Copy, Inbox' });
  assert.equal(parseAddress('<only@b.example>'), 'only@b.example');
  assert.deepEqual(parseAddress({ email: 'x@b.example' }), { email: 'x@b.example' });
});

test('toCloudflareMessage maps every Resend field the workers use', () => {
  assert.deepEqual(toCloudflareMessage(payload), {
    from: { email: 'orders@shop.example', name: 'Shop Orders' },
    to: ['buyer@example.net'],
    cc: ['owner@shop.example'],
    bcc: [{ email: 'copy@shop.example', name: 'Copy, Inbox' }],
    replyTo: 'help@shop.example',
    subject: 'Your order',
    html: '<p>Thanks</p>',
    text: 'Thanks',
    headers: { 'List-Unsubscribe': '<mailto:help@shop.example>', 'X-Source': 'test' },
    attachments: [{ filename: 'call.ics', content: 'QkVHSU46VkNBTEVOREFS', type: 'text/calendar', disposition: 'attachment' }]
  });
});

test('toCloudflareMessage leaves out empty optional fields', () => {
  const message = toCloudflareMessage({ from: 'a@b.example', to: 'c@d.example', subject: 'Hi', text: 'Hello', reply_to: 'e@f.example', bcc: [] });
  assert.deepEqual(message, { from: 'a@b.example', to: ['c@d.example'], subject: 'Hi', replyTo: 'e@f.example', text: 'Hello' });
});

test('sends through Cloudflare when the EMAIL binding is present', async (t) => {
  const calls = stubFetch(t);
  const sent = [];
  const env = { EMAIL: { async send(message) { sent.push(message); return { messageId: 'cf-1' }; } }, RESEND_API_KEY: 're_test' };
  const res = await sendEmail(env, payload);
  assert.equal(res.ok, true);
  assert.deepEqual(await res.json(), { id: 'cf-1', provider: 'cloudflare' });
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], toCloudflareMessage(payload));
  assert.equal(calls.length, 0, 'Resend must not be called when Cloudflare sent');
});

test('falls back to Resend with the original payload when Cloudflare fails', async (t) => {
  quietConsole(t);
  const calls = stubFetch(t);
  const env = {
    EMAIL: { async send() { throw Object.assign(new Error('daily limit'), { code: 'E_DAILY_LIMIT_EXCEEDED' }); } },
    RESEND_API_KEY: 're_test'
  };
  const res = await sendEmail(env, payload, { idempotencyKey: 'order-1-ack' });
  assert.equal(res.ok, true);
  assert.deepEqual(await res.json(), { id: 'resend-1' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.resend.com/emails');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer re_test');
  assert.equal(calls[0].init.headers['Idempotency-Key'], 'order-1-ack');
  assert.deepEqual(JSON.parse(calls[0].init.body), payload);
});

test('Resend alone still works (no EMAIL binding)', async (t) => {
  const calls = stubFetch(t);
  const res = await sendEmail({ RESEND_API_KEY: 're_test' }, payload);
  assert.equal(res.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.headers['Idempotency-Key'], undefined);
});

test('a Resend error is passed through unchanged', async (t) => {
  const calls = stubFetch(t, new Response(JSON.stringify({ message: 'bad from' }), { status: 422 }));
  const res = await sendEmail({ RESEND_API_KEY: 're_test' }, payload);
  assert.equal(calls.length, 1);
  assert.equal(res.status, 422);
  assert.equal((await res.json()).message, 'bad from');
});

test('Cloudflare failure with no fallback returns 502 with the error code', async (t) => {
  quietConsole(t);
  const calls = stubFetch(t);
  const env = { EMAIL: { async send() { throw Object.assign(new Error('not verified'), { code: 'E_SENDER_NOT_VERIFIED' }); } } };
  const res = await sendEmail(env, payload);
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.match(body.message, /E_SENDER_NOT_VERIFIED: not verified/);
  assert.equal(body.error, body.message);
  assert.equal(calls.length, 0);
});

test('no provider at all returns 500', async () => {
  const res = await sendEmail({}, payload);
  assert.equal(res.status, 500);
  assert.match((await res.text()), /No email provider is configured/);
});

test('emailConfigured accepts either provider', () => {
  assert.equal(emailConfigured({}), false);
  assert.equal(emailConfigured(undefined), false);
  assert.equal(emailConfigured({ EMAIL: {} }), true);
  assert.equal(emailConfigured({ RESEND_API_KEY: 're_x' }), true);
});
