# Cloudflare Stripe API (FMG)

## 1) Install + login

- `npm i -g wrangler`
- `wrangler login`

## 2) Set secrets

- `wrangler secret put STRIPE_SECRET_KEY`
- `wrangler secret put STRIPE_WEBHOOK_SECRET`

## 3) Deploy

- `wrangler deploy`

## 4) Route production URL

In Cloudflare dashboard, add Worker route:
- `www.florencemaegifts.com/api/*` -> this worker

## 5) Stripe endpoint URL

Set webhook endpoint in Stripe to:
- `https://www.florencemaegifts.com/api/stripe-webhook`

## 6) Test endpoint

- `curl https://www.florencemaegifts.com/api/health`
