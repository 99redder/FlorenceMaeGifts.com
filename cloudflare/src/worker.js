export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(env) });
    }

    if (url.pathname === "/api/health") {
      return json({ ok: true }, 200, env);
    }

    if (url.pathname === "/api/create-checkout-session" && request.method === "POST") {
      return handleCreateCheckoutSession(request, env);
    }

    if (url.pathname === "/api/checkout-session-details" && request.method === "GET") {
      return handleCheckoutSessionDetails(request, env);
    }

    if (url.pathname === "/api/stripe-webhook" && request.method === "POST") {
      return handleStripeWebhook(request, env);
    }

    return json({ error: "Not found" }, 404, env);
  },
};

async function handleCreateCheckoutSession(request, env) {
  if (!env.STRIPE_SECRET_KEY) return json({ error: "Missing STRIPE_SECRET_KEY" }, 500, env);

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400, env);
  }

  const customerName = (payload.customerName || "").trim();
  const customerEmail = (payload.customerEmail || "").trim();
  const selectedItemName = (payload.selectedItemName || "").trim();
  const orderNotes = (payload.orderNotes || "").trim();
  const incomingPriceId = (payload.priceId || "").trim();
  const isDigitalItem = selectedItemName.toLowerCase().includes("pdf download");

  const priceId = resolvePriceId(incomingPriceId, selectedItemName, env);
  if (!priceId) return json({ error: "Missing Stripe price id" }, 400, env);

  const form = new URLSearchParams();
  form.set("mode", "payment");
  form.set("success_url", "https://www.florencemaegifts.com/index.html?checkout=success&session_id={CHECKOUT_SESSION_ID}");
  form.set("cancel_url", "https://www.florencemaegifts.com/index.html");
  form.set("line_items[0][price]", priceId);
  form.set("line_items[0][quantity]", "1");

  // Collect shipping details and offer shipping choices for physical items.
  if (!isDigitalItem) {
    form.set("shipping_address_collection[allowed_countries][0]", "US");
    form.set("custom_text[shipping_address][message]", "Please allow 3-5 calendar days for processing before the item ships unless Rush Processing is selected at checkout.");

    form.set("shipping_options[0][shipping_rate_data][type]", "fixed_amount");
    form.set("shipping_options[0][shipping_rate_data][fixed_amount][amount]", "0");
    form.set("shipping_options[0][shipping_rate_data][fixed_amount][currency]", "usd");
    form.set("shipping_options[0][shipping_rate_data][display_name]", "Standard Shipping (3–5 business days)");

    form.set("shipping_options[1][shipping_rate_data][type]", "fixed_amount");
    form.set("shipping_options[1][shipping_rate_data][fixed_amount][amount]", "499");
    form.set("shipping_options[1][shipping_rate_data][fixed_amount][currency]", "usd");
    form.set("shipping_options[1][shipping_rate_data][display_name]", "Priority Shipping (2-3 business days)");

    form.set("shipping_options[2][shipping_rate_data][type]", "fixed_amount");
    form.set("shipping_options[2][shipping_rate_data][fixed_amount][amount]", "1999");
    form.set("shipping_options[2][shipping_rate_data][fixed_amount][currency]", "usd");
    form.set("shipping_options[2][shipping_rate_data][display_name]", "Rush Processing (24 hours) + Priority Shipping");
  }

  if (customerEmail) form.set("customer_email", customerEmail);

  if (customerName) form.set("metadata[customer_name]", customerName);
  if (selectedItemName) form.set("metadata[selected_item_name]", selectedItemName);
  if (orderNotes) form.set("metadata[order_notes]", orderNotes.slice(0, 450));

  const stripeRes = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form,
  });

  const stripeJson = await stripeRes.json();
  if (!stripeRes.ok) return json({ error: stripeJson.error?.message || "Stripe error" }, 400, env);

  return json({ id: stripeJson.id, url: stripeJson.url }, 200, env);
}

async function handleCheckoutSessionDetails(request, env) {
  if (!env.STRIPE_SECRET_KEY) return json({ error: "Missing STRIPE_SECRET_KEY" }, 500, env);

  const url = new URL(request.url);
  const sessionId = (url.searchParams.get("session_id") || "").trim();
  if (!sessionId || !sessionId.startsWith("cs_")) {
    return json({ error: "Missing or invalid session_id" }, 400, env);
  }

  const stripeRes = await fetch(`https://api.stripe.com/v1/checkout/sessions/${sessionId}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
  });

  const stripeJson = await stripeRes.json();
  if (!stripeRes.ok) return json({ error: stripeJson.error?.message || "Stripe error" }, 400, env);

  const itemName = (stripeJson.metadata?.selected_item_name || "").trim();
  const isDigital = itemName.toLowerCase().includes("pdf download");
  const downloadUrl = isDigital ? resolveDownloadUrl(itemName, env) : "";

  return json(
    {
      paid: stripeJson.payment_status === "paid",
      itemName,
      isDigital,
      downloadUrl,
    },
    200,
    env
  );
}

async function handleStripeWebhook(request, env) {
  if (!env.STRIPE_WEBHOOK_SECRET) {
    return json({ error: "Missing STRIPE_WEBHOOK_SECRET" }, 500, env);
  }

  const signature = request.headers.get("stripe-signature");
  if (!signature) return json({ error: "Missing stripe-signature header" }, 400, env);

  const rawBody = await request.text();
  const valid = await verifyStripeSignature(rawBody, signature, env.STRIPE_WEBHOOK_SECRET);
  if (!valid) return json({ error: "Invalid webhook signature" }, 400, env);

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return json({ error: "Invalid webhook payload" }, 400, env);
  }

  switch (event.type) {
    case "checkout.session.completed": {
      console.log("Stripe webhook event:", event.type, event.id);
      await maybeSendDigitalDownloadEmail(event, env);
      break;
    }
    case "checkout.session.async_payment_succeeded":
    case "checkout.session.async_payment_failed": {
      console.log("Stripe webhook event:", event.type, event.id);
      break;
    }
    default:
      break;
  }

  return json({ received: true }, 200, env);
}

async function maybeSendDigitalDownloadEmail(event, env) {
  try {
    if (!env.RESEND_API_KEY || !env.RESEND_FROM_EMAIL) return;
    const session = event?.data?.object;
    if (!session || session.object !== "checkout.session") return;

    const itemName = (session.metadata?.selected_item_name || "").trim();
    if (!itemName) return;

    const downloadUrl = resolveDownloadUrl(itemName, env);
    if (!downloadUrl) return;

    const email = (session.customer_details?.email || session.customer_email || "").trim();
    if (!email) return;

    await sendDigitalDownloadEmail({
      toEmail: email,
      itemName,
      downloadUrl,
      sessionId: session.id || "",
      env,
    });
  } catch (err) {
    console.error("Digital download email error:", err?.message || String(err));
  }
}

async function sendDigitalDownloadEmail({ toEmail, itemName, downloadUrl, sessionId, env }) {
  const supportEmail = env.SUPPORT_EMAIL || env.RESEND_FROM_EMAIL;
  const subject = `Your Florence Mae Gifts download: ${itemName}`;
  const htmlBody = `
    <div style="font-family:Arial,sans-serif;line-height:1.5;color:#111;max-width:640px;margin:0 auto;">
      <h2 style="margin:0 0 12px 0;">Thank you for your purchase 💖</h2>
      <p>Your digital download is ready:</p>
      <p><strong>${escapeHtml(itemName)}</strong></p>
      <p style="margin:18px 0;">
        <a href="${escapeHtml(downloadUrl)}" style="background:#FE6666;color:#fff;text-decoration:none;padding:10px 16px;border-radius:6px;display:inline-block;">Download your file</a>
      </p>
      <p style="font-size:13px;color:#444;">If the button doesn't work, copy and paste this link into your browser:</p>
      <p style="font-size:13px;word-break:break-all;"><a href="${escapeHtml(downloadUrl)}">${escapeHtml(downloadUrl)}</a></p>
      ${sessionId ? `<p style="font-size:12px;color:#666;">Order reference: ${escapeHtml(sessionId)}</p>` : ""}
      <p style="font-size:12px;color:#666;">Need help? Reply to this email or contact ${escapeHtml(supportEmail)}.</p>
    </div>
  `;

  const payload = {
    from: env.RESEND_FROM_EMAIL,
    to: [toEmail],
    subject,
    html: htmlBody,
  };

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const msg = await response.text();
    throw new Error(`Resend send failed (${response.status}): ${msg}`);
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function verifyStripeSignature(rawBody, stripeSignatureHeader, webhookSecret) {
  const parsed = parseStripeSignatureHeader(stripeSignatureHeader);
  if (!parsed.timestamp || parsed.signatures.length === 0) return false;

  // Stripe default tolerance: 300 seconds.
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parsed.timestamp) > 300) return false;

  const signedPayload = `${parsed.timestamp}.${rawBody}`;
  const expectedSig = await hmacSha256Hex(webhookSecret, signedPayload);

  return parsed.signatures.some((sig) => secureCompare(sig, expectedSig));
}

function parseStripeSignatureHeader(header) {
  const parts = header.split(",").map((p) => p.trim());
  let timestamp = 0;
  const signatures = [];

  for (const part of parts) {
    const [k, v] = part.split("=");
    if (!k || !v) continue;
    if (k === "t") timestamp = Number(v);
    if (k === "v1") signatures.push(v);
  }

  return { timestamp, signatures };
}

async function hmacSha256Hex(secret, payload) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const sigBuffer = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  return [...new Uint8Array(sigBuffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function secureCompare(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

function resolvePriceId(incomingPriceId, selectedItemName, env) {
  if (incomingPriceId && incomingPriceId.startsWith("price_")) return incomingPriceId;

  if (!env.ITEM_PRICE_MAP || !selectedItemName) return "";
  try {
    const map = JSON.parse(env.ITEM_PRICE_MAP);
    return map[selectedItemName] || "";
  } catch {
    return "";
  }
}

function resolveDownloadUrl(selectedItemName, env) {
  if (!selectedItemName || !env.DOWNLOAD_LINK_MAP) return "";
  try {
    const map = JSON.parse(env.DOWNLOAD_LINK_MAP);
    return map[selectedItemName] || "";
  } catch {
    return "";
  }
}

function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
  };
}

function json(data, status = 200, env) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(env),
    },
  });
}
