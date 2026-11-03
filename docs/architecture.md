# NextAi architecture

## Components

```
 WhatsApp ──► Chatwoot (app.aiingo.com) ──Agent Bot webhook──► core (Fastify, api.nextaierp.com)
                    ▲                                              │  ├─ Postgres 16 (Prisma, RLS)
                    └──────── replies / templates / files ◄────────┤  ├─ Redis 7 (state, queues, rate limits)
                                                                   │  └─ R2 (tenants/{id}/... , signed URLs)
 PWA / admin (Next.js, app.nextaierp.com) ──/v1, /admin/v1──►      │
                                                                   ▼
                                           worker (BullMQ) ──► ERPNext site per tenant (clientN.nextaierp.com)
                                                     ▲              │ on_submit webhooks (HMAC)
 Stripe ──/webhooks/stripe──► core                   └──────────────┘
 provisioner (ERPNext host, private) ◄── core admin wizard (HMAC-signed, whitelisted bench ops)
```

`apps/core` is both the API server and a library (`@nextai/core`) whose job handlers the worker imports,
so business logic lives in one place. Side effects go through a `Container` (Prisma, Redis, storage, AI,
queue, conversation store, ERPNext/Chatwoot client factories, payment provider, provisioner), which tests
replace with fakes.

## Multi-tenancy

1. **Data**: every tenant-owned table has `tenant_id uuid` (indexed). `tenantDb(prisma, tenantId)` is a
   Prisma client extension that injects `tenantId` into every `where`/`data` (overriding caller values,
   refusing to move rows between tenants) and runs each query in a transaction that first sets
   `app.tenant_id`. Postgres RLS (`FORCE ROW LEVEL SECURITY`) enforces the same rule at the database: the
   runtime role `nextai_app` is not the table owner, so a forgotten filter or raw query still cannot cross
   tenants. `audit_logs` is append-only for the runtime role.
2. **Tenant resolution** only from: Chatwoot `inbox.id` mapping (webhooks), the JWT `tid` claim (app), or an
   explicit admin selection (admin routes, all audited). Request bodies never choose the tenant.
   Cross-tenant work (webhook lookup, schedulers, admin) uses `systemDb` / `withSystemTx`
   (`app.bypass_rls = on`).
3. **Secrets**: ERPNext key/secret, Chatwoot bot token and ERPNext webhook secret are AES-256-GCM encrypted
   with `ENCRYPTION_KEY`, with the tenant id as additional authenticated data (a ciphertext copied to another
   tenant fails to decrypt). They are decrypted only inside `erpClientFor` / `chatwootClientFor`, kept in
   private fields that are not serialised, and redacted from logs.
4. **Storage**: keys are built by `tenantKey()` as `tenants/{tenant_id}/...`; every storage call asserts the
   prefix. Only short-lived signed URLs are handed out.
5. **Jobs** carry `tenantId` (validated by Zod per queue). The worker enforces a per-tenant concurrency cap
   with a Redis semaphore (jobs over the cap are delayed, not failed) plus global BullMQ limiters; failed jobs
   go to a dead-letter queue after retries.

## Conversation flow (WhatsApp)

`POST /webhooks/chatwoot` → IP allowlist + HMAC (or URL token) → only `message_created` + `incoming` from a
contact (loop guard) → idempotency (`WebhookEvent`, unique by message id) → tenant by inbox → user by phone
within that tenant (unknown numbers get one onboarding reply) → plan gating →

- **attachments**: download (SSRF-guarded host allowlist) → sha256 dedupe → R2 → `ocr.process` / `voice.process`
- **text**: deterministic flow engine with state in Redis `cw:{tenantId}:{conversationId}` (24h):
  `idle → awaiting_field → awaiting_confirm → (1 confirm | 2 edit → awaiting_edit | 3 cancel)`.
  Intent classification is rules-first (zero cost) with the LLM as fallback for free text.

`ocr.process`: prepare (PDF page count + embedded text) → vision extraction to a strict JSON schema →
validation (line maths, subtotal + tax = total, GSTIN checksum / TRN format, CGST = SGST, IGST xor CGST/SGST,
dates) → supplier matching (learned `VendorMapping`, then fuzzy match against ERPNext suppliers) → duplicate
check (supplier + invoice no + amount) → `Draft`. Low confidence / hard validation failures / duplicates go
to `needs_review`: Chatwoot label `needs-review`, conversation opened for a human, and the admin review queue.

`draft.post` (only after confirmation, or immediately when `settings.autoPost`): idempotent status claim →
create Supplier/Customer if missing → create + submit the ERPNext document (Purchase Invoice, Journal Entry
for small cash expenses, Sales Invoice, Payment Entry Receive/Pay) → attach the bill → learn the vendor
mapping → reply "Posted ✅". ERPNext errors are mapped to friendly messages; retriable errors are retried
with exponential backoff; corrections are cancel + amend, never delete.

## Outbound & schedules

- `outbound.invoice` / `outbound.receipt`: ERPNext PDF → customer via approved WhatsApp template + document
  (works outside the 24h window), deduplicated through `OutboundMessage`.
- `outbound.reminder`: per invoice or per party, at most once per invoice per 20h.
- Hourly schedulers fan out per tenant and act at the tenant's local hour: `schedule.reminders`
  (offsets relative to due date), `schedule.daily_summary` (evening). Also `usage.rollup` (hourly),
  `billing.sync` (daily: trial expiry, 7-day past-due grace → suspend), `health.erpnext` (5 min).

## Auth

- **App**: phone + WhatsApp OTP (sent through the tenant's Chatwoot inbox as a template, hashed in Redis,
  5 attempts, rate limited) → 15-minute access JWT (`aud=nextai-app`, `tid` claim) in memory + rotating
  refresh token in an httpOnly, SameSite=strict cookie scoped to `/v1/auth`. Reuse of a rotated refresh
  token revokes the session family. Multi-business users switch tenants via `/v1/auth/switch`.
- **Admin**: email + bcrypt password + mandatory TOTP (enrolled on first login), separate audience,
  cookie path and session kind. Roles: `super_admin`, `reviewer`, `support`.
- **Impersonation**: read-only app token with an `imp` claim; writes are rejected and every request is audited.

## Billing

`PaymentProvider` abstraction (Stripe implemented, Razorpay stub). Checkout uses the plan price for the tenant
currency and carries the remaining trial. `/webhooks/stripe` verifies the signature, is idempotent by event
id, and maps subscription status to tenant status (`trialing → trial`, `active`, `past_due`, others →
`suspended`). `past_due` shows a banner and sends a WhatsApp notice; `suspended` makes the app read-only and
the bot replies with the billing link. Plan limits (users, OCR pages, invoices sent, messages, features) are
enforced in the API and on WhatsApp.

## Security checklist

Helmet, CORS allowlist with credentials, global + per-tenant rate limits, Zod validation on every route,
signed webhooks (Chatwoot HMAC/token + IP allowlist, Frappe HMAC per tenant, Stripe signature), encrypted
tenant secrets, RLS, PII-safe pino logs (phones, emails, tokens, secrets redacted), audit log for money and
settings changes, provisioner limited to whitelisted argv (no shell), dependency audit in CI.
