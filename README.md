# NextAi Accountant

Accounting-as-a-service for small businesses in India (GST) and the UAE (VAT / Corporate Tax).
Owners send bills, voice notes and instructions on **WhatsApp**; NextAi records them in **ERPNext**
(hidden backend, one site per tenant), sends invoices / receipts / reminders, and shows dashboards in a
mobile-first PWA. A human accountant reviews exceptions in the admin console.

```
apps/
  core/      Fastify API (api.nextaierp.com) — webhooks, /v1 app API, /admin/v1, Prisma + RLS
  worker/    BullMQ workers — OCR, voice, posting, outbound WhatsApp, schedulers
  web/       Next.js 15 — customer PWA (/) and admin console (/admin)
  landing/   Astro + Tailwind marketing site (nextaierp.com, Cloudflare Pages) — see apps/landing/README.md
packages/
  shared/            types, Zod schemas, constants, i18n (en, ml, ar), money/tax helpers, brand tokens
  erpnext-client/    typed Frappe REST client + in-memory test double
  chatwoot-client/   Agent Bot client + webhook schema + test double
  payments/          PaymentProvider (Stripe now, Razorpay stub) + test double
infra/
  docker-compose.yml, Dockerfile.{core,worker,web}, postgres/, provisioner/ (whitelisted bench runner)
docs/architecture.md
```

See [docs/architecture.md](docs/architecture.md) for the design (multi-tenancy, flows, security) and
[docs/go-live.md](docs/go-live.md) for the launch checklist (Chatwoot/WhatsApp, Resend email reports, PWA, admin).

## Local setup

Requirements: Node 20+, pnpm 10, PostgreSQL 16, Redis 7.

```bash
pnpm install
cp .env.example .env   # then fill in the values below
```

Minimum `.env` for local development (ERPNext/Chatwoot replaced by in-memory fakes, mock AI):

```ini
NODE_ENV=development
DATABASE_URL=postgresql://nextai_app:nextai_app@localhost:5432/nextai        # runtime role (RLS applies)
DATABASE_MIGRATE_URL=postgresql://nextai:nextai@localhost:5432/nextai         # owner role (migrations, seed)
REDIS_URL=redis://localhost:6379
ENCRYPTION_KEY=<node -e "console.log(require('crypto').randomBytes(32).toString('base64'))">
JWT_SECRET=<32+ random chars>
JWT_REFRESH_SECRET=<32+ random chars>
CHATWOOT_WEBHOOK_SECRET=<16+ random chars>
MOCK_EXTERNALS=true
ADMIN_BOOTSTRAP_PASSWORD=<password for the first super_admin>
```

Create the database and roles, migrate (includes Row-Level Security) and seed:

```bash
sudo -u postgres psql -c "CREATE ROLE nextai LOGIN PASSWORD 'nextai' CREATEDB" -c "CREATE ROLE nextai_app LOGIN PASSWORD 'nextai_app'" -c "CREATE DATABASE nextai OWNER nextai"
```

```bash
pnpm db:migrate
```

```bash
pnpm db:seed
```

The seed creates plans, WhatsApp template mappings, the demo tenant **Aiingo Technologies India LLP**
(IN, INR, owner `+919999999999`) and the super_admin `ADMIN_BOOTSTRAP_EMAIL` (default `admin@nextaierp.com`).

Run everything:

```bash
pnpm turbo run build --filter "./packages/*"
```

```bash
pnpm dev
```

- API: http://localhost:8090 (OpenAPI UI at `/docs` outside production)
- App: http://localhost:3010 — log in with `+919999999999`; in development the OTP is pre-filled
- Admin: http://localhost:3010/admin — first login enrols TOTP 2FA
- Landing: `pnpm --filter @nextai/landing dev` → http://localhost:4321 (configure via `apps/landing/.env.example`)

Without R2 credentials, files are stored under `$TMPDIR/nextai-storage` (or `LOCAL_STORAGE_DIR`) and served via
HMAC-signed, expiring URLs, so the API and worker share uploads.

## Tests

```bash
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres TEST_REDIS_URL=redis://localhost:6379/1 pnpm test
```

Without `TEST_DATABASE_URL` / `TEST_REDIS_URL` the integration tests start Postgres 16 and Redis 7 with
testcontainers. They create a fresh `nextai_test` database, apply migrations as the owner and connect as
the non-owner `nextai_app` role, so RLS is exercised for real. Highlights:

- `apps/core/test/tenancy.test.ts` — tenant A can never read/write tenant B (extension + raw SQL under RLS)
- `webhooks.test.ts`, `pipeline.test.ts`, `outbound.test.ts` — Chatwoot/ERPNext webhooks, OCR → draft → post, invoices/reminders
- `app-api.test.ts`, `admin.test.ts`, `billing.test.ts` — app API isolation, review queue, provisioning, impersonation, Stripe lifecycle

Mobile e2e (login → capture → approve → posted) with Playwright, against a migrated + seeded DB:

```bash
pnpm --filter @nextai/web build && pnpm --filter @nextai/web e2e
```

## Adding a tenant

1. Admin console → **Provision** (super_admin). Enter business name, slug, country, plan and owner WhatsApp.
2. Run the steps (each is idempotent and can be retried):
   `erp_site` → `erp_api_user` → `erp_company` → `tunnel_hostname` → `chatwoot_inbox` → `erp_webhooks` → `test_connections` → `invite_owner`.
   - The provisioner (`infra/provisioner`) must run on the ERPNext host with `PROVISIONER_SECRET`.
   - Easiest: Admin → **Integrations** → tenant → *Connect inbox* with your Chatwoot access token, account id and
     inbox id (creates and assigns the Agent Bot). Or manually: create the WhatsApp inbox and an Agent Bot in Chatwoot, set the bot's outgoing URL to
     `https://api.nextaierp.com/webhooks/chatwoot?token=<CHATWOOT_WEBHOOK_SECRET>`, then paste account id,
     inbox id and bot token into the wizard (stored encrypted).
   - `erp_webhooks` shows a one-time secret: create ERPNext Webhooks for Sales Invoice and Payment Entry
     (`on_submit`) to `https://api.nextaierp.com/webhooks/erpnext/<slug>` with that secret.
3. The owner gets a WhatsApp welcome and can log in to the app with their number.

## Billing setup

```bash
STRIPE_SECRET_KEY=sk_... DATABASE_MIGRATE_URL=... pnpm --filter @nextai/core exec tsx scripts/stripe-setup.ts
```

Creates Base / Growth / Pro monthly prices in INR and AED and stores them on each plan. Point a Stripe
webhook at `https://api.nextaierp.com/webhooks/stripe` (events: `checkout.session.completed`,
`customer.subscription.*`, `invoice.paid`, `invoice.payment_failed`) and set `STRIPE_WEBHOOK_SECRET`.

## Deployment

`infra/docker-compose.yml` runs postgres, redis, a one-shot `migrate`, core (127.0.0.1:8090), worker and
web (127.0.0.1:3010). Cloudflare Tunnel routes `api.nextaierp.com → localhost:8090` and
`app.nextaierp.com → localhost:3010`.

The landing page deploys to Cloudflare Pages from `main`. Because the repo is now a monorepo, set the
Pages project's **root directory to `apps/landing`** (build command `npm run build` or
`pnpm --filter @nextai/landing build`, output `dist`, `NODE_VERSION=22`), or let the CI `landing` job deploy
it with `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`. GitHub Actions
(`.github/workflows/ci.yml`) runs lint, typecheck, tests (Postgres + Redis services), dependency audit and
Playwright e2e, then builds and pushes images to GHCR on `main`.

```bash
POSTGRES_PASSWORD=... NEXTAI_APP_PASSWORD=... docker compose -f infra/docker-compose.yml up -d
```

Health: `GET /healthz` (liveness), `GET /readyz` (Postgres + Redis).

### Coolify

`infra/docker-compose.coolify.yml` is a self-contained variant for [Coolify](https://coolify.io) (no `env_file`,
no bind mounts, no host ports; Coolify's proxy does TLS and routing).

1. Coolify → **New Resource** → this GitHub repo → Build Pack **Docker Compose**.
   Base directory `/`, Docker Compose location `/infra/docker-compose.coolify.yml`.
2. **Environment Variables** — required: `POSTGRES_PASSWORD`, `NEXTAI_APP_PASSWORD` (letters and digits only, they
   go into connection URLs), `ENCRYPTION_KEY`, `JWT_SECRET`, `JWT_REFRESH_SECRET`, `CHATWOOT_WEBHOOK_SECRET`,
   `ADMIN_BOOTSTRAP_PASSWORD`. Everything else from `.env.example` is optional and has the same meaning.
3. **Domains**: `web` → `https://app.nextaierp.com:3010`, `core` → `https://api.nextaierp.com:8090`
   (the port tells Coolify which container port to route to). In Cloudflare DNS, point `app` and `api` A records
   at the Coolify server.
4. Deploy. The one-shot `migrate` service creates the `nextai_app` role, applies migrations and seeds plans,
   templates, the demo tenant and the super_admin (idempotent; set `SEED_ON_DEPLOY=false` to skip). It shows as
   "exited" afterwards — that is expected.

Without R2 credentials, uploads go to the shared `uploads` volume (`/data/storage` in core and worker).
## AI accounting features

- **Audit Copilot** (Pro): tests 100% of transactions (duplicates, IN Sec 40A(3)/269ST cash limits, split payments,
  GSTIN/TRN gaps, invoice-number gaps, outliers, Benford, …) with hash-chained evidence and a CSV/JSON workpaper.
- **Cash-flow forecast** (Growth+): 13 weeks from AR/AP, learned customer payment delays, seasonality and macro
  signals, Monte Carlo risk band, what-if simulator.
- **E-invoicing** (all plans): India IRP (IRN + QR), UAE Peppol PINT AE, KSA ZATCA (hash chain + TLV QR); invoices
  are held until registered.

Details: [docs/architecture.md § AI accounting features](docs/architecture.md#ai-accounting-features).

## Known gaps / TODOs

- E-invoicing uses the local **sandbox** until `EINVOICE_GATEWAY_URL` points at a licensed GSP / Peppol access point /
  ZATCA-onboarded service; the HTTP contract may need an adapter per provider. ZATCA XAdES signing (CSID) is expected
  from that service, and KSA tenants (country `SA`, SAR) are not provisionable yet. Verify the PINT AE identifiers
  against the FTA's final specification before go-live.
- Forecast macro inputs are per-country defaults / tenant overrides, not a live economic data feed.

- Speech-to-text adapter: interface + mock only (`AI_STT_PROVIDER=mock`); add a provider supporting en/ml/ar.
- Vision/LLM adapters: Anthropic + mock; others plug in behind `VisionProvider` / `LlmProvider`.
- Cloudflare Tunnel hostname and ERPNext Webhook doc creation are manual wizard steps (wildcard route recommended).
- WhatsApp inbox creation is done in Chatwoot; the wizard maps it. Interactive list messages are off by default (numbered replies).
- WebAuthn sign-in and web-push sending are not implemented yet (push subscriptions are stored).
- Multi-page captures from the app are processed as separate documents.
- Razorpay provider is a stub. Legal pages on the landing site are placeholders.
- Self-signup: the landing form posts to `/v1/signup` (email code → trial business → **its own ERPNext site**
  `<slug>.nextaierp.com`, built automatically through the provisioner; or a company in the shared site via
  `ERPNEXT_SHARED_*` when no provisioner is set — `SIGNUP_ERP_MODE`). The client's WhatsApp number is still
  connected by an admin. See docs/go-live.md §1c.
- Payment links (Razorpay, India): each business connects its own account in Settings; links go out with
  invoices and reminders and paid links post a Payment Entry against the invoice. See docs/go-live.md §2b.
- Daily briefing and tax deadlines (GST/TDS/ITR in India, VAT/Corporate Tax in the UAE): Settings → Tax deadlines.
- Bank matching: statements (CSV, or PDF read by AI) and forwarded bank SMS; "bank" on WhatsApp for the rest.
- Accountant portal: More → All my businesses, for anyone on more than one business.
- Plans follow the published pricing, per month: Base AED 99 / ₹799 (1 user), Growth AED 299 / ₹1,999 (4 users),
  Pro AED 599 / ₹4,999 (10 users). INR prices exclude 18% GST. Payment-provider price IDs per currency are set in
  Admin → Plans.
