# Cloudflare Stripe API (FMG)

## 1) Install + login

- `npm i -g wrangler`
- `wrangler login`

## 2) Set secrets

- `wrangler secret put STRIPE_SECRET_KEY`
- `wrangler secret put STRIPE_WEBHOOK_SECRET`
- `wrangler secret put RESEND_API_KEY`

## 3) Create KV namespace for one-time download tokens

- `wrangler kv namespace create DOWNLOAD_TOKENS`
- Copy the returned namespace id into `wrangler.toml`:
  - `[[kv_namespaces]]`
  - `binding = "DOWNLOAD_TOKENS"`
  - `id = "<your-id>"`

## 4) Deploy

- `wrangler deploy`

## 5) Route production URL

In Cloudflare dashboard, add Worker route:
- `www.florencemaegifts.com/api/*` -> this worker

## 6) Stripe endpoint URL

Set webhook endpoint in Stripe to:
- `https://www.florencemaegifts.com/api/stripe-webhook`

## 7) Digital download email receipts (optional but recommended)

When a checkout completes for an item in `DOWNLOAD_FILE_MAP`, the webhook sends a one-time download link email using Resend.

Required:
- `RESEND_API_KEY` secret (set with Wrangler)
- `RESEND_FROM_EMAIL` var in `wrangler.toml` (must be a verified sender/domain in Resend)

## 8) Test endpoint

- `curl https://www.florencemaegifts.com/api/health`
