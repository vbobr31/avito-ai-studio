# Avito AI Studio — Telegram bot on Cloudflare Workers

This is the **first runnable milestone**, not the completed Avito integration. It handles the Telegram webhook, /start, interactive main menu and owner-only access. Avito API, AI-generated images and texts, product storage, and message synchronization are planned but are **not working yet**.

## Deploy

Cloudflare Workers & Pages → `avito-ai-studio` → connect GitHub repository `vbobr31/avito-ai-studio` (branch `main`).

Build command: `npm run check` (or leave empty for the first test).
Deploy command: `npx wrangler deploy`.
Root directory: `/`. Node.js 20+.

In **Settings → Variables and Secrets → Production**, set these as **Secret**, never as public/plain variables:

- `TELEGRAM_BOT_TOKEN`: token from @BotFather
- `TELEGRAM_WEBHOOK_SECRET`: a long random string consisting of `A-Z`, `a-z`, `0-9`, `_`, `-` (e.g. generate locally)
- `ADMIN_TELEGRAM_ID`: the owner's numeric Telegram user ID, not the bot username

Deploy, then open your Worker URL root, which should say `Avito AI Studio Worker: online`.

Register the webhook **from your own local terminal**, with your own secret values. Do not post a real token in screenshots, logs or chat.

```bash
curl -sS -X POST "https://api.telegram.org/botYOUR_BOT_TOKEN/setWebhook" \
  --data-urlencode "url=https://avito-ai-studio.YOUR_SUBDOMAIN.workers.dev/telegram" \
  --data-urlencode "secret_token=YOUR_TELEGRAM_WEBHOOK_SECRET" \
  --data-urlencode 'allowed_updates=["message","callback_query"]'
```

After this, send `/start` to `@AvitoAIStudio_Bot`. If no response, check Worker logs and Telegram `getWebhookInfo`.

## Agreed business rules (future Avito integration)

- Basic questions: automated response only when verified information is available
- Discounts: never offered automatically; require owner approval
- Notifications: every incoming and outgoing message
- Studio photos: fresh per listing; option for generated model, own model photo, or no model
- Publishing to Avito: only on explicit approval and if authorized by official Avito APIs

## Security

No API secrets in GitHub. Restrict access with `ADMIN_TELEGRAM_ID`. Do not change or delete other Cloudflare Workers. Do not claim Avito publication without API confirmation.
