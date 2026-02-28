// ===== ROUTE HANDLER INDEX =====
// POST /api/contact             → handleContact()        — Form submissions (domain offers, questions) + Resend email
// POST /api/checkout-session    → handleCheckoutSession() — Create Stripe checkout with conflict + past-time checks
// POST /api/zombie-bag-checkout → handleZombieBagCheckout() — Create Stripe checkout for Zombie Bag product sales
// POST /api/stripe-webhook      → handleStripeWebhook()   — Stripe payment confirmation, records booking in D1, auto-inserts tax income
// GET  /api/availability        → handleAvailability()    — Public unavailable slots + blocked dates
// GET  /api/bookings            → handleBookings()        — Admin: read bookings + blocked slots + blocked days
// POST /api/admin/block-slot    → handleAdminBlockSlot()  — Admin: block/unblock a specific 2-hour slot
// POST /api/admin/block-day     → handleAdminBlockDay()   — Admin: block/unblock an entire day
// GET  /api/tax/transactions    → handleTaxTransactions() — Admin: tax entries by year/type
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
// requireAdmin(request, env)           — Validate X-Admin-Password header
// toCents(v)                           — Convert dollar string to integer cents
// csvEscape(s)                         — Escape string for CSV output
// verifyStripeSignature(payload, sig, secret) — HMAC-SHA256 Stripe webhook verification
// json(data, status, headers)          — Build JSON Response

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowedOrigins = (env.ALLOWED_ORIGINS || '*')
      .split(',')
      .map(v => v.trim())
      .filter(Boolean);
    const allowAll = allowedOrigins.includes('*');
    // No Origin header = direct browser navigation (new tab link), not a cross-origin fetch — always allow.
    const originAllowed = allowAll || !origin || allowedOrigins.includes(origin);

    const corsHeaders = {
      'Access-Control-Allow-Origin': allowAll ? '*' : (originAllowed ? origin : allowedOrigins[0] || ''),
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Password',
      'Vary': 'Origin'
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(request.url);

    // Stripe webhook comes from Stripe servers (no browser Origin), so skip origin check there.
    if (url.pathname !== '/api/stripe-webhook') {
      const isBookingsRead = url.pathname === '/api/bookings' && request.method === 'GET';
      const isAvailabilityRead = url.pathname === '/api/availability' && request.method === 'GET';
      const isAdminBlockWrite = ['/api/admin/block-slot','/api/admin/block-day','/api/admin/bookings/cleanup-pending'].includes(url.pathname) && request.method === 'POST';
      const isTaxRead = ['/api/tax/transactions','/api/tax/export.csv','/api/tax/receipt'].includes(url.pathname) && request.method === 'GET';
      const isTaxWrite = ['/api/tax/expense','/api/tax/income','/api/tax/owner-transfer','/api/tax/expense/update','/api/tax/income/update','/api/tax/expense/delete','/api/tax/income/delete','/api/tax/receipt/upload'].includes(url.pathname) && request.method === 'POST';
      const isAccountsRead = ['/api/accounts/list','/api/accounts/summary','/api/accounts/journal','/api/accounts/statements','/api/accounts/invoices','/api/accounts/invoices/detail','/api/accounts/quotes','/api/accounts/quotes/detail'].includes(url.pathname) && request.method === 'GET';
      const isAccountsWrite = ['/api/accounts/journal','/api/accounts/rebuild-auto-journal','/api/accounts/year-close','/api/accounts/invoices','/api/accounts/invoices/update','/api/accounts/invoices/status','/api/accounts/invoices/payment','/api/accounts/invoices/payment-link','/api/accounts/invoices/send','/api/accounts/invoices/delete','/api/accounts/quotes','/api/accounts/quotes/update','/api/accounts/quotes/delete','/api/accounts/quotes/send','/api/accounts/quotes/convert'].includes(url.pathname) && request.method === 'POST';
      const isQuotePublic = ['/api/quote/accept','/api/quote/deny'].includes(url.pathname) && request.method === 'GET';
      const isInvoicePublic = ['/invoice/payment-success','/invoice/payment-cancelled'].includes(url.pathname) && request.method === 'GET';
      const isPostRoute = ['/api/contact', '/api/checkout-session', '/api/zombie-bag-checkout'].includes(url.pathname) && request.method === 'POST';
      if (!isBookingsRead && !isAvailabilityRead && !isAdminBlockWrite && !isTaxRead && !isTaxWrite && !isAccountsRead && !isAccountsWrite && !isPostRoute && !isQuotePublic && !isInvoicePublic) {
        return json({ ok: false, error: 'Method not allowed' }, 405, corsHeaders);
      }

      // Public quote accept/deny endpoints don't require CORS origin check
      if (!originAllowed && !isQuotePublic && !isInvoicePublic) {
        return json({ ok: false, error: 'Origin not allowed' }, 403, corsHeaders);
      }
    }

    if (url.pathname === '/api/contact') {
      return handleContact(request, env, corsHeaders);
    }

    if (url.pathname === '/api/checkout-session') {
      return handleCheckoutSession(request, env, corsHeaders, originAllowed, allowedOrigins);
    }

    if (url.pathname === '/api/zombie-bag-checkout') {
      return handleZombieBagCheckout(request, env, corsHeaders, originAllowed, allowedOrigins);
    }

    if (url.pathname === '/api/stripe-webhook') {
      return handleStripeWebhook(request, env, corsHeaders);
    }

    if (url.pathname === '/api/bookings') {
      return handleBookings(request, env, corsHeaders, url);
    }

    if (url.pathname === '/api/availability') {
      return handleAvailability(request, env, corsHeaders, url);
    }

    if (url.pathname === '/api/admin/block-slot') {
      return handleAdminBlockSlot(request, env, corsHeaders, url);
    }

    if (url.pathname === '/api/admin/block-day') {
      return handleAdminBlockDay(request, env, corsHeaders, url);
    }

    if (url.pathname === '/api/admin/bookings/cleanup-pending') {
      return handleAdminCleanupPendingBookings(request, env, corsHeaders, url);
    }

    if (url.pathname === '/api/tax/transactions') {
      return handleTaxTransactions(request, env, corsHeaders, url);
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

    if (url.pathname === '/api/accounts/summary') {
      return handleAccountsSummary(request, env, corsHeaders, url);
    }

    if (url.pathname === '/api/accounts/journal' && request.method === 'GET') {
      return handleAccountsJournal(request, env, corsHeaders, url);
    }

    if (url.pathname === '/api/accounts/statements' && request.method === 'GET') {
      return handleAccountsStatements(request, env, corsHeaders, url);
    }

    if (url.pathname === '/api/accounts/invoices' && request.method === 'GET') {
      return handleInvoicesList(request, env, corsHeaders, url);
    }

    if (url.pathname === '/api/accounts/invoices/detail' && request.method === 'GET') {
      return handleInvoiceDetail(request, env, corsHeaders, url);
    }

    if (url.pathname === '/api/accounts/journal' && request.method === 'POST') {
      return handleAccountsJournalCreate(request, env, corsHeaders, url);
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

    // Public quote accept/deny endpoints (no admin auth required, token-based)
    if (url.pathname === '/api/quote/accept' && request.method === 'GET') {
      return handleQuoteAccept(request, env, corsHeaders, url);
    }

    if (url.pathname === '/api/quote/deny' && request.method === 'GET') {
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
  }
};

/**
 * POST /api/contact — Process contact form submissions and send via Resend
 * @param {Request} request - JSON body: {name, email, message, mode, offer?, honey?}
 * @param {Object} env - Worker env (RESEND_API_KEY, TO_EMAIL, FROM_EMAIL)
 * @param {Object} corsHeaders
 * @returns {Response} {ok: true} or {ok: false, error: string}
 */
async function handleContact(request, env, corsHeaders) {
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

  if (!name || !email) {
    return json({ ok: false, error: 'Missing required fields' }, 400, corsHeaders);
  }

  const subject = mode === 'offer'
    ? `Domain Offer: easternshoreai.com (${offer || 'no amount'})`
    : 'General Inquiry: Florence Mae Gifts';

  const text = [
    `Mode: ${mode}`,
    `Name: ${name}`,
    `Email: ${email}`,
    `Offer/Budget: ${offer || '(not provided)'}`,
    '',
    'Message:',
    message || '(none)'
  ].join('\n');

  const emailPayload = {
    from: env.FROM_EMAIL,
    to: [env.TO_EMAIL],
    subject,
    text,
    reply_to: email
  };

  if (env.CC_EMAIL) {
    emailPayload.cc = [env.CC_EMAIL];
  }

  const resendRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(emailPayload)
  });

  if (!resendRes.ok) {
    const errText = await resendRes.text();
    return json({ ok: false, error: 'Email provider failed', detail: errText }, 502, corsHeaders);
  }

  return json({ ok: true }, 200, corsHeaders);
}

/**
 * POST /api/checkout-session — Create Stripe checkout session with booking conflict + past-time checks
 * @param {Request} request - JSON body: {setupDate, setupTime, customerName, customerEmail, serviceType?}
 * @param {Object} env - Worker env (STRIPE_SECRET_KEY, DB)
 * @returns {Response} {ok: true, checkoutUrl, id} or error
 */
async function handleCheckoutSession(request, env, corsHeaders, originAllowed, allowedOrigins) {
  let data;
  try {
    data = await request.json();
  } catch {
    return json({ ok: false, error: 'Invalid JSON' }, 400, corsHeaders);
  }

  const setupDate = (data.setupDate || '').toString().trim();
  const setupTime = (data.setupTime || '').toString().trim();
  const customerEmail = (data.email || '').toString().trim();
  const customerName = (data.name || '').toString().trim();
  const requestedService = (data.service || 'openclaw_setup').toString().trim().toLowerCase();
  const customerPhone = (data.phone || '').toString().trim();
  const preferredContactMethod = (data.preferredContactMethod || 'email').toString().trim().toLowerCase();
  const lessonTopic = (data.lessonTopic || '').toString().trim();
  const lessonCountRaw = Number.parseInt((data.lessonCount ?? '1').toString(), 10);
  const lessonCount = Number.isFinite(lessonCountRaw) ? Math.min(Math.max(lessonCountRaw, 1), 2) : 1;
  const extraSlotsInput = Array.isArray(data.extraSlots) ? data.extraSlots : [];
  const normalizedExtraSlots = extraSlotsInput
    .map((s) => ({
      setupDate: (s?.setupDate || '').toString().trim(),
      setupTime: (s?.setupTime || '').toString().trim()
    }))
    .filter((s) => s.setupDate && s.setupTime)
    .slice(0, 1);

  const requestedSlots = [{ setupDate, setupTime }, ...normalizedExtraSlots]
    .filter((s) => s.setupDate && s.setupTime);

  const uniqueSlots = [];
  const seenSlots = new Set();
  for (const slot of requestedSlots) {
    const key = `${slot.setupDate}T${slot.setupTime}`;
    if (seenSlots.has(key)) continue;
    seenSlots.add(key);
    uniqueSlots.push(slot);
  }

  const effectiveLessonCount = requestedService === 'lessons'
    ? Math.min(Math.max(lessonCount, 1), 2)
    : 1;

  if (requestedService === 'lessons' && uniqueSlots.length !== effectiveLessonCount) {
    return json({ ok: false, error: 'Please provide one unique time slot per lesson.' }, 400, corsHeaders);
  }

  const serviceConfig = requestedService === 'lessons'
    ? {
        key: 'lessons',
        label: 'Tech Tutoring (2 hour session)',
        amountCents: 10000,
        quantity: uniqueSlots.length || 1,
        successPath: '/book-lessons.html'
      }
    : {
        key: 'openclaw_setup',
        label: 'OpenClaw Setup',
        amountCents: 10000,
        quantity: 1,
        successPath: '/openclaw-setup.html'
      };

  // Reject past dates/blocks using America/New_York.
  {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).formatToParts(new Date());
    const get = (t) => parts.find(p => p.type === t)?.value;
    const today = `${get('year')}-${get('month')}-${get('day')}`;
    const nowHm = `${get('hour')}:${get('minute')}`;
    const start = setupTime.split('-')[0] || '';

    if (setupDate && today && setupDate < today) {
      return json({ ok: false, error: 'Selected date is in the past (ET). Choose a future date.' }, 400, corsHeaders);
    }
    if (setupDate && today && setupDate === today && start && start <= nowHm) {
      return json({ ok: false, error: 'Selected time block has already passed (ET). Choose a later block.' }, 400, corsHeaders);
    }
  }

  if (!setupDate || !setupTime) {
    return json({ ok: false, error: 'Missing setup date/time' }, 400, corsHeaders);
  }

  if (requestedService === 'lessons' && !lessonTopic) {
    return json({ ok: false, error: 'Missing lesson topic' }, 400, corsHeaders);
  }

  if (!env.STRIPE_SECRET_KEY) {
    return json({ ok: false, error: 'Stripe not configured' }, 500, corsHeaders);
  }

  const allSlots = requestedService === 'lessons'
    ? uniqueSlots
    : [{ setupDate, setupTime }];
  const setupAt = `${setupDate}T${setupTime}`;

  // Validate past-time for every selected slot
  {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).formatToParts(new Date());
    const get = (t) => parts.find(p => p.type === t)?.value;
    const today = `${get('year')}-${get('month')}-${get('day')}`;
    const nowHm = `${get('hour')}:${get('minute')}`;

    for (const slot of allSlots) {
      const start = (slot.setupTime || '').split('-')[0] || '';
      if (slot.setupDate && today && slot.setupDate < today) {
        return json({ ok: false, error: 'Selected date is in the past (ET). Choose a future date.' }, 400, corsHeaders);
      }
      if (slot.setupDate && today && slot.setupDate === today && start && start <= nowHm) {
        return json({ ok: false, error: 'Selected time block has already passed (ET). Choose a later block.' }, 400, corsHeaders);
      }
    }
  }

  if (env.DB) {
    for (const slot of allSlots) {
      const slotAt = `${slot.setupDate}T${slot.setupTime}`;
      const existing = await env.DB.prepare(
        `SELECT id FROM bookings WHERE setup_at = ?1 AND status IN ('paid','confirmed') LIMIT 1`
      ).bind(slotAt).first();

      if (existing) {
        return json({ ok: false, error: 'One of the selected date/time slots is already booked. Please choose another slot.' }, 409, corsHeaders);
      }

      const blocked = await env.DB.prepare(
        `SELECT id FROM blocked_slots WHERE setup_at = ?1 AND active = 1 LIMIT 1`
      ).bind(slotAt).first();

      if (blocked) {
        return json({ ok: false, error: 'One of the selected date/time slots is unavailable. Please choose another slot.' }, 409, corsHeaders);
      }

      const blockedDay = await env.DB.prepare(
        `SELECT id FROM blocked_days WHERE setup_date = ?1 AND active = 1 LIMIT 1`
      ).bind(slot.setupDate).first();

      if (blockedDay) {
        return json({ ok: false, error: 'One of the selected days is unavailable. Please choose another date.' }, 409, corsHeaders);
      }
    }
  }

  const siteOrigin = originAllowed ? (request.headers.get('Origin') || '') : (allowedOrigins[0] || 'https://www.florencemaegifts.com');
  const body = new URLSearchParams({
    mode: 'payment',
    allow_promotion_codes: 'true',
    success_url: `${siteOrigin}${serviceConfig.successPath}?paid=1`,
    cancel_url: `${siteOrigin}${serviceConfig.successPath}?canceled=1`,
    'line_items[0][price_data][currency]': 'usd',
    'line_items[0][price_data][unit_amount]': String(serviceConfig.amountCents),
    'line_items[0][price_data][product_data][name]': serviceConfig.label,
    'line_items[0][quantity]': String(serviceConfig.quantity || 1),
    'metadata[setup_date]': setupDate,
    'metadata[setup_time]': setupTime,
    'metadata[setup_at]': setupAt,
    'metadata[service_type]': serviceConfig.key,
    'metadata[service_label]': serviceConfig.label,
    'metadata[customer_name]': customerName || '(not provided)',
    'metadata[customer_phone]': customerPhone || '',
    'metadata[preferred_contact_method]': preferredContactMethod || 'email',
    'metadata[lesson_topic]': lessonTopic || '',
    'metadata[lesson_count]': String(serviceConfig.quantity || 1),
    'metadata[slots_json]': JSON.stringify(allSlots),
    'payment_intent_data[metadata][setup_date]': setupDate,
    'payment_intent_data[metadata][setup_time]': setupTime,
    'payment_intent_data[metadata][setup_at]': setupAt,
    'payment_intent_data[metadata][service_type]': serviceConfig.key,
    'payment_intent_data[metadata][service_label]': serviceConfig.label,
    'payment_intent_data[metadata][lesson_topic]': lessonTopic || '',
    'payment_intent_data[metadata][lesson_count]': String(serviceConfig.quantity || 1),
    'payment_intent_data[metadata][customer_phone]': customerPhone || '',
    'payment_intent_data[metadata][preferred_contact_method]': preferredContactMethod || 'email',
  });

  if (customerEmail) body.set('customer_email', customerEmail);

  const stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: body.toString()
  });

  const stripeData = await stripeRes.json();
  if (!stripeRes.ok) {
    return json({ ok: false, error: 'Stripe session failed', detail: stripeData }, 502, corsHeaders);
  }

  if (env.DB) {
    const totalAmount = serviceConfig.amountCents * (serviceConfig.quantity || 1);
    const splitAmount = Math.round(totalAmount / Math.max(allSlots.length, 1));
    for (let i = 0; i < allSlots.length; i++) {
      const slot = allSlots[i];
      const slotAt = `${slot.setupDate}T${slot.setupTime}`;
      const slotAmount = i === 0 ? (totalAmount - (splitAmount * (allSlots.length - 1))) : splitAmount;
      await env.DB.prepare(
        `INSERT INTO bookings (
          stripe_session_id, status, setup_date, setup_time, setup_at, customer_name, customer_email, customer_phone, preferred_contact_method, amount_cents, service_type
        ) VALUES (?1, 'pending', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`
      ).bind(
        stripeData.id,
        slot.setupDate,
        slot.setupTime,
        slotAt,
        customerName || null,
        customerEmail || null,
        customerPhone || null,
        preferredContactMethod || 'email',
        slotAmount,
        serviceConfig.key
      ).run();
    }
  }

  return json({ ok: true, checkoutUrl: stripeData.url, id: stripeData.id }, 200, corsHeaders);
}

/**
 * POST /api/zombie-bag-checkout — Create Stripe checkout for Zombie Bag ecommerce purchase
 * @param {Request} request - optional JSON body
 * @param {Object} env - Worker env (STRIPE_SECRET_KEY)
 * @returns {Response} {ok: true, checkoutUrl, id} or error
 */
async function handleZombieBagCheckout(request, env, corsHeaders, originAllowed, allowedOrigins) {
  if (!env.STRIPE_SECRET_KEY) {
    return json({ ok: false, error: 'Stripe not configured' }, 500, corsHeaders);
  }

  let data = {};
  try {
    data = await request.json();
  } catch {
    data = {};
  }

  const bagColor = (data.bagColor || 'not_selected').toString().trim().toLowerCase();
  const checkoutType = (data.checkoutType || 'zombie_bag').toString().trim().toLowerCase();
  const isByogSetup = checkoutType === 'byog_setup';
  const termsAccepted = data.termsAccepted === true;

  if (!termsAccepted) {
    return json({ ok: false, error: 'You must read and accept the Terms of Sale before checkout.' }, 400, corsHeaders);
  }

  const siteOrigin = originAllowed ? (request.headers.get('Origin') || '') : (allowedOrigins[0] || 'https://www.florencemaegifts.com');
  const successUrl = `${siteOrigin}/zombies.html?paid=1`;
  const cancelUrl = `${siteOrigin}/zombies.html?canceled=1`;

  const body = new URLSearchParams({
    mode: 'payment',
    success_url: successUrl,
    cancel_url: cancelUrl,
    billing_address_collection: 'required',
    'line_items[0][price_data][currency]': 'usd',
    'line_items[0][price_data][unit_amount]': isByogSetup ? '4999' : '14999',
    'line_items[0][price_data][product_data][name]': isByogSetup ? 'Zombie Bag BYOG Setup-Only Service' : 'Zombie Bag',
    'line_items[0][price_data][product_data][description]': isByogSetup ? 'Bring your own gear setup-only service' : 'Android tablet + solar charger + go bag with pre-installed emergency apps',
    'line_items[0][quantity]': '1',
    'metadata[product]': isByogSetup ? 'zombie_bag_byog_setup' : 'zombie_bag',
    'metadata[unit_price_cents]': isByogSetup ? '4999' : '14999',
    'metadata[bag_color]': bagColor,
    'metadata[checkout_type]': isByogSetup ? 'byog_setup' : 'zombie_bag'
  });

  if (!isByogSetup) {
    body.set('shipping_address_collection[allowed_countries][0]', 'US');
    body.set('shipping_options[0][shipping_rate_data][type]', 'fixed_amount');
    body.set('shipping_options[0][shipping_rate_data][fixed_amount][amount]', '0');
    body.set('shipping_options[0][shipping_rate_data][fixed_amount][currency]', 'usd');
    body.set('shipping_options[0][shipping_rate_data][display_name]', 'Free Delivery (Eastern Shore, MD area)');
    body.set('shipping_options[0][shipping_rate_data][delivery_estimate][minimum][unit]', 'business_day');
    body.set('shipping_options[0][shipping_rate_data][delivery_estimate][minimum][value]', '1');
    body.set('shipping_options[0][shipping_rate_data][delivery_estimate][maximum][unit]', 'business_day');
    body.set('shipping_options[0][shipping_rate_data][delivery_estimate][maximum][value]', '3');
    body.set('shipping_options[1][shipping_rate_data][type]', 'fixed_amount');
    body.set('shipping_options[1][shipping_rate_data][fixed_amount][amount]', '1999');
    body.set('shipping_options[1][shipping_rate_data][fixed_amount][currency]', 'usd');
    body.set('shipping_options[1][shipping_rate_data][display_name]', 'Continental U.S. Shipping');
    body.set('shipping_options[1][shipping_rate_data][delivery_estimate][minimum][unit]', 'business_day');
    body.set('shipping_options[1][shipping_rate_data][delivery_estimate][minimum][value]', '3');
    body.set('shipping_options[1][shipping_rate_data][delivery_estimate][maximum][unit]', 'business_day');
    body.set('shipping_options[1][shipping_rate_data][delivery_estimate][maximum][value]', '7');
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
  if (!stripeRes.ok) {
    return json({ ok: false, error: 'Stripe session failed', detail: stripeData }, 502, corsHeaders);
  }

  return json({ ok: true, checkoutUrl: stripeData.url, id: stripeData.id }, 200, corsHeaders);
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
    return json({ ok: false, error: 'Invalid Stripe signature' }, 400, corsHeaders);
  }

  let event;
  try {
    event = JSON.parse(payload);
  } catch {
    return json({ ok: false, error: 'Invalid JSON payload' }, 400, corsHeaders);
  }

  if (!env.DB) {
    // Still ack so Stripe doesn't keep retrying if DB isn't bound yet.
    return json({ ok: true, warning: 'DB binding missing' }, 200, corsHeaders);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data?.object || {};
    const sessionId = session.id || null;

    if ((session.metadata?.checkout_type || '').toString() === 'invoice_payment') {
      const invoiceId = Number(session.metadata?.invoice_id || 0);
      const amount = Math.round(Number(session.amount_total || 0));
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
        const feeCents = await fetchStripeFeeCents(env.STRIPE_SECRET_KEY, paymentIntentId);
        if (feeCents > 0 && sessionId) {
          const feeNote = `Auto Stripe fee for invoice session ${sessionId}`;
          const existingFee = await env.DB.prepare(
            `SELECT id FROM tax_expenses WHERE notes = ?1 LIMIT 1`
          ).bind(feeNote).first();

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
        return json({ ok: false, error: `Invoice webhook failed: ${e?.message || e}` }, 500, corsHeaders);
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
    const incomeCategory = serviceType === 'lessons' ? 'AI Lessons' : 'OpenClaw Setup';
    const incomeSource = serviceType === 'lessons' ? 'Stripe - Lessons' : 'Stripe';
    const amount = Number(session.amount_total || 10000);

    if (sessionId) {
      try {
        let slots = [];
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

        // Use the payment event timestamp for accounting date, not the appointment date
        const incomeDate = event.created
          ? new Date(event.created * 1000).toISOString().slice(0, 10)
          : new Date().toISOString().slice(0, 10);

        const existingIncome = await env.DB.prepare(
          `SELECT id FROM tax_income WHERE stripe_session_id = ?1 LIMIT 1`
        ).bind(sessionId).first();

        const incomeNotes = customerName
          ? `Auto-imported from Stripe checkout (${serviceLabel || incomeCategory}) for ${customerName}`
          : `Auto-imported from Stripe checkout (${serviceLabel || incomeCategory})`;
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
        for (const slot of slots) {
          const slotAt = `${slot.setupDate}T${slot.setupTime}`;
          await env.DB.prepare(
            `DELETE FROM bookings
             WHERE status = 'pending'
               AND setup_at = ?1
               AND stripe_session_id != ?2`
          ).bind(slotAt, sessionId).run();
        }

        // Auto-insert Stripe processing fee as expense for accurate net reporting
        const paymentIntentId = (session.payment_intent || '').toString().trim();
        const feeCents = await fetchStripeFeeCents(env.STRIPE_SECRET_KEY, paymentIntentId);
        if (feeCents > 0) {
          const feeNote = `Auto Stripe fee for session ${sessionId}`;
          const existingFee = await env.DB.prepare(
            `SELECT id FROM tax_expenses WHERE notes = ?1 LIMIT 1`
          ).bind(feeNote).first();

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
        console.error('Stripe webhook DB write failed', e);
        return json({ ok: false, error: `Webhook DB write failed: ${e?.message || e}` }, 500, corsHeaders);
      }
    }
  }

  return json({ ok: true }, 200, corsHeaders);
}

// ===== Utility Functions =====

/** Validate admin password from X-Admin-Password header or ?key query param */
function requireAdmin(request, env, corsHeaders, url) {
  const provided = (request.headers.get('X-Admin-Password') || url.searchParams.get('key') || '').trim();
  const expected = (env.ADMIN_PASSWORD || '').trim();
  if (!expected) return { ok: false, res: json({ ok: false, error: 'Admin password not configured' }, 500, corsHeaders) };
  if (!provided || provided !== expected) return { ok: false, res: json({ ok: false, error: 'Unauthorized' }, 401, corsHeaders) };
  return { ok: true };
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
 * GET /api/bookings — Admin: fetch all bookings + blocked slots + blocked days
 * @returns {Response} {ok: true, bookings, blockedSlots, blockedDays}
 */
async function handleBookings(request, env, corsHeaders, url) {
  if (!env.DB) {
    return json({ ok: false, error: 'DB binding missing' }, 500, corsHeaders);
  }

  const auth = requireAdmin(request, env, corsHeaders, url);
  if (!auth.ok) return auth.res;

  const limit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit') || 20)));
  const rows = await env.DB.prepare(
    `SELECT id, stripe_session_id, stripe_payment_intent_id, status, setup_date, setup_time, setup_at, customer_name, customer_email, customer_phone, preferred_contact_method, amount_cents, service_type, paid_at, created_at, updated_at
     FROM bookings
     ORDER BY created_at DESC
     LIMIT ?1`
  ).bind(limit).all();

  const blocked = await env.DB.prepare(
    `SELECT id, setup_date, setup_time, setup_at, reason, active, created_at, updated_at
     FROM blocked_slots
     ORDER BY created_at DESC
     LIMIT ?1`
  ).bind(limit).all();

  const blockedDays = await env.DB.prepare(
    `SELECT id, setup_date, reason, active, created_at, updated_at
     FROM blocked_days
     ORDER BY created_at DESC
     LIMIT ?1`
  ).bind(limit).all();

  return json({ ok: true, bookings: rows.results || [], blockedSlots: blocked.results || [], blockedDays: blockedDays.results || [] }, 200, corsHeaders);
}

/**
 * GET /api/availability — Public: return unavailable setup_at values and blocked dates
 * @returns {Response} {ok: true, unavailable: string[], blockedDates: string[]}
 */
async function handleAvailability(request, env, corsHeaders, url) {
  if (!env.DB) {
    return json({ ok: true, unavailable: [] }, 200, corsHeaders);
  }

  const from = (url.searchParams.get('from') || '').trim();
  const to = (url.searchParams.get('to') || '').trim();

  let bookedRows;
  let blockedRows;
  if (from && to) {
    bookedRows = await env.DB.prepare(
      `SELECT setup_at FROM bookings WHERE status IN ('paid','confirmed') AND setup_at >= ?1 AND setup_at <= ?2`
    ).bind(from, to).all();
    blockedRows = await env.DB.prepare(
      `SELECT setup_at FROM blocked_slots WHERE active = 1 AND setup_at >= ?1 AND setup_at <= ?2`
    ).bind(from, to).all();
  } else {
    bookedRows = await env.DB.prepare(
      `SELECT setup_at FROM bookings WHERE status IN ('paid','confirmed') ORDER BY setup_at DESC LIMIT 500`
    ).all();
    blockedRows = await env.DB.prepare(
      `SELECT setup_at FROM blocked_slots WHERE active = 1 ORDER BY setup_at DESC LIMIT 500`
    ).all();
  }

  const blockedDayRows = await env.DB.prepare(
    `SELECT setup_date FROM blocked_days WHERE active = 1`
  ).all();

  const unavailable = Array.from(new Set([
    ...(bookedRows.results || []).map(r => r.setup_at).filter(Boolean),
    ...(blockedRows.results || []).map(r => r.setup_at).filter(Boolean)
  ]));

  const blockedDates = Array.from(new Set((blockedDayRows.results || []).map(r => r.setup_date).filter(Boolean)));

  return json({ ok: true, unavailable, blockedDates }, 200, corsHeaders);
}

/**
 * POST /api/admin/block-slot — Block or unblock a specific 2-hour setup slot
 * @param {Request} request - JSON body: {setupDate, setupTime, active}
 * @returns {Response} {ok: true}
 */
async function handleAdminBlockSlot(request, env, corsHeaders, url) {
  if (!env.DB) {
    return json({ ok: false, error: 'DB binding missing' }, 500, corsHeaders);
  }

  const auth = requireAdmin(request, env, corsHeaders, url);
  if (!auth.ok) return auth.res;

  let data;
  try {
    data = await request.json();
  } catch {
    return json({ ok: false, error: 'Invalid JSON' }, 400, corsHeaders);
  }

  const setupDate = (data.setupDate || '').toString().trim();
  const setupTime = (data.setupTime || '').toString().trim();
  const reason = (data.reason || '').toString().trim();
  const active = data.active === false ? 0 : 1;

  if (!setupDate || !setupTime) {
    return json({ ok: false, error: 'Missing setup date/time' }, 400, corsHeaders);
  }

  const setupAt = `${setupDate}T${setupTime}`;

  await env.DB.prepare(
    `INSERT INTO blocked_slots (setup_date, setup_time, setup_at, reason, active)
     VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT(setup_at) DO UPDATE SET
       reason=excluded.reason,
       active=excluded.active,
       updated_at=datetime('now')`
  ).bind(setupDate, setupTime, setupAt, reason || null, active).run();

  return json({ ok: true, setupAt, active: !!active }, 200, corsHeaders);
}

/**
 * POST /api/admin/block-day — Block or unblock an entire day
 * @param {Request} request - JSON body: {date, active}
 * @returns {Response} {ok: true}
 */
async function handleAdminBlockDay(request, env, corsHeaders, url) {
  if (!env.DB) {
    return json({ ok: false, error: 'DB binding missing' }, 500, corsHeaders);
  }

  const auth = requireAdmin(request, env, corsHeaders, url);
  if (!auth.ok) return auth.res;

  let data;
  try {
    data = await request.json();
  } catch {
    return json({ ok: false, error: 'Invalid JSON' }, 400, corsHeaders);
  }

  const setupDate = (data.setupDate || '').toString().trim();
  const reason = (data.reason || '').toString().trim();
  const active = data.active === false ? 0 : 1;

  if (!setupDate) {
    return json({ ok: false, error: 'Missing setup date' }, 400, corsHeaders);
  }

  await env.DB.prepare(
    `INSERT INTO blocked_days (setup_date, reason, active)
     VALUES (?1, ?2, ?3)
     ON CONFLICT(setup_date) DO UPDATE SET
       reason=excluded.reason,
       active=excluded.active,
       updated_at=datetime('now')`
  ).bind(setupDate, reason || null, active).run();

  return json({ ok: true, setupDate, active: !!active }, 200, corsHeaders);
}

/**
 * POST /api/admin/bookings/cleanup-pending — Delete pending bookings older than N days
 * @param {Request} request - JSON body: {days?: number}
 * @returns {Response} {ok: true, days, deleted}
 */
async function handleAdminCleanupPendingBookings(request, env, corsHeaders, url) {
  if (!env.DB) {
    return json({ ok: false, error: 'DB binding missing' }, 500, corsHeaders);
  }

  const auth = requireAdmin(request, env, corsHeaders, url);
  if (!auth.ok) return auth.res;

  let data = {};
  try {
    data = await request.json();
  } catch {
    // allow empty body
  }

  const rawDays = Number(data.days);
  const days = Number.isFinite(rawDays) ? Math.max(1, Math.min(60, Math.floor(rawDays))) : 5;

  const result = await env.DB.prepare(
    `DELETE FROM bookings
     WHERE status = 'pending'
       AND datetime(created_at) < datetime('now', '-' || ?1 || ' days')`
  ).bind(days).run();

  return json({ ok: true, days, deleted: Number(result.meta?.changes || 0) }, 200, corsHeaders);
}

/**
 * GET /api/tax/transactions — Admin: fetch tax entries filtered by year and type
 * @returns {Response} {ok: true, income: [], expenses: []}
 */
async function handleTaxTransactions(request, env, corsHeaders, url) {
  if (!env.DB) return json({ ok: false, error: 'DB binding missing' }, 500, corsHeaders);
  const auth = requireAdmin(request, env, corsHeaders, url);
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
  const auth = requireAdmin(request, env, corsHeaders, url);
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
  const auth = requireAdmin(request, env, corsHeaders, url);
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
  const auth = requireAdmin(request, env, corsHeaders, url);
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
  const auth = requireAdmin(request, env, corsHeaders, url);
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
  if (!['personal_to_business','business_to_personal','personal_paid_business_card'].includes(transferType)) return json({ ok: false, error: 'Invalid transfer type' }, 400, corsHeaders);
  if (!Number.isFinite(cents) || cents <= 0) return json({ ok: false, error: 'Invalid amount' }, 400, corsHeaders);

  const cashId = await getAccountIdByCode(env.DB, '1000');
  const ownerContribId = await getAccountIdByCode(env.DB, '3100');
  const ownerDrawId = await getAccountIdByCode(env.DB, '3200');
  const ccPayableId = await getAccountIdByCode(env.DB, '2100');
  if (!cashId || !ownerContribId || !ownerDrawId || !ccPayableId) return json({ ok: false, error: 'Required accounts not found' }, 500, corsHeaders);

  const ins = await env.DB.prepare(`INSERT INTO journal_entries (entry_date, memo, source_type) VALUES (?1, ?2, 'owner_transfer')`).bind(entryDate, notes || `Owner transfer: ${transferType}`).run();
  const entryId = Number(ins.meta?.last_row_id || 0);

  if (transferType === 'personal_to_business') {
    await env.DB.prepare(`INSERT INTO journal_lines (entry_id, account_id, debit_cents, credit_cents) VALUES (?1, ?2, ?3, 0), (?1, ?4, 0, ?3)`).bind(entryId, cashId, cents, ownerContribId).run();
  } else if (transferType === 'business_to_personal') {
    await env.DB.prepare(`INSERT INTO journal_lines (entry_id, account_id, debit_cents, credit_cents) VALUES (?1, ?2, ?3, 0), (?1, ?4, 0, ?3)`).bind(entryId, ownerDrawId, cents, cashId).run();
  } else {
    await env.DB.prepare(`INSERT INTO journal_lines (entry_id, account_id, debit_cents, credit_cents) VALUES (?1, ?2, ?3, 0), (?1, ?4, 0, ?3)`).bind(entryId, ccPayableId, cents, ownerContribId).run();
  }

  return json({ ok: true, id: entryId }, 200, corsHeaders);
}

/**
 * POST /api/tax/income/update — Admin: edit an existing income entry
 */
async function handleTaxIncomeUpdate(request, env, corsHeaders, url) {
  if (!env.DB) return json({ ok: false, error: 'DB binding missing' }, 500, corsHeaders);
  const auth = requireAdmin(request, env, corsHeaders, url);
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

  const existing = await env.DB.prepare('SELECT id FROM tax_income WHERE id = ?1').bind(id).first();
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

  return json({ ok: true, id }, 200, corsHeaders);
}


/**
 * POST /api/tax/expense/delete — Admin: delete expense entry
 */
async function handleTaxExpenseDelete(request, env, corsHeaders, url) {
  if (!env.DB) return json({ ok: false, error: 'DB binding missing' }, 500, corsHeaders);
  const auth = requireAdmin(request, env, corsHeaders, url);
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
  const auth = requireAdmin(request, env, corsHeaders, url);
  if (!auth.ok) return auth.res;

  let data;
  try { data = await request.json(); } catch { return json({ ok: false, error: 'Invalid JSON' }, 400, corsHeaders); }
  const id = Number(data.id || 0);
  if (!Number.isInteger(id) || id <= 0) return json({ ok: false, error: 'Invalid id' }, 400, corsHeaders);

  const existing = await env.DB.prepare('SELECT id, receipt_key FROM tax_income WHERE id = ?1').bind(id).first();
  if (!existing) return json({ ok: false, error: 'Income not found' }, 404, corsHeaders);

  if (existing.receipt_key && env.RECEIPTS) {
    await env.RECEIPTS.delete(existing.receipt_key).catch(() => {});
  }

  await env.DB.prepare('DELETE FROM tax_income WHERE id = ?1').bind(id).run();
  await deleteAutoJournalBySource(env.DB, 'tax_income', id);
  return json({ ok: true, id }, 200, corsHeaders);
}

/**
 * POST /api/tax/receipt/upload — Admin: upload a receipt file to R2 and attach to a tax record
 * Multipart form fields: type (expense|income), id, file (PDF/JPG/PNG ≤ 10MB)
 */
async function handleTaxReceiptUpload(request, env, corsHeaders, url) {
  if (!env.DB) return json({ ok: false, error: 'DB binding missing' }, 500, corsHeaders);
  if (!env.RECEIPTS) return json({ ok: false, error: 'RECEIPTS binding missing' }, 500, corsHeaders);
  const auth = requireAdmin(request, env, corsHeaders, url);
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

  const col = type === 'expense' ? 'receipt_key' : 'receipt_key';
  await env.DB.prepare(`UPDATE ${table} SET receipt_key = ?1 WHERE id = ?2`).bind(key, id).run();

  return json({ ok: true, key }, 200, corsHeaders);
}

/**
 * GET /api/tax/receipt — Admin: retrieve a receipt from R2
 * Query params: key (R2 object key), key2 (admin password — alternative auth since ?key is taken)
 */
async function handleTaxReceiptGet(request, env, corsHeaders, url) {
  if (!env.RECEIPTS) return json({ ok: false, error: 'RECEIPTS binding missing' }, 500, corsHeaders);

  // Support ?key2=<password> as alternate auth param since ?key is used for the R2 key
  const adminPw = request.headers.get('X-Admin-Password') || url.searchParams.get('key2') || '';
  if (!adminPw || adminPw !== env.ADMIN_PASSWORD) {
    return new Response(JSON.stringify({ ok: false, error: 'Unauthorized' }), { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  const r2Key = url.searchParams.get('key') || '';
  if (!r2Key) return json({ ok: false, error: 'Missing key' }, 400, corsHeaders);

  const obj = await env.RECEIPTS.get(r2Key);
  if (!obj) return json({ ok: false, error: 'Receipt not found' }, 404, corsHeaders);

  const contentType = obj.httpMetadata?.contentType || 'application/octet-stream';
  return new Response(obj.body, {
    status: 200,
    headers: {
      ...corsHeaders,
      'Content-Type': contentType,
      'Content-Disposition': `inline; filename="receipt.${r2Key.split('.').pop()}"`,
      'Cache-Control': 'private, max-age=3600'
    }
  });
}

/**
 * GET /api/tax/export.csv — Admin: download CSV of tax entries for selected year/type
 * @returns {Response} CSV file attachment
 */
async function handleTaxExportCsv(request, env, corsHeaders, url) {
  if (!env.DB) return json({ ok: false, error: 'DB binding missing' }, 500, corsHeaders);
  const auth = requireAdmin(request, env, corsHeaders, url);
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
    headers: {
      ...corsHeaders,
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`
    }
  });
}

async function handleAccountsList(request, env, corsHeaders, url) {
  if (!env.DB) return json({ ok: false, error: 'DB binding missing' }, 500, corsHeaders);
  const auth = requireAdmin(request, env, corsHeaders, url);
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
  const auth = requireAdmin(request, env, corsHeaders, url);
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
  const auth = requireAdmin(request, env, corsHeaders, url);
  if (!auth.ok) return auth.res;

  const accountingReady = await ensureAccountingSetup(env.DB);
  if (!accountingReady) return json({ ok: false, error: 'Accounting tables are not migrated yet. Run D1 migrations with --remote.' }, 503, corsHeaders);

  const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit') || 200)));
  const year = (url.searchParams.get('year') || '').trim();
  const from = (url.searchParams.get('from') || '').trim();
  const to = (url.searchParams.get('to') || '').trim();

  let where = '';
  const binds = [];
  if (/^\d{4}$/.test(year)) { where = 'WHERE entry_date >= ?1 AND entry_date <= ?2'; binds.push(`${year}-01-01`, `${year}-12-31`); }
  else if (/^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to)) { where = 'WHERE entry_date >= ?1 AND entry_date <= ?2'; binds.push(from, to); }

  const entriesQ = env.DB.prepare(`SELECT id, entry_date, memo, source_type, source_id, created_at FROM journal_entries ${where} ORDER BY entry_date DESC, id DESC LIMIT ?${binds.length + 1}`);
  const entries = await entriesQ.bind(...binds, limit).all();
  const entryIds = (entries.results || []).map(e => Number(e.id)).filter(Boolean);
  if (!entryIds.length) return json({ ok: true, entries: [] }, 200, corsHeaders);

  const placeholders = entryIds.map(() => '?').join(',');
  const lines = await env.DB.prepare(
    `SELECT jl.id, jl.entry_id, jl.account_id, jl.debit_cents, jl.credit_cents, a.code, a.name
     FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
     WHERE jl.entry_id IN (${placeholders})
     ORDER BY jl.entry_id ASC, jl.id ASC`
  ).bind(...entryIds).all();

  const linesByEntry = new Map();
  for (const l of (lines.results || [])) {
    const key = Number(l.entry_id);
    if (!linesByEntry.has(key)) linesByEntry.set(key, []);
    linesByEntry.get(key).push(l);
  }

  const out = (entries.results || []).map((e) => ({ ...e, lines: linesByEntry.get(Number(e.id)) || [] }));
  return json({ ok: true, entries: out }, 200, corsHeaders);
}

async function handleAccountsStatements(request, env, corsHeaders, url) {
  if (!env.DB) return json({ ok: false, error: 'DB binding missing' }, 500, corsHeaders);
  const auth = requireAdmin(request, env, corsHeaders, url);
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
    const bal = r.normal_side === 'debit' ? (debits - credits) : (credits - debits);
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
    equationBalanced: totals.assets === (totals.liabilities + totals.equity)
  }, 200, corsHeaders);
}

async function handleAccountsJournalCreate(request, env, corsHeaders, url) {
  if (!env.DB) return json({ ok: false, error: 'DB binding missing' }, 500, corsHeaders);
  const auth = requireAdmin(request, env, corsHeaders, url);
  if (!auth.ok) return auth.res;
  const accountingReady = await ensureAccountingSetup(env.DB);
  if (!accountingReady) return json({ ok: false, error: 'Accounting tables are not migrated yet. Run D1 migrations with --remote.' }, 503, corsHeaders);

  let data;
  try { data = await request.json(); } catch { return json({ ok: false, error: 'Invalid JSON' }, 400, corsHeaders); }

  const entryDate = (data.date || '').toString().trim();
  const memo = (data.memo || '').toString().trim();
  const debitAccountId = Number(data.debitAccountId || 0);
  const creditAccountId = Number(data.creditAccountId || 0);
  const cents = toCents(data.amount);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(entryDate)) return json({ ok: false, error: 'Invalid date' }, 400, corsHeaders);
  if (!debitAccountId || !creditAccountId || debitAccountId === creditAccountId) return json({ ok: false, error: 'Invalid debit/credit accounts' }, 400, corsHeaders);
  if (!Number.isFinite(cents) || cents <= 0) return json({ ok: false, error: 'Invalid amount' }, 400, corsHeaders);

  const ins = await env.DB.prepare(`INSERT INTO journal_entries (entry_date, memo, source_type) VALUES (?1, ?2, 'manual')`).bind(entryDate, memo || null).run();
  const entryId = Number(ins.meta?.last_row_id || 0);

  await env.DB.prepare(`INSERT INTO journal_lines (entry_id, account_id, debit_cents, credit_cents) VALUES (?1, ?2, ?3, 0), (?1, ?4, 0, ?3)`).bind(entryId, debitAccountId, cents, creditAccountId).run();

  return json({ ok: true, id: entryId }, 200, corsHeaders);
}

async function handleAccountsRebuildAutoJournal(request, env, corsHeaders, url) {
  if (!env.DB) return json({ ok: false, error: 'DB binding missing' }, 500, corsHeaders);
  const auth = requireAdmin(request, env, corsHeaders, url);
  if (!auth.ok) return auth.res;
  const accountingReady = await ensureAccountingSetup(env.DB);
  if (!accountingReady) return json({ ok: false, error: 'Accounting tables are not migrated yet. Run D1 migrations with --remote.' }, 503, corsHeaders);

  const autoRows = await env.DB.prepare(
    `SELECT id FROM journal_entries WHERE source_type IN ('tax_expense','tax_income')`
  ).all();

  for (const r of (autoRows.results || [])) {
    await env.DB.prepare(`DELETE FROM journal_lines WHERE entry_id = ?1`).bind(r.id).run();
  }
  await env.DB.prepare(`DELETE FROM journal_entries WHERE source_type IN ('tax_expense','tax_income')`).run();

  const expenses = await env.DB.prepare(
    `SELECT id, expense_date, vendor, category, amount_cents, paid_via, notes FROM tax_expenses ORDER BY id ASC`
  ).all();
  const income = await env.DB.prepare(
    `SELECT id, income_date, source, category, amount_cents, notes, is_owner_funded FROM tax_income ORDER BY id ASC`
  ).all();

  for (const e of (expenses.results || [])) await upsertTaxExpenseJournal(env.DB, e);
  for (const i of (income.results || [])) await upsertTaxIncomeJournal(env.DB, i);

  return json({
    ok: true,
    rebuilt: {
      expenseEntries: (expenses.results || []).length,
      incomeEntries: (income.results || []).length
    }
  }, 200, corsHeaders);
}

async function handleAccountsYearClose(request, env, corsHeaders, url) {
  if (!env.DB) return json({ ok: false, error: 'DB binding missing' }, 500, corsHeaders);
  const auth = requireAdmin(request, env, corsHeaders, url);
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
  const auth = requireAdmin(request, env, corsHeaders, url);
  if (!auth.ok) return auth.res;
  let data;
  try { data = await request.json(); } catch { return json({ ok: false, error: 'Invalid JSON' }, 400, corsHeaders); }

  const invoiceNumber = (data.invoiceNumber || `INV-${Date.now()}`).toString();
  const customerName = (data.customerName || '').toString().trim();
  const customerEmail = (data.customerEmail || '').toString().trim();
  const customerPhone = (data.customerPhone || '').toString().trim();
  const issueDate = (data.issueDate || '').toString().trim();
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

  if (!customerName || !/^\d{4}-\d{2}-\d{2}$/.test(issueDate) || !/^\d{4}-\d{2}-\d{2}$/.test(dueDate) || !items.length) {
    return json({ ok: false, error: 'Missing required invoice fields' }, 400, corsHeaders);
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
  const auth = requireAdmin(request, env, corsHeaders, url);
  if (!auth.ok) return auth.res;
  const status = (url.searchParams.get('status') || '').trim();
  const useStatus = status && status !== 'all';
  const rows = useStatus
    ? await env.DB.prepare(`SELECT * FROM invoices WHERE status = ?1 ORDER BY due_date ASC, id DESC LIMIT 300`).bind(status).all()
    : await env.DB.prepare(`SELECT * FROM invoices ORDER BY due_date ASC, id DESC LIMIT 300`).all();
  return json({ ok: true, invoices: rows.results || [] }, 200, corsHeaders);
}

async function handleInvoiceDetail(request, env, corsHeaders, url) {
  if (!env.DB) return json({ ok: false, error: 'DB binding missing' }, 500, corsHeaders);
  const auth = requireAdmin(request, env, corsHeaders, url);
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
  const auth = requireAdmin(request, env, corsHeaders, url);
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

  if (!id || !customerName || !/^\d{4}-\d{2}-\d{2}$/.test(dueDate) || !items.length) {
    return json({ ok: false, error: 'Missing required invoice fields' }, 400, corsHeaders);
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
  const auth = requireAdmin(request, env, corsHeaders, url);
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
  if (appliedPaymentCents <= 0) throw new Error('Invoice is already fully paid');

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
  const auth = requireAdmin(request, env, corsHeaders, url);
  if (!auth.ok) return auth.res;
  let data;
  try { data = await request.json(); } catch { return json({ ok: false, error: 'Invalid JSON' }, 400, corsHeaders); }

  const id = Number(data.id || data.invoiceId || 0);
  const regenerate = !!data.regenerate;
  if (!id) return json({ ok: false, error: 'Invalid invoice id' }, 400, corsHeaders);

  const invoice = await env.DB.prepare(`SELECT * FROM invoices WHERE id = ?1`).bind(id).first();
  if (!invoice) return json({ ok: false, error: 'Invoice not found' }, 404, corsHeaders);

  const status = (invoice.status || '').toString().toLowerCase();
  const existingUrl = (invoice.stripe_checkout_url || '').toString().trim();
  const existingSessionId = (invoice.stripe_checkout_session_id || '').toString().trim();
  if (!regenerate && existingUrl && existingSessionId && !['paid','void'].includes(status)) {
    return json({ ok: true, id, paymentUrl: existingUrl, stripeCheckoutSessionId: existingSessionId, reused: true }, 200, corsHeaders);
  }

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

  const baseUrl = new URL(request.url).origin;
  const siteBase = (env.PUBLIC_SITE_URL || 'https://www.florencemaegifts.com').replace(/\/$/, '');
  const successBase = (env.INVOICE_PAYMENT_SUCCESS_URL || `${siteBase}/invoice-payment-success.html`).replace(/\/$/, '');
  const cancelBase = (env.INVOICE_PAYMENT_CANCEL_URL || `${siteBase}/invoice-payment-cancelled.html`).replace(/\/$/, '');

  const form = new URLSearchParams();
  form.append('mode', 'payment');
  form.append('success_url', `${successBase}?invoice_id=${encodeURIComponent(String(id))}`);
  form.append('cancel_url', `${cancelBase}?invoice_id=${encodeURIComponent(String(id))}`);
  form.append('client_reference_id', `invoice:${id}`);
  if (invoice.customer_email) form.append('customer_email', String(invoice.customer_email));

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

    const subtotalCents = Number(invoice.subtotal_cents || 0);
    const taxCents = Math.max(0, Number(invoice.tax_cents || 0));
    if (taxCents > 0 && subtotalCents > 0) {
      form.append(`line_items[${lineIdx}][price_data][currency]`, 'usd');
      form.append(`line_items[${lineIdx}][price_data][unit_amount]`, String(taxCents));
      form.append(`line_items[${lineIdx}][price_data][product_data][name]`, 'Invoice Tax');
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
  const auth = requireAdmin(request, env, corsHeaders, url);
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
  const auth = requireAdmin(request, env, corsHeaders, url);
  if (!auth.ok) return auth.res;
  let data;
  try { data = await request.json(); } catch { return json({ ok: false, error: 'Invalid JSON' }, 400, corsHeaders); }
  const id = Number(data.id || 0);
  if (!id) return json({ ok: false, error: 'Invalid invoice id' }, 400, corsHeaders);
  await env.DB.prepare(`DELETE FROM invoice_line_items WHERE invoice_id = ?1`).bind(id).run();
  await env.DB.prepare(`DELETE FROM invoices WHERE id = ?1`).bind(id).run();
  return json({ ok: true, id }, 200, corsHeaders);
}

async function handleInvoiceSend(request, env, corsHeaders, url) {
  if (!env.DB) return json({ ok: false, error: 'DB binding missing' }, 500, corsHeaders);
  const auth = requireAdmin(request, env, corsHeaders, url);
  if (!auth.ok) return auth.res;
  const fromEmailEnv = (env.FROM_EMAIL || env.RESEND_FROM_EMAIL || '').toString().trim();
  if (!env.RESEND_API_KEY || !fromEmailEnv) return json({ ok: false, error: 'Email provider is not configured' }, 500, corsHeaders);

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
  const paymentUrl = (invoice.stripe_checkout_url || '').toString().trim();
  const hasPaymentLink = !!paymentUrl && balanceDueCents > 0 && !['paid','void'].includes(String(invoice.status || '').toLowerCase());
  const payButtonHtml = hasPaymentLink ? `<div style="margin:18px 0 12px;text-align:center;"><a href="${escapeHtml(paymentUrl)}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;padding:12px 18px;border-radius:8px;font-weight:700;">Pay Invoice Securely</a><div style="margin-top:8px;font-size:12px;color:#6b7280;">Secure checkout powered by Stripe</div></div>` : '';
  const fromEmail = (env.FROM_EMAIL || env.RESEND_FROM_EMAIL || '').toString().trim();
  const replyToEmail = (env.CC_EMAIL || env.FROM_EMAIL || env.RESEND_FROM_EMAIL || '').toString().trim();

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

  const html = `<div style="font-family:Arial,sans-serif;background:#f7fafc;padding:24px;color:#111827;"><div style="max-width:760px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;"><img src="https://www.florencemaegifts.com/carousel.jpg" alt="Florence Mae Gifts" style="width:100%;height:auto;display:block;" /><div style="padding:20px 24px;background:linear-gradient(135deg,#0f172a,#1f2937);color:#ffffff;"><div style="font-size:12px;letter-spacing:1px;text-transform:uppercase;color:#FE6666;">Florence Mae Gifts</div><h1 style="margin:6px 0 0;font-size:24px;">Invoice ${escapeHtml(invoice.invoice_number || `INV-${id}`)}</h1></div><div style="padding:24px;"><p style="margin:0 0 12px;">Hi ${escapeHtml(invoice.customer_name || 'there')},</p><p style="margin:0 0 14px;color:#374151;">Thanks for working with Florence Mae Gifts. Your invoice details are below.</p><div style="margin:0 0 14px;color:#111827;"><strong>Issue Date:</strong> ${escapeHtml(invoice.issue_date || '')}<br><strong>Due Date:</strong> ${escapeHtml(invoice.due_date || '')}<br><strong>Customer:</strong> ${escapeHtml(invoice.customer_name || '')}</div><table width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;margin:10px 0 14px;"><thead><tr style="background:#f3f4f6;color:#111827;"><th style="padding:10px;text-align:left;">Item</th><th style="padding:10px;text-align:center;">Qty</th><th style="padding:10px;text-align:right;">Unit</th><th style="padding:10px;text-align:right;">Line Total</th></tr></thead><tbody>${itemRowsHtml}</tbody></table><div style="margin-top:10px;"><div style="display:flex;justify-content:flex-end;gap:20px;"><span>Subtotal</span><strong>${formatUsd(subtotalCents)}</strong></div>${taxCents > 0 ? `<div style="display:flex;justify-content:flex-end;gap:20px;margin-top:4px;"><span>Tax</span><strong>${formatUsd(taxCents)}</strong></div>` : ''}<div style="display:flex;justify-content:flex-end;gap:20px;margin-top:6px;font-size:18px;"><span>Total</span><strong>${formatUsd(totalCents)}</strong></div>${amountPaidCents > 0 ? `<div style="display:flex;justify-content:flex-end;gap:20px;margin-top:4px;"><span>Paid</span><strong>${formatUsd(amountPaidCents)}</strong></div>` : ''}<div style="display:flex;justify-content:flex-end;gap:20px;margin-top:4px;"><span>Balance Due</span><strong>${formatUsd(balanceDueCents)}</strong></div></div>${payButtonHtml}${notes ? `<p style="margin:16px 0 0;white-space:pre-wrap;color:#374151;"><strong>Description of work:</strong><br>${escapeHtml(notes)}</p>` : ''}<p style="margin:18px 0 0;color:#374151;text-align:center;">Questions? Reply to this email and we'll get back to you ASAP.</p></div><div style="padding:14px 24px;border-top:1px solid #e5e7eb;background:#f9fafb;color:#4b5563;font-size:13px;text-align:center;"><strong>Florence Mae Gifts, LLC</strong> • <a href="https://www.florencemaegifts.com" style="color:#2563eb;">www.florencemaegifts.com</a><p style="margin:6px 0 0;font-size:11px;line-height:1.45;color:#6b7280;">Privacy: We use your contact information only to prepare and deliver your invoice and related service communications. Terms: Charges are based on the line items shown; taxes or third-party processing fees may apply where required.</p></div></div></div>`;

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

  const sendRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(emailPayload)
  });
  const sendJson = await sendRes.json().catch(() => ({}));
  if (!sendRes.ok) {
    return json({ ok: false, error: sendJson?.message || sendJson?.error || 'Failed to send invoice email' }, 502, corsHeaders);
  }

  await env.DB.prepare(`UPDATE invoices SET status = 'sent', sent_at = datetime('now'), updated_at = datetime('now') WHERE id = ?1`).bind(id).run();
  return json({ ok: true, id, emailId: sendJson?.id || null }, 200, corsHeaders);
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
  const auth = requireAdmin(request, env, corsHeaders, url);
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
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let token = '';
  for (let i = 0; i < 32; i++) {
    token += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return token;
}

async function handleQuoteCreate(request, env, corsHeaders, url) {
  if (!env.DB) return json({ ok: false, error: 'DB binding missing' }, 500, corsHeaders);
  const auth = requireAdmin(request, env, corsHeaders, url);
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
  const auth = requireAdmin(request, env, corsHeaders, url);
  if (!auth.ok) return auth.res;

  const status = url.searchParams.get('status') || '';
  const rows = status && status !== 'all'
    ? await env.DB.prepare(`SELECT * FROM quotes WHERE status = ?1 ORDER BY valid_until ASC, id DESC LIMIT 300`).bind(status).all()
    : await env.DB.prepare(`SELECT * FROM quotes ORDER BY valid_until ASC, id DESC LIMIT 300`).all();
  return json({ ok: true, quotes: rows.results || [] }, 200, corsHeaders);
}

async function handleQuoteDetail(request, env, corsHeaders, url) {
  if (!env.DB) return json({ ok: false, error: 'DB binding missing' }, 500, corsHeaders);
  const auth = requireAdmin(request, env, corsHeaders, url);
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
  const auth = requireAdmin(request, env, corsHeaders, url);
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
  const auth = requireAdmin(request, env, corsHeaders, url);
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
  const auth = requireAdmin(request, env, corsHeaders, url);
  if (!auth.ok) return auth.res;
  const fromEmailEnv = (env.FROM_EMAIL || env.RESEND_FROM_EMAIL || '').toString().trim();
  if (!env.RESEND_API_KEY || !fromEmailEnv) return json({ ok: false, error: 'Email provider is not configured' }, 500, corsHeaders);

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
  const fromEmail = (env.FROM_EMAIL || env.RESEND_FROM_EMAIL || '').toString().trim();

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

  const sendRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(emailPayload)
  });
  const sendJson = await sendRes.json().catch(() => ({}));
  if (!sendRes.ok) {
    return json({ ok: false, error: sendJson?.message || sendJson?.error || 'Failed to send quote email' }, 502, corsHeaders);
  }

  await env.DB.prepare(`UPDATE quotes SET status = 'sent', sent_at = datetime('now'), updated_at = datetime('now') WHERE id = ?1`).bind(id).run();
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
    <div class="hero"><img src="https://www.florencemaegifts.com/carousel.jpg" alt="Florence Mae Gifts" /></div>
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
  return new Response(invoicePaymentPage('Payment Successful', 'Payment Successful', 'Thank you — your invoice payment was successful.', true, invoiceId), { status: 200, headers: { 'Content-Type': 'text/html' } });
}

async function handleInvoicePaymentCancelledPage(request, env, corsHeaders, url) {
  const invoiceId = url.searchParams.get('invoice_id') || '';
  return new Response(invoicePaymentPage('Payment Cancelled', 'Payment Cancelled', 'Your payment was cancelled. You can return to the invoice and complete payment anytime.', false, invoiceId), { status: 200, headers: { 'Content-Type': 'text/html' } });
}

function htmlPage(title, heading, message, success = true) {
  const bgColor = success ? '#059669' : '#dc2626';
  const icon = success ? '✓' : '✗';
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
      <p>${escapeHtml(message)}</p>
    </div>
    <div class="footer">
      <div><a href="https://www.florencemaegifts.com">www.florencemaegifts.com</a></div>
      <div style="margin-top:6px; font-size:13px;">Questions? Contact me here: <a href="mailto:contact@florencemaegifts.com" style="color:#FE6666; text-decoration:underline;">contact@florencemaegifts.com</a></div>
    </div>
  </div>
</body>
</html>`;
}

async function handleQuoteAccept(request, env, corsHeaders, url) {
  if (!env.DB) return new Response(htmlPage('Error', 'System Error', 'Database not configured.', false), { status: 500, headers: { 'Content-Type': 'text/html' } });

  const token = url.searchParams.get('token') || '';
  if (!token) return new Response(htmlPage('Invalid Link', 'Invalid Link', 'This quote link is invalid or missing a token.', false), { status: 400, headers: { 'Content-Type': 'text/html' } });

  const quote = await env.DB.prepare(`SELECT * FROM quotes WHERE accept_token = ?1`).bind(token).first();
  if (!quote) return new Response(htmlPage('Quote Not Found', 'Quote Not Found', 'This quote was not found or has already been processed.', false), { status: 404, headers: { 'Content-Type': 'text/html' } });

  // Check if already accepted
  if (quote.status === 'accepted' || quote.accepted_at) {
    return new Response(htmlPage('Already Accepted', 'Quote Already Accepted', 'This quote has already been accepted. Thank you!', true), { status: 200, headers: { 'Content-Type': 'text/html' } });
  }

  // Check if denied
  if (quote.status === 'denied' || quote.denied_at) {
    return new Response(htmlPage('Quote Declined', 'Quote Was Declined', 'This quote was previously declined.', false), { status: 400, headers: { 'Content-Type': 'text/html' } });
  }

  // Check if expired
  const validUntil = new Date(quote.valid_until);
  const now = new Date();
  if (validUntil < now) {
    return new Response(htmlPage('Quote Expired', 'Quote Expired', `This quote expired on ${quote.valid_until}. Please contact us for a new quote.`, false), { status: 400, headers: { 'Content-Type': 'text/html' } });
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
  try {
    const customerEmail = (quote.customer_email || '').toString().trim();
    const fromEmail = (env.FROM_EMAIL || env.RESEND_FROM_EMAIL || '').toString().trim();
    if (env.STRIPE_SECRET_KEY && env.RESEND_API_KEY && fromEmail && customerEmail) {
      const requestBase = new URL(request.url).origin;
      const siteBase = (env.PUBLIC_SITE_URL || 'https://www.florencemaegifts.com').replace(/\/$/, '');
      const successBase = (env.INVOICE_PAYMENT_SUCCESS_URL || `${siteBase}/invoice-payment-success.html`).replace(/\/$/, '');
      const cancelBase = (env.INVOICE_PAYMENT_CANCEL_URL || `${siteBase}/invoice-payment-cancelled.html`).replace(/\/$/, '');
      const balanceDueCents = Math.max(0, Number(total || 0));
      let paymentUrl = '';
      let sessionId = '';

      if (balanceDueCents > 0) {
        const form = new URLSearchParams();
        form.append('mode', 'payment');
        form.append('success_url', `${successBase}?invoice_id=${encodeURIComponent(String(invoiceId))}`);
        form.append('cancel_url', `${cancelBase}?invoice_id=${encodeURIComponent(String(invoiceId))}`);
        form.append('client_reference_id', `invoice:${invoiceId}`);
        form.append('customer_email', customerEmail);
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
        if (stripeRes.ok && stripeData?.url && stripeData?.id) {
          paymentUrl = stripeData.url;
          sessionId = stripeData.id;
          await env.DB.prepare(
            `UPDATE invoices SET stripe_checkout_session_id = ?1, stripe_checkout_url = ?2, stripe_payment_status = 'pending', stripe_payment_link_generated_at = datetime('now'), status = 'sent', sent_at = datetime('now'), updated_at = datetime('now') WHERE id = ?3`
          ).bind(sessionId, paymentUrl, invoiceId).run();
        }
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
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(sendPayload)
      }).catch(() => {});
    }
  } catch (_) {}

  // Send notification email to Chris
  const notifyTo = (env.TO_EMAIL || env.CONTACT_TO_EMAIL || '').toString().trim();
  const notifyFrom = (env.FROM_EMAIL || env.RESEND_FROM_EMAIL || '').toString().trim();
  if (env.RESEND_API_KEY && notifyTo && notifyFrom) {
    const notifyHtml = `<div style="font-family:Arial,sans-serif;padding:20px;"><h2 style="color:#059669;">Quote Accepted!</h2><p><strong>Quote:</strong> ${escapeHtml(quote.quote_number || `Q-${quote.id}`)}</p><p><strong>Customer:</strong> ${escapeHtml(quote.customer_name)} (${escapeHtml(quote.customer_email)})</p><p><strong>Total:</strong> ${formatUsd(total)}</p><p><strong>Invoice Created:</strong> ${invoiceNumber} (status: draft - not sent to customer yet)</p><p>Log in to the admin panel to review and send the invoice.</p></div>`;

    const notifyPayload = {
      from: notifyFrom,
      to: [notifyTo],
      subject: `Quote ${quote.quote_number || `Q-${quote.id}`} Accepted by ${quote.customer_name}`,
      html: notifyHtml,
      text: `Quote Accepted!\n\nQuote: ${quote.quote_number || `Q-${quote.id}`}\nCustomer: ${quote.customer_name} (${quote.customer_email})\nTotal: ${formatUsd(total)}\nInvoice Created: ${invoiceNumber}\n\nLog in to the admin panel to review and send the invoice.`
    };
    if (env.CC_EMAIL) notifyPayload.cc = [env.CC_EMAIL];

    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(notifyPayload)
    }).catch(() => {});
  }

  return new Response(htmlPage('Quote Accepted', 'Thank You!', "Your quote has been accepted. Please check your email inbox for your invoice and payment details.", true), { status: 200, headers: { 'Content-Type': 'text/html' } });
}

async function handleQuoteDeny(request, env, corsHeaders, url) {
  if (!env.DB) return new Response(htmlPage('Error', 'System Error', 'Database not configured.', false), { status: 500, headers: { 'Content-Type': 'text/html' } });

  const token = url.searchParams.get('token') || '';
  if (!token) return new Response(htmlPage('Invalid Link', 'Invalid Link', 'This quote link is invalid or missing a token.', false), { status: 400, headers: { 'Content-Type': 'text/html' } });

  const quote = await env.DB.prepare(`SELECT * FROM quotes WHERE deny_token = ?1`).bind(token).first();
  if (!quote) return new Response(htmlPage('Quote Not Found', 'Quote Not Found', 'This quote was not found or has already been processed.', false), { status: 404, headers: { 'Content-Type': 'text/html' } });

  // Check if already accepted
  if (quote.status === 'accepted' || quote.accepted_at) {
    return new Response(htmlPage('Quote Accepted', 'Quote Was Accepted', 'This quote has already been accepted and cannot be declined.', false), { status: 400, headers: { 'Content-Type': 'text/html' } });
  }

  // Check if already denied
  if (quote.status === 'denied' || quote.denied_at) {
    return new Response(htmlPage('Already Declined', 'Quote Already Declined', 'This quote has already been declined.', true), { status: 200, headers: { 'Content-Type': 'text/html' } });
  }

  // Check if expired
  const validUntil = new Date(quote.valid_until);
  const now = new Date();
  if (validUntil < now) {
    return new Response(htmlPage('Quote Expired', 'Quote Expired', `This quote expired on ${quote.valid_until}.`, false), { status: 400, headers: { 'Content-Type': 'text/html' } });
  }

  // Mark declined and retain record for manual admin cleanup
  await env.DB.prepare(`UPDATE quotes SET status = 'denied', denied_at = datetime('now'), updated_at = datetime('now') WHERE id = ?1`).bind(quote.id).run();

  return new Response(htmlPage('Quote Declined', 'Quote Declined', 'The quote has been declined. Thank you for letting us know. Feel free to reach out if you have any questions.', true), { status: 200, headers: { 'Content-Type': 'text/html' } });
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
  const ready = await accountingTablesReady(db);
  if (!ready) return false;
  const existing = await db.prepare(`SELECT COUNT(*) AS c FROM accounts`).first();
  if (Number(existing?.c || 0) > 0) return true;

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
    ['4000','Service Revenue','income','credit'],
    ['4900','Other Income','income','credit'],
    ['5000','Software Expense','expense','debit'],
    ['5100','Marketing Expense','expense','debit'],
    ['5200','Office Expense','expense','debit'],
    ['5300','Payment Processing Fees','expense','debit'],
    ['5400','Contractor Expense','expense','debit'],
    ['5500','Travel Expense','expense','debit'],
    ['5600','Utilities Expense','expense','debit']
  ];

  for (const s of seed) {
    await db.prepare(`INSERT INTO accounts (code, name, account_type, normal_side, is_system, active) VALUES (?1, ?2, ?3, ?4, 1, 1)`).bind(...s).run();
  }
  return true;
}

async function ensureAccountByCode(db, code, name, accountType, normalSide) {
  const existing = await db.prepare(`SELECT id FROM accounts WHERE code = ?1 LIMIT 1`).bind(code).first();
  if (existing?.id) return Number(existing.id);
  const ins = await db.prepare(`INSERT INTO accounts (code, name, account_type, normal_side, is_system, active) VALUES (?1, ?2, ?3, ?4, 1, 1)`).bind(code, name, accountType, normalSide).run();
  return Number(ins.meta?.last_row_id || 0) || null;
}

async function getAccountIdByCode(db, code) {
  const row = await db.prepare(`SELECT id FROM accounts WHERE code = ?1 LIMIT 1`).bind(code).first();
  return Number(row?.id || 0) || null;
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

async function upsertTaxExpenseJournal(db, row) {
  const accountingReady = await ensureAccountingSetup(db);
  if (!accountingReady) return;
  await deleteAutoJournalBySource(db, 'tax_expense', row.id);

  const amount = Number(row.amount_cents || 0);
  if (!Number.isFinite(amount) || amount <= 0) return;

  const expenseAccountCode = row.category === 'Payment Processing Fees' ? '5300' : '5200';
  const paidVia = (row.paid_via || '').toLowerCase();

  let offsetCode = '3100'; // default: treat as owner capital contribution
  if (paidVia.includes('stripe') || paidVia.includes('cash') || paidVia.includes('checking') || paidVia.includes('bank')) {
    offsetCode = '1000';
  } else if (paidVia.includes('business card') || paidVia.includes('corp card')) {
    offsetCode = '2100';
  }

  const debitAccountId = await getAccountIdByCode(db, expenseAccountCode);
  const creditAccountId = await getAccountIdByCode(db, offsetCode);
  if (!debitAccountId || !creditAccountId) return;

  const memo = `${row.category || 'Expense'}${row.vendor ? ` - ${row.vendor}` : ''}`;
  const ins = await db.prepare(`INSERT INTO journal_entries (entry_date, memo, source_type, source_id) VALUES (?1, ?2, 'tax_expense', ?3)`).bind(row.expense_date, memo, row.id).run();
  const entryId = Number(ins.meta?.last_row_id || 0);
  await db.prepare(`INSERT INTO journal_lines (entry_id, account_id, debit_cents, credit_cents) VALUES (?1, ?2, ?3, 0), (?1, ?4, 0, ?3)`).bind(entryId, debitAccountId, amount, creditAccountId).run();
}

async function upsertTaxIncomeJournal(db, row) {
  const accountingReady = await ensureAccountingSetup(db);
  if (!accountingReady) return;
  await deleteAutoJournalBySource(db, 'tax_income', row.id);

  const amount = Number(row.amount_cents || 0);
  if (!Number.isFinite(amount) || amount <= 0) return;

  const debitAccountId = await getAccountIdByCode(db, '1000');
  const categoryRaw = (row.category || '').toString().trim().toLowerCase();
  const sourceRaw = (row.source || '').toString().trim().toLowerCase();
  const isOwnerFunded = Number(row.is_owner_funded || 0) === 1 || categoryRaw.includes('owner funded') || categoryRaw.includes('non-revenue') || sourceRaw.includes('owner funded') || sourceRaw.includes('test');
  const creditAccountCode = isOwnerFunded ? '3100' : '4000';
  const creditAccountId = await getAccountIdByCode(db, creditAccountCode);
  if (!debitAccountId || !creditAccountId) return;

  const memo = `${row.category || 'Income'}${row.source ? ` - ${row.source}` : ''}`;
  const ins = await db.prepare(`INSERT INTO journal_entries (entry_date, memo, source_type, source_id) VALUES (?1, ?2, 'tax_income', ?3)`).bind(row.income_date, memo, row.id).run();
  const entryId = Number(ins.meta?.last_row_id || 0);
  await db.prepare(`INSERT INTO journal_lines (entry_id, account_id, debit_cents, credit_cents) VALUES (?1, ?2, ?3, 0), (?1, ?4, 0, ?3)`).bind(entryId, debitAccountId, amount, creditAccountId).run();
}

/**
 * Fetch Stripe fee (in cents) for a payment intent id.
 * Returns 0 if not found.
 */
async function fetchStripeFeeCents(stripeSecretKey, paymentIntentId) {
  if (!stripeSecretKey || !paymentIntentId) return 0;

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const url = `https://api.stripe.com/v1/payment_intents/${encodeURIComponent(paymentIntentId)}?expand[]=latest_charge.balance_transaction`;
    const piRes = await fetch(url, {
      headers: { Authorization: `Bearer ${stripeSecretKey}` }
    });
    const pi = await piRes.json().catch(() => ({}));
    if (!piRes.ok) {
      if (attempt < 2) await wait(1200);
      continue;
    }

    const latestCharge = pi?.latest_charge;
    const bt = (latestCharge && typeof latestCharge === 'object') ? latestCharge.balance_transaction : null;
    const feeExpanded = Number(bt?.fee || 0);
    if (Number.isFinite(feeExpanded) && feeExpanded > 0) return feeExpanded;

    const chargeId = typeof latestCharge === 'string' ? latestCharge : latestCharge?.id;
    if (chargeId) {
      const chRes = await fetch(`https://api.stripe.com/v1/charges/${encodeURIComponent(chargeId)}`, {
        headers: { Authorization: `Bearer ${stripeSecretKey}` }
      });
      const ch = await chRes.json().catch(() => ({}));
      if (chRes.ok) {
        const btId = ch?.balance_transaction;
        if (btId) {
          const btRes = await fetch(`https://api.stripe.com/v1/balance_transactions/${encodeURIComponent(btId)}`, {
            headers: { Authorization: `Bearer ${stripeSecretKey}` }
          });
          const btObj = await btRes.json().catch(() => ({}));
          const fee = Number(btObj?.fee || 0);
          if (btRes.ok && Number.isFinite(fee) && fee > 0) return fee;
        }
      }
    }

    if (attempt < 2) await wait(1200);
  }

  return 0;
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
  const parts = Object.fromEntries(
    stripeSignature
      .split(',')
      .map(p => p.split('=').map(x => x.trim()))
      .filter(pair => pair.length === 2)
  );

  const timestamp = parts.t;
  const expected = parts.v1;
  if (!timestamp || !expected) return { ok: false };

  const signedPayload = `${timestamp}.${payload}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(webhookSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signedPayload));
  const computed = [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');

  // timing-safe enough for this context with fixed length compare
  if (computed.length !== expected.length) return { ok: false };
  let mismatch = 0;
  for (let i = 0; i < computed.length; i++) mismatch |= computed.charCodeAt(i) ^ expected.charCodeAt(i);
  return { ok: mismatch === 0 };
}

/** @param {Object} payload @param {number} [status=200] @param {Object} [headers] @returns {Response} */
function json(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers }
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
