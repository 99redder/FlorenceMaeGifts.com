// Site orders: the shop_orders table (one row per paid site checkout, with the
// order number the buyer is emailed), ship-date estimates, the confirmation
// email for physical items, and the "here's your order status" email that Ask K
// sends on request (src/ask-k.js) for site orders and custom-order invoices.
//
// Nothing here shows order details anywhere but in an email to the address the
// order was placed with, so a stranger who types someone's email into the chat
// learns nothing.

import { PRICES, HANDLING_TIMES, SHIPPING } from './shop-data.js';

const SITE = 'https://www.florencemaegifts.com';
// No 0/O or 1/I/L, so a number read off a phone screen can't be mistyped.
const ORDER_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const STATUS_EMAIL_LIMIT = 10;

// ── Dates (Eastern time, business days) ────────────────────────

export function easternDate(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(date);
}

function iso(d) {
  return d.toISOString().slice(0, 10);
}

function utcDay(year, month, day) {
  return new Date(Date.UTC(year, month, day));
}

// nth (1-4) weekday of a month, or the last one when n is -1. month is 0-based.
function nthWeekday(year, month, weekday, n) {
  if (n === -1) {
    const d = utcDay(year, month + 1, 0);
    while (d.getUTCDay() !== weekday) d.setUTCDate(d.getUTCDate() - 1);
    return d;
  }
  const d = utcDay(year, month, 1);
  while (d.getUTCDay() !== weekday) d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCDate(d.getUTCDate() + 7 * (n - 1));
  return d;
}

// A fixed-date holiday on a weekend is observed on the Friday before or the Monday after.
function observed(d) {
  const out = new Date(d);
  if (out.getUTCDay() === 6) out.setUTCDate(out.getUTCDate() - 1);
  if (out.getUTCDay() === 0) out.setUTCDate(out.getUTCDate() + 1);
  return out;
}

const holidayCache = new Map();
function federalHolidays(year) {
  if (holidayCache.has(year)) return holidayCache.get(year);
  const days = [
    observed(utcDay(year, 0, 1)),
    nthWeekday(year, 0, 1, 3),      // Martin Luther King Jr. Day
    nthWeekday(year, 1, 1, 3),      // Washington's Birthday
    nthWeekday(year, 4, 1, -1),     // Memorial Day
    observed(utcDay(year, 5, 19)),  // Juneteenth
    observed(utcDay(year, 6, 4)),
    nthWeekday(year, 8, 1, 1),      // Labor Day
    nthWeekday(year, 9, 1, 2),      // Columbus Day
    observed(utcDay(year, 10, 11)), // Veterans Day
    nthWeekday(year, 10, 4, 4),     // Thanksgiving
    observed(utcDay(year, 11, 25)),
    observed(utcDay(year + 1, 0, 1)), // next New Year's Day, observed Dec 31 when it falls on a Saturday
  ];
  const set = new Set(days.map(iso));
  holidayCache.set(year, set);
  return set;
}

/** The date `n` business days after `isoDate` (weekends and U.S. federal holidays skipped). */
export function addBusinessDays(isoDate, n) {
  const d = new Date(`${isoDate}T12:00:00Z`);
  let left = n;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6 && !federalHolidays(d.getUTCFullYear()).has(iso(d))) left--;
  }
  return iso(d);
}

/** Handling window for an order placed on `orderDate` (seasonal windows end on their `through` date). */
export function handlingFor(orderDate) {
  return HANDLING_TIMES.find(w => !w.through || orderDate <= w.through) || HANDLING_TIMES[HANDLING_TIMES.length - 1];
}

/** { shipFrom, shipBy, deliverBy } for a made-to-order item, all estimates. */
export function shipEstimate(orderDate) {
  const w = handlingFor(orderDate);
  const shipBy = addBusinessDays(orderDate, w.maxDays);
  return { shipFrom: addBusinessDays(orderDate, w.minDays), shipBy, deliverBy: addBusinessDays(shipBy, SHIPPING.transitMaxDays) };
}

export function longDate(isoDate) {
  const day = String(isoDate || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return String(isoDate || '');
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric' }).format(new Date(`${day}T12:00:00Z`));
}

// ── Orders ─────────────────────────────────────────────────────

export async function ensureShopOrdersTable(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS shop_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_number TEXT NOT NULL UNIQUE,
    stripe_session_id TEXT NOT NULL UNIQUE,
    customer_email TEXT,
    customer_name TEXT,
    item_name TEXT NOT NULL,
    size_label TEXT,
    price_id TEXT,
    amount_cents INTEGER NOT NULL DEFAULT 0,
    is_digital INTEGER NOT NULL DEFAULT 0,
    order_date TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'received',
    in_production_at TEXT,
    shipped_at TEXT,
    tracking_carrier TEXT,
    tracking_number TEXT,
    tracking_url TEXT,
    delivered_at TEXT,
    confirmation_sent_at TEXT,
    last_email_status TEXT,
    last_email_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`).run();
}

function newOrderNumber() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return `FMG-${[...bytes].map(b => ORDER_ALPHABET[b % ORDER_ALPHABET.length]).join('')}`;
}

/** Item and size for a Stripe price ID; the listing name Stripe got has no size in it. */
export function describeItem(itemName, priceId) {
  const known = PRICES[String(priceId || '')];
  const item = known?.item || String(itemName || '').replace(/\s*\((Multiple Sizes Available|PDF Download Only)\)\s*$/i, '').trim() || 'Your item';
  return { item, size: known?.size || '' };
}

export function itemLabel(order) {
  return `${order.item_name}${order.size_label ? ` (${order.size_label})` : ''}`;
}

/** Saves a paid site checkout once (Stripe retries are no-ops) and returns its row. */
export async function recordShopOrder(env, { sessionId, itemName, priceId, customerEmail, customerName, amountCents, isDigital, created }) {
  await ensureShopOrdersTable(env);
  const find = () => env.DB.prepare('SELECT * FROM shop_orders WHERE stripe_session_id = ?1').bind(sessionId).first();
  const existing = await find();
  if (existing) return existing;
  const { item, size } = describeItem(itemName, priceId);
  const orderDate = easternDate(created ? new Date(Number(created) * 1000) : new Date());
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await env.DB.prepare(`INSERT INTO shop_orders
        (order_number, stripe_session_id, customer_email, customer_name, item_name, size_label, price_id, amount_cents, is_digital, order_date)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
        ON CONFLICT(stripe_session_id) DO NOTHING`)
        .bind(newOrderNumber(), sessionId, String(customerEmail || '').trim().toLowerCase() || null, customerName || null,
          item, size || null, priceId || null, Number(amountCents) || 0, isDigital ? 1 : 0, orderDate)
        .run();
      return await find();
    } catch (e) {
      // Only an order-number collision is worth another try.
      if (!/UNIQUE/i.test(String(e?.message || e))) throw e;
    }
  }
  throw new Error('Could not assign an order number');
}

// ── Emails ─────────────────────────────────────────────────────
// Same layout and rules as the invoice, quote and shipped emails in worker.js:
// the banner, dark header, pink details box and button, the LLC footer with its
// privacy line, an HTML and a plain-text version carrying the same links, sent
// from RESEND_FROM_EMAIL (orders@) with Reply-To SUPPORT_EMAIL (contact@).

export const ORDER_STATUSES = ['received', 'in_production', 'shipped', 'delivered', 'cancelled'];
// Statuses with their own customer email here; shipped uses worker.js's shipped email.
export const ORDER_EMAIL_STATUSES = ['received', 'in_production', 'delivered'];
export const ORDER_STATUS_LABELS = { received: 'Order received', in_production: 'In production', shipped: 'Shipped', delivered: 'Delivered', cancelled: 'Cancelled' };

function escapeHtml(input) {
  return String(input ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function emailShell(title, bodyHtml) {
  return `<div style="font-family:Arial,sans-serif;background:#f7fafc;padding:24px;color:#111827;"><div style="max-width:760px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;"><img src="${SITE}/images/banner3.png" alt="Florence Mae Gifts" style="width:100%;height:auto;display:block;" /><div style="padding:20px 24px;background:linear-gradient(135deg,#0f172a,#1f2937);color:#ffffff;"><div style="font-size:12px;letter-spacing:1px;text-transform:uppercase;color:#FE6666;">Florence Mae Gifts</div><h1 style="margin:6px 0 0;font-size:24px;">${escapeHtml(title)}</h1></div><div style="padding:24px;">${bodyHtml}</div><div style="padding:14px 24px;border-top:1px solid #e5e7eb;background:#f9fafb;color:#4b5563;font-size:13px;text-align:center;"><strong>Florence Mae Gifts, LLC</strong> • <a href="${SITE}" style="color:#2563eb;">www.florencemaegifts.com</a><p style="margin:6px 0 0;font-size:11px;line-height:1.45;color:#6b7280;">Privacy: We use your contact information only for order and shipping communication.</p></div></div></div>`;
}

const greetingHtml = (name) => `<p style="margin:0 0 12px;">Hi ${escapeHtml(name || 'there')},</p>`;
const paraHtml = (text) => `<p style="margin:0 0 14px;white-space:pre-wrap;color:#374151;">${escapeHtml(text)}</p>`;
const detailsHtml = (rows) => `<div style="margin:6px 0 14px;background:#fff5f5;border:1px solid #fecdd3;border-radius:10px;padding:14px 16px;color:#111827;">${rows.map(([label, value]) => `<div style="margin:0 0 4px;"><strong>${escapeHtml(label)}:</strong> ${escapeHtml(value)}</div>`).join('')}</div>`;
const buttonHtml = (url, label) => `<div style="margin:12px 0 18px;text-align:center;"><a href="${escapeHtml(url)}" style="display:inline-block;background:#FE6666;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:700;">${escapeHtml(label)}</a></div>`;
const linkHtml = (url, label) => `<p style="margin:0 0 14px;color:#374151;">${escapeHtml(label)}: <a href="${escapeHtml(url)}" style="color:#2563eb;">${escapeHtml(url)}</a></p>`;

// Blocks → { html, text }. Block kinds: ['p', text] ['details', rows] ['button', url, label] ['link', url, label]
function render(title, name, blocks) {
  const html = [greetingHtml(name)];
  const text = [`Hi ${name || 'there'},`, ''];
  for (const [kind, a, b] of blocks) {
    if (kind === 'p') { html.push(paraHtml(a)); text.push(a, ''); }
    if (kind === 'details') { html.push(detailsHtml(a)); text.push(...a.map(([l, v]) => `${l}: ${v}`), ''); }
    if (kind === 'button') { html.push(buttonHtml(a, b)); text.push(`${b}: ${a}`, ''); }
    if (kind === 'link') { html.push(linkHtml(a, b)); text.push(`${b}: ${a}`, ''); }
  }
  text.push('Florence Mae Gifts, LLC', SITE);
  return { html: emailShell(title, html.join('')), text: text.join('\n') };
}

function senderParts(env) {
  const from = (env.RESEND_FROM_EMAIL || env.FROM_EMAIL || '').toString().trim();
  const replyTo = env.SUPPORT_EMAIL || env.CONTACT_TO_EMAIL || env.TO_EMAIL || 'contact@florencemaegifts.com';
  return { from, replyTo };
}

// "November 10 – 18, 2026", "November 30 – December 4, 2026", "December 28, 2026 – January 5, 2027"
export function dateRange(fromIso, toIso) {
  const [from, to] = [new Date(`${fromIso}T12:00:00Z`), new Date(`${toIso}T12:00:00Z`)];
  const part = (d, opts) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', ...opts }).format(d);
  if (from.getUTCFullYear() !== to.getUTCFullYear()) return `${longDate(fromIso)} – ${longDate(toIso)}`;
  const sameMonth = from.getUTCMonth() === to.getUTCMonth();
  return `${part(from, { month: 'long', day: 'numeric' })} – ${sameMonth ? part(to, { day: 'numeric' }) : part(to, { month: 'long', day: 'numeric' })}, ${to.getUTCFullYear()}`;
}

function shipRange(orderDate) {
  const est = shipEstimate(orderDate);
  return dateRange(est.shipFrom, est.shipBy);
}

/**
 * Subject, html and text for the email that goes with moving a shop order to `status`
 * (received = the order confirmation, in_production, delivered). Shipped emails come
 * from buildShippedEmailContent in worker.js, which lets Megan add tracking and a note.
 */
export function buildOrderUpdateEmail(order, status) {
  const item = itemLabel(order);
  const num = order.order_number;
  if (status === 'received') {
    return {
      subject: `Your Florence Mae Gifts order is confirmed (${num})`,
      ...render('Thank You for Your Order!', order.customer_name, [
        ['p', 'Thank you for your order! Megan will crochet it by hand, just for you.'],
        ['details', [['Order Number', num], ['Item', item], ['Ordered', longDate(order.order_date)], ['Estimated Ship Date', shipRange(order.order_date)]]],
        ['p', `Every piece is made to order. It ships free by ${SHIPPING.carrier}, which usually takes ${SHIPPING.transitMinDays}–${SHIPPING.transitMaxDays} business days, and we'll email you the tracking number when it's on its way.`],
        ['p', 'Want an update any time? Tap "Need help with an order?" on our website, or just reply to this email.'],
      ]),
    };
  }
  if (status === 'in_production') {
    return {
      subject: `Your Florence Mae Gifts order is being made (${num})`,
      ...render('Your Order Is Being Made', order.customer_name, [
        ['p', 'Good news: Megan has started crocheting your order.'],
        ['details', [['Order Number', num], ['Item', item], ['Estimated Ship Date', shipRange(order.order_date)]]],
        ['p', "We'll email you the tracking number as soon as it ships. Questions? Just reply to this email."],
      ]),
    };
  }
  if (status === 'delivered') {
    return {
      subject: `Your Florence Mae Gifts order was delivered (${num})`,
      ...render('Your Order Was Delivered', order.customer_name, [
        ['p', 'Your package shows as delivered. We hope you love it!'],
        ['details', [['Order Number', num], ['Item', item], ['Delivered', longDate(order.delivered_at || easternDate())]]],
        ['p', "If anything isn't right, or the package isn't there, just reply to this email and Megan will help."],
        ['link', `${SITE}/shipping-returns.html`, 'Shipping & Returns'],
      ]),
    };
  }
  return null;
}

/** Emails the customer the update for `status` and records it on the order. @returns {Promise<boolean>} */
export async function sendOrderUpdateEmail(env, order, status, sendEmail) {
  const built = buildOrderUpdateEmail(order, status);
  if (!built || !order?.customer_email) return false;
  const { from, replyTo } = senderParts(env);
  const payload = { from, to: [order.customer_email], reply_to: replyTo, ...built };
  const bcc = (env.ORDER_EMAIL_BCC || env.ORDER_EMAIL_ALERT_TO || env.CONTACT_TO_EMAIL || '').toString().trim();
  if (bcc && bcc.toLowerCase() !== order.customer_email) payload.bcc = [bcc];
  let ok = false;
  try {
    const res = await sendEmail(env, payload);
    ok = res.ok;
    if (!ok) console.error('Order update email failed', status, await res.text());
  } catch (e) {
    console.error('Order update email failed', status, e?.message || e);
  }
  if (ok) await markOrderEmailed(env, order.id, status);
  return ok;
}

export async function markOrderEmailed(env, id, status) {
  await env.DB.prepare("UPDATE shop_orders SET last_email_status = ?2, last_email_at = datetime('now'), updated_at = datetime('now') WHERE id = ?1").bind(id, status).run();
}

/** The order confirmation for a physical site order, sent once (patterns get theirs with the download link). */
export async function sendShopOrderConfirmation(env, order, sendEmail) {
  if (!order || order.is_digital || !order.customer_email) return false;
  const claimed = await env.DB.prepare("UPDATE shop_orders SET confirmation_sent_at = 'sending' WHERE id = ?1 AND confirmation_sent_at IS NULL").bind(order.id).run();
  if (!claimed.meta?.changes) return false;
  const ok = await sendOrderUpdateEmail(env, order, 'received', sendEmail);
  await env.DB.prepare(`UPDATE shop_orders SET confirmation_sent_at = ${ok ? "datetime('now')" : 'NULL'} WHERE id = ?1`).bind(order.id).run();
  return ok;
}

// ── Order-status email (Ask K) ─────────────────────────────────

/** Site orders and sent/paid invoices for one email address, newest first. */
export async function ordersForEmail(env, email) {
  await ensureShopOrdersTable(env);
  const address = String(email || '').trim().toLowerCase();
  const shop = (await env.DB.prepare('SELECT * FROM shop_orders WHERE customer_email = ?1 ORDER BY order_date DESC, id DESC LIMIT ?2')
    .bind(address, STATUS_EMAIL_LIMIT).all()).results || [];
  const invoices = (await env.DB.prepare(`SELECT * FROM invoices WHERE lower(trim(customer_email)) = ?1 AND status IN ('sent', 'partial', 'paid')
    ORDER BY issue_date DESC, id DESC LIMIT ?2`).bind(address, STATUS_EMAIL_LIMIT).all()).results || [];
  for (const inv of invoices) {
    inv.items = ((await env.DB.prepare('SELECT item_description FROM invoice_line_items WHERE invoice_id = ?1 ORDER BY id').bind(inv.id).all()).results || [])
      .map(r => r.item_description).filter(Boolean);
  }
  return { shop, invoices };
}

function money(cents) {
  return `$${(Number(cents || 0) / 100).toFixed(2)}`;
}

function shippedText(shippedAt, carrier) {
  return `Shipped ${longDate(shippedAt)}${carrier ? ` by ${carrier}` : ''}`;
}

// Status line for a not-yet-shipped made-to-order item, honest when it runs late.
function makingText(order, today, lead) {
  const est = shipEstimate(order.order_date);
  return today > est.shipBy
    ? `${lead} It's taking a little longer than our estimate (it was due to ship by ${longDate(est.shipBy)}); reply to this email and Megan will check on it.`
    : `${lead} Estimated ship date: ${dateRange(est.shipFrom, est.shipBy)}.`;
}

function shopOrderBlocks(o, today) {
  const rows = [['Order Number', o.order_number], ['Item', itemLabel(o)], ['Ordered', longDate(o.order_date)]];
  const tracking = [];
  let status;
  if (o.status === 'cancelled') status = 'Cancelled';
  else if (o.is_digital) status = 'PDF pattern: the download link was emailed right after checkout. If it has expired, reply to this email and Megan will send the file again.';
  else if (o.status === 'delivered') status = `Delivered${o.delivered_at ? ` ${longDate(o.delivered_at)}` : ''}`;
  else if (o.status === 'shipped') status = shippedText(o.shipped_at, o.tracking_carrier);
  else if (o.status === 'in_production') status = makingText(o, today, 'Megan is making it now.');
  else status = makingText(o, today, 'Order received.');
  rows.push(['Status', status]);
  if (['shipped', 'delivered'].includes(o.status) && o.tracking_number) {
    rows.push(['Tracking Number', o.tracking_number]);
    if (o.tracking_url) tracking.push(['button', o.tracking_url, 'Track Your Package']);
  }
  return [['details', rows], ...tracking];
}

function invoiceBlocks(inv) {
  const balance = Number(inv.balance_due_cents || 0);
  const paid = inv.status === 'paid' || balance <= 0;
  const rows = [
    ['Custom Order', inv.invoice_number],
    ['Items', inv.items?.length ? inv.items.join(', ') : 'Custom order'],
    ['Invoice Date', longDate(inv.issue_date)],
    ['Payment', paid ? `Paid${inv.paid_date ? ` ${longDate(inv.paid_date)}` : ''}` : `${money(balance)} due${inv.due_date ? ` by ${longDate(inv.due_date)}` : ''}`],
    ['Status', inv.shipped_at ? shippedText(inv.shipped_at, inv.tracking_carrier) : paid ? "Megan is making it by hand; we'll email the tracking number when it ships." : 'Waiting for payment'],
  ];
  if (inv.shipped_at && inv.tracking_number) rows.push(['Tracking Number', inv.tracking_number]);
  return [['details', rows], ...(inv.shipped_at && inv.tracking_url ? [['button', inv.tracking_url, 'Track Your Package']] : [])];
}

/** Subject, html and text for the order-status email, or null when the address has no orders. */
export function buildOrderStatusEmail({ shop, invoices }, today = easternDate()) {
  if (!shop.length && !invoices.length) return null;
  const blocks = [['p', "Here's the latest on your Florence Mae Gifts order, as you asked in the order help chat on our website."]];
  for (const o of shop) blocks.push(...shopOrderBlocks(o, today));
  for (const inv of invoices) blocks.push(...invoiceBlocks(inv));
  blocks.push(
    ['p', 'Questions? Just reply to this email.'],
    ['p', "You're getting this because someone asked our order help chat for an update on orders placed with this email address. If that wasn't you, you can ignore it: nothing about your orders was shown in the chat."],
  );
  return { subject: 'Your Florence Mae Gifts order status', ...render('Your Order Status', null, blocks) };
}

/** Emails the status of every site order and invoice for `email` to that address. @returns {Promise<boolean>} whether one was sent */
export async function sendOrderStatusEmail(env, email, sendEmail) {
  const built = buildOrderStatusEmail(await ordersForEmail(env, email));
  if (!built) return false;
  const { from, replyTo } = senderParts(env);
  try {
    const res = await sendEmail(env, { from, to: [String(email).trim().toLowerCase()], reply_to: replyTo, ...built });
    if (!res.ok) console.error('Order status email failed', await res.text());
    return res.ok;
  } catch (e) {
    console.error('Order status email failed', e?.message || e);
    return false;
  }
}
