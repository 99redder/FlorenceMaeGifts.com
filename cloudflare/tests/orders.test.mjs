// src/orders.js on its own: business-day ship estimates, order numbers' item
// labels, and the wording of the order update and order-status emails.
// Run from cloudflare/: node --test tests/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { addBusinessDays, handlingFor, shipEstimate, dateRange, describeItem, buildOrderUpdateEmail, buildOrderStatusEmail } from '../src/orders.js';
import { HANDLING_TIMES, PRICES } from '../src/shop-data.js';

const ORDER = {
  id: 1, order_number: 'FMG-ABC234', customer_name: 'Pat Parent', customer_email: 'parent@example.org',
  item_name: 'Crochet Shadow Monster Baby Hat', size_label: '3-6 months', order_date: '2026-11-02',
  status: 'received', is_digital: 0
};

test('business days skip weekends and U.S. federal holidays, including observed ones', () => {
  assert.equal(addBusinessDays('2026-11-24', 3), '2026-11-30', 'Thanksgiving and the weekend are skipped');
  assert.equal(addBusinessDays('2026-07-02', 1), '2026-07-06', 'July 4, 2026 is a Saturday, observed Friday July 3');
  assert.equal(addBusinessDays('2026-11-10', 1), '2026-11-12', 'Veterans Day');
  assert.equal(addBusinessDays('2026-12-24', 1), '2026-12-28', 'Christmas Day and the weekend');
  assert.equal(addBusinessDays('2027-01-15', 1), '2027-01-19', 'Martin Luther King Jr. Day');
});

test('the handling window is picked by the order date', () => {
  const seasonal = HANDLING_TIMES.find(w => w.through);
  const standard = HANDLING_TIMES.find(w => !w.through);
  if (seasonal) {
    assert.deepEqual(handlingFor(seasonal.through), seasonal);
    assert.deepEqual(handlingFor(addBusinessDays(seasonal.through, 1)), standard);
  }
  const est = shipEstimate('2026-11-02');
  assert.equal(est.shipFrom, addBusinessDays('2026-11-02', handlingFor('2026-11-02').minDays));
  assert.equal(est.shipBy, addBusinessDays('2026-11-02', handlingFor('2026-11-02').maxDays));
  assert.ok(est.deliverBy > est.shipBy);
});

test('date ranges read naturally', () => {
  assert.equal(dateRange('2026-11-10', '2026-11-18'), 'November 10 – 18, 2026');
  assert.equal(dateRange('2026-11-30', '2026-12-04'), 'November 30 – December 4, 2026');
  assert.equal(dateRange('2026-12-28', '2027-01-05'), 'December 28, 2026 – January 5, 2027');
});

test('items are named by price ID, with the size Stripe never sees', () => {
  const [priceId, known] = Object.entries(PRICES).find(([, v]) => v.size);
  assert.deepEqual(describeItem('Anything (Multiple Sizes Available)', priceId), { item: known.item, size: known.size });
  assert.deepEqual(describeItem('Crochet Mystery Hat (Multiple Sizes Available)', 'price_unknown'), { item: 'Crochet Mystery Hat', size: '' });
});

test('order update emails use the shop layout and carry the same facts in plain text', () => {
  for (const [status, title, subject] of [
    ['received', 'Thank You for Your Order!', 'is confirmed'],
    ['in_production', 'Your Order Is Being Made', 'is being made'],
    ['delivered', 'Your Order Was Delivered', 'was delivered'],
  ]) {
    const mail = buildOrderUpdateEmail({ ...ORDER, status, delivered_at: '2026-11-20' }, status);
    assert.equal(mail.subject, `Your Florence Mae Gifts order ${subject} (FMG-ABC234)`);
    assert.match(mail.html, /images\/banner3\.png/);
    assert.ok(mail.html.includes(`>${title}</h1>`), title);
    assert.match(mail.html, /Privacy: We use your contact information only for order and shipping communication\./);
    assert.match(mail.text, /^Hi Pat Parent,/);
    assert.ok(mail.text.includes('Order Number: FMG-ABC234'));
    assert.ok(mail.text.includes('Item: Crochet Shadow Monster Baby Hat (3-6 months)'));
    assert.doesNotMatch(mail.text, /<[a-z]/i);
  }
  assert.equal(buildOrderUpdateEmail(ORDER, 'shipped'), null, 'shipped comes from the shipped email');
  const delivered = buildOrderUpdateEmail({ ...ORDER, delivered_at: '2026-11-20' }, 'delivered');
  assert.ok(delivered.text.includes('Delivered: November 20, 2026'));
  assert.ok(delivered.text.includes('Shipping & Returns: https://www.florencemaegifts.com/shipping-returns.html'));
});

test('the order-status email describes each status honestly, with tracking only once shipped', () => {
  const late = { ...ORDER, order_number: 'FMG-LATE22', order_date: '2026-09-01', status: 'in_production' };
  const shipped = { ...ORDER, order_number: 'FMG-SHIP33', status: 'shipped', shipped_at: '2026-11-12', tracking_carrier: 'USPS', tracking_number: '9400133333333333333333', tracking_url: 'https://tools.usps.com/go/TrackConfirmAction?tLabels=9400133333333333333333' };
  const pattern = { ...ORDER, order_number: 'FMG-PDF444', item_name: 'Four Star Ball Crochet Baby Hat Pattern', size_label: null, is_digital: 1 };
  const mail = buildOrderStatusEmail({
    shop: [ORDER, late, shipped, pattern, { ...ORDER, order_number: 'FMG-GONE55', status: 'cancelled' }],
    invoices: [
      { invoice_number: 'INV-1001', items: ['Custom blanket'], issue_date: '2026-10-01', status: 'paid', paid_date: '2026-10-02', balance_due_cents: 0 },
      { invoice_number: 'INV-1002', items: ['Custom hat'], issue_date: '2026-10-05', due_date: '2026-11-05', status: 'sent', balance_due_cents: 4500 },
    ],
  }, '2026-11-05');
  assert.equal(mail.subject, 'Your Florence Mae Gifts order status');
  const text = mail.text;
  assert.match(text, /^Hi there,/, 'no name: the request came from the chat');
  assert.ok(text.includes(`Status: Order received. Estimated ship date: ${dateRange(shipEstimate('2026-11-02').shipFrom, shipEstimate('2026-11-02').shipBy)}.`));
  assert.match(text, /Status: Megan is making it now\. It's taking a little longer than our estimate/);
  assert.ok(text.includes('Status: Shipped November 12, 2026 by USPS'));
  assert.ok(text.includes('Track Your Package: https://tools.usps.com/go/TrackConfirmAction?tLabels=9400133333333333333333'));
  assert.equal((mail.html.match(/Track Your Package/g) || []).length, 1, 'one tracking button, for the shipped order');
  assert.match(text, /Status: PDF pattern: the download link was emailed/);
  assert.ok(text.includes('Status: Cancelled'));
  assert.ok(text.includes('Payment: Paid October 2, 2026'));
  assert.ok(text.includes('Payment: $45.00 due by November 5, 2026'));
  assert.ok(text.includes('Status: Waiting for payment'));
  assert.doesNotMatch(text, /<[a-z]/i);
  assert.match(mail.html, /images\/banner3\.png/);
  assert.equal(buildOrderStatusEmail({ shop: [], invoices: [] }), null);
});
