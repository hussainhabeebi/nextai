-- CreateEnum
CREATE TYPE "TenantStatus" AS ENUM ('trial', 'active', 'past_due', 'suspended');

-- CreateEnum
CREATE TYPE "Country" AS ENUM ('IN', 'AE');

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('owner', 'staff', 'tenant_accountant');

-- CreateEnum
CREATE TYPE "PlatformRole" AS ENUM ('super_admin', 'reviewer', 'support');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('invited', 'active', 'disabled');

-- CreateEnum
CREATE TYPE "DocumentSource" AS ENUM ('whatsapp', 'app');

-- CreateEnum
CREATE TYPE "DraftType" AS ENUM ('purchase_invoice', 'journal_entry', 'sales_invoice', 'payment_in', 'payment_out');

-- CreateEnum
CREATE TYPE "DraftStatus" AS ENUM ('pending', 'confirmed', 'posting', 'posted', 'cancelled', 'needs_review', 'failed');

-- CreateEnum
CREATE TYPE "PlanCode" AS ENUM ('starter', 'business', 'pro');

-- CreateEnum
CREATE TYPE "PaymentProviderName" AS ENUM ('stripe', 'razorpay');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('user', 'admin', 'system', 'bot');

-- CreateEnum
CREATE TYPE "Channel" AS ENUM ('whatsapp', 'app', 'admin', 'system');

-- CreateEnum
CREATE TYPE "WebhookSource" AS ENUM ('chatwoot', 'erpnext', 'stripe');

-- CreateEnum
CREATE TYPE "SessionKind" AS ENUM ('app', 'admin');

-- CreateTable
CREATE TABLE "tenants" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "country" "Country" NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "language" VARCHAR(5) NOT NULL DEFAULT 'en',
    "status" "TenantStatus" NOT NULL DEFAULT 'trial',
    "erp_site_url" TEXT,
    "erp_api_key_enc" TEXT,
    "erp_api_secret_enc" TEXT,
    "erp_webhook_secret_enc" TEXT,
    "cw_account_id" INTEGER,
    "cw_inbox_id" INTEGER,
    "cw_bot_token_enc" TEXT,
    "plan_id" UUID,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "trial_ends_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "tenant_id" UUID,
    "phone" TEXT,
    "email" TEXT,
    "name" TEXT NOT NULL,
    "role" "UserRole",
    "platform_role" "PlatformRole",
    "password_hash" TEXT,
    "totp_secret_enc" TEXT,
    "language" VARCHAR(5),
    "status" "UserStatus" NOT NULL DEFAULT 'active',
    "last_login_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "tenant_id" UUID,
    "kind" "SessionKind" NOT NULL,
    "refresh_hash" TEXT NOT NULL,
    "user_agent" TEXT,
    "ip" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webauthn_credentials" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "credential_id" TEXT NOT NULL,
    "public_key" TEXT NOT NULL,
    "counter" INTEGER NOT NULL DEFAULT 0,
    "transports" TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webauthn_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "documents" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "r2_key" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "pages" INTEGER NOT NULL DEFAULT 1,
    "source" "DocumentSource" NOT NULL,
    "extracted" JSONB,
    "confidence" DOUBLE PRECISION,
    "uploaded_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "drafts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID,
    "document_id" UUID,
    "conversation_id" INTEGER,
    "type" "DraftType" NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "DraftStatus" NOT NULL DEFAULT 'pending',
    "confidence" DOUBLE PRECISION,
    "erp_doctype" TEXT,
    "erp_name" TEXT,
    "error" TEXT,
    "reviewed_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "drafts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vendor_mappings" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "supplier_name" TEXT NOT NULL,
    "tax_id" TEXT,
    "expense_account" TEXT NOT NULL,
    "tax_template" TEXT,
    "hits" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vendor_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plans" (
    "id" UUID NOT NULL,
    "code" "PlanCode" NOT NULL,
    "name" TEXT NOT NULL,
    "price_monthly" JSONB NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'INR',
    "limits" JSONB NOT NULL,
    "provider_price_ids" JSONB NOT NULL DEFAULT '{}',
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "provider" "PaymentProviderName" NOT NULL,
    "provider_customer_id" TEXT NOT NULL,
    "provider_subscription_id" TEXT,
    "status" TEXT NOT NULL,
    "plan_code" "PlanCode",
    "current_period_end" TIMESTAMP(3),
    "cancel_at_period_end" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_counters" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "period" TEXT NOT NULL,
    "messages" INTEGER NOT NULL DEFAULT 0,
    "ocr_pages" INTEGER NOT NULL DEFAULT 0,
    "ai_tokens" INTEGER NOT NULL DEFAULT 0,
    "ai_cost_micros" BIGINT NOT NULL DEFAULT 0,
    "invoices_sent" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "usage_counters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID,
    "actor_id" UUID,
    "actor_type" "ActorType" NOT NULL,
    "channel" "Channel" NOT NULL,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entity_id" TEXT,
    "before" JSONB,
    "after" JSONB,
    "ip" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_events" (
    "id" UUID NOT NULL,
    "source" "WebhookSource" NOT NULL,
    "external_id" TEXT NOT NULL,
    "tenant_id" UUID,
    "payload" JSONB NOT NULL,
    "processed_at" TIMESTAMP(3),
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbound_messages" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "to_phone" TEXT NOT NULL,
    "conversation_id" INTEGER,
    "ref" TEXT,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbound_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "push_subscriptions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "endpoint" TEXT NOT NULL,
    "keys" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "push_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feature_flags" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "tenant_id" UUID,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "feature_flags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_templates" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "language" VARCHAR(5) NOT NULL,
    "params" TEXT[],
    "category" TEXT NOT NULL DEFAULT 'UTILITY',
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "message_templates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenants_slug_key" ON "tenants"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "tenants_cw_inbox_id_key" ON "tenants"("cw_inbox_id");

-- CreateIndex
CREATE INDEX "users_tenant_id_idx" ON "users"("tenant_id");

-- CreateIndex
CREATE INDEX "users_phone_idx" ON "users"("phone");

-- CreateIndex
CREATE INDEX "users_email_idx" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_tenant_id_phone_key" ON "users"("tenant_id", "phone");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_refresh_hash_key" ON "sessions"("refresh_hash");

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "webauthn_credentials_credential_id_key" ON "webauthn_credentials"("credential_id");

-- CreateIndex
CREATE INDEX "documents_tenant_id_idx" ON "documents"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "documents_tenant_id_sha256_key" ON "documents"("tenant_id", "sha256");

-- CreateIndex
CREATE INDEX "drafts_tenant_id_idx" ON "drafts"("tenant_id");

-- CreateIndex
CREATE INDEX "drafts_tenant_id_status_idx" ON "drafts"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "drafts_status_idx" ON "drafts"("status");

-- CreateIndex
CREATE INDEX "vendor_mappings_tenant_id_idx" ON "vendor_mappings"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "vendor_mappings_tenant_id_supplier_name_key" ON "vendor_mappings"("tenant_id", "supplier_name");

-- CreateIndex
CREATE UNIQUE INDEX "plans_code_key" ON "plans"("code");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_provider_subscription_id_key" ON "subscriptions"("provider_subscription_id");

-- CreateIndex
CREATE INDEX "subscriptions_tenant_id_idx" ON "subscriptions"("tenant_id");

-- CreateIndex
CREATE INDEX "subscriptions_provider_customer_id_idx" ON "subscriptions"("provider_customer_id");

-- CreateIndex
CREATE INDEX "usage_counters_tenant_id_idx" ON "usage_counters"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "usage_counters_tenant_id_period_key" ON "usage_counters"("tenant_id", "period");

-- CreateIndex
CREATE INDEX "audit_logs_tenant_id_created_at_idx" ON "audit_logs"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_action_idx" ON "audit_logs"("action");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_events_external_id_key" ON "webhook_events"("external_id");

-- CreateIndex
CREATE INDEX "webhook_events_tenant_id_idx" ON "webhook_events"("tenant_id");

-- CreateIndex
CREATE INDEX "outbound_messages_tenant_id_created_at_idx" ON "outbound_messages"("tenant_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "push_subscriptions_endpoint_key" ON "push_subscriptions"("endpoint");

-- CreateIndex
CREATE INDEX "push_subscriptions_tenant_id_idx" ON "push_subscriptions"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "feature_flags_key_tenant_id_key" ON "feature_flags"("key", "tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "message_templates_key_language_key" ON "message_templates"("key", "language");

-- AddForeignKey
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webauthn_credentials" ADD CONSTRAINT "webauthn_credentials_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_mappings" ADD CONSTRAINT "vendor_mappings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_counters" ADD CONSTRAINT "usage_counters_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbound_messages" ADD CONSTRAINT "outbound_messages_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
