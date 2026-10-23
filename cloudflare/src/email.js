// Outgoing email. Sends through Cloudflare Email Sending (the EMAIL binding in
// wrangler.toml) and falls back to Resend when Cloudflare fails or isn't bound,
// so an outage or a quota limit on one provider never loses an email.
//
// Callers build a Resend-style payload — { from, to, cc, bcc, reply_to, subject,
// html, text, attachments, headers } — and get back a Response shaped like
// Resend's: 200 with { id, provider } when it sent, otherwise an error status
// whose JSON body carries `message`.
//
// This file is shared word for word by just-in-case, eastern-shore-ai/worker
// and FlorenceMaeGifts.com/cloudflare. Change all three together.

const RESEND_URL = 'https://api.resend.com/emails';

export function emailConfigured(env) {
  return Boolean(env?.EMAIL || env?.RESEND_API_KEY);
}

export async function sendEmail(env, payload, { idempotencyKey = '' } = {}) {
  let cloudflareError = null;
  if (env?.EMAIL) {
    try {
      const result = await env.EMAIL.send(toCloudflareMessage(payload));
      return Response.json({ id: result?.messageId || null, provider: 'cloudflare' });
    } catch (err) {
      cloudflareError = err;
      console.error('Cloudflare email send failed:', err?.code || '', err?.message || String(err), '| subject:', payload?.subject || '');
    }
  }

  if (env?.RESEND_API_KEY) {
    const res = await fetch(RESEND_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {})
      },
      body: JSON.stringify(payload)
    });
    if (cloudflareError) console.warn(`Resend fallback ${res.ok ? 'sent' : 'also failed'} (HTTP ${res.status}) | subject: ${payload?.subject || ''}`);
    return res;
  }

  const message = cloudflareError
    ? `${cloudflareError.code || 'E_UNKNOWN'}: ${cloudflareError.message || 'Cloudflare email send failed'}`
    : 'No email provider is configured';
  return Response.json({ name: cloudflareError?.code || 'not_configured', message, error: message }, { status: cloudflareError ? 502 : 500 });
}

// Resend payload → Cloudflare `EMAIL.send()` message.
export function toCloudflareMessage(payload = {}) {
  const message = {
    from: parseAddress(payload.from),
    to: addressList(payload.to),
    subject: String(payload.subject || '')
  };
  const cc = addressList(payload.cc);
  if (cc.length) message.cc = cc;
  const bcc = addressList(payload.bcc);
  if (bcc.length) message.bcc = bcc;
  const replyTo = addressList(payload.reply_to)[0];
  if (replyTo) message.replyTo = replyTo;
  if (payload.html) message.html = String(payload.html);
  if (payload.text) message.text = String(payload.text);
  if (payload.headers && Object.keys(payload.headers).length) message.headers = { ...payload.headers };
  if (Array.isArray(payload.attachments) && payload.attachments.length) {
    message.attachments = payload.attachments.map((a) => ({
      filename: a.filename,
      content: a.content,
      type: a.content_type || a.contentType || a.type || 'application/octet-stream',
      disposition: 'attachment'
    }));
  }
  return message;
}

// "Name <addr@example.com>" → { email, name }; a bare address stays a string.
export function parseAddress(value) {
  if (value && typeof value === 'object') return value;
  const raw = String(value || '').trim();
  const match = raw.match(/^(.*)<\s*([^<>\s]+@[^<>\s]+)\s*>$/);
  if (!match) return raw;
  const name = match[1].trim().replace(/^"(.*)"$/, '$1').trim();
  return name ? { email: match[2], name } : match[2];
}

function addressList(value) {
  const list = Array.isArray(value) ? value : (value ? [value] : []);
  return list.map(parseAddress).filter((a) => (typeof a === 'string' ? a : a?.email));
}
