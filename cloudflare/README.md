# Cloudflare Stripe API (FMG)

## 1) Install + login

- `npm i -g wrangler`
- `wrangler login`

## 2) Set secrets

- `wrangler secret put STRIPE_SECRET_KEY`
- `wrangler secret put STRIPE_WEBHOOK_SECRET`
- `wrangler secret put RESEND_API_KEY`

## 3) Deploy

- `wrangler deploy`

## 4) Route production URL

In Cloudflare dashboard, add Worker route:
- `www.florencemaegifts.com/api/*` -> this worker

## 5) Stripe endpoint URL

Set webhook endpoint in Stripe to:
- `https://www.florencemaegifts.com/api/stripe-webhook`

## 6) Digital download email receipts (optional but recommended)

When a checkout completes for an item in `DOWNLOAD_LINK_MAP`, the webhook sends a separate email with the download link using Resend.

Required:
- `RESEND_API_KEY` secret (set with Wrangler)
- `RESEND_FROM_EMAIL` var in `wrangler.toml` (must be a verified sender/domain in Resend)

## 7) Test endpoint

- `curl https://www.florencemaegifts.com/api/health`
