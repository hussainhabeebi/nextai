# Go-live checklist: WhatsApp, mobile app, email reports, admin

Follow this top to bottom. Each section ends with a check you can do before moving on.
Hostnames: API `api.nextaierp.com`, app + admin `app.nextaierp.com`, Chatwoot `app.aiingo.com`.

---

## 0. Server and secrets (15 min)

1. On the server, copy `.env.example` to `.env` and fill in at least:

   ```ini
   NODE_ENV=production
   APP_URL=https://app.nextaierp.com
   API_URL=https://api.nextaierp.com
   CORS_ORIGINS=https://app.nextaierp.com
   ENCRYPTION_KEY=<node -e "console.log(require('crypto').randomBytes(32).toString('base64'))">
   JWT_SECRET=<openssl rand -base64 48>
   JWT_REFRESH_SECRET=<openssl rand -base64 48>
   CHATWOOT_BASE_URL=https://app.aiingo.com
   CHATWOOT_WEBHOOK_SECRET=<openssl rand -hex 24>
   CHATWOOT_ALLOWED_IPS=<public IP of the app.aiingo.com server>
   ADMIN_BOOTSTRAP_EMAIL=<your admin email>
   ADMIN_BOOTSTRAP_PASSWORD=<strong password>
   # Email reports — see section 3
   RESEND_API_KEY=
   MAIL_FROM=NextAi Reports <reports@nextaierp.com>
   ADMIN_REPORT_EMAILS=<you@company.com>
   # AI — without these, bills are not read (mock mode)
   AI_VISION_PROVIDER=anthropic
   AI_VISION_API_KEY=...
   AI_LLM_PROVIDER=anthropic
   AI_LLM_API_KEY=...
   ```

   > **`CHATWOOT_ALLOWED_IPS` is required in production.** If it is empty, the API rejects every
   > Chatwoot webhook with 403 and WhatsApp messages never reach NextAi. Get the IP with
   > `dig +short app.aiingo.com` (if Chatwoot is behind Cloudflare, use the origin server's egress IP,
   > i.e. run `curl -s ifconfig.me` on the Chatwoot server).

2. Start the stack:

   ```bash
   POSTGRES_PASSWORD=... NEXTAI_APP_PASSWORD=... docker compose -f infra/docker-compose.yml up -d --build
   # once, from a checkout that can reach Postgres (plans, WhatsApp templates, first super_admin):
   DATABASE_MIGRATE_URL=postgresql://nextai:<POSTGRES_PASSWORD>@<db-host>:5432/nextai pnpm db:seed
   ```

3. Cloudflare Tunnel: `api.nextaierp.com → http://localhost:8090`, `app.nextaierp.com → http://localhost:3010`.

**Check:** `curl -i https://api.nextaierp.com/readyz` returns HTTP 200, and
`https://app.nextaierp.com/admin` shows the admin login.

---

## 1. Admin console (10 min)

1. Open `https://app.nextaierp.com/admin/login`, sign in with `ADMIN_BOOTSTRAP_EMAIL` / password.
2. Scan the QR code with Google Authenticator / 1Password (TOTP is mandatory) and enter the code.
3. **Admin users** → add your reviewers (`reviewer`: review queue) and support staff (`support`: tenants,
   integrations, impersonation). Each gets a temporary password shown once; they enrol TOTP on first login.
4. **Integrations** (new page) shows the status of Chatwoot, Resend, Stripe, R2, AI providers and the
   mobile app URL. Anything amber needs setup.

**Check:** Admin → Integrations loads and the Chatwoot card is green (not "webhooks rejected").

---

## 2. WhatsApp via Chatwoot (`app.aiingo.com`) (20–30 min per number)

You need, per business (tenant): a **WhatsApp inbox** in Chatwoot, its **Account ID** and **Inbox ID**, and a
**token**. NextAi can create the Agent Bot for you (automatic) or you can paste a bot token (manual).

### 2.1 Create the WhatsApp inbox in Chatwoot

1. Log in to `https://app.aiingo.com` as an **administrator**.
2. **Settings → Inboxes → Add Inbox → WhatsApp**. Choose **WhatsApp Cloud** and enter, from
   Meta Business Manager → WhatsApp → API Setup: phone number, **Phone number ID**, **Business Account ID**
   and a **permanent System User access token** (not the 24-hour temporary token).
3. Finish the wizard and copy the **webhook callback URL + verify token** Chatwoot shows into Meta
   (WhatsApp → Configuration → Webhook), subscribe to `messages`.
4. Note the ids from the browser address bar:
   - Account ID: `https://app.aiingo.com/app/accounts/`**`3`**`/...`
   - Inbox ID: open the inbox settings: `.../settings/inboxes/`**`12`**

### 2.2 Approve WhatsApp message templates in Meta

Business-initiated messages (OTP, invoices, reminders, daily summary) outside the 24-hour window only
deliver as **approved templates**. In Meta → WhatsApp Manager → Message templates, create (language English):

| Template name             | Category       | Body variables                                |
| ------------------------- | -------------- | --------------------------------------------- |
| `nextai_otp`              | Authentication | `{{1}}` code                                  |
| `nextai_invoice`          | Utility        | party, business, invoice no, amount, due date |
| `nextai_receipt`          | Utility        | party, business, amount, ref                  |
| `nextai_payment_reminder` | Utility        | party, business, amount, invoice no, due date |
| `nextai_daily_summary`    | Utility        | sales, expenses, cash, pending                |
| `nextai_billing_notice`   | Utility        | business, link                                |
| `nextai_draft_ready`      | Utility        | summary                                       |

Approval usually takes minutes to a few hours. Until then, messages only deliver to numbers that wrote to
the inbox in the last 24 hours — fine for testing with your own phone. After approval, in Chatwoot open
the inbox → **Settings → Sync templates**. Template names/params can be edited in Admin → Templates.

### 2.3 Connect the inbox to the tenant

Create the tenant first (Admin → **Provision**) if it does not exist. Then Admin → **Integrations** →
open the tenant → **Chatwoot / WhatsApp**:

**Option A — automatic (recommended).**

1. In Chatwoot: avatar → **Profile settings → Access Token** → copy it (your administrator token).
2. Enter **Account ID**, paste the token, click **Find inboxes**, click your WhatsApp inbox (fills
   **Inbox ID**), then **Connect inbox**.
3. NextAi creates (or reuses) an Agent Bot called _NextAi Accountant_, points its outgoing URL at
   `https://api.nextaierp.com/webhooks/chatwoot?token=<CHATWOOT_WEBHOOK_SECRET>`, assigns it to the inbox,
   verifies it and stores the **bot** token encrypted. Your administrator token is used once and not stored.

**Option B — manual.**

1. Chatwoot → **Settings → Bots → Add Bot**: name `NextAi Accountant`, webhook URL
   `https://api.nextaierp.com/webhooks/chatwoot?token=<CHATWOOT_WEBHOOK_SECRET>` (the real secret from `.env`).
2. Open the bot, copy its **Access Token**.
3. Chatwoot → **Settings → Inboxes → your WhatsApp inbox → Bot configuration** → select the bot → Save.
4. In NextAi, choose **Bot token (manual)**, enter Account ID, Inbox ID and the bot token, **Connect inbox**.

NextAi rejects an inbox that is already connected to another tenant (one inbox = one business).

### 2.4 Test

1. From your phone, send "hi" to the business WhatsApp number (this opens the 24-hour window).
2. Admin → Integrations → tenant → **Verify token** → "Bot token OK".
3. Enter your number → **Send test message** → you receive "NextAi is connected…".
4. Send a photo of a bill → within a minute you get the extracted summary with Confirm / Edit / Cancel.

If nothing arrives: check `docker compose logs core | grep chatwoot`. 403 = wrong
`CHATWOOT_ALLOWED_IPS`; 401 = wrong `?token=`; `unknown_inbox` = Inbox ID mismatch.

---

## 3. Email reports with Resend (15 min + DNS propagation)

1. Sign up at **resend.com** → **Domains → Add domain** → `nextaierp.com` (or a subdomain such as
   `mail.nextaierp.com`). Add the SPF/DKIM (and optional DMARC) DNS records it shows in Cloudflare DNS
   (set them to **DNS only**, grey cloud). Wait until the domain shows **Verified**.
2. **API Keys → Create** with _Sending access_, restricted to that domain. Put it in `.env`:

   ```ini
   RESEND_API_KEY=re_...
   MAIL_FROM=NextAi Reports <reports@nextaierp.com>   # must be on the verified domain
   MAIL_REPLY_TO=support@nextaierp.com                # optional
   ADMIN_REPORT_EMAILS=you@company.com,ops@company.com
   ```

3. Restart: `docker compose -f infra/docker-compose.yml up -d core worker`.
4. Admin → Integrations → **Send test** to your address, then **Send platform report now**.

What gets sent:

- **Daily summary** (per tenant) at the tenant's summary hour (default 20:00 local): sales, expenses,
  cash & bank, pending approvals. Goes to every **owner with an email** plus **Extra recipients**
  (e.g. the accountant) set in Admin → Integrations → tenant → _Email reports_. Sent at most once a day;
  **Send today's summary now** re-sends on demand. WhatsApp summary keeps working as before.
- **Platform report** every day at 04:10 UTC (08:10 Dubai, 09:40 India) to `ADMIN_REPORT_EMAILS`:
  tenants, entries posted, review queue, WhatsApp sent/failed, monthly usage and AI cost, failed jobs.
  The subject gets a ⚠ when something needs attention.

**Check:** the test email arrives (not in spam), and the Email card is green.

---

## 4. Mobile app (PWA) (10 min)

The mobile app is the installable web app at `https://app.nextaierp.com` (offline shell, camera capture,
home-screen icon). No app-store submission is needed to go live today.

1. Make sure the web image was built with `NEXT_PUBLIC_API_URL=https://api.nextaierp.com` (set in
   `infra/docker-compose.yml`) and `CORS_ORIGINS=https://app.nextaierp.com` is set for core.
2. Owner logs in with their WhatsApp number → receives the OTP on WhatsApp (needs section 2 done and the
   `nextai_otp` template approved, or a message to the inbox in the last 24h).
3. Install:
   - **iPhone (Safari):** Share → **Add to Home Screen**.
   - **Android (Chrome):** ⋮ → **Install app** (or the install banner).
4. Share a short message with customers, e.g.
   "Open app.nextaierp.com on your phone, log in with your WhatsApp number, then Add to Home Screen."

**Check:** on a phone, log in, take a photo in **Capture**, approve it in **Approvals**, and see it in
**Purchases**.

> Play Store / App Store listing is a later step (wrap the PWA with a Trusted Web Activity for Android
> or Capacitor for iOS); it is not required for launch.

---

## 5. Final go-live run (10 min)

- [ ] `/readyz` OK, Admin → **System health** all green.
- [ ] Admin → **Integrations**: Chatwoot, Email, AI cards green.
- [ ] For each launch tenant: inbox connected, **Verify token** OK, test WhatsApp received.
- [ ] Bill photo on WhatsApp → draft → Confirm → posted in ERPNext.
- [ ] OTP login on a phone works; PWA installed.
- [ ] Test email and platform report received.
- [ ] Admin → **Jobs**: no failed jobs.
