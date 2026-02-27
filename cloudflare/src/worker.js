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
      const isAccountsRead = ['/api/accounts/list','/api/accounts/summary','/api/accounts/journal','/api/accounts/statements'].includes(url.pathname) && request.method === 'GET';
      const isAccountsWrite = ['/api/accounts/journal','/api/accounts/rebuild-auto-journal','/api/accounts/year-close'].includes(url.pathname) && request.method === 'POST';
      const isPostRoute = ['/api/contact', '/api/checkout-session', '/api/zombie-bag-checkout'].includes(url.pathname) && request.method === 'POST';
      if (!isBookingsRead && !isAvailabilityRead && !isAdminBlockWrite && !isTaxRead && !isTaxWrite && !isAccountsRead && !isAccountsWrite && !isPostRoute) {
        return json({ ok: false, error: 'Method not allowed' }, 405, corsHeaders);
      }

      if (!originAllowed) {
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

    if (url.pathname === '/api/accounts/journal' && request.method === 'POST') {
      return handleAccountsJournalCreate(request, env, corsHeaders, url);
    }

    if (url.pathname === '/api/accounts/rebuild-auto-journal' && request.method === 'POST') {
      return handleAccountsRebuildAutoJournal(request, env, corsHeaders, url);
    }

    if (url.pathname === '/api/accounts/year-close' && request.method === 'POST') {
      return handleAccountsYearClose(request, env, corsHeaders, url);
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

  const siteOrigin = originAllowed ? (request.headers.get('Origin') || '') : (allowedOrigins[0] || 'https://easternshore.ai');
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

  const siteOrigin = originAllowed ? (request.headers.get('Origin') || '') : (allowedOrigins[0] || 'https://easternshore.ai');
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
  const filename = `florence-mae-gifts-tax-${year}-${type}.csv`;

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
  const piRes = await fetch(`https://api.stripe.com/v1/payment_intents/${encodeURIComponent(paymentIntentId)}`, {
    headers: { Authorization: `Bearer ${stripeSecretKey}` }
  });
  const pi = await piRes.json().catch(() => ({}));
  if (!piRes.ok) return 0;

  const chargeId = pi?.latest_charge;
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
  const bt = await btRes.json().catch(() => ({}));
  if (!btRes.ok) return 0;

  const fee = Number(bt?.fee || 0);
  return Number.isFinite(fee) && fee > 0 ? fee : 0;
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
