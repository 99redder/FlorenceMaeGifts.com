// ===== ROUTE HANDLER INDEX =====
// POST /api/contact                 → handleContact()        — Form submissions (domain offers, questions) + email (email.js)
// POST /api/ask-k                   → handleAskK() (ask-k.js) — Public: Ask K order-help chat (Claude), hands off to the contact form
// POST /api/create-checkout-session → handleStoreCheckoutSession() — Create Stripe checkout session for shop items (priceId)
// POST /api/stripe-webhook      → handleStripeWebhook()   — Stripe payment confirmation: shop orders (pattern downloads), invoice payments, auto-inserts tax income
// POST /api/admin/login         → handleAdminLogin()      — Admin: create signed HttpOnly session cookie
// GET  /api/admin/verify-session → requireAdmin()         — Admin: validate session cookie
// POST /api/admin/logout        → handleAdminLogout()     — Admin: clear session cookie
// GET  /api/tax/transactions    → handleTaxTransactions() — Admin: tax entries by year/type
// GET  /api/tax/summary         → handleTaxSummary()      — Read-only service token: annual tax + owner-retirement totals only
// POST /api/tax/expense         → handleTaxExpense()      — Admin: add expense entry
// POST /api/tax/income          → handleTaxIncome()       — Admin: add income entry
// POST /api/tax/expense/update  → handleTaxExpenseUpdate() — Admin: edit expense entry
// POST /api/tax/income/update   → handleTaxIncomeUpdate()  — Admin: edit income entry
// POST /api/tax/expense/delete  → handleTaxExpenseDelete() — Admin: delete expense entry
// POST /api/tax/income/delete   → handleTaxIncomeDelete()  — Admin: delete income entry
// GET  /api/tax/export.csv      → handleTaxExportCsv()    — Admin: CSV export for selected year/type
// POST /api/tax/receipt/upload  → handleTaxReceiptUpload() — Admin: upload receipt to R2, attach to record
// GET  /api/tax/receipt         → handleTaxReceiptGet()   — Admin: retrieve receipt from R2
// GET  /api/accounts/list       → handleAccountsList()    — Admin: chart of accounts
// GET  /api/accounts/summary    → handleAccountsSummary() — Admin: account balances + trial balance status
// GET  /api/accounts/journal    → handleAccountsJournal() — Admin: journal entries list
// POST /api/accounts/journal    → handleAccountsJournalCreate() — Admin: manual journal entry
//
// ===== UTILITY FUNCTIONS =====
// requireAdmin(request, env)           — Validate signed HttpOnly admin session cookie
// toCents(v)                           — Convert dollar string to integer cents
// csvEscape(s)                         — Escape string for CSV output
// verifyStripeSignature(payload, sig, secret) — HMAC-SHA256 Stripe webhook verification
// json(data, status, headers)          — Build JSON Response

import { sendEmail, emailConfigured } from './email.js';
import { handleEmailEventBatch } from './email-events.js';
import { handleAskK, ASK_K_TURNSTILE_ACTION } from './ask-k.js';

// Module-level caches — safe because account IDs and setup state are stable within a Worker isolate.
const _acctIdCache = new Map();
const _contactRateLimits = new Map();
let _accountingSetupDone = false;

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self' https://api.stripe.com; frame-ancestors 'none'"
};

function withSecurityHeaders(headers = {}) {
  return { ...SECURITY_HEADERS, ...headers };
}

function todayEtDate() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date());
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function requireUsShippingAddressAndAutomaticTax(form) {
  form.append('billing_address_collection', 'required');
  form.append('automatic_tax[enabled]', 'true');
  form.append('shipping_address_collection[allowed_countries][0]', 'US');
}

export default {
  async fetch(request, env) {
    try {
    const origin = request.headers.get('Origin') || '';
    const allowedOrigins = (env.ALLOWED_ORIGINS || env.ALLOWED_ORIGIN || '')
      .split(',')
      .map(v => v.trim())
      .filter(Boolean);
    const allowAll = allowedOrigins.includes('*');
    // No Origin header = direct browser navigation (new tab link), not a cross-origin fetch — always allow.
    const originAllowed = allowAll || !origin || allowedOrigins.includes(origin);

    const corsHeaders = {
      'Access-Control-Allow-Origin': allowAll ? '*' : (originAllowed ? origin : allowedOrigins[0] || ''),
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Tax-Read-Token',
      ...(allowAll ? {} : { 'Access-Control-Allow-Credentials': 'true' }),
      'Vary': 'Origin'
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(request.url);

    // Stripe webhook comes from Stripe servers (no browser Origin), so skip origin check there.
    if (url.pathname !== '/api/stripe-webhook') {
      const isTaxRead = ['/api/tax/transactions','/api/tax/summary','/api/tax/export.csv','/api/tax/receipt'].includes(url.pathname) && request.method === 'GET';
      const isTaxWrite = ['/api/tax/expense','/api/tax/income','/api/tax/owner-transfer','/api/tax/expense/update','/api/tax/income/update','/api/tax/expense/delete','/api/tax/income/delete','/api/tax/receipt/upload'].includes(url.pathname) && request.method === 'POST';
      const isAccountsRead = ['/api/accounts/list','/api/accounts/summary','/api/accounts/journal','/api/accounts/statements','/api/accounts/invoices','/api/accounts/invoices/detail','/api/accounts/quotes','/api/accounts/quotes/detail','/api/accounts/notes','/api/admin/notes'].includes(url.pathname) && request.method === 'GET';
      const isAccountsWrite = ['/api/accounts/journal','/api/accounts/rebuild-auto-journal','/api/accounts/year-close','/api/accounts/invoices','/api/accounts/invoices/update','/api/accounts/invoices/status','/api/accounts/invoices/payment','/api/accounts/invoices/payment-link','/api/accounts/invoices/send','/api/accounts/invoices/shipped','/api/accounts/invoices/shipped/preview','/api/accounts/invoices/delete','/api/accounts/quotes','/api/accounts/quotes/update','/api/accounts/quotes/delete','/api/accounts/quotes/send','/api/accounts/quotes/convert','/api/accounts/notes','/api/admin/notes'].includes(url.pathname) && request.method === 'POST';
      const isQuotePublic = ['/api/quote/accept','/api/quote/deny'].includes(url.pathname) && ['GET', 'POST'].includes(request.method);
      const isInvoicePublic = ['/invoice/payment-success','/invoice/payment-cancelled'].includes(url.pathname) && request.method === 'GET';
      const isDownloadRead = url.pathname === '/api/download' && request.method === 'GET';
      const isCheckoutSessionDetailsRead = url.pathname === '/api/checkout-session-details' && request.method === 'GET';
      const isHealthRead = url.pathname === '/api/health' && request.method === 'GET';
      const isPostRoute = ['/api/contact', '/api/create-checkout-session', '/api/ask-k'].includes(url.pathname) && request.method === 'POST';
      const isAdminSessionRoute = (url.pathname === '/api/admin/verify-session' && request.method === 'GET')
        || (url.pathname === '/api/admin/login' && request.method === 'POST')
        || (url.pathname === '/api/admin/logout' && request.method === 'POST')
        || (url.pathname === '/api/admin/emergency/status' && request.method === 'GET')
        || (['/api/admin/emergency/request', '/api/admin/emergency/verify'].includes(url.pathname) && request.method === 'POST');
      if (!isTaxRead && !isTaxWrite && !isAccountsRead && !isAccountsWrite && !isPostRoute && !isQuotePublic && !isInvoicePublic && !isDownloadRead && !isCheckoutSessionDetailsRead && !isAdminSessionRoute && !isHealthRead) {
        return json({ ok: false, error: 'Method not allowed' }, 405, corsHeaders);
      }

      // Public quote accept/deny, invoice landing, download, and checkout-session-details reads don't require strict origin check.
      if (!originAllowed && !isQuotePublic && !isInvoicePublic && !isDownloadRead && !isCheckoutSessionDetailsRead && !isHealthRead) {
        return json({ ok: false, error: 'Origin not allowed' }, 403, corsHeaders);
      }
    }

    if (url.pathname === '/api/health' && request.method === 'GET') {
      return json({ ok: true, service: 'fmg-stripe-api' }, 200, corsHeaders);
    }

    if (url.pathname === '/api/contact') {
      return handleContact(request, env, corsHeaders);
    }

    if (url.pathname === '/api/ask-k' && request.method === 'POST') {
      return handleAskK(request, env, {
        reply: (payload, status) => json(payload, status, corsHeaders),
        ip: getClientIp(request),
        verifyTurnstile: (token) => verifyTurnstile(env, request, token, ASK_K_TURNSTILE_ACTION),
        notify: (subject, text) => sendAskKAlert(env, subject, text)
      });
    }

    if (url.pathname === '/api/admin/verify-session' && request.method === 'GET') {
      const auth = await requireAdmin(request, env, corsHeaders, url);
      if (!auth.ok) return auth.res;
      return json({ ok: true }, 200, corsHeaders);
    }

    if (url.pathname === '/api/admin/login' && request.method === 'POST') {
      return handleAdminLogin(request, env, corsHeaders);
    }

    if (url.pathname === '/api/admin/logout' && request.method === 'POST') {
      return handleAdminLogout(corsHeaders);
    }

    if (url.pathname === '/api/admin/emergency/status' && request.method === 'GET') {
      return handleEmergencyStatus(env, corsHeaders);
    }

    if (url.pathname === '/api/admin/emergency/request' && request.method === 'POST') {
      return handleEmergencyRequest(request, env, corsHeaders);
    }

    if (url.pathname === '/api/admin/emergency/verify' && request.method === 'POST') {
      return handleEmergencyVerify(request, env, corsHeaders);
    }


    if (url.pathname === '/api/create-checkout-session') {
      return handleStoreCheckoutSession(request, env, corsHeaders, originAllowed, allowedOrigins);
    }

    if (url.pathname === '/api/stripe-webhook') {
      return handleStripeWebhook(request, env, corsHeaders);
    }

    if (url.pathname === '/api/download' && request.method === 'GET') {
      return handleDownload(request, env, corsHeaders);
    }

    if (url.pathname === '/api/checkout-session-details' && request.method === 'GET') {
      return handleCheckoutSessionDetails(request, env, corsHeaders, url);
    }








    if (url.pathname === '/api/tax/transactions') {
      return handleTaxTransactions(request, env, corsHeaders, url);
    }

    if (url.pathname === '/api/tax/summary') {
      return handleTaxSummary(request, env, corsHeaders, url);
    }

    if (url.pathname === '/api/tax/expense') {
      return handleTaxExpense(request, env, corsHeaders, url);
    }

    if (url.pathname === '/api/tax/expense/update') {
      return handleTaxExpenseUpdate(request, env, corsHeaders, url);
    }

    if (url.pathname === '/api/tax/expense/delete') {
      return handleTaxExpenseDelete(request, env, corsHeaders, url);
    }

    if (url.pathname === '/api/tax/income') {
      return handleTaxIncome(request, env, corsHeaders, url);
    }

    if (url.pathname === '/api/tax/owner-transfer') {
      return handleTaxOwnerTransfer(request, env, corsHeaders, url);
    }

    if (url.pathname === '/api/tax/income/update') {
      return handleTaxIncomeUpdate(request, env, corsHeaders, url);
    }

    if (url.pathname === '/api/tax/income/delete') {
      return handleTaxIncomeDelete(request, env, corsHeaders, url);
    }

    if (url.pathname === '/api/tax/export.csv') {
      return handleTaxExportCsv(request, env, corsHeaders, url);
    }

    if (url.pathname === '/api/tax/receipt/upload') {
      return handleTaxReceiptUpload(request, env, corsHeaders, url);
    }

    if (url.pathname === '/api/tax/receipt') {
      return handleTaxReceiptGet(request, env, corsHeaders, url);
    }

    if (url.pathname === '/api/accounts/list') {
      return handleAccountsList(request, env, corsHeaders, url);
    }

    if (url.pathname === '/api/admin/notes' && request.method === 'GET') {
      return handleAdminNotesList(request, env, corsHeaders, url);
    }

    if (url.pathname === '/api/admin/notes' && request.method === 'POST') {
      return handleAdminNotesCreate(request, env, corsHeaders, url);
    }

    if (url.pathname === '/api/accounts/summary') {
      return await handleAccountsSummary(request, env, corsHeaders, url);
    }

    if (url.pathname === '/api/accounts/journal' && request.method === 'GET') {
      return await handleAccountsJournal(request, env, corsHeaders, url);
    }

    if (url.pathname === '/api/accounts/notes' && request.method === 'GET') {
      return handleAdminNotesList(request, env, corsHeaders, url);
    }

    if (url.pathname === '/api/accounts/statements' && request.method === 'GET') {
      return await handleAccountsStatements(request, env, corsHeaders, url);
    }

    if (url.pathname === '/api/accounts/invoices' && request.method === 'GET') {
      return await handleInvoicesList(request, env, corsHeaders, url);
    }

    if (url.pathname === '/api/accounts/invoices/detail' && request.method === 'GET') {
      return await handleInvoiceDetail(request, env, corsHeaders, url);
    }

    if (url.pathname === '/api/accounts/journal' && request.method === 'POST') {
      return await handleAccountsJournalCreate(request, env, corsHeaders, url);
    }

    if (url.pathname === '/api/accounts/notes' && request.method === 'POST') {
      return handleAdminNotesCreate(request, env, corsHeaders, url);
    }

    if (url.pathname === '/api/accounts/invoices' && request.method === 'POST') {
      return handleInvoiceCreate(request, env, corsHeaders, url);
    }

    if (url.pathname === '/api/accounts/invoices/update' && request.method === 'POST') {
      return handleInvoiceUpdate(request, env, corsHeaders, url);
    }

    if (url.pathname === '/api/accounts/invoices/status' && request.method === 'POST') {
      return handleInvoiceStatus(request, env, corsHeaders, url);
    }

    if (url.pathname === '/api/accounts/invoices/payment' && request.method === 'POST') {
      return handleInvoicePayment(request, env, corsHeaders, url);
    }

    if (url.pathname === '/api/accounts/invoices/payment-link' && request.method === 'POST') {
      return handleInvoicePaymentLink(request, env, corsHeaders, url);
    }

    if (url.pathname === '/api/accounts/invoices/send' && request.method === 'POST') {
      return handleInvoiceSend(request, env, corsHeaders, url);
    }

    if (url.pathname === '/api/accounts/invoices/shipped/preview' && request.method === 'POST') {
      return handleInvoiceShippedPreview(request, env, corsHeaders, url);
    }

    if (url.pathname === '/api/accounts/invoices/shipped' && request.method === 'POST') {
      return handleInvoiceShippedEmail(request, env, corsHeaders, url);
    }

    if (url.pathname === '/api/accounts/invoices/delete' && request.method === 'POST') {
      return handleInvoiceDelete(request, env, corsHeaders, url);
    }

    // Quotes routes
    if (url.pathname === '/api/accounts/quotes' && request.method === 'GET') {
      return handleQuotesList(request, env, corsHeaders, url);
    }

    if (url.pathname === '/api/accounts/quotes/detail' && request.method === 'GET') {
      return handleQuoteDetail(request, env, corsHeaders, url);
    }

    if (url.pathname === '/api/accounts/quotes' && request.method === 'POST') {
      return handleQuoteCreate(request, env, corsHeaders, url);
    }

    if (url.pathname === '/api/accounts/quotes/update' && request.method === 'POST') {
      return handleQuoteUpdate(request, env, corsHeaders, url);
    }

    if (url.pathname === '/api/accounts/quotes/delete' && request.method === 'POST') {
      return handleQuoteDelete(request, env, corsHeaders, url);
    }

    if (url.pathname === '/api/accounts/quotes/send' && request.method === 'POST') {
      return handleQuoteSend(request, env, corsHeaders, url);
    }

    if (url.pathname === '/api/accounts/quotes/convert' && request.method === 'POST') {
      return handleQuoteConvert(request, env, corsHeaders, url);
    }

    // Public quote accept/deny endpoints (no admin auth required, token-based).
    // GET shows a confirmation page; only its button (POST) changes the quote.
    if (url.pathname === '/api/quote/accept' && ['GET', 'POST'].includes(request.method)) {
      return handleQuoteAccept(request, env, corsHeaders, url);
    }

    if (url.pathname === '/api/quote/deny' && ['GET', 'POST'].includes(request.method)) {
      return handleQuoteDeny(request, env, corsHeaders, url);
    }

    if (url.pathname === '/api/accounts/rebuild-auto-journal' && request.method === 'POST') {
      return handleAccountsRebuildAutoJournal(request, env, corsHeaders, url);
    }

    if (url.pathname === '/api/accounts/year-close' && request.method === 'POST') {
      return handleAccountsYearClose(request, env, corsHeaders, url);
    }


    if (url.pathname === '/invoice/payment-success' && request.method === 'GET') {
      return handleInvoicePaymentSuccessPage(request, env, corsHeaders, url);
    }

    if (url.pathname === '/invoice/payment-cancelled' && request.method === 'GET') {
      return handleInvoicePaymentCancelledPage(request, env, corsHeaders, url);
    }

    return json({ ok: false, error: 'Not found' }, 404, corsHeaders);
    } catch (err) {
      const origin = request.headers.get('Origin') || '';
      const allowedOrigins = (env.ALLOWED_ORIGINS || env.ALLOWED_ORIGIN || '')
        .split(',')
        .map(v => v.trim())
        .filter(Boolean);
      const allowAll = allowedOrigins.includes('*');
      const originAllowed = allowAll || !origin || allowedOrigins.includes(origin);
      const corsHeaders = {
        'Access-Control-Allow-Origin': allowAll ? '*' : (originAllowed ? origin : allowedOrigins[0] || ''),
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        ...(allowAll ? {} : { 'Access-Control-Allow-Credentials': 'true' }),
        'Vary': 'Origin'
      };
      // Details go to Workers Logs, not to whoever sent the request.
      console.error('Unhandled worker error', request.method, new URL(request.url).pathname, err);
      return json({ ok: false, error: 'Something went wrong. Please try again.' }, 500, corsHeaders);
    }
  },

  // Bounced / failed / rejected / spam-flagged emails, from the Email Sending
  // event subscription on the florencemaegifts-email-events queue.
  async queue(batch, env) {
    const alertTo = (env.ORDER_EMAIL_ALERT_TO || env.CONTACT_TO_EMAIL || env.TO_EMAIL || '').toString().trim();
    const fromEmail = (env.RESEND_FROM_EMAIL || env.FROM_EMAIL || '').toString().trim();
    return handleEmailEventBatch(batch, {
      notify: ({ subject, text }) => sendEmail(env, { from: fromEmail, to: [alertTo], subject, text }),
      internalAddresses: [alertTo, fromEmail.match(/<([^>]+)>/)?.[1] || fromEmail, env.SUPPORT_EMAIL, env.CONTACT_TO_EMAIL, env.ORDER_EMAIL_BCC]
    });
  }
};

// Contact modal topics (footer.html) and the optional fields each one can add, in email order.
const CONTACT_TOPICS = {
  general: 'General question',
  order: 'Question about an order',
  custom: 'Custom piece request',
  sizing: 'Sizing help',
  pattern: 'Pattern or download help',
  return: 'Return or refund'
};
const CONTACT_DETAIL_FIELDS = [
  ['orderNumber', 'Order #'],
  ['item', 'Item'],
  ['pieceType', 'Type of piece'],
  ['size', 'Size or age'],
  ['childAge', "Child's age"],
  ['headSize', 'Head circumference'],
  ['neededBy', 'Needed by'],
  ['phone', 'Phone']
];

/**
 * POST /api/contact — Process contact form submissions and email them (email.js)
 * @param {Request} request - JSON body: {name, email, message, mode, topic?, orderNumber?, item?, pieceType?, size?, childAge?, headSize?, neededBy?, phone?, askKChat?, offer?, website? (honeypot)}
 * @param {Object} env - Worker env (EMAIL binding or RESEND_API_KEY, TO_EMAIL, FROM_EMAIL)
 * @param {Object} corsHeaders
 * @returns {Response} {ok: true} or {ok: false, error: string}
 */
async function handleContact(request, env, corsHeaders) {
  const limited = checkContactRateLimit(request, corsHeaders);
  if (limited) return limited;

  let data;
  try {
    data = await request.json();
  } catch {
    return json({ ok: false, error: 'Invalid JSON' }, 400, corsHeaders);
  }

  const mode = (data.mode || 'contact').toString();
  const name = (data.name || '').toString().trim();
  const email = (data.email || '').toString().trim();
  const offer = (data.offer || '').toString().trim();
  const message = (data.message || '').toString().trim();
  const website = (data.website || '').toString().trim(); // honeypot

  if (website) {
    return json({ ok: true }, 200, corsHeaders);
  }

  if (!name || !email || !message) {
    return json({ ok: false, error: 'Missing required fields' }, 400, corsHeaders);
  }

  if (!isValidEmail(email)) {
    return json({ ok: false, error: 'Invalid email address' }, 400, corsHeaders);
  }

  if (!emailConfigured(env) || (!env.CONTACT_TO_EMAIL && !env.TO_EMAIL) || (!env.RESEND_FROM_EMAIL && !env.FROM_EMAIL)) {
    return json({ ok: false, error: 'Email provider not configured' }, 500, corsHeaders);
  }

  // The site's contact modal sends a topic plus that topic's extra fields. Older
  // cached pages may still send the retired custom form (mode 'custom', requestType).
  const oneLine = (value, max = 200) => (value || '').toString().replace(/[\r\n]+/g, ' ').trim().slice(0, max);
  const topicKey = oneLine(data.topic) || (mode === 'custom' ? 'custom' : 'general');
  const topic = CONTACT_TOPICS[topicKey] || CONTACT_TOPICS.general;
  const details = { ...data, pieceType: data.pieceType || data.requestType };
  const detailLines = CONTACT_DETAIL_FIELDS
    .map(([key, label]) => [label, oneLine(details[key])])
    .filter(([, value]) => value)
    .map(([label, value]) => `${label}: ${value}`);
  const orderNumber = oneLine(data.orderNumber, 60);
  // Sent when the form was opened from Ask K, so Megan sees what was already asked.
  const askKChat = (data.askKChat || '').toString().replace(/\r/g, '').trim().slice(0, 8000);

  const subject = mode === 'offer'
    ? `Domain Offer: florencemaegifts.com (${offer || 'no amount'})`
    : `Florence Mae Gifts: ${topic} from ${oneLine(name, 100)}${orderNumber ? ` (order ${orderNumber})` : ''}`;

  const text = mode === 'offer'
    ? [
      `Mode: ${mode}`,
      `Name: ${name}`,
      `Email: ${email}`,
      `Offer/Budget: ${offer || '(not provided)'}`,
      '',
      'Message:',
      message || '(none)'
    ].join('\n')
    : [
      `Topic: ${topic}`,
      `Name: ${name}`,
      `Email: ${email}`,
      ...detailLines,
      '',
      'Message:',
      message.slice(0, 5000),
      ...(askKChat ? ['', 'Their chat with Ask K before sending this:', askKChat] : []),
      '',
      'Reply to this email to answer them directly.'
    ].join('\n');

  const emailPayload = {
    from: env.RESEND_FROM_EMAIL || env.FROM_EMAIL,
    to: [env.CONTACT_TO_EMAIL || env.TO_EMAIL],
    subject,
    text,
    reply_to: email
  };

  if (env.CC_EMAIL) {
    emailPayload.cc = [env.CC_EMAIL];
  }

  const resendRes = await sendEmail(env, emailPayload);

  if (!resendRes.ok) {
    const errText = await resendRes.text();
    console.error('Contact form email failed', errText);
    return json({ ok: false, error: 'Email provider failed' }, 502, corsHeaders);
  }

  return json({ ok: true }, 200, corsHeaders);
}

function parseAllowedPriceIds(raw) {
  return new Set(String(raw || '')
    .split(',')
    .map(v => v.trim())
    .filter(v => v.startsWith('price_')));
}

/**
 * POST /api/create-checkout-session — Create Stripe checkout for FMG shop items by Stripe price id
 * @param {Request} request - JSON body: { selectedItemName, priceId }
 * @param {Object} env - Worker env (STRIPE_SECRET_KEY)
 * @returns {Response} {ok: true, url, id} or error
 */
async function handleStoreCheckoutSession(request, env, corsHeaders, originAllowed, allowedOrigins) {
  if (!env.STRIPE_SECRET_KEY) {
    return json({ ok: false, error: 'Stripe not configured' }, 500, corsHeaders);
  }

  let data = {};
  try {
    data = await request.json();
  } catch {
    return json({ ok: false, error: 'Invalid JSON' }, 400, corsHeaders);
  }

  const priceId = (data.priceId || '').toString().trim();
  const selectedItemName = (data.selectedItemName || '').toString().trim();

  if (!priceId || !priceId.startsWith('price_')) {
    return json({ ok: false, error: 'Missing or invalid Stripe price id.' }, 400, corsHeaders);
  }
  if (!selectedItemName) {
    return json({ ok: false, error: 'Missing selected item name.' }, 400, corsHeaders);
  }

  const allowedPriceIds = parseAllowedPriceIds(env.STORE_ALLOWED_PRICE_IDS);
  if (!allowedPriceIds.size) {
    return json({ ok: false, error: 'Store checkout is not configured' }, 500, corsHeaders);
  }
  if (!allowedPriceIds.has(priceId)) {
    return json({ ok: false, error: 'Unknown Stripe price id.' }, 400, corsHeaders);
  }

  const requestOrigin = (request.headers.get('Origin') || '').trim();
  const configuredOrigin = allowedOrigins.find((o) => o && o !== '*') || 'https://www.florencemaegifts.com';
  const siteOrigin = (originAllowed && requestOrigin)
    ? requestOrigin
    : configuredOrigin;
  const successUrl = `${siteOrigin}/index.html?checkout=success&session_id={CHECKOUT_SESSION_ID}`;
  const cancelUrl = `${siteOrigin}/index.html?checkout=cancel`;

  const isDigitalDownload = hasDownloadFileMapping(env, selectedItemName, priceId);
  const body = new URLSearchParams({
    mode: 'payment',
    success_url: successUrl,
    cancel_url: cancelUrl,
    billing_address_collection: 'required',
    'automatic_tax[enabled]': 'true',
    'line_items[0][price]': priceId,
    'line_items[0][quantity]': '1',
    'metadata[item_name]': selectedItemName,
    'metadata[price_id]': priceId,
    'metadata[checkout_type]': 'fmg_shop_item'
  });

  if (!isDigitalDownload) {
    body.set('shipping_address_collection[allowed_countries][0]', 'US');
  }

  const stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: body.toString()
  });

  const stripeData = await stripeRes.json().catch(() => ({}));
  if (!stripeRes.ok || !stripeData?.url || !stripeData?.id) {
    console.error('Shop checkout session failed', stripeData?.error || stripeData);
    return json({ ok: false, error: 'Stripe session failed' }, 502, corsHeaders);
  }

  return json({ ok: true, url: stripeData.url, id: stripeData.id }, 200, corsHeaders);
}

/**
 * POST /api/stripe-webhook — Verify Stripe signature, upsert booking as paid, auto-insert tax income
 * @param {Request} request - Raw body with Stripe-Signature header
 * @param {Object} env - Worker env (STRIPE_WEBHOOK_SECRET, DB)
 * @returns {Response} {ok: true} or error
 */
async function handleStripeWebhook(request, env, corsHeaders) {
  if (request.method !== 'POST') {
    return json({ ok: false, error: 'Method not allowed' }, 405, corsHeaders);
  }

  if (!env.STRIPE_WEBHOOK_SECRET) {
    return json({ ok: false, error: 'Webhook secret not configured' }, 500, corsHeaders);
  }

  const sig = request.headers.get('Stripe-Signature') || '';
  const payload = await request.text();

  const verified = await verifyStripeSignature(payload, sig, env.STRIPE_WEBHOOK_SECRET);
  if (!verified.ok) {
    console.error('Stripe webhook signature verification failed', verified.reason || 'invalid signature');
    return new Response('Invalid signature', { status: 400, headers: withSecurityHeaders(corsHeaders) });
  }

  let event;
  try {
    event = JSON.parse(payload);
  } catch {
    return json({ ok: false, error: 'Invalid JSON payload' }, 400, corsHeaders);
  }

  if (!env.DB) {
    const session = event.data?.object || {};
    if (event.type === 'checkout.session.completed') {
      const checkoutType = (session.metadata?.checkout_type || '').toString().trim().toLowerCase();
      const itemName = (session.metadata?.item_name || session.metadata?.selectedItemName || '').toString().trim();
      const priceId = (session.metadata?.price_id || '').toString().trim();
      const isFmgShopItem = checkoutType === 'fmg_shop_item' || !!itemName;
      if (isFmgShopItem && hasDownloadFileMapping(env, itemName, priceId)) {
        await fulfillFmgShopOrder(env, {
          sessionId: (session.id || '').toString().trim(),
          itemName,
          priceId,
          customerEmail: session.customer_details?.email || session.customer_email || null,
          customerName: session.metadata?.customer_name || session.customer_details?.name || null
        });
      }
    }
    await alertFmgOperationalFailure(env, {
      subject: '[ACTION NEEDED] FMG Stripe webhook DB binding missing',
      detail: 'A Stripe webhook was acknowledged while the D1 DB binding was missing. Review Stripe and D1 manually.',
      session
    });
    return json({ ok: true, warning: 'DB binding missing' }, 200, corsHeaders);
  }

  if (event.type === 'checkout.session.expired') {
    const session = event.data?.object || {};
    const sessionId = (session.id || '').toString().trim();
    if (sessionId) {
      await env.DB.prepare(`DELETE FROM bookings WHERE status = 'pending' AND stripe_session_id = ?1`).bind(sessionId).run();
    }
    return json({ ok: true }, 200, corsHeaders);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data?.object || {};
    const sessionId = session.id || null;

    if ((session.metadata?.checkout_type || '').toString() === 'invoice_payment') {
      const invoiceId = Number(session.metadata?.invoice_id || 0);
      const amount = Math.round(Number(session.amount_total ?? 0));
      const paymentEventId = (event.id || sessionId || '').toString().trim();

      if (!invoiceId || amount <= 0 || !paymentEventId) {
        return json({ ok: false, error: 'Invalid invoice checkout metadata' }, 400, corsHeaders);
      }

      try {
        const paymentResult = await applyInvoicePayment(env.DB, {
          invoiceId,
          requestedPaymentCents: amount,
          paymentEventId,
          incomeDate: event.created ? new Date(event.created * 1000).toISOString().slice(0, 10) : undefined,
          incomeSource: 'Stripe Invoice Checkout',
          incomeCategory: 'Service Revenue',
          incomeNotes: `Stripe invoice checkout completed | invoice_id=${invoiceId} | invoice_number=${session.metadata?.invoice_number || ''} | session_id=${sessionId || ''}`,
          stripeSessionIdForBooks: sessionId || null
        });

        await env.DB.prepare(
          `UPDATE invoices
           SET amount_paid_cents = COALESCE(?1, amount_paid_cents),
               balance_due_cents = COALESCE(?2, balance_due_cents),
               status = COALESCE(?3, status),
               paid_date = CASE WHEN COALESCE(?2, balance_due_cents) = 0 THEN COALESCE(paid_date, date('now')) ELSE paid_date END,
               stripe_checkout_session_id = COALESCE(?4, stripe_checkout_session_id),
               stripe_checkout_url = COALESCE(?5, stripe_checkout_url),
               stripe_payment_status = 'paid',
               stripe_payment_completed_at = datetime('now'),
               updated_at = datetime('now')
           WHERE id = ?6`
        ).bind(
          Number(paymentResult?.amountPaidCents ?? null),
          Number(paymentResult?.balanceDueCents ?? null),
          (paymentResult?.status || null),
          sessionId || null,
          session.url || null,
          invoiceId
        ).run();

        // Auto-insert Stripe processing fee for invoice checkout (deduped by session id)
        const paymentIntentId = (session.payment_intent || '').toString().trim();
        let feeCents = await fetchStripeFeeCents(env.STRIPE_SECRET_KEY, paymentIntentId);
        let feeWasEstimated = false;
        if (feeCents <= 0) {
          feeCents = estimateStripeFeeCents(amount);
          feeWasEstimated = feeCents > 0;
        }
        if (feeCents > 0 && sessionId) {
          const feeNote = feeWasEstimated
            ? `Estimated Stripe fee for invoice session ${sessionId}`
            : `Auto Stripe fee for invoice session ${sessionId}`;
          const existingFee = await env.DB.prepare(
            `SELECT id FROM tax_expenses WHERE notes IN (?1, ?2) LIMIT 1`
          ).bind(
            `Auto Stripe fee for invoice session ${sessionId}`,
            `Estimated Stripe fee for invoice session ${sessionId}`
          ).first();

          if (!existingFee?.id) {
            const feeDate = event.created ? new Date(event.created * 1000).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
            const insFee = await env.DB.prepare(
              `INSERT INTO tax_expenses (expense_date, vendor, category, amount_cents, paid_via, notes)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
            ).bind(
              feeDate,
              'Stripe',
              'Payment Processing Fees',
              feeCents,
              'stripe',
              feeNote
            ).run();
            const feeId = Number(insFee.meta?.last_row_id || 0) || null;
            if (feeId) {
              await upsertTaxExpenseJournal(env.DB, {
                id: feeId,
                expense_date: feeDate,
                vendor: 'Stripe',
                category: 'Payment Processing Fees',
                amount_cents: feeCents,
                paid_via: 'stripe',
                notes: feeNote
              });
            }
          }
        }
      } catch (e) {
        console.error('Invoice Stripe webhook handling failed', e);
        await alertFmgOperationalFailure(env, {
          subject: '[ACTION NEEDED] FMG invoice Stripe webhook failed',
          detail: `Invoice checkout webhook failed after Stripe reported payment. Stripe was acknowledged to avoid duplicate retry side effects. Error: ${e?.message || e}`,
          session
        });
        return json({ ok: true, warning: `Invoice webhook failed: ${e?.message || e}` }, 200, corsHeaders);
      }

      return json({ ok: true }, 200, corsHeaders);
    }

    const setupDate = session.metadata?.setup_date || null;
    const setupTime = session.metadata?.setup_time || null;
    const setupAt = session.metadata?.setup_at || (setupDate && setupTime ? `${setupDate}T${setupTime}` : null);
    const customerName = session.metadata?.customer_name || session.customer_details?.name || null;
    const customerEmail = session.customer_details?.email || session.customer_email || null;
    const customerPhone = session.metadata?.customer_phone || null;
    const preferredContactMethod = (session.metadata?.preferred_contact_method || 'email').toString();
    const serviceType = (session.metadata?.service_type || 'openclaw_setup').toString();
    const serviceLabel = (session.metadata?.service_label || '').toString().trim();
    const checkoutType = (session.metadata?.checkout_type || '').toString().trim().toLowerCase();
    const itemName = (session.metadata?.item_name || session.metadata?.selectedItemName || '').toString().trim();
    const priceId = (session.metadata?.price_id || '').toString().trim();
    const isFmgShopItem = checkoutType === 'fmg_shop_item' || !!itemName;
    const isDigitalDownload = isFmgShopItem && hasDownloadFileMapping(env, itemName, priceId);
    const incomeCategory = isFmgShopItem ? 'Florence Mae Gifts Shop' : (serviceType === 'lessons' ? 'AI Lessons' : 'OpenClaw Setup');
    const incomeSource = isFmgShopItem ? 'Stripe - Florence Mae Gifts Shop' : (serviceType === 'lessons' ? 'Stripe - Lessons' : 'Stripe');
    const amount = Number(session.amount_total ?? 0);
    let downloadUrl = null;

    if (sessionId) {
      try {
        let slots = [];
        if (!isFmgShopItem) {
          try {
            const parsed = JSON.parse(session.metadata?.slots_json || '[]');
            if (Array.isArray(parsed)) {
              slots = parsed
                .map((s) => ({
                  setupDate: (s?.setupDate || '').toString().trim(),
                  setupTime: (s?.setupTime || '').toString().trim()
                }))
                .filter((s) => s.setupDate && s.setupTime);
            }
          } catch {}
          if (!slots.length && setupDate && setupTime) {
            slots = [{ setupDate, setupTime }];
          }
        }

        if (!isFmgShopItem) {
          const splitAmount = Math.round(amount / Math.max(slots.length, 1));
          for (let i = 0; i < slots.length; i++) {
          const slot = slots[i];
          const slotAt = `${slot.setupDate}T${slot.setupTime}`;
          const slotAmount = i === 0 ? (amount - (splitAmount * (slots.length - 1))) : splitAmount;

          const existingSlotBooking = await env.DB.prepare(
            `SELECT id FROM bookings WHERE stripe_session_id = ?1 AND setup_at = ?2 LIMIT 1`
          ).bind(sessionId, slotAt).first();

          if (existingSlotBooking?.id) {
            await env.DB.prepare(
              `UPDATE bookings
               SET stripe_payment_intent_id = COALESCE(?1, stripe_payment_intent_id),
                   status = 'paid',
                   setup_date = COALESCE(?2, setup_date),
                   setup_time = COALESCE(?3, setup_time),
                   setup_at = COALESCE(?4, setup_at),
                   customer_name = COALESCE(?5, customer_name),
                   customer_email = COALESCE(?6, customer_email),
                   customer_phone = COALESCE(?7, customer_phone),
                   preferred_contact_method = COALESCE(?8, preferred_contact_method),
                   amount_cents = COALESCE(?9, amount_cents),
                   service_type = COALESCE(?10, service_type),
                   paid_at = datetime('now'),
                   updated_at = datetime('now')
               WHERE id = ?11`
            ).bind(
              session.payment_intent || null,
              slot.setupDate,
              slot.setupTime,
              slotAt,
              customerName,
              customerEmail,
              customerPhone,
              preferredContactMethod,
              slotAmount,
              serviceType,
              existingSlotBooking.id
            ).run();
          } else {
            await env.DB.prepare(
              `INSERT INTO bookings (
                stripe_session_id, stripe_payment_intent_id, status,
                setup_date, setup_time, setup_at,
                customer_name, customer_email, customer_phone, preferred_contact_method, amount_cents, service_type, paid_at
              ) VALUES (?1, ?2, 'paid', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, datetime('now'))`
            ).bind(
              sessionId,
              session.payment_intent || null,
              slot.setupDate,
              slot.setupTime,
              slotAt,
              customerName,
              customerEmail,
              customerPhone,
              preferredContactMethod,
              slotAmount,
              serviceType
            ).run();
            }
          }
        }

        // Use the payment event timestamp for accounting date, not the appointment date
        const incomeDate = event.created
          ? new Date(event.created * 1000).toISOString().slice(0, 10)
          : new Date().toISOString().slice(0, 10);

        const existingIncome = await env.DB.prepare(
          `SELECT id FROM tax_income WHERE stripe_session_id = ?1 LIMIT 1`
        ).bind(sessionId).first();

        const incomeNotes = customerName
          ? `Auto-imported from Stripe checkout (${itemName || serviceLabel || incomeCategory}) for ${customerName}`
          : `Auto-imported from Stripe checkout (${itemName || serviceLabel || incomeCategory})`;
        let incomeId = Number(existingIncome?.id || 0) || null;
        if (!incomeId) {
          const ins = await env.DB.prepare(
            `INSERT INTO tax_income (
              income_date, source, category, amount_cents, stripe_session_id, notes
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
          ).bind(
            incomeDate,
            incomeSource,
            incomeCategory,
            amount,
            sessionId,
            incomeNotes
          ).run();
          incomeId = Number(ins.meta?.last_row_id || 0) || null;
        }
        if (isDigitalDownload) {
          downloadUrl = await fulfillFmgShopOrder(env, {
            sessionId,
            itemName,
            priceId,
            customerEmail,
            customerName
          });
        }

        if (incomeId) {
          await upsertTaxIncomeJournal(env.DB, {
            id: incomeId,
            income_date: incomeDate,
            source: incomeSource,
            category: incomeCategory,
            amount_cents: amount,
            notes: incomeNotes
          });
        }

        // Clean up stale pending rows for same slot(s) after successful payment
        if (!isFmgShopItem) {
          for (const slot of slots) {
            const slotAt = `${slot.setupDate}T${slot.setupTime}`;
            await env.DB.prepare(
              `DELETE FROM bookings
               WHERE status = 'pending'
                 AND setup_at = ?1
                 AND stripe_session_id != ?2`
            ).bind(slotAt, sessionId).run();
          }
        }

        // Auto-insert Stripe processing fee as expense for accurate net reporting.
        // Keep this isolated so a fee lookup/insert failure cannot block buyer email + download delivery.
        try {
          const paymentIntentId = (session.payment_intent || '').toString().trim();
          let feeCents = await fetchStripeFeeCents(env.STRIPE_SECRET_KEY, paymentIntentId);
          let feeWasEstimated = false;
          if (feeCents <= 0) {
            feeCents = estimateStripeFeeCents(amount);
            feeWasEstimated = feeCents > 0;
          }
          if (feeCents > 0) {
            const feeNote = feeWasEstimated
              ? `Estimated Stripe fee for session ${sessionId}`
              : `Auto Stripe fee for session ${sessionId}`;
            const existingFee = await env.DB.prepare(
              `SELECT id FROM tax_expenses WHERE notes IN (?1, ?2) LIMIT 1`
            ).bind(
              `Auto Stripe fee for session ${sessionId}`,
              `Estimated Stripe fee for session ${sessionId}`
            ).first();

            if (!existingFee?.id) {
              const insFee = await env.DB.prepare(
                `INSERT INTO tax_expenses (expense_date, vendor, category, amount_cents, paid_via, notes)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
              ).bind(
                incomeDate,
                'Stripe',
                'Payment Processing Fees',
                feeCents,
                'stripe',
                feeNote
              ).run();
              const feeId = Number(insFee.meta?.last_row_id || 0) || null;
              if (feeId) {
                await upsertTaxExpenseJournal(env.DB, {
                  id: feeId,
                  expense_date: incomeDate,
                  vendor: 'Stripe',
                  category: 'Payment Processing Fees',
                  amount_cents: feeCents,
                  paid_via: 'stripe',
                  notes: feeNote
                });
              }
            }
          }
        } catch (e) {
          console.error('Stripe fee expense insert failed; continuing webhook delivery flow', e);
        }
      } catch (e) {
        console.error('Stripe webhook DB write failed', e);
        if (isDigitalDownload) {
          downloadUrl = await fulfillFmgShopOrder(env, {
            sessionId,
            itemName,
            priceId,
            customerEmail,
            customerName
          }).catch((fulfillErr) => {
            console.error('FMG shop fulfillment recovery failed', fulfillErr);
            return null;
          });
        }
        await alertFmgOperationalFailure(env, {
          subject: '[ACTION NEEDED] FMG Stripe webhook DB write failed',
          detail: `A paid Stripe checkout could not be fully written to D1. Stripe was acknowledged to avoid duplicate retry side effects. Fulfillment recovery ${downloadUrl ? 'created or found a download link' : 'did not create a download link'}. Error: ${e?.message || e}`,
          session
        });
        return json({ ok: true, warning: `Webhook DB write failed: ${e?.message || e}` }, 200, corsHeaders);
      }
    }
  }

  return json({ ok: true }, 200, corsHeaders);
}

async function fulfillFmgShopOrder(env, { sessionId, itemName, priceId, customerEmail, customerName }) {
  if (!sessionId) return null;
  if (await hasOrderConfirmationBeenSent(env, sessionId)) return await getDownloadUrlForSession(env, sessionId);
  await markOrderConfirmationSent(env, sessionId, 'sending');

  let downloadUrl = null;
  try {
    downloadUrl = await createDownloadTokenForPurchase(env, {
      itemName,
      priceId,
      customerEmail,
      sessionId
    });
  } catch (e) {
    console.error('Download token generation failed', e);
  }

  if (!downloadUrl) {
    await alertOrderEmailFailure(env, {
      customerEmail,
      detail: `Digital download token generation failed for paid order. session_id=${sessionId || 'n/a'}, item=${itemName || 'n/a'}, price_id=${priceId || 'n/a'}`
    });
  }

  const sent = await sendOrderConfirmationEmail(env, {
    customerEmail,
    customerName,
    downloadUrl,
    itemName
  });
  if (sent) {
    await markOrderConfirmationSent(env, sessionId, 'sent');
  } else {
    await markOrderConfirmationSent(env, sessionId, 'failed');
  }
  return downloadUrl;
}

async function createDownloadTokenForPurchase(env, { itemName, priceId, customerEmail, sessionId }) {
  if (!env.DOWNLOAD_TOKENS || !env.DOWNLOADS_BUCKET || !env.DOWNLOAD_FILE_MAP || !env.DOWNLOAD_BASE_URL || (!itemName && !priceId)) {
    return null;
  }

  if (sessionId) {
    const existingUrl = await getDownloadUrlForSession(env, sessionId);
    if (existingUrl) return existingUrl;
  }

  let fileMap = {};
  try {
    fileMap = JSON.parse(env.DOWNLOAD_FILE_MAP || '{}') || {};
  } catch (e) {
    console.error('Invalid DOWNLOAD_FILE_MAP JSON', e);
    return null;
  }

  const lookupKeys = [itemName, priceId]
    .map((v) => (v || '').toString().trim().toLowerCase())
    .filter(Boolean);
  const entry = Object.entries(fileMap).find(([name]) => lookupKeys.includes(name.toString().trim().toLowerCase()));
  const r2Key = (entry?.[1] || '').toString().trim();
  if (!r2Key) return null;

  const r2Object = await env.DOWNLOADS_BUCKET.head(r2Key);
  if (!r2Object) {
    console.error('Download file missing from R2 before token creation', { r2Key, itemName, priceId, sessionId });
    return null;
  }

  const ttlSeconds = Math.max(60, parseInt(env.DOWNLOAD_TOKEN_TTL_SECONDS || '86400', 10) || 86400);
  const maxUses = Math.max(1, parseInt(env.DOWNLOAD_TOKEN_MAX_USES || '3', 10) || 3);
  const token = crypto.randomUUID();
  const expiresAt = Date.now() + ttlSeconds * 1000;

  await env.DOWNLOAD_TOKENS.put(token, JSON.stringify({
    r2Key,
    usesRemaining: maxUses,
    email: customerEmail || null,
    sessionId: sessionId || null,
    expiresAt
  }), { expirationTtl: ttlSeconds });

  if (sessionId) {
    await env.DOWNLOAD_TOKENS.put(`checkout-session:${sessionId}`, JSON.stringify({ token, expiresAt }), {
      expirationTtl: ttlSeconds
    });
  }

  return buildDownloadUrl(env, token);
}

function buildDownloadUrl(env, token) {
  if (!env.DOWNLOAD_BASE_URL || !token) return null;
  const url = new URL(env.DOWNLOAD_BASE_URL);
  url.searchParams.set('token', token);
  return url.toString();
}

async function getDownloadUrlForSession(env, sessionId) {
  if (!env.DOWNLOAD_TOKENS || !sessionId) return null;

  const raw = await env.DOWNLOAD_TOKENS.get(`checkout-session:${sessionId}`);
  if (!raw) return null;

  try {
    const mapped = JSON.parse(raw);
    const token = (mapped?.token || '').toString().trim();
    if (!token) return null;

    const tokenRaw = await env.DOWNLOAD_TOKENS.get(token);
    if (!tokenRaw) return null;

    const stored = JSON.parse(tokenRaw);
    const expiresAt = Number(stored?.expiresAt || 0);
    const usesRemaining = Number(stored?.usesRemaining || 0);
    if (!expiresAt || expiresAt <= Date.now() || usesRemaining <= 0) return null;

    return buildDownloadUrl(env, token);
  } catch {
    return null;
  }
}

async function hasOrderConfirmationBeenSent(env, sessionId) {
  if (!env.DOWNLOAD_TOKENS || !sessionId) return false;
  try {
    return !!(await env.DOWNLOAD_TOKENS.get(`order-confirmation-sent:${sessionId}`));
  } catch {
    return false;
  }
}

async function markOrderConfirmationSent(env, sessionId, status = 'sent') {
  if (!env.DOWNLOAD_TOKENS || !sessionId) return;
  try {
    const ttlSeconds = Math.max(7 * 24 * 60 * 60, parseInt(env.DOWNLOAD_TOKEN_TTL_SECONDS || '86400', 10) || 86400);
    await env.DOWNLOAD_TOKENS.put(`order-confirmation-sent:${sessionId}`, JSON.stringify({ status, sentAt: status === 'sent' ? Date.now() : null, updatedAt: Date.now() }), {
      expirationTtl: ttlSeconds
    });
  } catch (e) {
    console.error('Order confirmation sent marker failed', e);
  }
}

async function handleCheckoutSessionDetails(request, env, corsHeaders, url) {
  if (request.method !== 'GET') {
    return json({ ok: false, error: 'Method not allowed' }, 405, corsHeaders);
  }

  if (!env.STRIPE_SECRET_KEY) {
    return json({ ok: false, error: 'Stripe not configured' }, 500, corsHeaders);
  }

  const sessionId = (url.searchParams.get('session_id') || '').trim();
  if (!sessionId || !sessionId.startsWith('cs_')) {
    return json({ ok: false, error: 'Missing or invalid session_id' }, 400, corsHeaders);
  }

  const stripeRes = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, {
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` }
  });
  const session = await stripeRes.json().catch(() => ({}));

  if (!stripeRes.ok || !session?.id) {
    return json({ ok: false, error: 'Stripe session not found' }, stripeRes.status === 404 ? 404 : 502, corsHeaders);
  }

  const checkoutType = (session.metadata?.checkout_type || '').toString().trim().toLowerCase();
  const itemName = (session.metadata?.item_name || session.metadata?.selectedItemName || '').toString().trim();
  const priceId = (session.metadata?.price_id || '').toString().trim();
  const isDigital = checkoutType === 'fmg_shop_item' || !!itemName || !!priceId;
  const isPaid = session.payment_status === 'paid' || session.status === 'complete';
  let downloadUrl = null;

  // The session ID sits in the shop's success URL, so it only mints a new link while the
  // order is fresh (one download-link lifetime); after that it is not a re-download key.
  // The buyer's emailed link comes from the webhook and is unaffected.
  const linkTtlSeconds = Math.max(60, parseInt(env.DOWNLOAD_TOKEN_TTL_SECONDS || '86400', 10) || 86400);
  const orderIsFresh = Math.floor(Date.now() / 1000) - Number(session.created || 0) <= linkTtlSeconds;
  if (isDigital && isPaid) {
    downloadUrl = await getDownloadUrlForSession(env, sessionId);
    if (!downloadUrl && orderIsFresh) {
      try {
        downloadUrl = await createDownloadTokenForPurchase(env, {
          itemName,
          priceId,
          customerEmail: session.customer_details?.email || session.customer_email || null,
          sessionId
        });
      } catch (e) {
        console.error('Checkout session details download token lookup failed', e);
      }
    }
  }

  return json({
    ok: true,
    isDigital,
    paymentStatus: session.payment_status || session.status || null,
    downloadUrl,
    // Order totals for the purchase event the shop page sends to Google (no customer details).
    purchase: isPaid ? {
      transactionId: session.id,
      value: Number(session.amount_subtotal ?? session.amount_total ?? 0) / 100,
      tax: Number(session.total_details?.amount_tax ?? 0) / 100,
      currency: (session.currency || 'usd').toUpperCase(),
      itemName,
      priceId
    } : null
  }, 200, corsHeaders);
}

async function handleDownload(request, env, corsHeaders) {
  if (!env.DOWNLOAD_TOKENS || !env.DOWNLOADS_BUCKET) {
    return json({ ok: false, error: 'Downloads not configured' }, 500, corsHeaders);
  }

  const url = new URL(request.url);
  const token = (url.searchParams.get('token') || '').trim();
  if (!token) return json({ ok: false, error: 'Missing token' }, 400, corsHeaders);

  const storedRaw = await env.DOWNLOAD_TOKENS.get(token);
  if (!storedRaw) return json({ ok: false, error: 'Download token not found' }, 404, corsHeaders);

  let stored;
  try {
    stored = JSON.parse(storedRaw);
  } catch {
    await env.DOWNLOAD_TOKENS.delete(token);
    return json({ ok: false, error: 'Invalid download token' }, 410, corsHeaders);
  }

  const expiresAt = Number(stored.expiresAt || 0);
  if (!expiresAt || expiresAt <= Date.now()) {
    await env.DOWNLOAD_TOKENS.delete(token).catch(() => {});
    return json({ ok: false, error: 'Download token expired' }, 410, corsHeaders);
  }

  const usesRemaining = Number(stored.usesRemaining || 0);
  if (!stored.r2Key || usesRemaining <= 0) {
    await env.DOWNLOAD_TOKENS.delete(token).catch(() => {});
    return json({ ok: false, error: 'Download token exhausted' }, 410, corsHeaders);
  }

  const r2Object = await env.DOWNLOADS_BUCKET.get(stored.r2Key);
  if (!r2Object) return json({ ok: false, error: 'Download file not found' }, 404, corsHeaders);

  const nextUsesRemaining = usesRemaining - 1;
  if (nextUsesRemaining <= 0) {
    await env.DOWNLOAD_TOKENS.delete(token);
  } else {
    const remainingTtlSeconds = expiresAt
      ? Math.ceil((expiresAt - Date.now()) / 1000)
      : Math.max(60, parseInt(env.DOWNLOAD_TOKEN_TTL_SECONDS || '86400', 10) || 86400);
    if (remainingTtlSeconds <= 0) {
      await env.DOWNLOAD_TOKENS.delete(token).catch(() => {});
      return json({ ok: false, error: 'Download token expired' }, 410, corsHeaders);
    }
    await env.DOWNLOAD_TOKENS.put(token, JSON.stringify({ ...stored, usesRemaining: nextUsesRemaining }), {
      expirationTtl: remainingTtlSeconds
    });
  }

  const filename = stored.r2Key.split('/').pop() || 'download.pdf';
  return new Response(r2Object.body, {
    status: 200,
    headers: withSecurityHeaders({
      ...corsHeaders,
      'Content-Type': r2Object.httpMetadata?.contentType || 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename.replace(/"/g, '')}"`,
      'Cache-Control': 'private, no-store'
    })
  });
}

async function sendOrderConfirmationEmail(env, { customerEmail, customerName, downloadUrl, itemName }) {
  if (!emailConfigured(env)) {
    console.error('Order confirmation email skipped: no email provider configured');
    return false;
  }
  if (!customerEmail) {
    console.error('Order confirmation email skipped: missing customer email');
    await alertOrderEmailFailure(env, {
      customerEmail,
      detail: `Paid order has no customer email; confirmation/download email was not sent. Item: ${itemName || 'n/a'}`
    });
    return false;
  }

  const fromEmail = (env.RESEND_FROM_EMAIL || env.FROM_EMAIL || '').toString().trim();
  if (!fromEmail) {
    console.error('Order confirmation email skipped: missing sender email');
    return false;
  }

  const ttlSeconds = parseInt(env.DOWNLOAD_TOKEN_TTL_SECONDS || '86400', 10) || 86400;
  const maxUses = parseInt(env.DOWNLOAD_TOKEN_MAX_USES || '3', 10) || 3;
  const validHours = Math.max(1, Math.round(ttlSeconds / 3600));
  const supportEmail = env.SUPPORT_EMAIL || env.CONTACT_TO_EMAIL || env.TO_EMAIL || 'contact@florencemaegifts.com';
  const displayName = (customerName || 'there').toString().replace(/[\r\n]+/g, ' ').trim() || 'there';
  const safeName = escapeHtml(displayName);
  const displayItemName = (itemName || 'your item').toString().replace(/[\r\n]+/g, ' ').trim() || 'your item';
  const safeItemName = escapeHtml(displayItemName);
  const safeDownloadUrl = downloadUrl ? escapeHtml(downloadUrl) : '';
  const downloadSection = safeDownloadUrl
    ? `<p>Download your file here (link valid for ${validHours} hours, up to ${maxUses} downloads):<br><a href="${safeDownloadUrl}">${safeDownloadUrl}</a></p>`
    : `<p>We received your payment, but your download link could not be generated automatically. Please reply to this email or contact us at ${escapeHtml(supportEmail)} and we’ll send the file manually.</p>`;
  // Plain-text copy of the same message, for text-only mail apps and spam filters.
  const downloadText = downloadUrl
    ? `Download your file here (link valid for ${validHours} hours, up to ${maxUses} downloads):\n${downloadUrl}`
    : `We received your payment, but your download link could not be generated automatically. Please reply to this email or contact us at ${supportEmail} and we’ll send the file manually.`;
  const emailBody = {
    from: fromEmail,
    to: [customerEmail],
    subject: `Your Florence Mae Gifts Order Confirmation - ${displayItemName}`,
    reply_to: supportEmail,
    html: `<p>Hi ${safeName},</p>
<p>Thank you for your order! Your payment for <strong>${safeItemName}</strong> was successful.</p>
${downloadSection}
<p>Questions? Reply to this email or contact us at ${escapeHtml(supportEmail)}.</p>
<p>— Florence Mae Gifts</p>`,
    text: [
      `Hi ${displayName},`,
      '',
      `Thank you for your order! Your payment for ${displayItemName} was successful.`,
      '',
      downloadText,
      '',
      `Questions? Reply to this email or contact us at ${supportEmail}.`,
      '',
      '— Florence Mae Gifts'
    ].join('\n')
  };
  const adminBcc = (env.ORDER_EMAIL_BCC || env.ORDER_EMAIL_ALERT_TO || env.CONTACT_TO_EMAIL || env.TO_EMAIL || '').toString().trim();
  if (adminBcc && adminBcc.toLowerCase() !== customerEmail.toLowerCase()) {
    emailBody.bcc = [adminBcc];
  }

  try {
    const resendRes = await sendEmail(env, emailBody);
    if (!resendRes.ok) {
      const detail = await resendRes.text();
      console.error('Order confirmation email failed', detail);
      await alertOrderEmailFailure(env, { customerEmail, detail });
      return false;
    }
    return true;
  } catch (e) {
    const detail = e?.message || String(e);
    console.error('Order confirmation email failed', e);
    await alertOrderEmailFailure(env, { customerEmail, detail });
    return false;
  }
}

async function alertOrderEmailFailure(env, { customerEmail, detail }) {
  const alertTo = (env.ORDER_EMAIL_ALERT_TO || env.CONTACT_TO_EMAIL || env.TO_EMAIL || '').toString().trim();
  const fromEmail = (env.RESEND_FROM_EMAIL || env.FROM_EMAIL || '').toString().trim();
  if (!emailConfigured(env) || !alertTo || !fromEmail) return;

  await sendEmail(env, {
    from: fromEmail,
    to: [alertTo],
    subject: 'FMG order confirmation email failed',
    html: `<p>An order confirmation email failed.</p><p><strong>Customer:</strong> ${escapeHtml(customerEmail || '(missing)')}</p><p><strong>Error:</strong> ${escapeHtml(detail || 'Unknown error')}</p>`
  }).catch((e) => console.error('Order confirmation failure alert failed', e));
}

async function alertFmgOperationalFailure(env, { subject, detail, session }) {
  const alertTo = (env.ORDER_EMAIL_ALERT_TO || env.CONTACT_TO_EMAIL || env.TO_EMAIL || '').toString().trim();
  const fromEmail = (env.RESEND_FROM_EMAIL || env.FROM_EMAIL || '').toString().trim();
  if (!emailConfigured(env) || !alertTo || !fromEmail) return;

  const metadata = session?.metadata || {};
  const customerEmail = session?.customer_details?.email || session?.customer_email || '';
  const lines = [
    detail || 'FMG worker operational failure.',
    '',
    `Stripe session: ${(session?.id || '').toString() || 'n/a'}`,
    `Payment intent: ${(session?.payment_intent || '').toString() || 'n/a'}`,
    `Customer: ${(session?.customer_details?.name || metadata.customer_name || '').toString() || '(not provided)'}`,
    `Email: ${customerEmail || '(not provided)'}`,
    `Checkout type: ${(metadata.checkout_type || '').toString() || '(not provided)'}`,
    `Item: ${(metadata.item_name || metadata.selectedItemName || '').toString() || '(not provided)'}`,
    `Price ID: ${(metadata.price_id || '').toString() || '(not provided)'}`,
    `Amount: ${formatUsd(Number(session?.amount_total || 0))}`
  ];

  await sendEmail(env, {
    from: fromEmail,
    to: [alertTo],
    subject: subject || '[ACTION NEEDED] FMG worker alert',
    text: lines.join('\n')
  }).catch((e) => console.error('FMG operational alert failed', e));
}

// ===== Utility Functions =====

const ADMIN_SESSION_COOKIE = 'fmg_admin_session';
const ADMIN_SESSION_TTL_SECONDS = 60 * 60 * 12;

async function handleAdminLogin(request, env, corsHeaders) {
  let data;
  try { data = await request.json(); } catch { return json({ ok: false, error: 'Invalid JSON' }, 400, corsHeaders); }

  const username = (data.username || '').toString().trim();
  const password = (data.password || '').toString();
  const code = (data.code || '').toString().replace(/\s+/g, '');
  const expectedUser = (env.ADMIN_USER || 'admin').trim();
  const expectedPass = (env.ADMIN_PASS || '').trim();
  const totpSecret = (env.TOTP_SECRET || '').trim();

  if (!expectedPass) {
    return json({ ok: false, error: 'Admin credentials not configured' }, 500, corsHeaders);
  }
  if (!(env.ADMIN_SESSION_SECRET || '').trim()) {
    return json({ ok: false, error: 'Admin session secret not configured' }, 500, corsHeaders);
  }
  if (!totpSecret) {
    return json({ ok: false, error: 'Authenticator is not configured on the server' }, 500, corsHeaders);
  }

  const ip = getClientIp(request);
  if (await adminAuthBlocked(env, ip)) return json({ ok: false, error: 'Too many failed attempts. Try again in 15 minutes.' }, 429, corsHeaders);

  const [userOk, passOk] = await Promise.all([
    timingSafeEqual(username, expectedUser),
    timingSafeEqual(password, expectedPass)
  ]);
  const totpOk = userOk && passOk ? await verifyTotp(totpSecret, code) : false;
  if (!userOk || !passOk || !totpOk) {
    const blocked = await recordAdminAuthFailure(env, ip);
    console.log(`Failed admin login at ${new Date().toISOString()} from ${ip} for username=${username || '(blank)'} (${userOk && passOk ? 'wrong code' : 'wrong username or password'})`);
    if (blocked) return json({ ok: false, error: 'Too many failed attempts. Try again in 15 minutes.' }, 429, corsHeaders);
    // Same answer whichever part was wrong, so a guess never confirms the password.
    return json({ ok: false, error: 'Invalid username, password or authenticator code.' }, 401, corsHeaders);
  }

  await clearAdminAuthFailures(env, ip);
  const session = await createAdminSessionCookie(env);
  return json({ ok: true }, 200, {
    ...corsHeaders,
    'Set-Cookie': `${ADMIN_SESSION_COOKIE}=${session}; Path=/; Max-Age=${ADMIN_SESSION_TTL_SECONDS}; HttpOnly; Secure; SameSite=Strict`
  });
}

function handleAdminLogout(corsHeaders) {
  return json({ ok: true }, 200, {
    ...corsHeaders,
    'Set-Cookie': `${ADMIN_SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`
  });
}

// ===== Emergency admin access (admin-emergency.html) =====
// For Megan if Chris can't sign in for her: the normal login needs the
// authenticator on Chris's phone. A 6-digit code goes only to
// EMERGENCY_ADMIN_EMAIL. Setup (or a forgotten password) is the emailed code
// plus a new password; after that, signing in is her password plus an emailed
// code. Every setup code, new password and sign-in is also emailed to
// EMERGENCY_NOTIFY_EMAIL so a use nobody expected is noticed. Codes: 15
// minutes, 3 tries, 5 an hour, stored hashed. The session is the normal admin
// session cookie.
const EMERGENCY_CODE_TTL_SECONDS = 15 * 60;
const EMERGENCY_CODE_TRIES = 3;
const EMERGENCY_CODES_PER_HOUR = 5;
const EMERGENCY_MIN_PASSWORD = 12;
const EMERGENCY_PBKDF2_ITERATIONS = 100000;

async function ensureEmergencyTables(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS admin_emergency_account (
    email TEXT PRIMARY KEY,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_login_at TEXT
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS admin_emergency_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code_hash TEXT NOT NULL,
    purpose TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    used INTEGER NOT NULL DEFAULT 0
  )`).run();
}

const emergencyEmail = (env) => (env.EMERGENCY_ADMIN_EMAIL || '').trim().toLowerCase();

function maskEmail(email) {
  const [user, domain] = String(email).split('@');
  if (!user || !domain) return '';
  return `${user.slice(0, 2)}${'•'.repeat(Math.max(1, user.length - 2))}@${domain}`;
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text)));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function hashEmergencyPassword(password, saltHex = null) {
  const salt = saltHex || [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(salt), iterations: EMERGENCY_PBKDF2_ITERATIONS }, key, 256);
  return `${salt}:${[...new Uint8Array(bits)].map(b => b.toString(16).padStart(2, '0')).join('')}`;
}

async function verifyEmergencyPassword(password, stored) {
  const [salt] = String(stored || '').split(':');
  if (!salt) return false;
  return timingSafeEqual(await hashEmergencyPassword(password, salt), stored);
}

async function emergencyAccount(env) {
  return env.DB.prepare('SELECT email, password_hash FROM admin_emergency_account WHERE email = ?1').bind(emergencyEmail(env)).first();
}

async function notifyEmergencyUse(env, request, what) {
  const to = (env.EMERGENCY_NOTIFY_EMAIL || '').trim();
  if (!to) return;
  const where = [request.cf?.city, request.cf?.region].filter(Boolean).join(', ');
  const text = [
    `Florence Mae Gifts admin emergency access: ${what}.`,
    '',
    `Time: ${new Date().toISOString()}`,
    `From: ${getClientIp(request)}${where ? ` (${where})` : ''}`,
    `Device: ${request.headers.get('User-Agent') || 'unknown'}`,
    '',
    'If this was not expected, change ADMIN_SESSION_SECRET (signs everyone out) and delete the admin_emergency_account row.',
  ].join('\n');
  try {
    await sendEmail(env, { from: env.RESEND_FROM_EMAIL, to: [to], subject: `FMG admin emergency access: ${what}`, text });
  } catch (err) {
    console.error('emergency notify failed:', err?.message || err);
  }
}

async function handleEmergencyStatus(env, corsHeaders) {
  if (!emergencyEmail(env)) return json({ ok: true, configured: false }, 200, corsHeaders);
  await ensureEmergencyTables(env);
  const account = await emergencyAccount(env);
  return json({ ok: true, configured: true, hasAccount: !!account, sentTo: maskEmail(emergencyEmail(env)) }, 200, corsHeaders);
}

async function handleEmergencyRequest(request, env, corsHeaders) {
  const email = emergencyEmail(env);
  if (!email || !(env.ADMIN_SESSION_SECRET || '').trim() || !turnstileConfigured(env)) return json({ ok: false, error: 'Emergency access is not set up on the server' }, 500, corsHeaders);
  let data;
  try { data = await request.json(); } catch { return json({ ok: false, error: 'Invalid JSON' }, 400, corsHeaders); }
  await ensureEmergencyTables(env);

  const ip = getClientIp(request);
  if (await adminAuthBlocked(env, ip)) return json({ ok: false, error: 'Too many attempts. Try again in 15 minutes.' }, 429, corsHeaders);
  // Before the password check and before any email: no passed Turnstile check, no code.
  if (!(await verifyTurnstile(env, request, data.turnstileToken, EMERGENCY_TURNSTILE_ACTION))) {
    return json({ ok: false, error: 'The security check did not go through. Wait for it to finish, then try again.' }, 403, corsHeaders);
  }

  const account = await emergencyAccount(env);
  const purpose = data.reset || !account ? 'setup' : 'login';
  if (purpose === 'login' && !(await verifyEmergencyPassword(String(data.password || ''), account.password_hash))) {
    const blocked = await recordAdminAuthFailure(env, ip);
    return json({ ok: false, error: blocked ? 'Too many attempts. Try again in 15 minutes.' : 'That password is not right.' }, blocked ? 429 : 401, corsHeaders);
  }

  const now = Math.floor(Date.now() / 1000);
  const recent = await env.DB.prepare('SELECT COUNT(*) AS n FROM admin_emergency_codes WHERE created_at > ?1').bind(now - 3600).first();
  if (Number(recent?.n || 0) >= EMERGENCY_CODES_PER_HOUR) return json({ ok: false, error: 'Too many codes this hour. Use the last code we sent, or try again later.' }, 429, corsHeaders);

  const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, '0');
  await env.DB.prepare('UPDATE admin_emergency_codes SET used = 1 WHERE used = 0').run();
  await env.DB.prepare('INSERT INTO admin_emergency_codes (code_hash, purpose, created_at, expires_at) VALUES (?1, ?2, ?3, ?4)')
    .bind(await sha256Hex(code), purpose, now, now + EMERGENCY_CODE_TTL_SECONDS).run();

  const lead = purpose === 'setup' ? 'Here is your code to set up your Florence Mae Gifts admin sign-in.' : 'Here is your code to sign in to the Florence Mae Gifts admin.';
  const res = await sendEmail(env, {
    from: env.RESEND_FROM_EMAIL,
    to: [email],
    subject: `Your Florence Mae Gifts admin code: ${code}`,
    text: `${lead}\n\n${code}\n\nIt works for 15 minutes. If you did not ask for this, you can ignore this email.`,
    html: `<p>${lead}</p><p style="font-size:28px;font-weight:bold;letter-spacing:4px">${code}</p><p>It works for 15 minutes. If you did not ask for this, you can ignore this email.</p>`,
  });
  if (!res.ok) return json({ ok: false, error: 'The code could not be emailed. Try again in a few minutes.' }, 502, corsHeaders);
  if (purpose === 'setup') await notifyEmergencyUse(env, request, account ? 'a password-reset code was sent to Megan' : 'a setup code was sent to Megan');
  return json({ ok: true, purpose, sentTo: maskEmail(email) }, 200, corsHeaders);
}

// Cloudflare Turnstile on the emergency page's "Email me a code" button (widget
// "FMG emergency sign-in"). TURNSTILE_SECRET is a Worker secret; TURNSTILE_HOSTNAMES
// lists the frontend hostnames a passed check may come from (production: www only).
const EMERGENCY_TURNSTILE_ACTION = 'emergency_code';

function turnstileHostnames(env) {
  return new Set(String(env.TURNSTILE_HOSTNAMES || '').split(',').map((h) => h.trim()).filter(Boolean));
}

function turnstileConfigured(env) {
  return !!(env.TURNSTILE_SECRET || '').trim() && turnstileHostnames(env).size > 0;
}

/** Siteverify a Turnstile token. Fails closed: a missing token, an unreachable or failed check, or the wrong action or hostname all return false. */
async function verifyTurnstile(env, request, token, expectedAction) {
  const hostnames = turnstileHostnames(env);
  if (!turnstileConfigured(env) || typeof token !== 'string' || !token || token.length > 2048) return false;
  const body = new URLSearchParams({ secret: env.TURNSTILE_SECRET.trim(), response: token });
  const ip = getClientIp(request);
  if (ip !== 'unknown') body.set('remoteip', ip);
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      signal: AbortSignal.timeout(10000),
      body
    });
    if (!res.ok) throw new Error(`siteverify ${res.status}`);
    const result = await res.json();
    if (result.success === true && result.action === expectedAction && hostnames.has(result.hostname)) return true;
    console.log('Turnstile check refused', { action: result.action, hostname: result.hostname, errors: result['error-codes'] });
    return false;
  } catch (err) {
    console.error('Turnstile siteverify failed', err?.message || err);
    return false;
  }
}

// Ask K alerts (budget spent, credit or key problems) go to Chris: ASKK_ALERT_TO,
// else EMERGENCY_NOTIFY_EMAIL, else the shop inbox.
async function sendAskKAlert(env, subject, text) {
  const to = (env.ASKK_ALERT_TO || env.EMERGENCY_NOTIFY_EMAIL || env.CONTACT_TO_EMAIL || env.TO_EMAIL || '').toString().trim();
  if (!to || !emailConfigured(env)) return;
  const res = await sendEmail(env, { from: env.RESEND_FROM_EMAIL || env.FROM_EMAIL, to: [to], subject, text });
  if (!res.ok) console.error('Ask K alert email failed', await res.text());
}

async function handleEmergencyVerify(request, env, corsHeaders) {
  const email = emergencyEmail(env);
  if (!email || !(env.ADMIN_SESSION_SECRET || '').trim()) return json({ ok: false, error: 'Emergency access is not set up on the server' }, 500, corsHeaders);
  let data;
  try { data = await request.json(); } catch { return json({ ok: false, error: 'Invalid JSON' }, 400, corsHeaders); }
  await ensureEmergencyTables(env);

  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare('SELECT id, code_hash, purpose, attempts FROM admin_emergency_codes WHERE used = 0 AND expires_at > ?1 ORDER BY id DESC LIMIT 1').bind(now).first();
  if (!row) return json({ ok: false, error: 'That code has expired. Ask for a new one.' }, 401, corsHeaders);
  const tooManyWrong = () => json({ ok: false, error: 'Too many wrong codes. Ask for a new one.' }, 429, corsHeaders);
  if (row.attempts >= EMERGENCY_CODE_TRIES) return tooManyWrong();

  // Checked before a try is used, so a too-short new password doesn't cost Megan a try.
  const password = String(data.newPassword || '');
  if (row.purpose === 'setup' && password.length < EMERGENCY_MIN_PASSWORD) return json({ ok: false, error: `Choose a password of at least ${EMERGENCY_MIN_PASSWORD} characters.` }, 400, corsHeaders);

  // Claim one of the code's tries before comparing. The UPDATE only succeeds while tries
  // are left, so guesses sent at the same moment can't get more than EMERGENCY_CODE_TRIES.
  const claimed = await env.DB.prepare('UPDATE admin_emergency_codes SET attempts = attempts + 1 WHERE id = ?1 AND used = 0 AND attempts < ?2')
    .bind(row.id, EMERGENCY_CODE_TRIES).run();
  if (!claimed.meta?.changes) return tooManyWrong();

  const code = String(data.code || '').replace(/\D/g, '');
  if (!(await timingSafeEqual(await sha256Hex(code), row.code_hash))) {
    return json({ ok: false, error: 'That code is not right. Check the newest email.' }, 401, corsHeaders);
  }

  // Mark it used in the same step that checks it is unused, so a code signs in only once.
  const used = await env.DB.prepare('UPDATE admin_emergency_codes SET used = 1 WHERE id = ?1 AND used = 0').bind(row.id).run();
  if (!used.meta?.changes) return json({ ok: false, error: 'That code has already been used. Ask for a new one.' }, 401, corsHeaders);

  if (row.purpose === 'setup') {
    await env.DB.prepare(`INSERT INTO admin_emergency_account (email, password_hash) VALUES (?1, ?2)
      ON CONFLICT(email) DO UPDATE SET password_hash = excluded.password_hash, updated_at = datetime('now')`)
      .bind(email, await hashEmergencyPassword(password)).run();
  }
  await env.DB.prepare(`UPDATE admin_emergency_account SET last_login_at = datetime('now') WHERE email = ?1`).bind(email).run();
  await notifyEmergencyUse(env, request, row.purpose === 'setup' ? 'Megan set a password and signed in' : 'Megan signed in');

  const session = await createAdminSessionCookie(env);
  return json({ ok: true }, 200, {
    ...corsHeaders,
    'Set-Cookie': `${ADMIN_SESSION_COOKIE}=${session}; Path=/; Max-Age=${ADMIN_SESSION_TTL_SECONDS}; HttpOnly; Secure; SameSite=Strict`
  });
}

async function requireAdmin(request, env, corsHeaders, url) {
  if (!(env.ADMIN_SESSION_SECRET || '').trim()) {
    return { ok: false, res: json({ ok: false, error: 'Admin session secret not configured' }, 500, corsHeaders) };
  }
  if (await hasValidAdminSession(request, env)) return { ok: true };
  return { ok: false, res: json({ ok: false, error: 'Unauthorized' }, 401, corsHeaders) };
}

function getClientIp(request) {
  return (request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'unknown')
    .split(',')[0]
    .trim() || 'unknown';
}

// Failed admin and emergency sign-ins per IP: 3 in 15 minutes, then locked out
// for the rest of the window. Kept in D1 (not Worker memory) so the count holds
// across Worker instances and Cloudflare data centers.
const ADMIN_AUTH_FAILURE_LIMIT = 3;
const ADMIN_AUTH_WINDOW_SECONDS = 15 * 60;

async function ensureAdminAuthFailuresTable(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS admin_auth_failures (
    ip TEXT PRIMARY KEY,
    count INTEGER NOT NULL DEFAULT 0,
    window_start INTEGER NOT NULL
  )`).run();
}

async function adminAuthBlocked(env, ip) {
  await ensureAdminAuthFailuresTable(env);
  const windowOpen = Math.floor(Date.now() / 1000) - ADMIN_AUTH_WINDOW_SECONDS;
  const row = await env.DB.prepare('SELECT count, window_start FROM admin_auth_failures WHERE ip = ?1').bind(ip).first();
  return !!row && Number(row.window_start) > windowOpen && Number(row.count) >= ADMIN_AUTH_FAILURE_LIMIT;
}

/** Count one failure (a new window starts once the old one has passed). @returns {Promise<boolean>} now locked out */
async function recordAdminAuthFailure(env, ip) {
  await ensureAdminAuthFailuresTable(env);
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(`INSERT INTO admin_auth_failures (ip, count, window_start) VALUES (?1, 1, ?2)
    ON CONFLICT(ip) DO UPDATE SET
      count = CASE WHEN window_start <= ?3 THEN 1 ELSE count + 1 END,
      window_start = CASE WHEN window_start <= ?3 THEN ?2 ELSE window_start END`)
    .bind(ip, now, now - ADMIN_AUTH_WINDOW_SECONDS).run();
  return adminAuthBlocked(env, ip);
}

async function clearAdminAuthFailures(env, ip) {
  await env.DB.prepare('DELETE FROM admin_auth_failures WHERE ip = ?1').bind(ip).run();
}

async function hasValidAdminSession(request, env) {
  const token = getCookie(request, ADMIN_SESSION_COOKIE);
  if (!token) return false;
  const [payloadB64, sig] = token.split('.');
  if (!payloadB64 || !sig) return false;
  const expectedSig = await signAdminSession(env, payloadB64);
  if (!(await timingSafeEqual(sig, expectedSig))) return false;
  try {
    const payload = JSON.parse(base64UrlDecode(payloadB64));
    return payload?.exp && Number(payload.exp) > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

async function createAdminSessionCookie(env) {
  const payload = {
    v: 1,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + ADMIN_SESSION_TTL_SECONDS,
    nonce: crypto.randomUUID()
  };
  const payloadB64 = b64url(JSON.stringify(payload));
  return `${payloadB64}.${await signAdminSession(env, payloadB64)}`;
}

async function signAdminSession(env, payloadB64) {
  const secret = (env.ADMIN_SESSION_SECRET || '').trim();
  if (!secret) throw new Error('ADMIN_SESSION_SECRET is not configured');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payloadB64));
  return b64urlBytes(new Uint8Array(sig));
}

function getCookie(request, name) {
  const cookie = request.headers.get('Cookie') || '';
  return cookie.split(';').map(v => v.trim()).find(v => v.startsWith(`${name}=`))?.slice(name.length + 1) || '';
}

function b64url(s) {
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function b64urlBytes(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlDecode(s) {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  return atob(padded);
}

async function timingSafeEqual(a, b) {
  const encoder = new TextEncoder();
  const [aHash, bHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(String(a ?? ''))),
    crypto.subtle.digest('SHA-256', encoder.encode(String(b ?? '')))
  ]);
  const aBytes = new Uint8Array(aHash);
  const bBytes = new Uint8Array(bHash);
  let out = 0;
  for (let i = 0; i < aBytes.length; i++) out |= aBytes[i] ^ bBytes[i];
  return out === 0;
}

// RFC 6238 TOTP settings used by Microsoft Authenticator and the rentals admin:
// 6 digits, HMAC-SHA1, a 30-second period, and ±1 period for clock drift.
const TOTP_DIGITS = 6;
const TOTP_PERIOD_SECONDS = 30;
const TOTP_SKEW_STEPS = 1;

function base32Decode(input) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = String(input || '').toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const index = alphabet.indexOf(ch);
    if (index === -1) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

async function totpCodeForStep(secretBytes, step) {
  const counter = new ArrayBuffer(8);
  const view = new DataView(counter);
  view.setUint32(0, Math.floor(step / 0x1_0000_0000));
  view.setUint32(4, step >>> 0);
  const key = await crypto.subtle.importKey('raw', secretBytes, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, counter));
  const offset = signature[signature.length - 1] & 0x0f;
  const binary = ((signature[offset] & 0x7f) << 24)
    | ((signature[offset + 1] & 0xff) << 16)
    | ((signature[offset + 2] & 0xff) << 8)
    | (signature[offset + 3] & 0xff);
  return String(binary % (10 ** TOTP_DIGITS)).padStart(TOTP_DIGITS, '0');
}

async function verifyTotp(secret, code, now = Date.now()) {
  const cleanCode = String(code || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(cleanCode)) return false;
  const secretBytes = base32Decode(secret);
  if (secretBytes.length === 0) return false;
  const currentStep = Math.floor(now / 1000 / TOTP_PERIOD_SECONDS);
  let match = false;
  for (let offset = -TOTP_SKEW_STEPS; offset <= TOTP_SKEW_STEPS; offset++) {
    const expected = await totpCodeForStep(secretBytes, currentStep + offset);
    if (await timingSafeEqual(expected, cleanCode)) match = true;
  }
  return match;
}

/** @param {string|number} amount - Dollar amount @returns {number|null} Integer cents */
function toCents(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

/** @param {*} v - Value to escape for CSV output @returns {string} */
function csvEscape(v) {
  const s = (v ?? '').toString();
  if (/[\n\r",]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/**
 * GET /api/tax/summary — Service-to-service annual totals. The dedicated token
 * cannot authorize transaction reads, exports, receipt access, or any writes.
 */
async function handleTaxSummary(request, env, corsHeaders, url) {
  if (!env.DB) return json({ ok: false, error: 'DB binding missing' }, 500, corsHeaders);
  const expected = String(env.TAX_READ_TOKEN || '').trim();
  const provided = String(request.headers.get('X-Tax-Read-Token') || '').trim();
  if (!expected) return json({ ok: false, error: 'Tax read integration is not configured' }, 503, corsHeaders);
  if (!provided || !(await timingSafeEqual(provided, expected))) {
    return json({ ok: false, error: 'Unauthorized' }, 401, corsHeaders);
  }

  const year = (url.searchParams.get('year') || '').trim();
  if (!/^\d{4}$/.test(year)) return json({ ok: false, error: 'Missing/invalid year' }, 400, corsHeaders);

  const [expenseTotal, incomeTotal, ownerRetirementTotal] = await Promise.all([
    env.DB.prepare(
      `SELECT COALESCE(SUM(amount_cents), 0) AS total_cents
       FROM tax_expenses WHERE substr(expense_date, 1, 4) = ?1`
    ).bind(year).first(),
    env.DB.prepare(
      `SELECT COALESCE(SUM(amount_cents), 0) AS total_cents
       FROM tax_income WHERE substr(income_date, 1, 4) = ?1`
    ).bind(year).first(),
    env.DB.prepare(
      `SELECT COALESCE(SUM(jl.debit_cents - jl.credit_cents), 0) AS total_cents
       FROM journal_lines jl
       JOIN journal_entries je ON je.id = jl.entry_id
       JOIN accounts a ON a.id = jl.account_id
       WHERE a.code = '3210' AND substr(je.entry_date, 1, 4) = ?1`
    ).bind(year).first(),
  ]);
  const incomeCents = Number(incomeTotal?.total_cents || 0);
  const expenseCents = Number(expenseTotal?.total_cents || 0);
  const ownerRetirementContributionCents = Number(ownerRetirementTotal?.total_cents || 0);
  return json({
    ok: true,
    year,
    incomeCents,
    expenseCents,
    netCents: incomeCents - expenseCents,
    ownerRetirementContributionCents,
  }, 200, corsHeaders);
}

/**
 * GET /api/tax/transactions — Admin: fetch tax entries filtered by year and type
 * @returns {Response} {ok: true, income: [], expenses: []}
 */
async function handleTaxTransactions(request, env, corsHeaders, url) {
  if (!env.DB) return json({ ok: false, error: 'DB binding missing' }, 500, corsHeaders);
  const auth = await requireAdmin(request, env, corsHeaders, url);
  if (!auth.ok) return auth.res;

  const year = (url.searchParams.get('year') || '').trim();
  const type = (url.searchParams.get('type') || 'all').trim();
  if (!/^\d{4}$/.test(year)) return json({ ok: false, error: 'Missing/invalid year' }, 400, corsHeaders);

  const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit') || 200)));

  const expensesP = (type === 'all' || type === 'expense')
    ? env.DB.prepare(
        `SELECT id, expense_date AS date, vendor, category, amount_cents, paid_via, notes, receipt_key, created_at
         FROM tax_expenses
         WHERE substr(expense_date,1,4) = ?1
         ORDER BY expense_date DESC, id DESC
         LIMIT ?2`
      ).bind(year, limit).all()
    : Promise.resolve({ results: [] });

  const incomeP = (type === 'all' || type === 'income')
    ? env.DB.prepare(
        `SELECT id, income_date AS date, source, category, amount_cents, stripe_session_id, notes, receipt_key, is_owner_funded, created_at
         FROM tax_income
         WHERE substr(income_date,1,4) = ?1
         ORDER BY income_date DESC, id DESC
         LIMIT ?2`
      ).bind(year, limit).all()
    : Promise.resolve({ results: [] });

  const [expenses, income] = await Promise.all([expensesP, incomeP]);

  return json({
    ok: true,
    year,
    expenses: expenses.results || [],
    income: income.results || []
  }, 200, corsHeaders);
}

/**
 * POST /api/tax/expense — Admin: add a manual expense entry
 * @param {Request} request - JSON body: {date, category, description, amount}
 * @returns {Response} {ok: true, id}
 */
async function handleTaxExpense(request, env, corsHeaders, url) {
  if (!env.DB) return json({ ok: false, error: 'DB binding missing' }, 500, corsHeaders);
  const auth = await requireAdmin(request, env, corsHeaders, url);
  if (!auth.ok) return auth.res;

  let data;
  try { data = await request.json(); } catch { return json({ ok: false, error: 'Invalid JSON' }, 400, corsHeaders); }

  const expenseDate = (data.date || '').toString().trim();
  const vendor = (data.vendor || '').toString().trim();
  const category = (data.category || '').toString().trim();
  const paidVia = (data.paidVia || '').toString().trim();
  const notes = (data.notes || '').toString().trim();
  const cents = toCents(data.amount);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(expenseDate)) return json({ ok: false, error: 'Invalid date' }, 400, corsHeaders);
  if (!category) return json({ ok: false, error: 'Missing category' }, 400, corsHeaders);
  if (cents === null) return json({ ok: false, error: 'Invalid amount' }, 400, corsHeaders);

  const r = await env.DB.prepare(
    `INSERT INTO tax_expenses (expense_date, vendor, category, amount_cents, paid_via, notes)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
  ).bind(expenseDate, vendor || null, category, cents, paidVia || null, notes || null).run();

  const id = Number(r.meta?.last_row_id || 0) || null;
  if (id) {
    await upsertTaxExpenseJournal(env.DB, {
      id,
      expense_date: expenseDate,
      vendor,
      category,
      amount_cents: cents,
      paid_via: paidVia || null,
      notes: notes || null
    });
  }

  return json({ ok: true, id }, 200, corsHeaders);
}

/**
 * POST /api/tax/income — Admin: add a manual income entry
 * @param {Request} request - JSON body: {date, category, description, amount}
 * @returns {Response} {ok: true, id}
 */
async function handleTaxIncome(request, env, corsHeaders, url) {
  if (!env.DB) return json({ ok: false, error: 'DB binding missing' }, 500, corsHeaders);
  const auth = await requireAdmin(request, env, corsHeaders, url);
  if (!auth.ok) return auth.res;

  let data;
  try { data = await request.json(); } catch { return json({ ok: false, error: 'Invalid JSON' }, 400, corsHeaders); }

  const incomeDate = (data.date || '').toString().trim();
  const source = (data.source || '').toString().trim();
  const category = (data.category || '').toString().trim();
  const stripeSessionId = (data.stripeSessionId || '').toString().trim();
  const notes = (data.notes || '').toString().trim();
  const isOwnerFunded = data.isOwnerFunded === true ? 1 : 0;
  const cents = toCents(data.amount);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(incomeDate)) return json({ ok: false, error: 'Invalid date' }, 400, corsHeaders);
  if (!category) return json({ ok: false, error: 'Missing category' }, 400, corsHeaders);
  if (cents === null) return json({ ok: false, error: 'Invalid amount' }, 400, corsHeaders);

  const r = await env.DB.prepare(
    `INSERT INTO tax_income (income_date, source, category, amount_cents, stripe_session_id, notes, is_owner_funded)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
  ).bind(incomeDate, source || null, category, cents, stripeSessionId || null, notes || null, isOwnerFunded).run();

  const id = Number(r.meta?.last_row_id || 0) || null;
  if (id) {
    await upsertTaxIncomeJournal(env.DB, {
      id,
      income_date: incomeDate,
      source,
      category,
      amount_cents: cents,
      notes: notes || null,
      is_owner_funded: isOwnerFunded
    });
  }

  return json({ ok: true, id }, 200, corsHeaders);
}


/**
 * POST /api/tax/expense/update — Admin: edit an existing expense entry
 */
async function handleTaxExpenseUpdate(request, env, corsHeaders, url) {
  if (!env.DB) return json({ ok: false, error: 'DB binding missing' }, 500, corsHeaders);
  const auth = await requireAdmin(request, env, corsHeaders, url);
  if (!auth.ok) return auth.res;

  let data;
  try { data = await request.json(); } catch { return json({ ok: false, error: 'Invalid JSON' }, 400, corsHeaders); }

  const id = Number(data.id || 0);
  const expenseDate = (data.date || '').toString().trim();
  const vendor = (data.vendor || '').toString().trim();
  const category = (data.category || '').toString().trim();
  const paidVia = (data.paidVia || '').toString().trim();
  const notes = (data.notes || '').toString().trim();
  const cents = toCents(data.amount);

  if (!Number.isInteger(id) || id <= 0) return json({ ok: false, error: 'Invalid id' }, 400, corsHeaders);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expenseDate)) return json({ ok: false, error: 'Invalid date' }, 400, corsHeaders);
  if (!category) return json({ ok: false, error: 'Missing category' }, 400, corsHeaders);
  if (cents === null) return json({ ok: false, error: 'Invalid amount' }, 400, corsHeaders);

  const existing = await env.DB.prepare('SELECT id FROM tax_expenses WHERE id = ?1').bind(id).first();
  if (!existing) return json({ ok: false, error: 'Expense not found' }, 404, corsHeaders);

  await env.DB.prepare(
    `UPDATE tax_expenses
     SET expense_date = ?1,
         vendor = ?2,
         category = ?3,
         amount_cents = ?4,
         paid_via = ?5,
         notes = ?6
     WHERE id = ?7`
  ).bind(expenseDate, vendor || null, category, cents, paidVia || null, notes || null, id).run();

  await upsertTaxExpenseJournal(env.DB, {
    id,
    expense_date: expenseDate,
    vendor,
    category,
    amount_cents: cents,
    paid_via: paidVia || null,
    notes: notes || null
  });

  return json({ ok: true, id }, 200, corsHeaders);
}

async function handleTaxOwnerTransfer(request, env, corsHeaders, url) {
  if (!env.DB) return json({ ok: false, error: 'DB binding missing' }, 500, corsHeaders);
  const auth = await requireAdmin(request, env, corsHeaders, url);
  if (!auth.ok) return auth.res;

  const accountingReady = await ensureAccountingSetup(env.DB);
  if (!accountingReady) return json({ ok: false, error: 'Accounting tables are not migrated yet. Run D1 migrations with --remote.' }, 503, corsHeaders);

  let data;
  try { data = await request.json(); } catch { return json({ ok: false, error: 'Invalid JSON' }, 400, corsHeaders); }

  const entryDate = (data.date || '').toString().trim();
  const transferType = (data.transferType || '').toString().trim();
  const notes = (data.notes || '').toString().trim();
  const cents = toCents(data.amount);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(entryDate)) return json({ ok: false, error: 'Invalid date' }, 400, corsHeaders);
  const validTransferTypes = [
    'personal_to_business',
    'business_to_personal',
    'business_to_solo_401k',
    'personal_to_solo_401k',
    'personal_paid_business_card',
    'business_paid_business_card'
  ];
  if (!validTransferTypes.includes(transferType)) return json({ ok: false, error: 'Invalid transfer type' }, 400, corsHeaders);
  if (!Number.isFinite(cents) || cents <= 0) return json({ ok: false, error: 'Invalid amount' }, 400, corsHeaders);

  const cashId = await getAccountIdByCode(env.DB, '1000');
  const ownerContribId = await getAccountIdByCode(env.DB, '3100');
  const ownerDrawId = await getAccountIdByCode(env.DB, '3200');
  const ownerRetirementId = await ensureAccountByCode(env.DB, '3210', 'Owner Retirement Contributions', 'equity', 'debit');
  const ccPayableId = await getAccountIdByCode(env.DB, '2100');
  if (!cashId || !ownerContribId || !ownerDrawId || !ownerRetirementId || !ccPayableId) return json({ ok: false, error: 'Required accounts not found' }, 500, corsHeaders);

  const transferLabels = {
    personal_to_business: 'Personal to business owner contribution',
    business_to_personal: 'Business to personal owner draw',
    business_to_solo_401k: 'Business cash to owner Solo 401(k)',
    personal_to_solo_401k: 'Personal or joint funds to owner Solo 401(k)',
    personal_paid_business_card: 'Personal funds paid business card',
    business_paid_business_card: 'Business funds paid business card'
  };
  const ins = await env.DB.prepare(`INSERT INTO journal_entries (entry_date, memo, source_type, notes) VALUES (?1, ?2, 'owner_transfer', ?3)`).bind(entryDate, transferLabels[transferType], notes || null).run();
  const entryId = Number(ins.meta?.last_row_id || 0);

  if (transferType === 'personal_to_business') {
    await env.DB.prepare(`INSERT INTO journal_lines (entry_id, account_id, debit_cents, credit_cents) VALUES (?1, ?2, ?3, 0), (?1, ?4, 0, ?3)`).bind(entryId, cashId, cents, ownerContribId).run();
  } else if (transferType === 'business_to_personal') {
    await env.DB.prepare(`INSERT INTO journal_lines (entry_id, account_id, debit_cents, credit_cents) VALUES (?1, ?2, ?3, 0), (?1, ?4, 0, ?3)`).bind(entryId, ownerDrawId, cents, cashId).run();
  } else if (transferType === 'business_to_solo_401k') {
    // Owner-only retirement contributions are owner-level deductions, not Schedule C expenses.
    await env.DB.prepare(`INSERT INTO journal_lines (entry_id, account_id, debit_cents, credit_cents) VALUES (?1, ?2, ?3, 0), (?1, ?4, 0, ?3)`).bind(entryId, ownerRetirementId, cents, cashId).run();
  } else if (transferType === 'personal_to_solo_401k') {
    // Track an outside-funded contribution without changing business cash or the income statement.
    await env.DB.prepare(`INSERT INTO journal_lines (entry_id, account_id, debit_cents, credit_cents) VALUES (?1, ?2, ?3, 0), (?1, ?4, 0, ?3)`).bind(entryId, ownerRetirementId, cents, ownerContribId).run();
  } else if (transferType === 'personal_paid_business_card') {
    await env.DB.prepare(`INSERT INTO journal_lines (entry_id, account_id, debit_cents, credit_cents) VALUES (?1, ?2, ?3, 0), (?1, ?4, 0, ?3)`).bind(entryId, ccPayableId, cents, ownerContribId).run();
  } else {
    await env.DB.prepare(`INSERT INTO journal_lines (entry_id, account_id, debit_cents, credit_cents) VALUES (?1, ?2, ?3, 0), (?1, ?4, 0, ?3)`).bind(entryId, ccPayableId, cents, cashId).run();
  }

  return json({ ok: true, id: entryId }, 200, corsHeaders);
}

/**
 * POST /api/tax/income/update — Admin: edit an existing income entry
 */
async function handleTaxIncomeUpdate(request, env, corsHeaders, url) {
  if (!env.DB) return json({ ok: false, error: 'DB binding missing' }, 500, corsHeaders);
  const auth = await requireAdmin(request, env, corsHeaders, url);
  if (!auth.ok) return auth.res;

  let data;
  try { data = await request.json(); } catch { return json({ ok: false, error: 'Invalid JSON' }, 400, corsHeaders); }

  const id = Number(data.id || 0);
  const incomeDate = (data.date || '').toString().trim();
  const source = (data.source || '').toString().trim();
  const category = (data.category || '').toString().trim();
  const stripeSessionId = (data.stripeSessionId || '').toString().trim();
  const notes = (data.notes || '').toString().trim();
  const isOwnerFunded = data.isOwnerFunded === true ? 1 : 0;
  const cents = toCents(data.amount);

  if (!Number.isInteger(id) || id <= 0) return json({ ok: false, error: 'Invalid id' }, 400, corsHeaders);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(incomeDate)) return json({ ok: false, error: 'Invalid date' }, 400, corsHeaders);
  if (!category) return json({ ok: false, error: 'Missing category' }, 400, corsHeaders);
  if (cents === null) return json({ ok: false, error: 'Invalid amount' }, 400, corsHeaders);

  const existing = await env.DB.prepare('SELECT id, stripe_session_id, notes FROM tax_income WHERE id = ?1').bind(id).first();
  if (!existing) return json({ ok: false, error: 'Income not found' }, 404, corsHeaders);

  await env.DB.prepare(
    `UPDATE tax_income
     SET income_date = ?1,
         source = ?2,
         category = ?3,
         amount_cents = ?4,
         stripe_session_id = ?5,
         notes = ?6,
         is_owner_funded = ?7
     WHERE id = ?8`
  ).bind(incomeDate, source || null, category, cents, stripeSessionId || null, notes || null, isOwnerFunded, id).run();

  await upsertTaxIncomeJournal(env.DB, {
    id,
    income_date: incomeDate,
    source,
    category,
    amount_cents: cents,
    notes: notes || null,
    is_owner_funded: isOwnerFunded
  });

  const invoiceIds = new Set([
    extractInvoiceIdFromIncome(existing),
    extractInvoiceIdFromIncome({ stripe_session_id: stripeSessionId, notes })
  ].filter(Boolean));
  for (const invoiceId of invoiceIds) {
    await syncInvoicePaidFromIncome(env.DB, invoiceId);
  }

  return json({ ok: true, id }, 200, corsHeaders);
}


/**
 * POST /api/tax/expense/delete — Admin: delete expense entry
 */
async function handleTaxExpenseDelete(request, env, corsHeaders, url) {
  if (!env.DB) return json({ ok: false, error: 'DB binding missing' }, 500, corsHeaders);
  const auth = await requireAdmin(request, env, corsHeaders, url);
  if (!auth.ok) return auth.res;

  let data;
  try { data = await request.json(); } catch { return json({ ok: false, error: 'Invalid JSON' }, 400, corsHeaders); }
  const id = Number(data.id || 0);
  if (!Number.isInteger(id) || id <= 0) return json({ ok: false, error: 'Invalid id' }, 400, corsHeaders);

  const existing = await env.DB.prepare('SELECT id, receipt_key FROM tax_expenses WHERE id = ?1').bind(id).first();
  if (!existing) return json({ ok: false, error: 'Expense not found' }, 404, corsHeaders);

  if (existing.receipt_key && env.RECEIPTS) {
    await env.RECEIPTS.delete(existing.receipt_key).catch(() => {});
  }

  await env.DB.prepare('DELETE FROM tax_expenses WHERE id = ?1').bind(id).run();
  await deleteAutoJournalBySource(env.DB, 'tax_expense', id);
  return json({ ok: true, id }, 200, corsHeaders);
}

/**
 * POST /api/tax/income/delete — Admin: delete income entry
 */
async function handleTaxIncomeDelete(request, env, corsHeaders, url) {
  if (!env.DB) return json({ ok: false, error: 'DB binding missing' }, 500, corsHeaders);
  const auth = await requireAdmin(request, env, corsHeaders, url);
  if (!auth.ok) return auth.res;

  let data;
  try { data = await request.json(); } catch { return json({ ok: false, error: 'Invalid JSON' }, 400, corsHeaders); }
  const id = Number(data.id || 0);
  if (!Number.isInteger(id) || id <= 0) return json({ ok: false, error: 'Invalid id' }, 400, corsHeaders);

  const existing = await env.DB.prepare('SELECT id, receipt_key, stripe_session_id, notes FROM tax_income WHERE id = ?1').bind(id).first();
  if (!existing) return json({ ok: false, error: 'Income not found' }, 404, corsHeaders);

  if (existing.receipt_key && env.RECEIPTS) {
    await env.RECEIPTS.delete(existing.receipt_key).catch(() => {});
  }

  await env.DB.prepare('DELETE FROM tax_income WHERE id = ?1').bind(id).run();
  await deleteAutoJournalBySource(env.DB, 'tax_income', id);
  const invoiceId = extractInvoiceIdFromIncome(existing);
  if (invoiceId) await syncInvoicePaidFromIncome(env.DB, invoiceId);
  return json({ ok: true, id }, 200, corsHeaders);
}

/**
 * POST /api/tax/receipt/upload — Admin: upload a receipt file to R2 and attach to a tax record
 * Multipart form fields: type (expense|income), id, file (PDF/JPG/PNG ≤ 10MB)
 */
async function handleTaxReceiptUpload(request, env, corsHeaders, url) {
  if (!env.DB) return json({ ok: false, error: 'DB binding missing' }, 500, corsHeaders);
  if (!env.RECEIPTS) return json({ ok: false, error: 'RECEIPTS binding missing' }, 500, corsHeaders);
  const auth = await requireAdmin(request, env, corsHeaders, url);
  if (!auth.ok) return auth.res;

  let formData;
  try { formData = await request.formData(); } catch { return json({ ok: false, error: 'Invalid form data' }, 400, corsHeaders); }

  const type = (formData.get('type') || '').toString().trim();
  const id = Number(formData.get('id') || 0);
  const file = formData.get('file');

  if (!['expense', 'income'].includes(type)) return json({ ok: false, error: 'Invalid type' }, 400, corsHeaders);
  if (!Number.isInteger(id) || id <= 0) return json({ ok: false, error: 'Invalid id' }, 400, corsHeaders);
  if (!file || typeof file.arrayBuffer !== 'function') return json({ ok: false, error: 'Missing file' }, 400, corsHeaders);

  const allowedTypes = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png' };
  const ext = allowedTypes[file.type];
  if (!ext) return json({ ok: false, error: 'File must be PDF, JPG, or PNG' }, 400, corsHeaders);

  const bytes = await file.arrayBuffer();
  if (bytes.byteLength > 10 * 1024 * 1024) return json({ ok: false, error: 'File exceeds 10MB limit' }, 400, corsHeaders);

  // Verify record exists
  const table = type === 'expense' ? 'tax_expenses' : 'tax_income';
  const existing = await env.DB.prepare(`SELECT id, receipt_key FROM ${table} WHERE id = ?1`).bind(id).first();
  if (!existing) return json({ ok: false, error: `${type} record not found` }, 404, corsHeaders);

  // Delete old R2 object if replacing
  if (existing.receipt_key) {
    await env.RECEIPTS.delete(existing.receipt_key).catch(() => {});
  }

  const key = `receipts/${type}/${id}.${ext}`;
  await env.RECEIPTS.put(key, bytes, { httpMetadata: { contentType: file.type } });

  await env.DB.prepare(`UPDATE ${table} SET receipt_key = ?1 WHERE id = ?2`).bind(key, id).run();

  return json({ ok: true, key }, 200, corsHeaders);
}

/**
 * GET /api/tax/receipt — Admin: retrieve a receipt from R2
 * Query params: key (R2 object key)
 */
async function handleTaxReceiptGet(request, env, corsHeaders, url) {
  if (!env.RECEIPTS) return json({ ok: false, error: 'RECEIPTS binding missing' }, 500, corsHeaders);

  const auth = await requireAdmin(request, env, corsHeaders, url);
  if (!auth.ok) return auth.res;

  const r2Key = url.searchParams.get('key') || '';
  if (!r2Key) return json({ ok: false, error: 'Missing key' }, 400, corsHeaders);

  const obj = await env.RECEIPTS.get(r2Key);
  if (!obj) return json({ ok: false, error: 'Receipt not found' }, 404, corsHeaders);

  const contentType = obj.httpMetadata?.contentType || 'application/octet-stream';
  return new Response(obj.body, {
    status: 200,
    headers: withSecurityHeaders({
      ...corsHeaders,
      'Content-Type': contentType,
      'Content-Disposition': `inline; filename="receipt.${r2Key.split('.').pop()}"`,
      'Cache-Control': 'private, max-age=3600'
    })
  });
}

/**
 * GET /api/tax/export.csv — Admin: download CSV of tax entries for selected year/type
 * @returns {Response} CSV file attachment
 */
async function handleTaxExportCsv(request, env, corsHeaders, url) {
  if (!env.DB) return json({ ok: false, error: 'DB binding missing' }, 500, corsHeaders);
  const auth = await requireAdmin(request, env, corsHeaders, url);
  if (!auth.ok) return auth.res;

  const year = (url.searchParams.get('year') || '').trim();
  const type = (url.searchParams.get('type') || 'all').trim();
  if (!/^\d{4}$/.test(year)) return json({ ok: false, error: 'Missing/invalid year' }, 400, corsHeaders);

  const expenses = (type === 'all' || type === 'expense')
    ? await env.DB.prepare(
        `SELECT expense_date AS date, vendor, category, amount_cents, paid_via, notes, created_at
         FROM tax_expenses
         WHERE substr(expense_date,1,4) = ?1
         ORDER BY expense_date ASC, id ASC`
      ).bind(year).all()
    : { results: [] };

  const income = (type === 'all' || type === 'income')
    ? await env.DB.prepare(
        `SELECT income_date AS date, source, category, amount_cents, stripe_session_id, notes, is_owner_funded, created_at
         FROM tax_income
         WHERE substr(income_date,1,4) = ?1
         ORDER BY income_date ASC, id ASC`
      ).bind(year).all()
    : { results: [] };

  const lines = [];
  lines.push(['date','type','category','vendor_or_source','amount','paid_via','stripe_session_id','notes','created_at'].join(','));

  for (const r of (income.results || [])) {
    lines.push([
      csvEscape(r.date),
      'income',
      csvEscape(r.category),
      csvEscape(r.source || ''),
      (Number(r.amount_cents || 0) / 100).toFixed(2),
      '',
      csvEscape(r.stripe_session_id || ''),
      csvEscape(r.notes || ''),
      csvEscape(r.created_at || '')
    ].join(','));
  }

  for (const r of (expenses.results || [])) {
    lines.push([
      csvEscape(r.date),
      'expense',
      csvEscape(r.category),
      csvEscape(r.vendor || ''),
      (Number(r.amount_cents || 0) / 100).toFixed(2),
      csvEscape(r.paid_via || ''),
      '',
      csvEscape(r.notes || ''),
      csvEscape(r.created_at || '')
    ].join(','));
  }

  const csv = lines.join('\n');
  const filename = `fmg-tax-${year}-${type}.csv`;

  return new Response(csv, {
    status: 200,
    headers: withSecurityHeaders({
      ...corsHeaders,
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`
    })
  });
}

async function handleAdminNotesList(request, env, corsHeaders, url) {
  if (!env.DB) return json({ ok: false, error: 'DB binding missing' }, 500, corsHeaders);
  const auth = await requireAdmin(request, env, corsHeaders, url);
  if (!auth.ok) return auth.res;
  const scope = (url.searchParams.get('scope') || 'general').toString().trim().toLowerCase();
  const noteYear = Number(url.searchParams.get('year') || 0);
  const validScope = scope === 'year' ? 'year' : 'general';
  let query = `SELECT id, scope_type, note_year, note_text, created_at, updated_at FROM admin_notes WHERE scope_type = ?1`;
  const binds = [validScope];
  if (validScope === 'year' && noteYear) {
    query += ` AND note_year = ?2`;
    binds.push(noteYear);
  }
  query += ` ORDER BY created_at DESC, id DESC`;
  const stmt = env.DB.prepare(query);
  const result = binds.length === 2 ? await stmt.bind(binds[0], binds[1]).all() : await stmt.bind(binds[0]).all();
  return json({ ok: true, notes: result.results || [] }, 200, corsHeaders);
}

async function handleAdminNotesCreate(request, env, corsHeaders, url) {
  if (!env.DB) return json({ ok: false, error: 'DB binding missing' }, 500, corsHeaders);
  const auth = await requireAdmin(request, env, corsHeaders, url);
  if (!auth.ok) return auth.res;
  let data;
  try { data = await request.json(); } catch { return json({ ok: false, error: 'Invalid JSON' }, 400, corsHeaders); }
  const scopeType = (data.scopeType || data.scope || 'general').toString().trim().toLowerCase() === 'year' ? 'year' : 'general';
  const noteYear = scopeType === 'year' ? Number(data.noteYear || data.year || 0) : null;
  const noteText = (data.noteText || data.text || '').toString().trim();
  if (!noteText) return json({ ok: false, error: 'Note text is required' }, 400, corsHeaders);
  if (scopeType === 'year' && (!Number.isInteger(noteYear) || noteYear < 2000 || noteYear > 2100)) {
    return json({ ok: false, error: 'Valid note year is required' }, 400, corsHeaders);
  }
  const res = await env.DB.prepare(
    `INSERT INTO admin_notes (scope_type, note_year, note_text, updated_at) VALUES (?1, ?2, ?3, datetime('now'))`
  ).bind(scopeType, noteYear, noteText).run();
  return json({ ok: true, id: Number(res.meta?.last_row_id || 0) }, 200, corsHeaders);
}

async function handleAccountsList(request, env, corsHeaders, url) {
  if (!env.DB) return json({ ok: false, error: 'DB binding missing' }, 500, corsHeaders);
  const auth = await requireAdmin(request, env, corsHeaders, url);
  if (!auth.ok) return auth.res;

  const accountingReady = await ensureAccountingSetup(env.DB);
  if (!accountingReady) return json({ ok: false, error: 'Accounting tables are not migrated yet. Run D1 migrations with --remote.' }, 503, corsHeaders);
  const rows = await env.DB.prepare(
    `SELECT id, code, name, account_type, normal_side, is_system, active
     FROM accounts
     WHERE active = 1
     ORDER BY code ASC, id ASC`
  ).all();

  return json({ ok: true, accounts: rows.results || [] }, 200, corsHeaders);
}

async function handleAccountsSummary(request, env, corsHeaders, url) {
  if (!env.DB) return json({ ok: false, error: 'DB binding missing' }, 500, corsHeaders);
  const auth = await requireAdmin(request, env, corsHeaders, url);
  if (!auth.ok) return auth.res;

  const accountingReady = await ensureAccountingSetup(env.DB);
  if (!accountingReady) return json({ ok: false, error: 'Accounting tables are not migrated yet. Run D1 migrations with --remote.' }, 503, corsHeaders);

  const year = (url.searchParams.get('year') || '').trim();
  const from = (url.searchParams.get('from') || '').trim();
  const to = (url.searchParams.get('to') || '').trim();

  let where = '';
  const binds = [];
  if (/^\d{4}$/.test(year)) {
    where = `WHERE substr(je.entry_date,1,4) = ?1`;
    binds.push(year);
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to)) {
    where = `WHERE je.entry_date >= ?1 AND je.entry_date <= ?2`;
    binds.push(from, to);
  }

  const sql = `SELECT a.id, a.code, a.name, a.account_type, a.normal_side,
      COALESCE(SUM(jl.debit_cents),0) AS debit_total,
      COALESCE(SUM(jl.credit_cents),0) AS credit_total
    FROM accounts a
    LEFT JOIN journal_lines jl ON jl.account_id = a.id
    LEFT JOIN journal_entries je ON je.id = jl.entry_id
    ${where}
    GROUP BY a.id, a.code, a.name, a.account_type, a.normal_side
    ORDER BY a.code ASC, a.id ASC`;

  const q = env.DB.prepare(sql);
  const rows = binds.length ? await q.bind(...binds).all() : await q.all();
  const accounts = (rows.results || []).map((r) => {
    const debits = Number(r.debit_total || 0);
    const credits = Number(r.credit_total || 0);
    const balance = r.normal_side === 'debit' ? (debits - credits) : (credits - debits);
    return { ...r, debit_total: debits, credit_total: credits, balance_cents: balance };
  });

  const totals = accounts.reduce((acc, r) => {
    acc.debits += Number(r.debit_total || 0);
    acc.credits += Number(r.credit_total || 0);
    return acc;
  }, { debits: 0, credits: 0 });

  return json({
    ok: true,
    accounts,
    totals,
    balanced: totals.debits === totals.credits,
    period: { year: /^\d{4}$/.test(year) ? year : null, from: from || null, to: to || null }
  }, 200, corsHeaders);
}

async function handleAccountsJournal(request, env, corsHeaders, url) {
  if (!env.DB) return json({ ok: false, error: 'DB binding missing' }, 500, corsHeaders);
  const auth = await requireAdmin(request, env, corsHeaders, url);
  if (!auth.ok) return auth.res;

  const accountingReady = await ensureAccountingSetup(env.DB);
  if (!accountingReady) return json({ ok: false, error: 'Accounting tables are not migrated yet. Run D1 migrations with --remote.' }, 503, corsHeaders);

  const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit') || 200)));
  const year = (url.searchParams.get('year') || '').trim();
  const from = (url.searchParams.get('from') || '').trim();
  const to = (url.searchParams.get('to') || '').trim();

  let entryWhere = '';
  const binds = [];
  if (/^\d{4}$/.test(year)) { entryWhere = 'WHERE entry_date >= ?1 AND entry_date <= ?2'; binds.push(`${year}-01-01`, `${year}-12-31`); }
  else if (/^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to)) { entryWhere = 'WHERE entry_date >= ?1 AND entry_date <= ?2'; binds.push(from, to); }

  // Use a subquery JOIN to avoid passing up to 500 entry IDs as bind parameters
  // (D1 caps bound parameters at 100 per statement).
  const limitParam = `?${binds.length + 1}`;
  const sql = `
    SELECT je.id AS entry_id, je.entry_date, je.memo, je.source_type, je.source_id, je.created_at, je.notes,
           jl.id AS line_id, jl.account_id, jl.debit_cents, jl.credit_cents, a.code, a.name
    FROM (
      SELECT id, entry_date, memo, source_type, source_id, created_at, notes
      FROM journal_entries ${entryWhere}
      ORDER BY entry_date DESC, id DESC
      LIMIT ${limitParam}
    ) je
    JOIN journal_lines jl ON jl.entry_id = je.id
    JOIN accounts a ON a.id = jl.account_id
    ORDER BY je.entry_date DESC, je.id DESC, jl.id ASC`;

  const q = env.DB.prepare(sql);
  const rows = await (binds.length ? q.bind(...binds, limit) : q.bind(limit)).all();

  // Group flat rows into entry objects with nested lines arrays.
  const entriesMap = new Map();
  const entryOrder = [];
  for (const row of (rows.results || [])) {
    const eid = Number(row.entry_id);
    if (!entriesMap.has(eid)) {
      entryOrder.push(eid);
      entriesMap.set(eid, {
        id: eid,
        entry_date: row.entry_date,
        memo: row.memo,
        source_type: row.source_type,
        source_id: row.source_id,
        created_at: row.created_at,
        notes: row.notes,
        lines: []
      });
    }
    entriesMap.get(eid).lines.push({
      id: Number(row.line_id),
      entry_id: eid,
      account_id: Number(row.account_id),
      debit_cents: Number(row.debit_cents || 0),
      credit_cents: Number(row.credit_cents || 0),
      code: row.code,
      name: row.name
    });
  }
  const out = entryOrder.map(id => entriesMap.get(id));
  return json({ ok: true, entries: out }, 200, corsHeaders);
}

async function handleAccountsStatements(request, env, corsHeaders, url) {
  if (!env.DB) return json({ ok: false, error: 'DB binding missing' }, 500, corsHeaders);
  const auth = await requireAdmin(request, env, corsHeaders, url);
  if (!auth.ok) return auth.res;

  const accountingReady = await ensureAccountingSetup(env.DB);
  if (!accountingReady) return json({ ok: false, error: 'Accounting tables are not migrated yet. Run D1 migrations with --remote.' }, 503, corsHeaders);

  const year = (url.searchParams.get('year') || '').trim();
  const from = (url.searchParams.get('from') || '').trim();
  const to = (url.searchParams.get('to') || '').trim();

  let where = '';
  const binds = [];
  if (/^\d{4}$/.test(year)) {
    where = `WHERE je.entry_date >= ?1 AND je.entry_date <= ?2`;
    binds.push(`${year}-01-01`, `${year}-12-31`);
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to)) {
    where = `WHERE je.entry_date >= ?1 AND je.entry_date <= ?2`;
    binds.push(from, to);
  }

  const q = env.DB.prepare(`SELECT a.id, a.code, a.name, a.account_type, a.normal_side,
      COALESCE(SUM(jl.debit_cents),0) AS debit_total,
      COALESCE(SUM(jl.credit_cents),0) AS credit_total
    FROM accounts a
    LEFT JOIN journal_lines jl ON jl.account_id = a.id
    LEFT JOIN journal_entries je ON je.id = jl.entry_id
    ${where}
    GROUP BY a.id, a.code, a.name, a.account_type, a.normal_side
    ORDER BY a.code ASC, a.id ASC`);
  const rows = binds.length ? await q.bind(...binds).all() : await q.all();
  const accounts = (rows.results || []).map((r) => {
    const debits = Number(r.debit_total || 0);
    const credits = Number(r.credit_total || 0);
    let bal;
    if (r.account_type === 'asset' || r.account_type === 'expense') {
      bal = debits - credits;
    } else {
      bal = credits - debits;
    }
    return { ...r, debit_total: debits, credit_total: credits, balance_cents: bal };
  });

  const balanceSheet = {
    assets: accounts.filter(a => a.account_type === 'asset'),
    liabilities: accounts.filter(a => a.account_type === 'liability'),
    equity: accounts.filter(a => a.account_type === 'equity')
  };

  const incomeStatement = {
    income: accounts.filter(a => a.account_type === 'income'),
    expenses: accounts.filter(a => a.account_type === 'expense')
  };

  const totals = {
    assets: balanceSheet.assets.reduce((s, a) => s + Number(a.balance_cents || 0), 0),
    liabilities: balanceSheet.liabilities.reduce((s, a) => s + Number(a.balance_cents || 0), 0),
    equity: balanceSheet.equity.reduce((s, a) => s + Number(a.balance_cents || 0), 0),
    income: incomeStatement.income.reduce((s, a) => s + Number(a.balance_cents || 0), 0),
    expenses: incomeStatement.expenses.reduce((s, a) => s + Number(a.balance_cents || 0), 0)
  };
  const currentEarnings = totals.income - totals.expenses;

  const cashAccount = accounts.find(a => a.code === '1000');
  const cashFlow = {
    netCashChange: Number(cashAccount?.balance_cents || 0),
    note: 'Simple direct cash movement from Cash on Hand account for selected period.'
  };

  return json({
    ok: true,
    balanceSheet,
    incomeStatement,
    cashFlow,
    totals,
    equationBalanced: totals.assets === (totals.liabilities + totals.equity + currentEarnings)
  }, 200, corsHeaders);
}

async function handleAccountsJournalCreate(request, env, corsHeaders, url) {
  if (!env.DB) return json({ ok: false, error: 'DB binding missing' }, 500, corsHeaders);
  const auth = await requireAdmin(request, env, corsHeaders, url);
  if (!auth.ok) return auth.res;
  const accountingReady = await ensureAccountingSetup(env.DB);
  if (!accountingReady) return json({ ok: false, error: 'Accounting tables are not migrated yet. Run D1 migrations with --remote.' }, 503, corsHeaders);

  let data;
  try { data = await request.json(); } catch { return json({ ok: false, error: 'Invalid JSON' }, 400, corsHeaders); }

  const entryDate = (data.entry_date || data.date || '').toString().trim();
  const memo = (data.memo || '').toString().trim();
  const notes = (data.notes || '').toString().trim();
  const lines = data.lines || [];

  if (!/^\d{4}-\d{2}-\d{2}$/.test(entryDate)) return json({ ok: false, error: 'Invalid date' }, 400, corsHeaders);
  if (!Array.isArray(lines) || lines.length < 2) return json({ ok: false, error: 'At least 2 journal lines required' }, 400, corsHeaders);

  let totalDebit = 0;
  let totalCredit = 0;
  const lineValues = [];

  for (const line of lines) {
    let accountId = 0;
    const code = (line.code || line.account_code || line.accountCode || '').toString().trim();
    if (code) {
      accountId = await getAccountIdByCode(env.DB, code);
      if (!accountId) return json({ ok: false, error: `Account code '${code}' not found` }, 400, corsHeaders);
    } else {
      const rawAccountId = line.account_id ?? line.accountId ?? '';
      accountId = Number(rawAccountId || 0);
      if (accountId) {
        const account = await env.DB.prepare(`SELECT id FROM accounts WHERE id = ?1`).bind(accountId).first();
        if (!account) {
          const accountCode = rawAccountId.toString().trim();
          accountId = accountCode ? await getAccountIdByCode(env.DB, accountCode) : null;
        }
      }
    }
    if (!accountId) return json({ ok: false, error: 'Invalid account_id or code in lines' }, 400, corsHeaders);

    const debitCents = Number(line.debit_cents || line.debitCents || 0);
    const creditCents = Number(line.credit_cents || line.creditCents || 0);
    if (!Number.isInteger(debitCents) || !Number.isInteger(creditCents) || debitCents < 0 || creditCents < 0) {
      return json({ ok: false, error: 'Invalid debit/credit cents in lines' }, 400, corsHeaders);
    }
    totalDebit += debitCents;
    totalCredit += creditCents;
    lineValues.push({ accountId, debitCents, creditCents });
  }

  if (totalDebit !== totalCredit) return json({ ok: false, error: 'Journal must balance (total debit must equal total credit)' }, 400, corsHeaders);
  if (totalDebit <= 0) return json({ ok: false, error: 'Total amount must be greater than 0' }, 400, corsHeaders);

  const ins = await env.DB.prepare(`INSERT INTO journal_entries (entry_date, memo, source_type, notes) VALUES (?1, ?2, 'manual', ?3)`).bind(entryDate, memo || null, notes || null).run();
  const entryId = Number(ins.meta?.last_row_id || 0);

  const values = [];
  for (const lv of lineValues) {
    values.push(entryId, lv.accountId, lv.debitCents, lv.creditCents);
  }

  const placeholders = lineValues.map(() => '(?, ?, ?, ?)').join(', ');
  await env.DB.prepare(`INSERT INTO journal_lines (entry_id, account_id, debit_cents, credit_cents) VALUES ${placeholders}`).bind(...values).run();

  return json({ ok: true, id: entryId }, 200, corsHeaders);
}

async function handleAccountsRebuildAutoJournal(request, env, corsHeaders, url) {
  if (!env.DB) return json({ ok: false, error: 'DB binding missing' }, 500, corsHeaders);
  const auth = await requireAdmin(request, env, corsHeaders, url);
  if (!auth.ok) return auth.res;
  const accountingReady = await ensureAccountingSetup(env.DB);
  if (!accountingReady) return json({ ok: false, error: 'Accounting tables are not migrated yet. Run D1 migrations with --remote.' }, 503, corsHeaders);

  // Chunked rebuild: Cloudflare caps the number of DB calls a single Worker
  // invocation can make (~1000). With hundreds of tax rows (each needing several
  // DB ops) a one-shot rebuild blows past that limit and fails partway. The client
  // calls this repeatedly with an increasing `start` until `done` is true.
  let body = {};
  try { body = await request.json(); } catch {}
  const start = Math.max(0, Number(body.start || 0));
  const BATCH = 150;

  // Clear all auto-generated journal rows once, on the first chunk only.
  if (start === 0) {
    await env.DB.prepare(
      `DELETE FROM journal_lines WHERE entry_id IN (SELECT id FROM journal_entries WHERE source_type IN ('tax_expense','tax_income'))`
    ).run();
    await env.DB.prepare(`DELETE FROM journal_entries WHERE source_type IN ('tax_expense','tax_income')`).run();
  }

  const expenses = await env.DB.prepare(
    `SELECT id, expense_date, vendor, category, amount_cents, paid_via, notes FROM tax_expenses ORDER BY id ASC`
  ).all();
  const income = await env.DB.prepare(
    `SELECT id, income_date, source, category, amount_cents, notes, is_owner_funded FROM tax_income ORDER BY id ASC`
  ).all();

  const combined = [
    ...(expenses.results || []).map(row => ({ kind: 'expense', row })),
    ...(income.results || []).map(row => ({ kind: 'income', row }))
  ];
  const total = combined.length;
  const slice = combined.slice(start, start + BATCH);

  const errors = [];
  for (const item of slice) {
    try {
      // skipDelete=true: the bulk delete above already cleared prior auto rows,
      // and each source row appears in exactly one chunk, so no per-row delete needed.
      if (item.kind === 'expense') await upsertTaxExpenseJournal(env.DB, item.row, true);
      else await upsertTaxIncomeJournal(env.DB, item.row, true);
    } catch (err) {
      errors.push({ type: item.kind, id: item.row.id, category: item.row.category, amount_cents: item.row.amount_cents, error: String(err?.message || err) });
    }
  }

  const nextStart = start + slice.length;
  const done = nextStart >= total;
  return json({
    ok: true,
    done,
    nextStart,
    total,
    processed: slice.length,
    errors
  }, 200, corsHeaders);
}

async function handleAccountsYearClose(request, env, corsHeaders, url) {
  if (!env.DB) return json({ ok: false, error: 'DB binding missing' }, 500, corsHeaders);
  const auth = await requireAdmin(request, env, corsHeaders, url);
  if (!auth.ok) return auth.res;
  const accountingReady = await ensureAccountingSetup(env.DB);
  if (!accountingReady) return json({ ok: false, error: 'Accounting tables are not migrated yet. Run D1 migrations with --remote.' }, 503, corsHeaders);

  let data;
  try { data = await request.json(); } catch { return json({ ok: false, error: 'Invalid JSON' }, 400, corsHeaders); }
  const year = (data.year || '').toString().trim();
  const apply = data.apply === true;
  if (!/^\d{4}$/.test(year)) return json({ ok: false, error: 'Invalid year' }, 400, corsHeaders);

  const from = `${year}-01-01`;
  const to = `${year}-12-31`;
  const rows = await env.DB.prepare(`SELECT a.id, a.code, a.name, a.account_type, a.normal_side,
      COALESCE(SUM(jl.debit_cents),0) AS debit_total,
      COALESCE(SUM(jl.credit_cents),0) AS credit_total
    FROM accounts a
    LEFT JOIN journal_lines jl ON jl.account_id = a.id
    LEFT JOIN journal_entries je ON je.id = jl.entry_id AND je.entry_date >= ?1 AND je.entry_date <= ?2
    GROUP BY a.id, a.code, a.name, a.account_type, a.normal_side
    ORDER BY a.code ASC`).bind(from, to).all();

  const accounts = (rows.results || []).map((r) => {
    const debits = Number(r.debit_total || 0);
    const credits = Number(r.credit_total || 0);
    const bal = r.normal_side === 'debit' ? (debits - credits) : (credits - debits);
    return { ...r, balance_cents: bal };
  });

  const income = accounts.filter(a => a.account_type === 'income' && Number(a.balance_cents) !== 0);
  const expenses = accounts.filter(a => a.account_type === 'expense' && Number(a.balance_cents) !== 0);
  const incomeTotal = income.reduce((s, a) => s + Number(a.balance_cents || 0), 0);
  const expenseTotal = expenses.reduce((s, a) => s + Number(a.balance_cents || 0), 0);
  const net = incomeTotal - expenseTotal;

  const incomeSummaryId = await ensureAccountByCode(env.DB, '3900', 'Income Summary', 'equity', 'credit');
  const ownerEquityId = await ensureAccountByCode(env.DB, '3000', 'Owner Equity', 'equity', 'credit');

  const preview = {
    year,
    steps: [
      { step: 1, title: 'Close revenue accounts to Income Summary', amount_cents: incomeTotal },
      { step: 2, title: 'Close expense accounts to Income Summary', amount_cents: expenseTotal },
      { step: 3, title: 'Close net income/loss to Owner Equity', amount_cents: net }
    ]
  };

  if (!apply) return json({ ok: true, preview }, 200, corsHeaders);

  const existing = await env.DB.prepare(`SELECT id FROM journal_entries WHERE source_type = 'year_close' AND source_id = ?1`).bind(Number(year)).all();
  for (const r of (existing.results || [])) {
    await env.DB.prepare(`DELETE FROM journal_lines WHERE entry_id = ?1`).bind(r.id).run();
    await env.DB.prepare(`DELETE FROM journal_entries WHERE id = ?1`).bind(r.id).run();
  }

  const closeDate = `${year}-12-31`;

  if (incomeTotal !== 0) {
    const e1 = await env.DB.prepare(`INSERT INTO journal_entries (entry_date, memo, source_type, source_id) VALUES (?1, ?2, 'year_close', ?3)`).bind(closeDate, `Year-end close ${year} - revenues`, Number(year)).run();
    const entryId = Number(e1.meta?.last_row_id || 0);
    for (const a of income) {
      await env.DB.prepare(`INSERT INTO journal_lines (entry_id, account_id, debit_cents, credit_cents) VALUES (?1, ?2, ?3, 0)`).bind(entryId, a.id, Number(a.balance_cents)).run();
    }
    await env.DB.prepare(`INSERT INTO journal_lines (entry_id, account_id, debit_cents, credit_cents) VALUES (?1, ?2, 0, ?3)`).bind(entryId, incomeSummaryId, incomeTotal).run();
  }

  if (expenseTotal !== 0) {
    const e2 = await env.DB.prepare(`INSERT INTO journal_entries (entry_date, memo, source_type, source_id) VALUES (?1, ?2, 'year_close', ?3)`).bind(closeDate, `Year-end close ${year} - expenses`, Number(year)).run();
    const entryId = Number(e2.meta?.last_row_id || 0);
    await env.DB.prepare(`INSERT INTO journal_lines (entry_id, account_id, debit_cents, credit_cents) VALUES (?1, ?2, ?3, 0)`).bind(entryId, incomeSummaryId, expenseTotal).run();
    for (const a of expenses) {
      await env.DB.prepare(`INSERT INTO journal_lines (entry_id, account_id, debit_cents, credit_cents) VALUES (?1, ?2, 0, ?3)`).bind(entryId, a.id, Number(a.balance_cents)).run();
    }
  }

  if (net !== 0) {
    const e3 = await env.DB.prepare(`INSERT INTO journal_entries (entry_date, memo, source_type, source_id) VALUES (?1, ?2, 'year_close', ?3)`).bind(closeDate, `Year-end close ${year} - net to equity`, Number(year)).run();
    const entryId = Number(e3.meta?.last_row_id || 0);
    if (net > 0) {
      await env.DB.prepare(`INSERT INTO journal_lines (entry_id, account_id, debit_cents, credit_cents) VALUES (?1, ?2, ?3, 0), (?1, ?4, 0, ?3)`).bind(entryId, incomeSummaryId, net, ownerEquityId).run();
    } else {
      const loss = Math.abs(net);
      await env.DB.prepare(`INSERT INTO journal_lines (entry_id, account_id, debit_cents, credit_cents) VALUES (?1, ?2, ?3, 0), (?1, ?4, 0, ?3)`).bind(entryId, ownerEquityId, loss, incomeSummaryId).run();
    }
  }

  return json({ ok: true, preview, applied: true }, 200, corsHeaders);
}

async function handleInvoiceCreate(request, env, corsHeaders, url) {
  if (!env.DB) return json({ ok: false, error: 'DB binding missing' }, 500, corsHeaders);
  const auth = await requireAdmin(request, env, corsHeaders, url);
  if (!auth.ok) return auth.res;
  let data;
  try { data = await request.json(); } catch { return json({ ok: false, error: 'Invalid JSON' }, 400, corsHeaders); }

  const invoiceNumber = (data.invoiceNumber || `INV-${Date.now()}`).toString();
  const customerName = (data.customerName || '').toString().trim();
  const customerEmail = (data.customerEmail || '').toString().trim();
  const customerPhone = (data.customerPhone || '').toString().trim();
  const issueDate = (data.issueDate || todayEtDate()).toString().trim();
  const dueDate = (data.dueDate || '').toString().trim();
  const descriptionOfWork = (data.descriptionOfWork || data.notes || '').toString().trim();
  const rawItems = Array.isArray(data.items) ? data.items : [];
  const items = rawItems
    .map((item) => {
      const qtyRaw = Number(item.quantity ?? item.qty ?? 1);
      const qty = Number.isFinite(qtyRaw) && qtyRaw > 0 ? qtyRaw : 1;
      let unitAmountCents = Number(item.unitAmountCents ?? item.amountCents ?? 0);
      if (!Number.isFinite(unitAmountCents) || unitAmountCents <= 0) {
        unitAmountCents = Math.round(Number(item.unitAmount ?? item.amount ?? 0) * 100);
      }
      const description = (item.description || item.itemDescription || '').toString().trim();
      return { description, quantity: qty, unitAmountCents: Math.max(0, Math.round(unitAmountCents)) };
    })
    .filter((item) => item.unitAmountCents > 0 || item.description);

  const missing = [];
  if (!customerName) missing.push('customer name');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(issueDate)) missing.push('issue date');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) missing.push('due date');
  if (!items.length) missing.push('at least one line item');
  if (missing.length) {
    return json({ ok: false, error: `Missing required invoice fields: ${missing.join(', ')}` }, 400, corsHeaders);
  }

  let subtotal = 0;
  for (const item of items) subtotal += Math.round(Number(item.quantity || 1) * Number(item.unitAmountCents || 0));
  const taxCents = Math.max(0, Number(data.taxCents || 0));
  const total = subtotal + taxCents;

  const r = await env.DB.prepare(`INSERT INTO invoices (invoice_number, customer_name, customer_email, customer_phone, customer_company, issue_date, due_date, status, subtotal_cents, tax_cents, total_cents, amount_paid_cents, balance_due_cents, notes) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 0, ?11, ?12)`)
    .bind(invoiceNumber, customerName, customerEmail || null, customerPhone || null, data.customerCompany || null, issueDate, dueDate, data.status || 'draft', subtotal, taxCents, total, descriptionOfWork || null).run();
  const invoiceId = Number(r.meta?.last_row_id || 0);

  for (const item of items) {
    const qty = Number(item.quantity || 1);
    const unit = Number(item.unitAmountCents || 0);
    const lineTotal = Math.round(qty * unit);
    await env.DB.prepare(`INSERT INTO invoice_line_items (invoice_id, item_description, quantity, unit_amount_cents, line_total_cents) VALUES (?1, ?2, ?3, ?4, ?5)`)
      .bind(invoiceId, (item.description || 'Service').toString(), qty, unit, lineTotal).run();
  }

  return json({ ok: true, invoiceId }, 200, corsHeaders);
}

async function handleInvoicesList(request, env, corsHeaders, url) {
  if (!env.DB) return json({ ok: false, error: 'DB binding missing' }, 500, corsHeaders);
  const auth = await requireAdmin(request, env, corsHeaders, url);
  if (!auth.ok) return auth.res;
  const status = (url.searchParams.get('status') || '').trim();
  const useStatus = status && status !== 'all';
  const sort = (url.searchParams.get('sort') || 'newest').trim();
  const orderBy = ({
    newest: 'created_at DESC, issue_date DESC, id DESC',
    'last-name': 'lower(customer_name) ASC, created_at DESC, id DESC',
    status: 'status ASC, created_at DESC, id DESC'
  })[sort] || 'created_at DESC, issue_date DESC, id DESC';
  const rows = useStatus
    ? await env.DB.prepare(`SELECT * FROM invoices WHERE status = ?1 ORDER BY ${orderBy} LIMIT 300`).bind(status).all()
    : await env.DB.prepare(`SELECT * FROM invoices ORDER BY ${orderBy} LIMIT 300`).all();
  return json({ ok: true, invoices: rows.results || [] }, 200, corsHeaders);
}

async function handleInvoiceDetail(request, env, corsHeaders, url) {
  if (!env.DB) return json({ ok: false, error: 'DB binding missing' }, 500, corsHeaders);
  const auth = await requireAdmin(request, env, corsHeaders, url);
  if (!auth.ok) return auth.res;

  const id = Number(url.searchParams.get('id') || 0);
  if (!id) return json({ ok: false, error: 'Invalid invoice id' }, 400, corsHeaders);

  const invoice = await env.DB.prepare(`SELECT * FROM invoices WHERE id = ?1`).bind(id).first();
  if (!invoice) return json({ ok: false, error: 'Invoice not found' }, 404, corsHeaders);

  const itemsRes = await env.DB.prepare(`SELECT id, item_description, quantity, unit_amount_cents, line_total_cents FROM invoice_line_items WHERE invoice_id = ?1 ORDER BY id ASC`).bind(id).all();
  return json({ ok: true, invoice: { ...invoice, line_items: itemsRes.results || [] } }, 200, corsHeaders);
}

async function handleInvoiceUpdate(request, env, corsHeaders, url) {
  if (!env.DB) return json({ ok: false, error: 'DB binding missing' }, 500, corsHeaders);
  const auth = await requireAdmin(request, env, corsHeaders, url);
  if (!auth.ok) return auth.res;

  let data;
  try { data = await request.json(); } catch { return json({ ok: false, error: 'Invalid JSON' }, 400, corsHeaders); }

  const id = Number(data.id || data.invoiceId || 0);
  const customerName = (data.customerName || '').toString().trim();
  const customerEmail = (data.customerEmail || '').toString().trim();
  const customerPhone = (data.customerPhone || '').toString().trim();
  const dueDate = (data.dueDate || '').toString().trim();
  const descriptionOfWork = (data.descriptionOfWork || data.notes || '').toString().trim();
  const rawItems = Array.isArray(data.items) ? data.items : [];
  const items = rawItems
    .map((item) => {
      const qtyRaw = Number(item.quantity ?? item.qty ?? 1);
      const qty = Number.isFinite(qtyRaw) && qtyRaw > 0 ? qtyRaw : 1;
      let unitAmountCents = Number(item.unitAmountCents ?? item.amountCents ?? 0);
      if (!Number.isFinite(unitAmountCents) || unitAmountCents <= 0) {
        unitAmountCents = Math.round(Number(item.unitAmount ?? item.amount ?? 0) * 100);
      }
      const description = (item.description || item.itemDescription || '').toString().trim();
      return { description, quantity: qty, unitAmountCents: Math.max(0, Math.round(unitAmountCents)) };
    })
    .filter((item) => item.unitAmountCents > 0 || item.description);

  const missing = [];
  if (!id) missing.push('invoice id');
  if (!customerName) missing.push('customer name');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) missing.push('due date');
  if (!items.length) missing.push('at least one line item');
  if (missing.length) {
    return json({ ok: false, error: `Missing required invoice fields: ${missing.join(', ')}` }, 400, corsHeaders);
  }

  const existing = await env.DB.prepare(`SELECT id, tax_cents, amount_paid_cents, issue_date, invoice_number, status, customer_company FROM invoices WHERE id = ?1`).bind(id).first();
  if (!existing) return json({ ok: false, error: 'Invoice not found' }, 404, corsHeaders);

  let subtotal = 0;
  for (const item of items) subtotal += Math.round(Number(item.quantity || 1) * Number(item.unitAmountCents || 0));
  const taxCents = Math.max(0, Number(data.taxCents ?? existing.tax_cents ?? 0));
  const total = subtotal + taxCents;
  const amountPaid = Math.max(0, Number(existing.amount_paid_cents || 0));
  const balance = Math.max(0, total - amountPaid);
  const nextStatus = balance <= 0 ? 'paid' : (amountPaid > 0 ? 'partial' : (existing.status || 'draft'));

  await env.DB.prepare(`UPDATE invoices SET customer_name = ?1, customer_email = ?2, customer_phone = ?3, due_date = ?4, notes = ?5, subtotal_cents = ?6, tax_cents = ?7, total_cents = ?8, balance_due_cents = ?9, status = ?10, updated_at = datetime('now') WHERE id = ?11`)
    .bind(customerName, customerEmail || null, customerPhone || null, dueDate, descriptionOfWork || null, subtotal, taxCents, total, balance, nextStatus, id).run();

  await env.DB.prepare(`DELETE FROM invoice_line_items WHERE invoice_id = ?1`).bind(id).run();
  for (const item of items) {
    const qty = Number(item.quantity || 1);
    const unit = Number(item.unitAmountCents || 0);
    const lineTotal = Math.round(qty * unit);
    await env.DB.prepare(`INSERT INTO invoice_line_items (invoice_id, item_description, quantity, unit_amount_cents, line_total_cents) VALUES (?1, ?2, ?3, ?4, ?5)`)
      .bind(id, (item.description || 'Service').toString(), qty, unit, lineTotal).run();
  }

  return json({ ok: true, invoiceId: id, status: nextStatus, balanceDueCents: balance, amountPaidCents: amountPaid }, 200, corsHeaders);
}

async function handleInvoiceStatus(request, env, corsHeaders, url) {
  if (!env.DB) return json({ ok: false, error: 'DB binding missing' }, 500, corsHeaders);
  const auth = await requireAdmin(request, env, corsHeaders, url);
  if (!auth.ok) return auth.res;
  let data;
  try { data = await request.json(); } catch { return json({ ok: false, error: 'Invalid JSON' }, 400, corsHeaders); }
  const id = Number(data.id || 0);
  const status = (data.status || '').toString();
  if (!id || !['draft','sent','partial','paid','void'].includes(status)) return json({ ok: false, error: 'Invalid payload' }, 400, corsHeaders);
  const paidDate = status === 'paid' ? (data.paidDate || new Date().toISOString().slice(0,10)) : null;
  await env.DB.prepare(`UPDATE invoices SET status = ?1, paid_date = COALESCE(?2, paid_date), sent_at = CASE WHEN ?1 = 'sent' AND sent_at IS NULL THEN datetime('now') ELSE sent_at END, updated_at = datetime('now') WHERE id = ?3`).bind(status, paidDate, id).run();
  return json({ ok: true, id, status }, 200, corsHeaders);
}

function extractInvoiceIdFromIncome(row) {
  const stripeSessionId = (row?.stripe_session_id || row?.stripeSessionId || '').toString();
  const notes = (row?.notes || '').toString();
  const fromSession = stripeSessionId.match(/^invoice-payment:(\d+):/);
  if (fromSession) return Number(fromSession[1]);
  const fromNotes = notes.match(/invoice_id=(\d+)/);
  return fromNotes ? Number(fromNotes[1]) : null;
}

async function syncInvoicePaidFromIncome(db, invoiceId) {
  const id = Number(invoiceId || 0);
  if (!id) return null;
  const inv = await db.prepare(`SELECT id, total_cents, amount_paid_cents FROM invoices WHERE id = ?1`).bind(id).first();
  if (!inv) return null;
  const total = Number(inv.total_cents || 0);
  const sumRow = await db.prepare(
    `SELECT COALESCE(SUM(amount_cents),0) AS s
     FROM tax_income
     WHERE stripe_session_id LIKE ?1
        OR notes LIKE ?2`
  ).bind(`invoice-payment:${id}:%`, `%invoice_id=${id}%`).first();
  const paid = Math.max(0, Math.min(total, Number(sumRow?.s || 0)));
  const balance = Math.max(0, total - paid);
  const status = balance <= 0 ? 'paid' : (paid > 0 ? 'partial' : 'draft');
  await db.prepare(
    `UPDATE invoices
     SET amount_paid_cents = ?1,
         balance_due_cents = ?2,
         status = CASE WHEN status = 'void' THEN status ELSE ?3 END,
         paid_date = CASE WHEN ?2 = 0 THEN COALESCE(paid_date, date('now')) ELSE paid_date END,
         updated_at = datetime('now')
     WHERE id = ?4`
  ).bind(paid, balance, status, id).run();
  return { paid, balance, status };
}

async function applyInvoicePayment(db, {
  invoiceId,
  requestedPaymentCents,
  paymentEventId,
  incomeDate,
  incomeSource = 'Invoice Payment',
  incomeCategory = 'Service Revenue',
  incomeNotes,
  stripeSessionIdForBooks = null
}) {
  const id = Number(invoiceId || 0);
  const requestCents = Math.round(Number(requestedPaymentCents || 0));
  const eventId = (paymentEventId || '').toString().trim();
  if (!id || !Number.isFinite(requestCents) || requestCents <= 0) throw new Error('Invalid payment payload');
  if (!eventId) throw new Error('Missing paymentEventId');

  const eventKey = `invoice-payment:${id}:${eventId}`;

  const inv = await db.prepare(
    `SELECT id, invoice_number, total_cents, amount_paid_cents
     FROM invoices
     WHERE id = ?1`
  ).bind(id).first();
  if (!inv) throw new Error('Invoice not found');

  const existingPaymentEvent = await db.prepare(
    `SELECT id
     FROM tax_income
     WHERE stripe_session_id = ?1
     LIMIT 1`
  ).bind(eventKey).first();

  const total = Number(inv.total_cents || 0);
  const currentlyPaid = Number(inv.amount_paid_cents || 0);

  if (existingPaymentEvent?.id) {
    const duplicateBalance = Math.max(0, total - currentlyPaid);
    const duplicateStatus = duplicateBalance <= 0 ? 'paid' : 'partial';
    return {
      ok: true,
      id,
      amountPaidCents: currentlyPaid,
      balanceDueCents: duplicateBalance,
      status: duplicateStatus,
      paymentPostedCents: 0,
      booksUpdated: true,
      duplicateEvent: true
    };
  }

  const remaining = Math.max(0, total - currentlyPaid);
  const appliedPaymentCents = Math.min(remaining, requestCents);
  if (appliedPaymentCents <= 0) {
    return {
      ok: true,
      id,
      amountPaidCents: currentlyPaid,
      balanceDueCents: 0,
      status: 'paid',
      paymentPostedCents: 0,
      booksUpdated: false,
      alreadyPaid: true
    };
  }

  const resolvedIncomeDate = (incomeDate || new Date().toISOString().slice(0, 10)).toString().slice(0, 10);
  let resolvedNotes = (incomeNotes || `Invoice payment posted to books | invoice_id=${id} | invoice_number=${inv.invoice_number || ''} | payment_event_id=${eventId}`).toString();
  if (stripeSessionIdForBooks && !resolvedNotes.includes('stripe_session_id=')) {
    resolvedNotes += ` | stripe_session_id=${stripeSessionIdForBooks}`;
  }
  const stripeIdForBooks = eventKey;

  let incomeId = null;
  try {
    const incomeInsert = await db.prepare(
      `INSERT INTO tax_income (income_date, source, category, amount_cents, stripe_session_id, notes)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
    ).bind(
      resolvedIncomeDate,
      incomeSource,
      incomeCategory,
      appliedPaymentCents,
      stripeIdForBooks,
      resolvedNotes
    ).run();
    incomeId = Number(incomeInsert.meta?.last_row_id || 0) || null;
  } catch (e) {
    // Idempotency race: if same payment event was inserted by a concurrent execution, treat as duplicate.
    const raced = await db.prepare(`SELECT id FROM tax_income WHERE stripe_session_id = ?1 LIMIT 1`).bind(eventKey).first();
    if (raced?.id) {
      const latest = await db.prepare(`SELECT total_cents, amount_paid_cents FROM invoices WHERE id = ?1`).bind(id).first();
      const paidNow = Number(latest?.amount_paid_cents || currentlyPaid);
      const balNow = Math.max(0, Number(latest?.total_cents || total) - paidNow);
      return {
        ok: true,
        id,
        amountPaidCents: paidNow,
        balanceDueCents: balNow,
        status: balNow <= 0 ? 'paid' : 'partial',
        paymentPostedCents: 0,
        booksUpdated: true,
        duplicateEvent: true
      };
    }
    throw e;
  }

  if (!incomeId) throw new Error('Failed to create tax income entry for invoice payment');

  await upsertTaxIncomeJournal(db, {
    id: incomeId,
    income_date: resolvedIncomeDate,
    source: incomeSource,
    category: incomeCategory,
    amount_cents: appliedPaymentCents,
    notes: resolvedNotes,
    is_owner_funded: 0
  });

  const nextPaid = currentlyPaid + appliedPaymentCents;
  const nextBalance = Math.max(0, total - nextPaid);
  const nextStatus = nextBalance <= 0 ? 'paid' : 'partial';

  await db.prepare(
    `UPDATE invoices
     SET amount_paid_cents = ?1,
         balance_due_cents = ?2,
         status = ?3,
         paid_date = CASE WHEN ?2 = 0 THEN date('now') ELSE paid_date END,
         updated_at = datetime('now')
     WHERE id = ?4`
  ).bind(nextPaid, nextBalance, nextStatus, id).run();

  return {
    ok: true,
    id,
    amountPaidCents: nextPaid,
    balanceDueCents: nextBalance,
    status: nextStatus,
    paymentPostedCents: appliedPaymentCents,
    booksUpdated: true,
    duplicateEvent: false
  };
}


async function handleInvoicePaymentLink(request, env, corsHeaders, url) {
  if (!env.DB) return json({ ok: false, error: 'DB binding missing' }, 500, corsHeaders);
  if (!env.STRIPE_SECRET_KEY) return json({ ok: false, error: 'Stripe secret not configured' }, 500, corsHeaders);
  const auth = await requireAdmin(request, env, corsHeaders, url);
  if (!auth.ok) return auth.res;
  let data;
  try { data = await request.json(); } catch { return json({ ok: false, error: 'Invalid JSON' }, 400, corsHeaders); }

  const id = Number(data.id || data.invoiceId || 0);
  if (!id) return json({ ok: false, error: 'Invalid invoice id' }, 400, corsHeaders);

  const invoice = await env.DB.prepare(`SELECT * FROM invoices WHERE id = ?1`).bind(id).first();
  if (!invoice) return json({ ok: false, error: 'Invoice not found' }, 404, corsHeaders);

  const status = (invoice.status || '').toString().toLowerCase();
  if (['paid','void'].includes(status)) return json({ ok: false, error: 'Invoice is not payable' }, 400, corsHeaders);

  const itemsRes = await env.DB.prepare(`SELECT item_description, quantity, unit_amount_cents, line_total_cents FROM invoice_line_items WHERE invoice_id = ?1 ORDER BY id ASC`).bind(id).all();
  const items = itemsRes.results || [];
  if (!items.length) return json({ ok: false, error: 'Invoice has no line items' }, 400, corsHeaders);

  const totalCents = Number(invoice.total_cents || 0);
  const balanceDueCents = Math.max(0, Number(invoice.balance_due_cents || 0));
  if (balanceDueCents <= 0 || totalCents <= 0) return json({ ok: false, error: 'Invoice has no balance due' }, 400, corsHeaders);

  const metadata = {
    checkout_type: 'invoice_payment',
    invoice_id: String(id),
    invoice_number: String(invoice.invoice_number || `INV-${id}`),
    customer_email: String(invoice.customer_email || ''),
    balance_due_cents: String(balanceDueCents)
  };

  const requestBase = new URL(request.url).origin.replace(/\/$/, '');
  const successBase = (env.INVOICE_PAYMENT_SUCCESS_URL || `${requestBase}/invoice/payment-success`).replace(/\/$/, '');
  const cancelBase = (env.INVOICE_PAYMENT_CANCEL_URL || `${requestBase}/invoice/payment-cancelled`).replace(/\/$/, '');

  const form = new URLSearchParams();
  form.append('mode', 'payment');
  form.append('success_url', `${successBase}?invoice_id=${encodeURIComponent(String(id))}`);
  form.append('cancel_url', `${cancelBase}?invoice_id=${encodeURIComponent(String(id))}`);
  form.append('client_reference_id', `invoice:${id}`);
  if (invoice.customer_email) form.append('customer_email', String(invoice.customer_email));
  requireUsShippingAddressAndAutomaticTax(form);

  Object.entries(metadata).forEach(([k, v]) => {
    form.append(`metadata[${k}]`, v);
    form.append(`payment_intent_data[metadata][${k}]`, v);
  });

  let lineIdx = 0;
  if (balanceDueCents < totalCents) {
    form.append(`line_items[${lineIdx}][price_data][currency]`, 'usd');
    form.append(`line_items[${lineIdx}][price_data][unit_amount]`, String(balanceDueCents));
    form.append(`line_items[${lineIdx}][price_data][product_data][name]`, `Invoice ${String(invoice.invoice_number || `INV-${id}`)} Balance Due`);
    form.append(`line_items[${lineIdx}][quantity]`, '1');
    lineIdx += 1;
  } else {
    for (const item of items) {
      const lineTotalCents = Math.round(Number(item.line_total_cents || 0));
      if (lineTotalCents <= 0) continue;
      form.append(`line_items[${lineIdx}][price_data][currency]`, 'usd');
      form.append(`line_items[${lineIdx}][price_data][unit_amount]`, String(lineTotalCents));
      form.append(`line_items[${lineIdx}][price_data][product_data][name]`, (item.item_description || 'Service').toString().slice(0, 120));
      form.append(`line_items[${lineIdx}][quantity]`, '1');
      lineIdx += 1;
    }

  }

  if (!lineIdx) return json({ ok: false, error: 'Invoice line items are invalid for checkout' }, 400, corsHeaders);

  const stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: form.toString()
  });

  const stripeData = await stripeRes.json().catch(() => ({}));
  if (!stripeRes.ok || !stripeData?.url || !stripeData?.id) {
    return json({ ok: false, error: 'Stripe session failed', detail: stripeData }, 502, corsHeaders);
  }

  await env.DB.prepare(
    `UPDATE invoices
     SET stripe_checkout_session_id = ?1,
         stripe_checkout_url = ?2,
         stripe_payment_status = CASE WHEN status IN ('paid','void') THEN stripe_payment_status ELSE 'pending' END,
         stripe_payment_link_generated_at = datetime('now'),
         updated_at = datetime('now')
     WHERE id = ?3`
  ).bind(stripeData.id, stripeData.url, id).run();

  return json({ ok: true, id, paymentUrl: stripeData.url, stripeCheckoutSessionId: stripeData.id, reused: false }, 200, corsHeaders);
}

async function handleInvoicePayment(request, env, corsHeaders, url) {
  if (!env.DB) return json({ ok: false, error: 'DB binding missing' }, 500, corsHeaders);
  const auth = await requireAdmin(request, env, corsHeaders, url);
  if (!auth.ok) return auth.res;
  let data;
  try { data = await request.json(); } catch { return json({ ok: false, error: 'Invalid JSON' }, 400, corsHeaders); }

  const id = Number(data.id || 0);
  const requestedPaymentCents = Math.round(Number(data.paymentCents || 0));
  const paymentEventId = (data.paymentEventId || '').toString().trim();
  if (!id || !Number.isFinite(requestedPaymentCents) || requestedPaymentCents <= 0) {
    return json({ ok: false, error: 'Invalid payload' }, 400, corsHeaders);
  }
  if (!paymentEventId) {
    return json({ ok: false, error: 'Missing paymentEventId' }, 400, corsHeaders);
  }

  try {
    const result = await applyInvoicePayment(env.DB, {
      invoiceId: id,
      requestedPaymentCents,
      paymentEventId,
      incomeSource: 'Invoice Payment',
      incomeCategory: 'Service Revenue',
      incomeNotes: `Invoice payment posted to books | invoice_id=${id} | payment_event_id=${paymentEventId}`
    });
    return json(result, 200, corsHeaders);
  } catch (e) {
    const msg = `${e?.message || e}`;
    const status = msg.includes('Invoice not found') ? 404 : (msg.includes('already fully paid') || msg.includes('Invalid payment payload') || msg.includes('Missing paymentEventId') ? 400 : 500);
    return json({ ok: false, error: `Payment update failed: ${msg}` }, status, corsHeaders);
  }
}


async function handleInvoiceDelete(request, env, corsHeaders, url) {
  if (!env.DB) return json({ ok: false, error: 'DB binding missing' }, 500, corsHeaders);
  const auth = await requireAdmin(request, env, corsHeaders, url);
  if (!auth.ok) return auth.res;
  let data;
  try { data = await request.json(); } catch { return json({ ok: false, error: 'Invalid JSON' }, 400, corsHeaders); }
  const id = Number(data.id || 0);
  if (!id) return json({ ok: false, error: 'Invalid invoice id' }, 400, corsHeaders);
  const invoice = await env.DB.prepare(`SELECT status, amount_paid_cents FROM invoices WHERE id = ?1`).bind(id).first();
  if (!invoice) return json({ ok: false, error: 'Invoice not found' }, 404, corsHeaders);
  const status = (invoice.status || '').toString().toLowerCase();
  if (status === 'paid' || Number(invoice.amount_paid_cents || 0) > 0) {
    return json({ ok: false, error: 'Paid invoices cannot be deleted' }, 400, corsHeaders);
  }
  await env.DB.prepare(`DELETE FROM invoice_line_items WHERE invoice_id = ?1`).bind(id).run();
  await env.DB.prepare(`DELETE FROM invoices WHERE id = ?1`).bind(id).run();
  return json({ ok: true, id }, 200, corsHeaders);
}

async function handleInvoiceSend(request, env, corsHeaders, url) {
  if (!env.DB) return json({ ok: false, error: 'DB binding missing' }, 500, corsHeaders);
  const auth = await requireAdmin(request, env, corsHeaders, url);
  if (!auth.ok) return auth.res;
  const fromEmailEnv = (env.RESEND_FROM_EMAIL || env.FROM_EMAIL || '').toString().trim();
  if (!emailConfigured(env) || !fromEmailEnv) return json({ ok: false, error: 'Email provider is not configured' }, 500, corsHeaders);

  let data;
  try { data = await request.json(); } catch { return json({ ok: false, error: 'Invalid JSON' }, 400, corsHeaders); }

  const id = Number(data.id || data.invoiceId || 0);
  if (!id) return json({ ok: false, error: 'Invalid payload' }, 400, corsHeaders);

  const invoice = await env.DB.prepare(`SELECT * FROM invoices WHERE id = ?1`).bind(id).first();
  if (!invoice) return json({ ok: false, error: 'Invoice not found' }, 404, corsHeaders);

  const customerEmail = (invoice.customer_email || '').toString().trim();
  if (!customerEmail) return json({ ok: false, error: 'Invoice has no customer email' }, 400, corsHeaders);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)) return json({ ok: false, error: 'Invoice customer email is invalid' }, 400, corsHeaders);

  const itemsRes = await env.DB.prepare(`SELECT item_description, quantity, unit_amount_cents, line_total_cents FROM invoice_line_items WHERE invoice_id = ?1 ORDER BY id ASC`).bind(id).all();
  const items = itemsRes.results || [];
  if (!items.length) return json({ ok: false, error: 'Invoice has no line items' }, 400, corsHeaders);

  const subtotalCents = Number(invoice.subtotal_cents || 0);
  const taxCents = Number(invoice.tax_cents || 0);
  const totalCents = Number(invoice.total_cents || 0);
  const amountPaidCents = Number(invoice.amount_paid_cents || 0);
  const balanceDueCents = Number(invoice.balance_due_cents || 0);
  const notes = (invoice.notes || '').toString().trim();
  const invoiceStatus = String(invoice.status || '').toLowerCase();
  let paymentUrl = '';
  if (balanceDueCents > 0 && !['paid','void'].includes(invoiceStatus)) {
    if (!env.STRIPE_SECRET_KEY) return json({ ok: false, error: 'Stripe secret not configured' }, 500, corsHeaders);

    const metadata = {
      checkout_type: 'invoice_payment',
      invoice_id: String(id),
      invoice_number: String(invoice.invoice_number || `INV-${id}`),
      customer_email: customerEmail,
      balance_due_cents: String(balanceDueCents)
    };

    const requestBase = new URL(request.url).origin.replace(/\/$/, '');
    const successBase = (env.INVOICE_PAYMENT_SUCCESS_URL || `${requestBase}/invoice/payment-success`).replace(/\/$/, '');
    const cancelBase = (env.INVOICE_PAYMENT_CANCEL_URL || `${requestBase}/invoice/payment-cancelled`).replace(/\/$/, '');
    const form = new URLSearchParams();
    form.append('mode', 'payment');
    form.append('success_url', `${successBase}?invoice_id=${encodeURIComponent(String(id))}`);
    form.append('cancel_url', `${cancelBase}?invoice_id=${encodeURIComponent(String(id))}`);
    form.append('client_reference_id', `invoice:${id}`);
    form.append('customer_email', customerEmail);
    requireUsShippingAddressAndAutomaticTax(form);
    Object.entries(metadata).forEach(([k, v]) => {
      form.append(`metadata[${k}]`, v);
      form.append(`payment_intent_data[metadata][${k}]`, v);
    });

    form.append('line_items[0][price_data][currency]', 'usd');
    form.append('line_items[0][price_data][unit_amount]', String(balanceDueCents));
    form.append('line_items[0][price_data][product_data][name]', `Invoice ${String(invoice.invoice_number || `INV-${id}`)} Balance Due`);
    form.append('line_items[0][quantity]', '1');

    const stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: form.toString()
    });
    const stripeData = await stripeRes.json().catch(() => ({}));
    if (!stripeRes.ok || !stripeData?.url || !stripeData?.id) {
      return json({ ok: false, error: `Stripe payment link failed: ${stripeData?.error?.message || stripeRes.status}` }, 502, corsHeaders);
    }
    paymentUrl = stripeData.url;
    await env.DB.prepare(
      `UPDATE invoices
       SET stripe_checkout_session_id = ?1,
           stripe_checkout_url = ?2,
           stripe_payment_status = 'pending',
           stripe_payment_link_generated_at = datetime('now'),
           updated_at = datetime('now')
       WHERE id = ?3`
    ).bind(stripeData.id, paymentUrl, id).run();
  }
  const hasPaymentLink = !!paymentUrl && balanceDueCents > 0 && !['paid','void'].includes(invoiceStatus);
  const payButtonHtml = hasPaymentLink ? `<div style="margin:18px 0 12px;text-align:center;"><a href="${escapeHtml(paymentUrl)}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;padding:12px 18px;border-radius:8px;font-weight:700;">Pay Invoice Securely</a><div style="margin-top:8px;font-size:12px;color:#6b7280;">Secure checkout powered by Stripe</div></div>` : '';
  const fromEmail = (env.RESEND_FROM_EMAIL || env.FROM_EMAIL || '').toString().trim();
  const replyToEmail = (env.CC_EMAIL || env.RESEND_FROM_EMAIL || env.FROM_EMAIL || '').toString().trim();

  const itemRowsHtml = items.map((item) => {
    const desc = escapeHtml(item.item_description || 'Service');
    const qty = Number(item.quantity || 1);
    const unit = Number(item.unit_amount_cents || 0);
    const line = Number(item.line_total_cents || 0);
    return `<tr>
      <td style="padding:10px;border-bottom:1px solid #e5e7eb;">${desc}</td>
      <td style="padding:10px;border-bottom:1px solid #e5e7eb;text-align:center;">${qty}</td>
      <td style="padding:10px;border-bottom:1px solid #e5e7eb;text-align:right;">${formatUsd(unit)}</td>
      <td style="padding:10px;border-bottom:1px solid #e5e7eb;text-align:right;">${formatUsd(line)}</td>
    </tr>`;
  }).join('');

  const html = `<div style="font-family:Arial,sans-serif;background:#f7fafc;padding:24px;color:#111827;"><div style="max-width:760px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;"><img src="https://www.florencemaegifts.com/images/banner3.png" alt="Florence Mae Gifts" style="width:100%;height:auto;display:block;" /><div style="padding:20px 24px;background:linear-gradient(135deg,#0f172a,#1f2937);color:#ffffff;"><div style="font-size:12px;letter-spacing:1px;text-transform:uppercase;color:#FE6666;">Florence Mae Gifts</div><h1 style="margin:6px 0 0;font-size:24px;">Invoice ${escapeHtml(invoice.invoice_number || `INV-${id}`)}</h1></div><div style="padding:24px;"><p style="margin:0 0 12px;">Hi ${escapeHtml(invoice.customer_name || 'there')},</p><p style="margin:0 0 14px;color:#374151;">Thanks for working with Florence Mae Gifts. Your invoice details are below.</p><div style="margin:0 0 14px;color:#111827;"><strong>Issue Date:</strong> ${escapeHtml(invoice.issue_date || '')}<br><strong>Due Date:</strong> ${escapeHtml(invoice.due_date || '')}<br><strong>Customer:</strong> ${escapeHtml(invoice.customer_name || '')}</div><table width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;margin:10px 0 14px;"><thead><tr style="background:#f3f4f6;color:#111827;"><th style="padding:10px;text-align:left;">Item</th><th style="padding:10px;text-align:center;">Qty</th><th style="padding:10px;text-align:right;">Unit</th><th style="padding:10px;text-align:right;">Line Total</th></tr></thead><tbody>${itemRowsHtml}</tbody></table><div style="margin-top:10px;"><div style="display:flex;justify-content:flex-end;gap:20px;"><span>Subtotal</span><strong>${formatUsd(subtotalCents)}</strong></div>${taxCents > 0 ? `<div style="display:flex;justify-content:flex-end;gap:20px;margin-top:4px;"><span>Tax</span><strong>${formatUsd(taxCents)}</strong></div>` : ''}<div style="display:flex;justify-content:flex-end;gap:20px;margin-top:6px;font-size:18px;"><span>Total</span><strong>${formatUsd(totalCents)}</strong></div>${amountPaidCents > 0 ? `<div style="display:flex;justify-content:flex-end;gap:20px;margin-top:4px;"><span>Paid</span><strong>${formatUsd(amountPaidCents)}</strong></div>` : ''}<div style="display:flex;justify-content:flex-end;gap:20px;margin-top:4px;"><span>Balance Due</span><strong>${formatUsd(balanceDueCents)}</strong></div></div>${payButtonHtml}${notes ? `<p style="margin:16px 0 0;white-space:pre-wrap;color:#374151;"><strong>Description of work:</strong><br>${escapeHtml(notes)}</p>` : ''}<p style="margin:18px 0 0;color:#374151;text-align:center;">Questions? Reply to this email and we'll get back to you ASAP.</p></div><div style="padding:14px 24px;border-top:1px solid #e5e7eb;background:#f9fafb;color:#4b5563;font-size:13px;text-align:center;"><strong>Florence Mae Gifts, LLC</strong> • <a href="https://www.florencemaegifts.com" style="color:#2563eb;">www.florencemaegifts.com</a><p style="margin:6px 0 0;font-size:11px;line-height:1.45;color:#6b7280;">Privacy: We use your contact information only to prepare and deliver your invoice and related service communications. Terms: Charges are based on the line items shown; taxes or third-party processing fees may apply where required.</p></div></div></div>`;

  const textLines = [
    `Florence Mae Gifts Invoice ${invoice.invoice_number || `INV-${id}`}`,
    `Customer: ${invoice.customer_name || ''}`,
    `Issue Date: ${invoice.issue_date || ''}`,
    `Due Date: ${invoice.due_date || ''}`,
    '',
    'Line Items:'
  ];
  for (const item of items) {
    textLines.push(`- ${(item.item_description || 'Service').toString()}: ${Number(item.quantity || 1)} × ${formatUsd(Number(item.unit_amount_cents || 0))} = ${formatUsd(Number(item.line_total_cents || 0))}`);
  }
  textLines.push('', `Subtotal: ${formatUsd(subtotalCents)}`);
  if (taxCents > 0) textLines.push(`Tax: ${formatUsd(taxCents)}`);
  textLines.push(`Total: ${formatUsd(totalCents)}`);
  if (amountPaidCents > 0) textLines.push(`Paid: ${formatUsd(amountPaidCents)}`);
  textLines.push(`Balance Due: ${formatUsd(balanceDueCents)}`);
  if (hasPaymentLink) textLines.push('', `Pay Invoice Securely: ${paymentUrl}`);
  if (notes) textLines.push('', `Description of work: ${notes}`);
  textLines.push('', 'Reply to this email or contact us at our contact form or contact@florencemaegifts.com.', 'Florence Mae Gifts, LLC', 'Privacy: Contact details are used only for invoice/service communication.', 'Terms: Charges are based on listed line items; taxes/processing fees may apply.', 'https://www.florencemaegifts.com');

  const emailPayload = {
    from: fromEmail,
    to: [customerEmail],
    subject: `Invoice ${invoice.invoice_number || `INV-${id}`} from Florence Mae Gifts`,
    html,
    text: textLines.join('\n'),
    reply_to: replyToEmail || fromEmail
  };
  if (env.CC_EMAIL) emailPayload.cc = [env.CC_EMAIL];

  const sendRes = await sendEmail(env, emailPayload);
  const sendJson = await sendRes.json().catch(() => ({}));
  if (!sendRes.ok) {
    return json({ ok: false, error: sendJson?.message || sendJson?.error || 'Failed to send invoice email' }, 502, corsHeaders);
  }

  await env.DB.prepare(`UPDATE invoices SET status = CASE WHEN status IN ('paid','void') THEN status ELSE 'sent' END, sent_at = COALESCE(sent_at, datetime('now')), updated_at = datetime('now') WHERE id = ?1`).bind(id).run();
  return json({ ok: true, id, emailId: sendJson?.id || null, paymentUrl: hasPaymentLink ? paymentUrl : null }, 200, corsHeaders);
}

// Build a carrier tracking URL from a carrier name + tracking number.
// Returns '' when the carrier is unknown so callers can fall back to a
// manually supplied URL.
function buildTrackingUrl(carrier, trackingNumber) {
  const num = encodeURIComponent(String(trackingNumber || '').trim());
  if (!num) return '';
  const key = String(carrier || '').trim().toLowerCase();
  if (key.includes('usps')) return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${num}`;
  if (key.includes('ups')) return `https://www.ups.com/track?tracknum=${num}`;
  if (key.includes('fedex')) return `https://www.fedex.com/fedextrack/?trknbr=${num}`;
  if (key.includes('dhl')) return `https://www.dhl.com/us-en/home/tracking.html?tracking-id=${num}`;
  return '';
}

// Default editable copy for the "Your Item Has Shipped" email. The admin
// modal pre-fills these same strings so preview and send stay identical.
const DEFAULT_SHIPPED_INTRO = 'Great news — your handmade order from Florence Mae Gifts is on its way! Your tracking details are below.';
const DEFAULT_SHIPPED_CLOSING = 'Thank you so much for your order! Questions? Just reply to this email.';

// Build the branded shipped-email HTML + plain-text + subject from an invoice,
// its notes, tracking info, and (optionally personalized) copy. Shared by
// the send handler and the preview endpoint so they never drift.
function buildShippedEmailContent({ invoice, id, carrier, trackingNumber, shipDate, note, trackingUrl, introMessage, closingMessage }) {
  const invoiceNumber = String(invoice.invoice_number || `INV-${id}`);
  const intro = (introMessage || '').toString().trim() || DEFAULT_SHIPPED_INTRO;
  const closing = (closingMessage || '').toString().trim() || DEFAULT_SHIPPED_CLOSING;
  const packageNotes = (invoice.notes || '').toString().trim();
  const packageNotesHtml = packageNotes
    ? `<div style="margin:20px 0 0;"><div style="font-weight:700;margin-bottom:6px;color:#111827;">What's in your package:</div><p style="margin:0;white-space:pre-wrap;color:#374151;">${escapeHtml(packageNotes)}</p></div>`
    : '';

  const trackButtonHtml = trackingUrl
    ? `<div style="margin:18px 0 4px;text-align:center;"><a href="${escapeHtml(trackingUrl)}" style="display:inline-block;background:#FE6666;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:700;">Track Your Package</a></div>`
    : '';

  const trackingRowsHtml = `
    <div style="margin:6px 0 0;background:#fff5f5;border:1px solid #fecdd3;border-radius:10px;padding:14px 16px;color:#111827;">
      ${carrier ? `<div style="margin:0 0 4px;"><strong>Carrier:</strong> ${escapeHtml(carrier)}</div>` : ''}
      <div style="margin:0 0 4px;"><strong>Tracking Number:</strong> ${escapeHtml(trackingNumber)}</div>
      ${shipDate ? `<div style="margin:0;"><strong>Shipped:</strong> ${escapeHtml(shipDate)}</div>` : ''}
    </div>`;

  const html = `<div style="font-family:Arial,sans-serif;background:#f7fafc;padding:24px;color:#111827;"><div style="max-width:760px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;"><img src="https://www.florencemaegifts.com/images/banner3.png" alt="Florence Mae Gifts" style="width:100%;height:auto;display:block;" /><div style="padding:20px 24px;background:linear-gradient(135deg,#0f172a,#1f2937);color:#ffffff;"><div style="font-size:12px;letter-spacing:1px;text-transform:uppercase;color:#FE6666;">Florence Mae Gifts</div><h1 style="margin:6px 0 0;font-size:24px;">Your Order Has Shipped! 📦</h1></div><div style="padding:24px;"><p style="margin:0 0 12px;">Hi ${escapeHtml(invoice.customer_name || 'there')},</p><p style="margin:0 0 14px;white-space:pre-wrap;color:#374151;">${escapeHtml(intro)}</p>${trackingRowsHtml}${trackButtonHtml}${trackingUrl ? '' : '<p style="margin:12px 0 0;color:#6b7280;font-size:13px;text-align:center;">Use the tracking number above with your carrier to follow your package.</p>'}${packageNotesHtml}${note ? `<p style="margin:18px 0 0;white-space:pre-wrap;color:#374151;">${escapeHtml(note)}</p>` : ''}<p style="margin:18px 0 0;white-space:pre-wrap;color:#374151;text-align:center;">${escapeHtml(closing)}</p></div><div style="padding:14px 24px;border-top:1px solid #e5e7eb;background:#f9fafb;color:#4b5563;font-size:13px;text-align:center;"><strong>Florence Mae Gifts, LLC</strong> • <a href="https://www.florencemaegifts.com" style="color:#2563eb;">www.florencemaegifts.com</a><p style="margin:6px 0 0;font-size:11px;line-height:1.45;color:#6b7280;">Privacy: We use your contact information only for order and shipping communication. Tracking details are provided by the carrier.</p></div></div></div>`;

  const textLines = [
    `Your Florence Mae Gifts order has shipped! 📦`,
    `Invoice: ${invoiceNumber}`,
    `Customer: ${invoice.customer_name || ''}`,
    '',
    intro,
    ''
  ];
  if (carrier) textLines.push(`Carrier: ${carrier}`);
  textLines.push(`Tracking Number: ${trackingNumber}`);
  if (shipDate) textLines.push(`Shipped: ${shipDate}`);
  if (trackingUrl) textLines.push('', `Track your package: ${trackingUrl}`);
  if (packageNotes) {
    textLines.push('', "What's in your package:");
    textLines.push(packageNotes);
  }
  if (note) textLines.push('', note);
  textLines.push('', closing, 'Florence Mae Gifts, LLC', 'https://www.florencemaegifts.com');

  return {
    subject: `Your Florence Mae Gifts order has shipped (${invoiceNumber})`,
    html,
    text: textLines.join('\n')
  };
}

// Shared: parse + validate shipped-email inputs and load the invoice.
// Returns { error, status } on failure or the resolved context on success.
async function resolveShippedEmailContext(request, env) {
  let data;
  try { data = await request.json(); } catch { return { error: 'Invalid JSON', status: 400 }; }

  const id = Number(data.id || data.invoiceId || 0);
  if (!id) return { error: 'Invalid payload', status: 400 };

  const carrier = (data.carrier || data.trackingCarrier || '').toString().trim();
  const trackingNumber = (data.trackingNumber || data.tracking_number || '').toString().trim();
  if (!trackingNumber) return { error: 'Tracking number is required', status: 400 };
  const shipDate = (data.shipDate || data.shipped_at || '').toString().trim();
  const note = (data.note || data.message || '').toString().trim();
  const introMessage = (data.introMessage || data.intro || '').toString();
  const closingMessage = (data.closingMessage || data.closing || '').toString();
  const trackingUrl = (data.trackingUrl || data.tracking_url || '').toString().trim() || buildTrackingUrl(carrier, trackingNumber);

  const invoice = await env.DB.prepare(`SELECT * FROM invoices WHERE id = ?1`).bind(id).first();
  if (!invoice) return { error: 'Invoice not found', status: 404 };

  return { id, carrier, trackingNumber, shipDate, note, introMessage, closingMessage, trackingUrl, invoice };
}

async function handleInvoiceShippedPreview(request, env, corsHeaders, url) {
  if (!env.DB) return json({ ok: false, error: 'DB binding missing' }, 500, corsHeaders);
  const auth = await requireAdmin(request, env, corsHeaders, url);
  if (!auth.ok) return auth.res;

  const ctx = await resolveShippedEmailContext(request, env);
  if (ctx.error) return json({ ok: false, error: ctx.error }, ctx.status, corsHeaders);

  const built = buildShippedEmailContent(ctx);
  return json({ ok: true, subject: built.subject, html: built.html }, 200, corsHeaders);
}

async function handleInvoiceShippedEmail(request, env, corsHeaders, url) {
  if (!env.DB) return json({ ok: false, error: 'DB binding missing' }, 500, corsHeaders);
  const auth = await requireAdmin(request, env, corsHeaders, url);
  if (!auth.ok) return auth.res;
  const fromEmailEnv = (env.RESEND_FROM_EMAIL || env.FROM_EMAIL || '').toString().trim();
  if (!emailConfigured(env) || !fromEmailEnv) return json({ ok: false, error: 'Email provider is not configured' }, 500, corsHeaders);

  const ctx = await resolveShippedEmailContext(request, env);
  if (ctx.error) return json({ ok: false, error: ctx.error }, ctx.status, corsHeaders);
  const { id, carrier, trackingNumber, shipDate, trackingUrl, invoice } = ctx;

  const customerEmail = (invoice.customer_email || '').toString().trim();
  if (!customerEmail) return json({ ok: false, error: 'Invoice has no customer email' }, 400, corsHeaders);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)) return json({ ok: false, error: 'Invoice customer email is invalid' }, 400, corsHeaders);

  const fromEmail = fromEmailEnv;
  const replyToEmail = (env.CC_EMAIL || env.RESEND_FROM_EMAIL || env.FROM_EMAIL || '').toString().trim();

  const built = buildShippedEmailContent(ctx);

  const emailPayload = {
    from: fromEmail,
    to: [customerEmail],
    subject: built.subject,
    html: built.html,
    text: built.text,
    reply_to: replyToEmail || fromEmail
  };
  if (env.CC_EMAIL) emailPayload.cc = [env.CC_EMAIL];
  const shippedEmailBcc = 'contact@florencemaegifts.com';
  if (customerEmail.toLowerCase() !== shippedEmailBcc) emailPayload.bcc = [shippedEmailBcc];

  const sendRes = await sendEmail(env, emailPayload);
  const sendJson = await sendRes.json().catch(() => ({}));
  if (!sendRes.ok) {
    return json({ ok: false, error: sendJson?.message || sendJson?.error || 'Failed to send shipping email' }, 502, corsHeaders);
  }

  await env.DB.prepare(
    `UPDATE invoices
     SET shipped_at = COALESCE(?2, datetime('now')),
         tracking_carrier = ?3,
         tracking_number = ?4,
         tracking_url = ?5,
         updated_at = datetime('now')
     WHERE id = ?1`
  ).bind(id, shipDate || null, carrier || null, trackingNumber, trackingUrl || null).run();

  return json({ ok: true, id, emailId: sendJson?.id || null, trackingUrl: trackingUrl || null }, 200, corsHeaders);
}

async function convertQuoteToInvoice(db, quote) {
  const quoteId = Number(quote?.id || 0);
  if (!quoteId) return { ok: false, error: 'Invalid quote' };
  const itemsRes = await db.prepare(`SELECT item_description, quantity, unit_amount_cents, line_total_cents FROM quote_line_items WHERE quote_id = ?1 ORDER BY id ASC`).bind(quoteId).all();
  const items = itemsRes.results || [];
  if (!items.length) return { ok: false, error: 'Quote has no line items' };

  const subtotal = Number(quote.subtotal_cents || 0);
  const total = Number(quote.total_cents || 0);
  const issueDate = new Date().toISOString().slice(0, 10);
  const dueDate = quote.valid_until || issueDate;
  const invoiceNumber = `INV-${Date.now()}-${quoteId}`;

  const inv = await db.prepare(`INSERT INTO invoices (invoice_number, customer_name, customer_email, customer_phone, customer_company, issue_date, due_date, status, subtotal_cents, tax_cents, total_cents, amount_paid_cents, balance_due_cents, notes) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'draft', ?8, 0, ?9, 0, ?9, ?10)`)
    .bind(invoiceNumber, quote.customer_name || '', quote.customer_email || null, quote.customer_phone || null, null, issueDate, dueDate, subtotal, total, quote.notes || null).run();
  const invoiceId = Number(inv.meta?.last_row_id || 0);

  for (const item of items) {
    await db.prepare(`INSERT INTO invoice_line_items (invoice_id, item_description, quantity, unit_amount_cents, line_total_cents) VALUES (?1, ?2, ?3, ?4, ?5)`)
      .bind(invoiceId, item.item_description || 'Service', Number(item.quantity || 1), Number(item.unit_amount_cents || 0), Number(item.line_total_cents || 0)).run();
  }

  await db.prepare(`UPDATE quotes SET status = 'accepted', accepted_at = datetime('now'), converted_invoice_id = ?1, updated_at = datetime('now') WHERE id = ?2`)
    .bind(invoiceId, quoteId).run();
  return { ok: true, invoiceId };
}

async function handleQuoteConvert(request, env, corsHeaders, url) {
  if (!env.DB) return json({ ok: false, error: 'DB binding missing' }, 500, corsHeaders);
  const auth = await requireAdmin(request, env, corsHeaders, url);
  if (!auth.ok) return auth.res;
  let data;
  try { data = await request.json(); } catch { return json({ ok: false, error: 'Invalid JSON' }, 400, corsHeaders); }
  const id = Number(data.id || data.quoteId || 0);
  if (!id) return json({ ok: false, error: 'Invalid quote id' }, 400, corsHeaders);
  const quote = await env.DB.prepare(`SELECT * FROM quotes WHERE id = ?1`).bind(id).first();
  if (!quote) return json({ ok: false, error: 'Quote not found' }, 404, corsHeaders);

  const existingInvoiceId = Number(quote.converted_invoice_id || 0);
  if (quote.status === 'accepted' || existingInvoiceId > 0) {
    if (existingInvoiceId > 0) {
      const existingInvoice = await env.DB.prepare(`SELECT id FROM invoices WHERE id = ?1`).bind(existingInvoiceId).first();
      if (existingInvoice?.id) {
        return json({ ok: false, error: 'Quote already converted', invoiceId: existingInvoiceId }, 400, corsHeaders);
      }
      // stale pointer: invoice was not created or later removed; allow recovery conversion
      await env.DB.prepare(`UPDATE quotes SET status = 'draft', accepted_at = NULL, converted_invoice_id = NULL, updated_at = datetime('now') WHERE id = ?1`).bind(id).run();
      quote.status = 'draft';
      quote.accepted_at = null;
      quote.converted_invoice_id = null;
    } else {
      return json({ ok: false, error: 'Quote already converted' }, 400, corsHeaders);
    }
  }

  const result = await convertQuoteToInvoice(env.DB, quote);
  if (!result.ok) return json({ ok: false, error: result.error || 'Failed to convert quote' }, 400, corsHeaders);
  return json({ ok: true, quoteId: id, invoiceId: result.invoiceId }, 200, corsHeaders);
}

// ===== Quotes Handlers =====

function generateToken() {
  return crypto.randomUUID().replace(/-/g, '');
}

async function handleQuoteCreate(request, env, corsHeaders, url) {
  if (!env.DB) return json({ ok: false, error: 'DB binding missing' }, 500, corsHeaders);
  const auth = await requireAdmin(request, env, corsHeaders, url);
  if (!auth.ok) return auth.res;

  let data;
  try { data = await request.json(); } catch { return json({ ok: false, error: 'Invalid JSON' }, 400, corsHeaders); }

  const quoteNumber = (data.quoteNumber || `Q-${Date.now()}`).toString();
  const customerName = (data.customerName || '').toString().trim();
  const customerEmail = (data.customerEmail || '').toString().trim();
  const customerPhone = (data.customerPhone || '').toString().trim();
  let validUntil = (data.validUntil || '').toString().trim();

  // Default to 30 days from now if no valid date
  if (!validUntil) {
    const d = new Date();
    d.setDate(d.getDate() + 30);
    validUntil = d.toISOString().slice(0, 10);
  }

  const descriptionOfWork = (data.descriptionOfWork || data.notes || '').toString().trim();
  const items = Array.isArray(data.items) ? data.items : [];

  if (!customerName || !customerEmail) {
    return json({ ok: false, error: 'Missing required quote fields' }, 400, corsHeaders);
  }

  let subtotal = 0;
  for (const item of items) {
    const qty = Number(item.quantity || 1);
    const unit = Number(item.unitAmountCents || 0);
    subtotal += Math.round(qty * unit);
  }
  const total = subtotal;

  const acceptToken = generateToken();
  const denyToken = generateToken();

  const r = await env.DB.prepare(`INSERT INTO quotes (quote_number, customer_name, customer_email, customer_phone, valid_until, status, subtotal_cents, total_cents, notes, accept_token, deny_token) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`)
    .bind(quoteNumber, customerName, customerEmail, customerPhone || null, validUntil, data.status || 'draft', subtotal, total, descriptionOfWork || null, acceptToken, denyToken).run();
  const quoteId = Number(r.meta?.last_row_id || 0);

  for (const item of items) {
    const qty = Number(item.quantity || 1);
    const unit = Number(item.unitAmountCents || 0);
    const lineTotal = Math.round(qty * unit);
    await env.DB.prepare(`INSERT INTO quote_line_items (quote_id, item_description, quantity, unit_amount_cents, line_total_cents) VALUES (?1, ?2, ?3, ?4, ?5)`)
      .bind(quoteId, (item.description || 'Service').toString(), qty, unit, lineTotal).run();
  }

  return json({ ok: true, quoteId }, 200, corsHeaders);
}

async function handleQuotesList(request, env, corsHeaders, url) {
  if (!env.DB) return json({ ok: false, error: 'DB binding missing' }, 500, corsHeaders);
  const auth = await requireAdmin(request, env, corsHeaders, url);
  if (!auth.ok) return auth.res;

  const status = url.searchParams.get('status') || '';
  const rows = status && status !== 'all'
    ? await env.DB.prepare(`SELECT * FROM quotes WHERE status = ?1 ORDER BY valid_until ASC, id DESC LIMIT 300`).bind(status).all()
    : await env.DB.prepare(`SELECT * FROM quotes ORDER BY valid_until ASC, id DESC LIMIT 300`).all();
  return json({ ok: true, quotes: rows.results || [] }, 200, corsHeaders);
}

async function handleQuoteDetail(request, env, corsHeaders, url) {
  if (!env.DB) return json({ ok: false, error: 'DB binding missing' }, 500, corsHeaders);
  const auth = await requireAdmin(request, env, corsHeaders, url);
  if (!auth.ok) return auth.res;

  const id = Number(url.searchParams.get('id') || 0);
  if (!id) return json({ ok: false, error: 'Invalid quote id' }, 400, corsHeaders);

  const quote = await env.DB.prepare(`SELECT * FROM quotes WHERE id = ?1`).bind(id).first();
  if (!quote) return json({ ok: false, error: 'Quote not found' }, 404, corsHeaders);

  const itemsRes = await env.DB.prepare(`SELECT id, item_description, quantity, unit_amount_cents, line_total_cents FROM quote_line_items WHERE quote_id = ?1 ORDER BY id ASC`).bind(id).all();
  return json({ ok: true, quote: { ...quote, line_items: itemsRes.results || [] } }, 200, corsHeaders);
}

async function handleQuoteUpdate(request, env, corsHeaders, url) {
  if (!env.DB) return json({ ok: false, error: 'DB binding missing' }, 500, corsHeaders);
  const auth = await requireAdmin(request, env, corsHeaders, url);
  if (!auth.ok) return auth.res;

  let data;
  try { data = await request.json(); } catch { return json({ ok: false, error: 'Invalid JSON' }, 400, corsHeaders); }

  const id = Number(data.id || data.quoteId || 0);
  const customerName = (data.customerName || '').toString().trim();
  const customerEmail = (data.customerEmail || '').toString().trim();
  const customerPhone = (data.customerPhone || '').toString().trim();
  let validUntil = (data.validUntil || '').toString().trim();
  const descriptionOfWork = (data.descriptionOfWork || data.notes || '').toString().trim();
  const items = Array.isArray(data.items) ? data.items : [];

  if (!id || !customerName || !customerEmail) {
    return json({ ok: false, error: 'Missing required quote fields' }, 400, corsHeaders);
  }

  const existing = await env.DB.prepare(`SELECT id FROM quotes WHERE id = ?1`).bind(id).first();
  if (!existing) return json({ ok: false, error: 'Quote not found' }, 404, corsHeaders);

  let subtotal = 0;
  for (const item of items) {
    const qty = Number(item.quantity || 1);
    const unit = Number(item.unitAmountCents || 0);
    subtotal += Math.round(qty * unit);
  }
  const total = subtotal;

  await env.DB.prepare(`UPDATE quotes SET customer_name = ?1, customer_email = ?2, customer_phone = ?3, valid_until = ?4, notes = ?5, subtotal_cents = ?6, total_cents = ?7, status = 'draft', accepted_at = NULL, converted_invoice_id = NULL, updated_at = datetime('now') WHERE id = ?8`)
    .bind(customerName, customerEmail, customerPhone || null, validUntil, descriptionOfWork || null, subtotal, total, id).run();

  await env.DB.prepare(`DELETE FROM quote_line_items WHERE quote_id = ?1`).bind(id).run();
  for (const item of items) {
    const qty = Number(item.quantity || 1);
    const unit = Number(item.unitAmountCents || 0);
    const lineTotal = Math.round(qty * unit);
    await env.DB.prepare(`INSERT INTO quote_line_items (quote_id, item_description, quantity, unit_amount_cents, line_total_cents) VALUES (?1, ?2, ?3, ?4, ?5)`)
      .bind(id, (item.description || 'Service').toString(), qty, unit, lineTotal).run();
  }

  return json({ ok: true, quoteId: id }, 200, corsHeaders);
}

async function handleQuoteDelete(request, env, corsHeaders, url) {
  if (!env.DB) return json({ ok: false, error: 'DB binding missing' }, 500, corsHeaders);
  const auth = await requireAdmin(request, env, corsHeaders, url);
  if (!auth.ok) return auth.res;

  let data;
  try { data = await request.json(); } catch { return json({ ok: false, error: 'Invalid JSON' }, 400, corsHeaders); }

  const id = Number(data.id || data.quoteId || 0);
  if (!id) return json({ ok: false, error: 'Invalid quote id' }, 400, corsHeaders);

  await env.DB.prepare(`DELETE FROM quote_line_items WHERE quote_id = ?1`).bind(id).run();
  await env.DB.prepare(`DELETE FROM quotes WHERE id = ?1`).bind(id).run();

  return json({ ok: true }, 200, corsHeaders);
}

async function handleQuoteSend(request, env, corsHeaders, url) {
  if (!env.DB) return json({ ok: false, error: 'DB binding missing' }, 500, corsHeaders);
  const auth = await requireAdmin(request, env, corsHeaders, url);
  if (!auth.ok) return auth.res;
  const fromEmailEnv = (env.RESEND_FROM_EMAIL || env.FROM_EMAIL || '').toString().trim();
  if (!emailConfigured(env) || !fromEmailEnv) return json({ ok: false, error: 'Email provider is not configured' }, 500, corsHeaders);

  let data;
  try { data = await request.json(); } catch { return json({ ok: false, error: 'Invalid JSON' }, 400, corsHeaders); }

  const id = Number(data.id || data.quoteId || 0);
  if (!id) return json({ ok: false, error: 'Invalid payload' }, 400, corsHeaders);

  const quote = await env.DB.prepare(`SELECT * FROM quotes WHERE id = ?1`).bind(id).first();
  if (!quote) return json({ ok: false, error: 'Quote not found' }, 404, corsHeaders);

  const customerEmail = (quote.customer_email || '').toString().trim();
  if (!customerEmail) return json({ ok: false, error: 'Quote has no customer email' }, 400, corsHeaders);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)) return json({ ok: false, error: 'Quote customer email is invalid' }, 400, corsHeaders);

  const itemsRes = await env.DB.prepare(`SELECT item_description, quantity, unit_amount_cents, line_total_cents FROM quote_line_items WHERE quote_id = ?1 ORDER BY id ASC`).bind(id).all();
  const items = itemsRes.results || [];
  if (!items.length) return json({ ok: false, error: 'Quote has no line items' }, 400, corsHeaders);

  const subtotalCents = Number(quote.subtotal_cents || 0);
  const totalCents = Number(quote.total_cents || 0);
  const notes = (quote.notes || '').toString().trim();
  const fromEmail = (env.RESEND_FROM_EMAIL || env.FROM_EMAIL || '').toString().trim();

  const baseUrl = new URL(request.url).origin;
  const acceptUrl = `${baseUrl}/api/quote/accept?token=${encodeURIComponent(quote.accept_token)}`;
  const denyUrl = `${baseUrl}/api/quote/deny?token=${encodeURIComponent(quote.deny_token)}`;

  const itemRowsHtml = items.map((item) => {
    const desc = escapeHtml(item.item_description || 'Service');
    const qty = Number(item.quantity || 1);
    const unit = Number(item.unit_amount_cents || 0);
    const line = Number(item.line_total_cents || 0);
    return `<tr>
      <td style="padding:10px;border-bottom:1px solid #e5e7eb;">${desc}</td>
      <td style="padding:10px;border-bottom:1px solid #e5e7eb;text-align:center;">${qty}</td>
      <td style="padding:10px;border-bottom:1px solid #e5e7eb;text-align:right;">${formatUsd(unit)}</td>
      <td style="padding:10px;border-bottom:1px solid #e5e7eb;text-align:right;">${formatUsd(line)}</td>
    </tr>`;
  }).join('');

  const html = `<div style="font-family:Arial,sans-serif;background:#f7fafc;padding:24px;color:#111827;"><div style="max-width:760px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;"><img src="https://www.florencemaegifts.com/images/banner3.png" alt="Florence Mae Gifts" style="width:100%;height:auto;display:block;" /><div style="padding:20px 24px;background:linear-gradient(135deg,#0f172a,#1f2937);color:#ffffff;"><div style="font-size:12px;letter-spacing:1px;text-transform:uppercase;color:#FE6666;">Florence Mae Gifts</div><h1 style="margin:6px 0 0;font-size:24px;">Quote ${escapeHtml(quote.quote_number || `Q-${id}`)}</h1></div><div style="padding:24px;"><p style="margin:0 0 12px;">Hi ${escapeHtml(quote.customer_name || 'there')},</p><p style="margin:0 0 14px;color:#374151;">Thank you so much for your interest in my services! Here is your personalized quote:</p><div style="margin:0 0 14px;color:#111827;"><strong>Valid Until:</strong> ${escapeHtml(quote.valid_until || '')}<br><strong>Customer:</strong> ${escapeHtml(quote.customer_name || '')}</div><table width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;margin:10px 0 14px;"><thead><tr style="background:#f3f4f6;color:#111827;"><th style="padding:10px;text-align:left;">Item</th><th style="padding:10px;text-align:center;">Qty</th><th style="padding:10px;text-align:right;">Unit</th><th style="padding:10px;text-align:right;">Line Total</th></tr></thead><tbody>${itemRowsHtml}</tbody></table><div style="margin-top:10px;"><div style="display:flex;justify-content:flex-end;gap:20px;"><span>Subtotal</span><strong>${formatUsd(subtotalCents)}</strong></div><div style="display:flex;justify-content:flex-end;gap:20px;margin-top:6px;font-size:18px;"><span>Total</span><strong>${formatUsd(totalCents)}</strong></div></div>${notes ? `<p style="margin:16px 0 0;white-space:pre-wrap;color:#374151;"><strong>Description of work:</strong><br>${escapeHtml(notes)}</p>` : ''}<div style="margin:24px 0;text-align:center;"><a href="${acceptUrl}" style="display:inline-block;padding:14px 32px;margin:0 8px;background:#059669;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:bold;font-size:16px;">Accept Quote</a><a href="${denyUrl}" style="display:inline-block;padding:14px 32px;margin:0 8px;background:#dc2626;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:bold;font-size:16px;">Decline Quote</a></div><p style="margin:18px 0 0;color:#374151;text-align:center;">Questions? Reply to this email and we'll get back to you ASAP.</p></div><div style="padding:14px 24px;border-top:1px solid #e5e7eb;background:#f9fafb;color:#4b5563;font-size:13px;text-align:center;"><strong>Florence Mae Gifts, LLC</strong> • <a href="https://www.florencemaegifts.com" style="color:#2563eb;">www.florencemaegifts.com</a><p style="margin:6px 0 0;font-size:11px;line-height:1.45;color:#6b7280;">Privacy: We use your contact information only to prepare and deliver your quote and related service communications. Terms: Pricing and scope are based on the listed line items; quote is valid until the listed date unless otherwise stated.</p></div></div></div>`;

  const textLines = [
    `Florence Mae Gifts Quote ${quote.quote_number || `Q-${id}`}`,
    `Customer: ${quote.customer_name || ''}`,
    `Valid Until: ${quote.valid_until || ''}`,
    '',
    'Line Items:'
  ];
  for (const item of items) {
    textLines.push(`- ${(item.item_description || 'Service').toString()}: ${Number(item.quantity || 1)} × ${formatUsd(Number(item.unit_amount_cents || 0))} = ${formatUsd(Number(item.line_total_cents || 0))}`);
  }
  textLines.push('', `Subtotal: ${formatUsd(subtotalCents)}`);
  textLines.push(`Total: ${formatUsd(totalCents)}`);
  if (notes) textLines.push('', `Description of work: ${notes}`);
  textLines.push('', `Accept Quote: ${acceptUrl}`, `Decline Quote: ${denyUrl}`, '', 'Reply to this email or contact us at our contact form or contact@florencemaegifts.com.', 'Florence Mae Gifts, LLC', 'Privacy: Contact details are used only for quote/service communication.', 'Terms: Pricing/scope are based on listed line items; quote valid until listed date unless otherwise stated.', 'https://www.florencemaegifts.com');

  const emailPayload = {
    from: fromEmail,
    to: [customerEmail],
    subject: `Quote ${quote.quote_number || `Q-${id}`} from Florence Mae Gifts`,
    html,
    text: textLines.join('\n'),
    reply_to: env.CC_EMAIL || fromEmail
  };
  if (env.CC_EMAIL) emailPayload.cc = [env.CC_EMAIL];

  const sendRes = await sendEmail(env, emailPayload);
  const sendJson = await sendRes.json().catch(() => ({}));
  if (!sendRes.ok) {
    return json({ ok: false, error: sendJson?.message || sendJson?.error || 'Failed to send quote email' }, 502, corsHeaders);
  }

  await env.DB.prepare(`UPDATE quotes SET status = CASE WHEN status IN ('accepted','denied','void') THEN status ELSE 'sent' END, sent_at = COALESCE(sent_at, datetime('now')), updated_at = datetime('now') WHERE id = ?1`).bind(id).run();
  return json({ ok: true, id, emailId: sendJson?.id || null }, 200, corsHeaders);
}


function invoicePaymentPage(title, heading, message, success = true, invoiceId = '') {
  const bgColor = success ? '#059669' : '#dc2626';
  const icon = success ? '✓' : '✗';
  const invLine = invoiceId ? `<p style="margin-top:10px;color:#d8dce8;font-weight:600;">Invoice #${escapeHtml(String(invoiceId))}</p>` : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)} - Florence Mae Gifts</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: Arial, sans-serif; background: #0a0b10; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; color:#d8dce8; }
    .card { max-width: 620px; width:100%; background: #141620; border: 1px solid #222438; border-radius: 8px; overflow: hidden; text-align: center; box-shadow:0 12px 30px rgba(0,0,0,.35); }
    .hero img { width:100%; height:auto; display:block; }
    .header { padding: 20px 24px; background: linear-gradient(145deg,#0f2f57,#1f4f90); color: #eaf3ff; border-top:1px solid #2b68ad; border-bottom:1px solid #2b68ad; }
    .header h1 { font-size: 18px; letter-spacing:.2px; }
    .icon { width: 64px; height: 64px; border-radius: 50%; background: ${bgColor}; color: #fff; display: flex; align-items: center; justify-content: center; font-size: 32px; margin: 24px auto 16px; }
    .content { padding: 24px; }
    .content h2 { color: #00e5ff; margin-bottom: 12px; }
    .content p { color: #b7bfd3; line-height: 1.6; }
    .footer { padding: 16px 24px; border-top: 1px solid #222438; background: #10121a; color:#9aa3b7; }
    .footer a { color: #7bb6ff; text-decoration: none; }
  </style>
</head>
<body>
  <div class="card">
    <div class="hero"><img src="https://www.florencemaegifts.com/images/banner3.png" alt="Florence Mae Gifts" /></div>
    <div class="header"><h1>Florence Mae Gifts, LLC</h1></div>
    <div class="content"><div class="icon">${icon}</div><h2>${escapeHtml(heading)}</h2><p>${escapeHtml(message)}</p>${invLine}</div>
    <div class="footer">
      <div><a href="https://www.florencemaegifts.com">www.florencemaegifts.com</a></div>
      <div style="margin-top:6px; font-size:13px;">Questions? Contact me here: <a href="mailto:contact@florencemaegifts.com" style="color:#7bb6ff; text-decoration:underline;">contact@florencemaegifts.com</a></div>
    </div>
  </div>
</body>
</html>`;
}

async function handleInvoicePaymentSuccessPage(request, env, corsHeaders, url) {
  const invoiceId = url.searchParams.get('invoice_id') || '';
  return new Response(invoicePaymentPage('Payment Successful', 'Payment Successful', 'Thank you — your invoice payment was successful.', true, invoiceId), { status: 200, headers: withSecurityHeaders({ 'Content-Type': 'text/html' }) });
}

async function handleInvoicePaymentCancelledPage(request, env, corsHeaders, url) {
  const invoiceId = url.searchParams.get('invoice_id') || '';
  return new Response(invoicePaymentPage('Payment Cancelled', 'Payment Cancelled', 'Your payment was cancelled. You can return to the invoice and complete payment anytime.', false, invoiceId), { status: 200, headers: withSecurityHeaders({ 'Content-Type': 'text/html' }) });
}

/** @param {{path: string, token: string, label: string}} [confirm] - show a button that POSTs the token back (quote links) */
function htmlPage(title, heading, message, success = true, confirm = null) {
  const bgColor = confirm ? '#FE6666' : (success ? '#059669' : '#dc2626');
  const icon = confirm ? '?' : (success ? '✓' : '✗');
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)} - Florence Mae Gifts</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: Arial, sans-serif; background: #ffffff; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; color:#000; }
    .card { max-width: 620px; width:100%; background: #ffffff; border: 1px solid #d8d8d8; border-radius: 8px; overflow: hidden; text-align: center; box-shadow:0 8px 22px rgba(0,0,0,.12); }
    .hero img { width:100%; height:auto; display:block; }
    .header { padding: 20px 24px; background: linear-gradient(135deg, #fecac4 0%, #FEA0AE 100%); color: #000; border-top:1px solid #fecac4; border-bottom:1px solid #fecac4; }
    .header h1 { font-size: 18px; letter-spacing:.2px; }
    .icon { width: 64px; height: 64px; border-radius: 50%; background: ${bgColor}; color: #fff; display: flex; align-items: center; justify-content: center; font-size: 32px; margin: 24px auto 16px; }
    .content { padding: 24px; }
    .content h2 { color: #FE6666; margin-bottom: 12px; }
    .content p { color: #4b4b4b; line-height: 1.6; }
    .footer { padding: 16px 24px; border-top: 1px solid #d0d0d0; background: #efefef; color:#333333; }
    .footer a { color: #FE6666; text-decoration: none; }
  </style>
</head>
<body>
  <div class="card">
    <div class="hero"><img src="https://www.florencemaegifts.com/images/banner3.png" alt="Florence Mae Gifts" /></div>
    <div class="header">
      <h1>Florence Mae Gifts, LLC</h1>
    </div>
    <div class="content">
      <div class="icon">${icon}</div>
      <h2>${escapeHtml(heading)}</h2>
      <p>${escapeHtml(message)}</p>${confirm ? `
      <form method="post" action="${escapeHtml(confirm.path)}" style="margin-top:22px;">
        <input type="hidden" name="token" value="${escapeHtml(confirm.token)}">
        <button type="submit" style="background:#FE6666; color:#fff; border:0; border-radius:999px; padding:13px 28px; font-size:16px; font-weight:bold; cursor:pointer;">${escapeHtml(confirm.label)}</button>
      </form>` : ''}
    </div>
    <div class="footer">
      <div><a href="https://www.florencemaegifts.com">www.florencemaegifts.com</a></div>
      <div style="margin-top:6px; font-size:13px;">Questions? Contact me here: <a href="mailto:contact@florencemaegifts.com" style="color:#FE6666; text-decoration:underline;">contact@florencemaegifts.com</a></div>
    </div>
  </div>
</body>
</html>`;
}

// Quote links open a confirmation page (GET) and only its button (POST) acts,
// so email scanners that open every link can't accept or decline a quote.
async function quoteLinkToken(request, url) {
  if (request.method !== 'POST') return url.searchParams.get('token') || '';
  const form = await request.formData().catch(() => null);
  return (form?.get('token') || '').toString();
}

function quoteValidUntilEndOfDay(validUntil) {
  const raw = (validUntil || '').toString().trim();
  if (!raw) return new Date(0);
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return new Date(`${raw}T23:59:59.999Z`);
  return new Date(raw);
}

async function handleQuoteAccept(request, env, corsHeaders, url) {
  if (!env.DB) return new Response(htmlPage('Error', 'System Error', 'Database not configured.', false), { status: 500, headers: withSecurityHeaders({ 'Content-Type': 'text/html' }) });

  const token = await quoteLinkToken(request, url);
  if (!token) return new Response(htmlPage('Invalid Link', 'Invalid Link', 'This quote link is invalid or missing a token.', false), { status: 400, headers: withSecurityHeaders({ 'Content-Type': 'text/html' }) });

  const quote = await env.DB.prepare(`SELECT * FROM quotes WHERE accept_token = ?1`).bind(token).first();
  if (!quote) return new Response(htmlPage('Quote Not Found', 'Quote Not Found', 'This quote was not found or has already been processed.', false), { status: 404, headers: withSecurityHeaders({ 'Content-Type': 'text/html' }) });

  // Check if already accepted
  if (quote.status === 'accepted' || quote.accepted_at) {
    return new Response(htmlPage('Already Accepted', 'Quote Already Accepted', 'This quote has already been accepted. Thank you!', true), { status: 200, headers: withSecurityHeaders({ 'Content-Type': 'text/html' }) });
  }

  // Check if denied
  if (quote.status === 'denied' || quote.denied_at) {
    return new Response(htmlPage('Quote Declined', 'Quote Was Declined', 'This quote was previously declined.', false), { status: 400, headers: withSecurityHeaders({ 'Content-Type': 'text/html' }) });
  }

  // Check if expired at the end of the valid-until day, not midnight UTC.
  const validUntil = quoteValidUntilEndOfDay(quote.valid_until);
  const now = new Date();
  if (validUntil < now) {
    return new Response(htmlPage('Quote Expired', 'Quote Expired', `This quote expired on ${quote.valid_until}. Please contact us for a new quote.`, false), { status: 400, headers: withSecurityHeaders({ 'Content-Type': 'text/html' }) });
  }

  if (request.method !== 'POST') {
    return new Response(htmlPage('Accept Quote', `Accept quote ${quote.quote_number || ''}?`.replace(' ?', '?'),
      `Total: ${formatUsd(quote.total_cents)}. When you accept, we'll email you an invoice with a secure payment link.`, true,
      { path: '/api/quote/accept', token, label: 'Accept quote' }), { status: 200, headers: withSecurityHeaders({ 'Content-Type': 'text/html' }) });
  }

  // Get line items to convert to invoice
  const itemsRes = await env.DB.prepare(`SELECT item_description, quantity, unit_amount_cents, line_total_cents FROM quote_line_items WHERE quote_id = ?1 ORDER BY id ASC`).bind(quote.id).all();
  const items = itemsRes.results || [];

  // Create invoice from quote
  const invoiceNumber = `INV-${Date.now()}`;
  const issueDate = new Date().toISOString().slice(0, 10);
  const dueDate = quote.valid_until;
  const subtotal = Number(quote.subtotal_cents || 0);
  const total = Number(quote.total_cents || 0);

  let invRes;
  try {
    invRes = await env.DB.prepare(`INSERT INTO invoices (invoice_number, customer_name, customer_email, customer_phone, customer_company, issue_date, due_date, status, subtotal_cents, tax_cents, total_cents, amount_paid_cents, balance_due_cents, notes) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, ?10, 0, ?10, ?11)`)
      .bind(invoiceNumber, quote.customer_name, quote.customer_email, quote.customer_phone || null, null, issueDate, dueDate, 'draft', subtotal, total, quote.notes || null).run();
  } catch (e) {
    // Backward compatibility if customer_phone column is not migrated yet
    if (String(e?.message || e).includes('customer_phone')) {
      invRes = await env.DB.prepare(`INSERT INTO invoices (invoice_number, customer_name, customer_email, customer_company, issue_date, due_date, status, subtotal_cents, tax_cents, total_cents, amount_paid_cents, balance_due_cents, notes) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 0, ?10, ?11)`)
        .bind(invoiceNumber, quote.customer_name, quote.customer_email, null, issueDate, dueDate, 'draft', subtotal, 0, total, quote.notes || null).run();
    } else {
      throw e;
    }
  }
  const invoiceId = Number(invRes.meta?.last_row_id || 0);

  // Copy line items to invoice
  for (const item of items) {
    await env.DB.prepare(`INSERT INTO invoice_line_items (invoice_id, item_description, quantity, unit_amount_cents, line_total_cents) VALUES (?1, ?2, ?3, ?4, ?5)`)
      .bind(invoiceId, item.item_description, item.quantity, item.unit_amount_cents, item.line_total_cents).run();
  }

  // Mark quote as accepted
  await env.DB.prepare(`UPDATE quotes SET status = 'accepted', accepted_at = datetime('now'), converted_invoice_id = ?1, updated_at = datetime('now') WHERE id = ?2`).bind(invoiceId, quote.id).run();

  // Auto-generate payment link + send invoice email to customer (pay-first flow)
  let acceptDeliveryError = null;
  try {
    const customerEmail = (quote.customer_email || '').toString().trim();
    const fromEmail = (env.RESEND_FROM_EMAIL || env.FROM_EMAIL || '').toString().trim();
    const requestBase = new URL(request.url).origin.replace(/\/$/, '');
    const successBase = (env.INVOICE_PAYMENT_SUCCESS_URL || `${requestBase}/invoice/payment-success`).replace(/\/$/, '');
    const cancelBase = (env.INVOICE_PAYMENT_CANCEL_URL || `${requestBase}/invoice/payment-cancelled`).replace(/\/$/, '');
    const balanceDueCents = Math.max(0, Number(total || 0));
    if (!emailConfigured(env) || !fromEmail || !customerEmail) {
      throw new Error('Invoice email is not configured');
    }
    if (balanceDueCents > 0 && !env.STRIPE_SECRET_KEY) {
      throw new Error('Stripe payment links are not configured');
    }

    let paymentUrl = '';
    let sessionId = '';

    if (balanceDueCents > 0) {
        const form = new URLSearchParams();
        form.append('mode', 'payment');
        form.append('success_url', `${successBase}?invoice_id=${encodeURIComponent(String(invoiceId))}`);
        form.append('cancel_url', `${cancelBase}?invoice_id=${encodeURIComponent(String(invoiceId))}`);
        form.append('client_reference_id', `invoice:${invoiceId}`);
        form.append('customer_email', customerEmail);
        requireUsShippingAddressAndAutomaticTax(form);
        const metadata = {
          checkout_type: 'invoice_payment',
          invoice_id: String(invoiceId),
          invoice_number: String(invoiceNumber),
          customer_email: customerEmail,
          balance_due_cents: String(balanceDueCents)
        };
        Object.entries(metadata).forEach(([k, v]) => {
          form.append(`metadata[${k}]`, v);
          form.append(`payment_intent_data[metadata][${k}]`, v);
        });
        form.append('line_items[0][price_data][currency]', 'usd');
        form.append('line_items[0][price_data][unit_amount]', String(balanceDueCents));
        form.append('line_items[0][price_data][product_data][name]', `Invoice ${invoiceNumber} Balance Due`);
        form.append('line_items[0][quantity]', '1');

        const stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
          method: 'POST',
          headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: form.toString()
        });
        const stripeData = await stripeRes.json().catch(() => ({}));
        if (!stripeRes.ok || !stripeData?.url || !stripeData?.id) {
          throw new Error(`Stripe payment link failed: ${stripeData?.error?.message || stripeRes.status}`);
        }
        paymentUrl = stripeData.url;
        sessionId = stripeData.id;
        await env.DB.prepare(
          `UPDATE invoices SET stripe_checkout_session_id = ?1, stripe_checkout_url = ?2, stripe_payment_status = 'pending', stripe_payment_link_generated_at = datetime('now'), status = 'sent', sent_at = datetime('now'), updated_at = datetime('now') WHERE id = ?3`
        ).bind(sessionId, paymentUrl, invoiceId).run();
      }

      const rows = items.map((it) => `<tr><td style="padding:8px;border-bottom:1px solid #f0f0f0;">${escapeHtml(it.item_description || 'Service')}</td><td style="padding:8px;border-bottom:1px solid #f0f0f0;text-align:center;">${Number(it.quantity || 1)}</td><td style="padding:8px;border-bottom:1px solid #f0f0f0;text-align:right;">${formatUsd(Number(it.line_total_cents || 0))}</td></tr>`).join('');
      const payBtn = paymentUrl ? `<div style="margin:20px 0;text-align:center;"><a href="${paymentUrl}" style="display:inline-block;padding:12px 24px;background:#FE6666;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;">Pay Invoice Securely</a><div style="margin-top:8px;font-size:12px;color:#6b7280;">Secure checkout powered by Stripe</div></div>` : "";
      const invoiceHtml = `
        <div style="font-family:Arial,sans-serif;max-width:700px;margin:0 auto;background:#fff;border:1px solid #eee;border-radius:10px;overflow:hidden;">
          <img src="https://www.florencemaegifts.com/images/banner3.png" alt="Florence Mae Gifts" style="width:100%;height:auto;display:block;" />
          <div style="padding:20px 24px;background:linear-gradient(135deg,#0f172a,#1f2937);color:#fff;"><h1 style="margin:0;font-size:22px;">Invoice ${escapeHtml(invoiceNumber)}</h1></div>
          <div style="padding:24px;">
            <p style="margin:0 0 10px;">Hi ${escapeHtml(quote.customer_name || 'there')},</p>
            <p style="margin:0 0 14px;color:#374151;">Thanks for approving your quote. Here is your invoice for payment:</p>
            <table style="width:100%;border-collapse:collapse;margin:12px 0 8px;"><thead><tr><th style="text-align:left;padding:8px;border-bottom:1px solid #ddd;">Item</th><th style="text-align:center;padding:8px;border-bottom:1px solid #ddd;">Qty</th><th style="text-align:right;padding:8px;border-bottom:1px solid #ddd;">Amount</th></tr></thead><tbody>${rows}</tbody></table>
            <p style="text-align:right;margin:10px 0 0;"><strong>Total Due: ${formatUsd(total)}</strong></p>
            ${payBtn}
            <p style="margin:16px 0 0;color:#374151;text-align:center;">Questions? Reply to this email and we'll get back to you ASAP.</p>
          </div>
          <div style="padding:14px 24px;border-top:1px solid #e5e7eb;background:#f9fafb;color:#4b5563;font-size:13px;text-align:center;"><strong>Florence Mae Gifts, LLC</strong> • <a href="https://www.florencemaegifts.com" style="color:#2563eb;">www.florencemaegifts.com</a></div>
        </div>`;
      const invoiceText = [
        `Invoice ${invoiceNumber}`,
        '',
        `Hi ${quote.customer_name || 'there'},`,
        'Thanks for approving your quote. Here is your invoice for payment.',
        '',
        `Total Due: ${formatUsd(total)}`,
        paymentUrl ? `Pay here: ${paymentUrl}` : '',
        '',
        "Questions? Reply to this email and we'll get back to you ASAP.",
        'Florence Mae Gifts, LLC',
        'https://www.florencemaegifts.com'
      ].filter(Boolean).join('\n');

      const sendPayload = {
        from: fromEmail,
        to: [customerEmail],
        subject: `Invoice ${invoiceNumber} from Florence Mae Gifts`,
        html: invoiceHtml,
        text: invoiceText
      };
      if (env.CC_EMAIL) sendPayload.cc = [env.CC_EMAIL];
      const resendRes = await sendEmail(env, sendPayload);
      if (!resendRes.ok) {
        const resendText = await resendRes.text().catch(() => '');
        throw new Error(`Invoice email failed: ${resendRes.status} ${resendText}`.trim());
      }
  } catch (e) {
    acceptDeliveryError = e;
    console.error('Quote accept invoice/payment email failed', e);
  }

  // Send notification email to Chris
  const notifyTo = (env.TO_EMAIL || env.CONTACT_TO_EMAIL || '').toString().trim();
  const notifyFrom = (env.FROM_EMAIL || env.RESEND_FROM_EMAIL || '').toString().trim();
  if (emailConfigured(env) && notifyTo && notifyFrom) {
    const notifyHtml = `<div style="font-family:Arial,sans-serif;padding:20px;"><h2 style="color:#059669;">Quote Accepted!</h2><p><strong>Quote:</strong> ${escapeHtml(quote.quote_number || `Q-${quote.id}`)}</p><p><strong>Customer:</strong> ${escapeHtml(quote.customer_name)} (${escapeHtml(quote.customer_email)})</p><p><strong>Total:</strong> ${formatUsd(total)}</p><p><strong>Invoice Created:</strong> ${invoiceNumber}</p>${acceptDeliveryError ? `<p style="color:#dc2626;"><strong>Customer invoice delivery failed:</strong> ${escapeHtml(acceptDeliveryError.message || String(acceptDeliveryError))}</p>` : '<p>Invoice email/payment link sent when configured.</p>'}<p>Log in to the admin panel to review the invoice.</p></div>`;

    const notifyPayload = {
      from: notifyFrom,
      to: [notifyTo],
      subject: `Quote ${quote.quote_number || `Q-${quote.id}`} Accepted by ${quote.customer_name}`,
      html: notifyHtml,
      text: `Quote Accepted!\n\nQuote: ${quote.quote_number || `Q-${quote.id}`}\nCustomer: ${quote.customer_name} (${quote.customer_email})\nTotal: ${formatUsd(total)}\nInvoice Created: ${invoiceNumber}${acceptDeliveryError ? `\nCustomer invoice delivery failed: ${acceptDeliveryError.message || String(acceptDeliveryError)}` : `\nInvoice email/payment link sent when configured.`}\n\nLog in to the admin panel to review the invoice.`
    };
    if (env.CC_EMAIL) notifyPayload.cc = [env.CC_EMAIL];

    await sendEmail(env, notifyPayload).catch(() => {});
  }

  if (acceptDeliveryError) {
    return new Response(htmlPage('Quote Accepted — Follow-Up Needed', 'Quote Accepted', "Your quote was accepted, but we could not generate or send the invoice/payment email automatically. Please contact us and we’ll send the payment details manually.", false), { status: 502, headers: withSecurityHeaders({ 'Content-Type': 'text/html' }) });
  }

  return new Response(htmlPage('Quote Accepted', 'Thank You!', "Your quote has been accepted. Please check your email inbox for your invoice and payment details.", true), { status: 200, headers: withSecurityHeaders({ 'Content-Type': 'text/html' }) });
}

async function handleQuoteDeny(request, env, corsHeaders, url) {
  if (!env.DB) return new Response(htmlPage('Error', 'System Error', 'Database not configured.', false), { status: 500, headers: withSecurityHeaders({ 'Content-Type': 'text/html' }) });

  const token = await quoteLinkToken(request, url);
  if (!token) return new Response(htmlPage('Invalid Link', 'Invalid Link', 'This quote link is invalid or missing a token.', false), { status: 400, headers: withSecurityHeaders({ 'Content-Type': 'text/html' }) });

  const quote = await env.DB.prepare(`SELECT * FROM quotes WHERE deny_token = ?1`).bind(token).first();
  if (!quote) return new Response(htmlPage('Quote Not Found', 'Quote Not Found', 'This quote was not found or has already been processed.', false), { status: 404, headers: withSecurityHeaders({ 'Content-Type': 'text/html' }) });

  // Check if already accepted
  if (quote.status === 'accepted' || quote.accepted_at) {
    return new Response(htmlPage('Quote Accepted', 'Quote Was Accepted', 'This quote has already been accepted and cannot be declined.', false), { status: 400, headers: withSecurityHeaders({ 'Content-Type': 'text/html' }) });
  }

  // Check if already denied
  if (quote.status === 'denied' || quote.denied_at) {
    return new Response(htmlPage('Already Declined', 'Quote Already Declined', 'This quote has already been declined.', true), { status: 200, headers: withSecurityHeaders({ 'Content-Type': 'text/html' }) });
  }

  // Check if expired at the end of the valid-until day, not midnight UTC.
  const validUntil = quoteValidUntilEndOfDay(quote.valid_until);
  const now = new Date();
  if (validUntil < now) {
    return new Response(htmlPage('Quote Expired', 'Quote Expired', `This quote expired on ${quote.valid_until}.`, false), { status: 400, headers: withSecurityHeaders({ 'Content-Type': 'text/html' }) });
  }

  if (request.method !== 'POST') {
    return new Response(htmlPage('Decline Quote', `Decline quote ${quote.quote_number || ''}?`.replace(' ?', '?'),
      "Let us know you've decided not to go ahead with this quote. You can still contact us if you change your mind.", true,
      { path: '/api/quote/deny', token, label: 'Decline quote' }), { status: 200, headers: withSecurityHeaders({ 'Content-Type': 'text/html' }) });
  }

  // Mark declined and retain record for manual admin cleanup
  await env.DB.prepare(`UPDATE quotes SET status = 'denied', denied_at = datetime('now'), updated_at = datetime('now') WHERE id = ?1`).bind(quote.id).run();

  return new Response(htmlPage('Quote Declined', 'Quote Declined', 'The quote has been declined. Thank you for letting us know. Feel free to reach out if you have any questions.', true), { status: 200, headers: withSecurityHeaders({ 'Content-Type': 'text/html' }) });
}

async function accountingTablesReady(db) {
  const tables = ['accounts', 'journal_entries', 'journal_lines'];
  for (const t of tables) {
    const has = await db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?1`).bind(t).first();
    if (!has) return false;
  }
  return true;
}

async function ensureAccountingSetup(db) {
  if (_accountingSetupDone) return true;
  const ready = await accountingTablesReady(db);
  if (!ready) return false;
  const existing = await db.prepare(`SELECT COUNT(*) AS c FROM accounts`).first();
  if (Number(existing?.c || 0) > 0) { _accountingSetupDone = true; return true; }

  const seed = [
    ['1000','Cash on Hand','asset','debit'],
    ['1010','Owner Personal Card Clearing','liability','credit'],
    ['1100','Accounts Receivable','asset','debit'],
    ['2000','Accounts Payable','liability','credit'],
    ['2100','Credit Card Payable','liability','credit'],
    ['2200','Sales Tax Payable','liability','credit'],
    ['3000','Owner Equity','equity','credit'],
    ['3100','Owner Contributions','equity','credit'],
    ['3200','Owner Draw','equity','debit'],
    ['3210','Owner Retirement Contributions','equity','debit'],
    ['4000','Sales Revenue','income','credit'],
    ['4900','Other Income','income','credit'],
    ['5000','Software Expense','expense','debit'],
    ['5100','Marketing Expense','expense','debit'],
    ['5200','Supplies Expense','expense','debit'],
    ['5300','Payment Processing Fees','expense','debit'],
    ['5400','Contractor Expense','expense','debit'],
    ['5600','Utilities Expense','expense','debit'],
    ['5700','Marketplace Fees','expense','debit'],
    ['5800','Shipping Expense','expense','debit'],
    ['5900','Taxes & Licenses','expense','debit']
  ];

  for (const s of seed) {
    await db.prepare(`INSERT INTO accounts (code, name, account_type, normal_side, is_system, active) VALUES (?1, ?2, ?3, ?4, 1, 1)`).bind(...s).run();
  }
  _accountingSetupDone = true;
  return true;
}

async function ensureAccountByCode(db, code, name, accountType, normalSide) {
  const existing = await db.prepare(`SELECT id FROM accounts WHERE code = ?1 LIMIT 1`).bind(code).first();
  if (existing?.id) return Number(existing.id);
  const ins = await db.prepare(`INSERT INTO accounts (code, name, account_type, normal_side, is_system, active) VALUES (?1, ?2, ?3, ?4, 1, 1)`).bind(code, name, accountType, normalSide).run();
  return Number(ins.meta?.last_row_id || 0) || null;
}

async function getAccountIdByCode(db, code) {
  if (_acctIdCache.has(code)) return _acctIdCache.get(code);
  const row = await db.prepare(`SELECT id FROM accounts WHERE code = ?1 LIMIT 1`).bind(code).first();
  const id = Number(row?.id || 0) || null;
  _acctIdCache.set(code, id);
  return id;
}

async function deleteAutoJournalBySource(db, sourceType, sourceId) {
  const ready = await accountingTablesReady(db);
  if (!ready) return;
  const rows = await db.prepare(`SELECT id FROM journal_entries WHERE source_type = ?1 AND source_id = ?2`).bind(sourceType, sourceId).all();
  for (const r of (rows.results || [])) {
    await db.prepare(`DELETE FROM journal_lines WHERE entry_id = ?1`).bind(r.id).run();
    await db.prepare(`DELETE FROM journal_entries WHERE id = ?1`).bind(r.id).run();
  }
}

async function upsertTaxExpenseJournal(db, row, skipDelete = false) {
  const accountingReady = await ensureAccountingSetup(db);
  if (!accountingReady) return;
  if (!skipDelete) await deleteAutoJournalBySource(db, 'tax_expense', row.id);

  const amount = Number(row.amount_cents || 0);
  if (!Number.isFinite(amount) || amount === 0) return;

  const cat = row.category || '';
  let expenseAccountCode;
  if (['Stripe Processing Fees', 'Payment Processing Fees'].includes(cat)) {
    expenseAccountCode = '5300'; // Payment Processing Fees
  } else if (['Etsy Listing Fees', 'Etsy Transaction Fees', 'Etsy Offsite Ads', 'Etsy Processing Fees', 'Mercari Selling Fees', 'Mercari Processing Fees'].includes(cat)) {
    expenseAccountCode = '5700'; // Marketplace Fees
  } else if (cat === 'Advertising/Marketing') {
    expenseAccountCode = '5100'; // Marketing Expense (voluntary spend only)
  } else if (cat === 'Software/SaaS' || cat === 'Hosting/Cloud') {
    expenseAccountCode = '5000'; // Software Expense
  } else if (cat === 'Shipping Costs') {
    expenseAccountCode = '5800'; // Shipping Expense
  } else if (cat === 'Taxes - Sales & Use' || cat === 'Business License Fees' || cat === 'LLC Fees') {
    expenseAccountCode = '5900'; // Taxes & Licenses
  } else {
    expenseAccountCode = '5200'; // Supplies Expense (catch-all, includes Shipping & Packaging Supplies)
  }
  // Guarantee the Taxes & Licenses account exists on already-seeded (production) DBs,
  // since ensureAccountingSetup only seeds fresh DBs and getAccountIdByCode won't create it.
  if (expenseAccountCode === '5900') {
    await ensureAccountByCode(db, '5900', 'Taxes & Licenses', 'expense', 'debit');
    _acctIdCache.delete('5900');
  }
  const paidVia = (row.paid_via || '').toLowerCase();

  let offsetCode = '3100'; // default: treat as owner capital contribution
  if (paidVia.includes('stripe') || paidVia.includes('cash') || paidVia.includes('checking') || paidVia.includes('bank') || paidVia.includes('etsy') || paidVia.includes('mercari') || paidVia.includes('cash on hand')) {
    offsetCode = '1000';
  } else if (paidVia.includes('business card') || paidVia.includes('corp card') || paidVia.includes('credit')) {
    offsetCode = '2100';
  }

  const debitAccountId = await getAccountIdByCode(db, expenseAccountCode);
  const creditAccountId = await getAccountIdByCode(db, offsetCode);
  if (!debitAccountId || !creditAccountId) return;

  const memo = `${row.category || 'Expense'}${row.vendor ? ` - ${row.vendor}` : ''}`;
  const notes = (row.notes || '').toString().trim();
  const ins = await db.prepare(`INSERT INTO journal_entries (entry_date, memo, source_type, source_id, notes) VALUES (?1, ?2, 'tax_expense', ?3, ?4)`).bind(row.expense_date, memo, row.id, notes).run();
  const entryId = Number(ins.meta?.last_row_id || 0);
  const absAmount = Math.abs(amount);
  // Normal expense: debit expense account, credit offset. Credit/reversal: flip sides.
  const [lineDebitId, lineCreditId] = amount > 0 ? [debitAccountId, creditAccountId] : [creditAccountId, debitAccountId];
  await db.prepare(`INSERT INTO journal_lines (entry_id, account_id, debit_cents, credit_cents) VALUES (?1, ?2, ?3, 0), (?1, ?4, 0, ?3)`).bind(entryId, lineDebitId, absAmount, lineCreditId).run();
}

async function upsertTaxIncomeJournal(db, row, skipDelete = false) {
  const accountingReady = await ensureAccountingSetup(db);
  if (!accountingReady) return;
  if (!skipDelete) await deleteAutoJournalBySource(db, 'tax_income', row.id);

  const amount = Number(row.amount_cents || 0);
  if (!Number.isFinite(amount) || amount === 0) return;

  const cashAccountId = await getAccountIdByCode(db, '1000');
  const categoryRaw = (row.category || '').toString().trim().toLowerCase();
  const sourceRaw = (row.source || '').toString().trim().toLowerCase();
  const isOwnerFunded = Number(row.is_owner_funded || 0) === 1 || categoryRaw.includes('owner funded') || categoryRaw.includes('non-revenue') || sourceRaw.includes('owner funded') || sourceRaw.includes('test');
  const isOtherIncome = categoryRaw.includes('credit card bonus') || categoryRaw.includes('bank interest') || sourceRaw.includes('credit card bonus') || sourceRaw.includes('bank interest');
  const creditAccountCode = isOwnerFunded ? '3100' : (isOtherIncome ? '4900' : '4000');
  const incomeAccountId = await getAccountIdByCode(db, creditAccountCode);
  if (!cashAccountId || !incomeAccountId) return;

  const memo = `${row.category || 'Income'}${row.source ? ` - ${row.source}` : ''}`;
  const notes = (row.notes || '').toString().trim();
  const ins = await db.prepare(`INSERT INTO journal_entries (entry_date, memo, source_type, source_id, notes) VALUES (?1, ?2, 'tax_income', ?3, ?4)`).bind(row.income_date, memo, row.id, notes).run();
  const entryId = Number(ins.meta?.last_row_id || 0);
  const absAmount = Math.abs(amount);
  const [lineDebitId, lineCreditId] = amount > 0 ? [cashAccountId, incomeAccountId] : [incomeAccountId, cashAccountId];
  await db.prepare(`INSERT INTO journal_lines (entry_id, account_id, debit_cents, credit_cents) VALUES (?1, ?2, ?3, 0), (?1, ?4, 0, ?3)`).bind(entryId, lineDebitId, absAmount, lineCreditId).run();
}

/** Estimate Stripe fee for fallback bookkeeping when Stripe balance transaction is delayed. */
function estimateStripeFeeCents(amountCents) {
  const amount = Number(amountCents || 0);
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  return Math.max(1, Math.round(amount * 0.029) + 30);
}

/**
 * Fetch Stripe fee (in cents) for a payment intent id.
 * Returns 0 if not found.
 */
async function fetchStripeFeeCents(stripeSecretKey, paymentIntentId) {
  if (!stripeSecretKey || !paymentIntentId) return 0;

  const url = `https://api.stripe.com/v1/payment_intents/${encodeURIComponent(paymentIntentId)}?expand[]=latest_charge.balance_transaction`;
  const piRes = await fetch(url, {
    headers: { Authorization: `Bearer ${stripeSecretKey}` }
  });
  const pi = await piRes.json().catch(() => ({}));
  if (!piRes.ok) return 0;

  const latestCharge = pi?.latest_charge;
  const bt = (latestCharge && typeof latestCharge === 'object') ? latestCharge.balance_transaction : null;
  const feeExpanded = Number(bt?.fee || 0);
  if (Number.isFinite(feeExpanded) && feeExpanded > 0) return feeExpanded;

  const chargeId = typeof latestCharge === 'string' ? latestCharge : latestCharge?.id;
  if (!chargeId) return 0;

  const chRes = await fetch(`https://api.stripe.com/v1/charges/${encodeURIComponent(chargeId)}`, {
    headers: { Authorization: `Bearer ${stripeSecretKey}` }
  });
  const ch = await chRes.json().catch(() => ({}));
  if (!chRes.ok) return 0;

  const btId = ch?.balance_transaction;
  if (!btId) return 0;

  const btRes = await fetch(`https://api.stripe.com/v1/balance_transactions/${encodeURIComponent(btId)}`, {
    headers: { Authorization: `Bearer ${stripeSecretKey}` }
  });
  const btObj = await btRes.json().catch(() => ({}));
  const fee = Number(btObj?.fee || 0);
  return btRes.ok && Number.isFinite(fee) && fee > 0 ? fee : 0;
}

/**
 * Verify Stripe webhook signature using HMAC-SHA256
 * @param {string} payload - Raw request body
 * @param {string} stripeSignature - Stripe-Signature header value
 * @param {string} webhookSecret - STRIPE_WEBHOOK_SECRET
 * @returns {Promise<boolean>}
 */
async function verifyStripeSignature(payload, stripeSignature, webhookSecret) {
  // Stripe-Signature header format: t=timestamp,v1=signature[,v1=signature2]
  if (!stripeSignature || !webhookSecret) return { ok: false, reason: 'missing signature or secret' };

  let timestamp = null;
  const signatures = [];
  for (const part of stripeSignature.split(',')) {
    const [key, value] = part.split('=').map(x => x.trim());
    if (key === 't') timestamp = Number(value);
    if (key === 'v1' && /^[a-f0-9]+$/i.test(value || '') && value.length % 2 === 0) signatures.push(value);
  }

  if (!Number.isFinite(timestamp) || signatures.length === 0) return { ok: false, reason: 'malformed Stripe-Signature header' };

  const toleranceSeconds = 300;
  const ageSeconds = Math.abs(Math.floor(Date.now() / 1000) - timestamp);
  if (ageSeconds > toleranceSeconds) return { ok: false, reason: 'signature timestamp outside tolerance' };

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(webhookSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  );

  const signedPayload = new TextEncoder().encode(`${timestamp}.${payload}`);
  for (const signature of signatures) {
    const signatureBytes = new Uint8Array(signature.match(/.{2}/g).map(byte => parseInt(byte, 16)));
    const ok = await crypto.subtle.verify('HMAC', key, signatureBytes, signedPayload);
    if (ok) return { ok: true };
  }

  return { ok: false, reason: 'signature mismatch' };
}

function checkContactRateLimit(request, corsHeaders) {
  const ip = (request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'unknown')
    .split(',')[0]
    .trim() || 'unknown';
  const now = Date.now();
  const windowMs = 15 * 60 * 1000;
  for (const [key, entry] of _contactRateLimits) {
    if (!entry?.expiresAt || entry.expiresAt <= now) _contactRateLimits.delete(key);
  }
  const existing = _contactRateLimits.get(ip);
  const current = existing && existing.expiresAt > now ? existing : { count: 0, expiresAt: now + windowMs };
  current.count += 1;
  current.expiresAt = current.expiresAt || (now + windowMs);
  _contactRateLimits.set(ip, current);
  if (current.count > 10) {
    return json({ ok: false, error: 'Too many contact requests. Please try again later.' }, 429, {
      ...corsHeaders,
      'Retry-After': String(Math.ceil((current.expiresAt - now) / 1000))
    });
  }
  return null;
}

function hasDownloadFileMapping(env, itemName, priceId) {
  try {
    const fileMap = JSON.parse(env.DOWNLOAD_FILE_MAP || '{}') || {};
    const lookupKeys = [itemName, priceId]
      .map((v) => (v || '').toString().trim().toLowerCase())
      .filter(Boolean);
    return Object.entries(fileMap).some(([name]) => lookupKeys.includes(name.toString().trim().toLowerCase()));
  } catch (e) {
    console.error('Invalid DOWNLOAD_FILE_MAP JSON', e);
    return false;
  }
}

function json(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: withSecurityHeaders({ 'Content-Type': 'application/json', ...headers })
  });
}

function formatUsd(cents) {
  return `$${(Number(cents || 0) / 100).toFixed(2)}`;
}

function escapeHtml(input) {
  return String(input ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim());
}
