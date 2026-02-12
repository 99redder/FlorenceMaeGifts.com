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
  form.set("success_url", env.SUCCESS_URL || "https://www.florencemaegifts.com/shop.html?checkout=success");
  form.set("cancel_url", "https://www.florencemaegifts.com/index.html");
  form.set("line_items[0][price]", priceId);
  form.set("line_items[0][quantity]", "1");
  form.set("custom_text[shipping_address][message]", "Please allow 3-5 calendar days for processing before the item ships unless Rush Processing is selected at checkout.");

  // Collect shipping details and offer shipping choices for physical items.
  if (!isDigitalItem) {
    form.set("shipping_address_collection[allowed_countries][0]", "US");

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
    case "checkout.session.completed":
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
