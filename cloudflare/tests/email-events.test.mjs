// Tests for src/email-events.js (shared with eastern-shore-ai/worker).
// Run from cloudflare/: node --test tests/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { describeEmailEvent, handleEmailEventBatch } from '../src/email-events.js';

const bounced = (recipient = 'buyer@example.net') => ({
  type: 'cf.email.sending.message.bounced',
  source: { type: 'email.sending', zoneId: 'z', domain: 'shop.example' },
  payload: {
    eventId: 'ev1', messageId: 'msg-1', sender: 'orders@shop.example', recipient, subject: 'Your order',
    terminal: true,
    delivery: { status: 'bounced', smtpStatusCode: '550', smtpResponse: '550 5.1.1 User unknown' },
    bounce: { type: 'hard', classification: 'permanent_failure', reason: '550 5.1.1 User unknown' }
  },
  metadata: { accountId: 'a', eventSubscriptionId: 's', eventSchemaVersion: 1, eventTimestamp: '2026-10-23T15:02:00.000Z' }
});

function batchOf(bodies, queue = 'q') {
  const messages = bodies.map((body) => ({
    body, acked: false, retried: null,
    ack() { this.acked = true; },
    retry(opts) { this.retried = opts || {}; }
  }));
  return { queue, messages };
}

test('a bounced customer email becomes an action-needed alert', () => {
  const alert = describeEmailEvent(bounced(), { internalAddresses: ['owner@shop.example'] });
  assert.equal(alert.subject, '[ACTION NEEDED] Email to buyer@example.net bounced');
  assert.match(alert.text, /did not reach buyer@example\.net/);
  assert.match(alert.text, /Subject: Your order/);
  assert.match(alert.text, /What happened: bounced \(hard\)/);
  assert.match(alert.text, /Reason: 550 5\.1\.1 User unknown/);
  assert.match(alert.text, /When: Oct 23, 2026, 11:02 AM ET/);
  assert.match(alert.text, /Message ID: msg-1/);
});

test('failed, rejected and complained events are described; delivered and deferred are ignored', () => {
  const base = bounced();
  const failed = describeEmailEvent({ ...base, type: 'cf.email.sending.message.failed', payload: { ...base.payload, bounce: undefined, failure: { reason: 'delivery_failed' } } });
  assert.match(failed.subject, /failed to send$/);
  assert.match(failed.text, /Reason: delivery_failed/);
  const rejected = describeEmailEvent({ ...base, type: 'cf.email.sending.message.rejected', payload: { ...base.payload, bounce: undefined, rejection: { reason: 'suppressed', party: 'cloudflare', detail: 'Recipient is on the suppression list' } } });
  assert.match(rejected.subject, /was rejected before sending$/);
  assert.match(rejected.text, /suppression list/);
  const complained = describeEmailEvent({ ...base, type: 'cf.email.sending.message.complained', payload: { ...base.payload, bounce: undefined, complaint: { type: 'abuse' } } });
  assert.equal(complained.subject, 'Email to buyer@example.net was marked as spam');
  assert.equal(describeEmailEvent({ ...base, type: 'cf.email.sending.message.delivered' }), null);
  assert.equal(describeEmailEvent({ ...base, type: 'cf.email.sending.message.deferred' }), null);
  assert.equal(describeEmailEvent(null), null);
});

test('short event names (as configured on the subscription) are handled too', () => {
  const alert = describeEmailEvent({ ...bounced(), type: 'message.bounced' });
  assert.equal(alert.subject, '[ACTION NEEDED] Email to buyer@example.net bounced');
  assert.equal(describeEmailEvent({ ...bounced(), type: 'message.complained' }).subject, 'Email to buyer@example.net was marked as spam');
  assert.equal(describeEmailEvent({ ...bounced(), type: 'message.delivered' }), null);
});

test('events about our own addresses are skipped (no alert loops)', () => {
  assert.equal(describeEmailEvent(bounced('Owner@Shop.example'), { internalAddresses: ['owner@shop.example', undefined, ''] }), null);
});

test('batch: alerts are sent and acked; a failed alert is retried; ignored events are acked', async () => {
  const sent = [];
  const batch = batchOf([bounced('a@example.net'), { type: 'cf.email.sending.message.delivered', payload: {} }, bounced('b@example.net')]);
  await handleEmailEventBatch(batch, {
    notify: async (alert) => { sent.push(alert); return { ok: !alert.subject.includes('b@example.net') }; },
    internalAddresses: []
  });
  assert.equal(sent.length, 2);
  assert.deepEqual(batch.messages.map((m) => [m.acked, m.retried]), [[true, null], [true, null], [false, { delaySeconds: 300 }]]);
});

test('batch: an exception in one message does not lose the others', async () => {
  const original = console.error;
  console.error = () => {};
  try {
    const batch = batchOf([bounced('a@example.net'), bounced('b@example.net')]);
    let calls = 0;
    await handleEmailEventBatch(batch, { notify: async () => { calls++; if (calls === 1) throw new Error('boom'); return { ok: true }; } });
    assert.deepEqual(batch.messages.map((m) => [m.acked, Boolean(m.retried)]), [[false, true], [true, false]]);
  } finally {
    console.error = original;
  }
});
