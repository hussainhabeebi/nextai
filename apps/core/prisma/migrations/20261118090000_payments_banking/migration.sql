-- Razorpay payment links, bank statement/SMS lines, template approval.
ALTER TYPE "WebhookSource" ADD VALUE IF NOT EXISTS 'razorpay';

ALTER TABLE "tenants" ADD COLUMN "rzp_key_id" TEXT,
  ADD COLUMN "rzp_key_secret_enc" TEXT,
  ADD COLUMN "rzp_webhook_secret_enc" TEXT;

-- Existing templates are the ones already approved in Meta.
ALTER TABLE "message_templates" ADD COLUMN "approved" BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE "payment_links" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "invoice_name" TEXT NOT NULL,
    "customer" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'razorpay',
    "provider_id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'created',
    "payment_id" TEXT,
    "erp_payment_entry" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paid_at" TIMESTAMP(3),
    CONSTRAINT "payment_links_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "payment_links_provider_id_key" ON "payment_links"("provider_id");
CREATE INDEX "payment_links_tenant_id_invoice_name_idx" ON "payment_links"("tenant_id", "invoice_name");
ALTER TABLE "payment_links" ADD CONSTRAINT "payment_links_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "bank_lines" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "date" VARCHAR(10) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "direction" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "reference" TEXT,
    "balance" DECIMAL(14,2),
    "source" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'unmatched',
    "match_type" TEXT,
    "match_name" TEXT,
    "draft_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "bank_lines_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "bank_lines_tenant_id_fingerprint_key" ON "bank_lines"("tenant_id", "fingerprint");
CREATE INDEX "bank_lines_tenant_id_status_idx" ON "bank_lines"("tenant_id", "status");
ALTER TABLE "bank_lines" ADD CONSTRAINT "bank_lines_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Same tenant isolation as every other tenant-owned table (see 20261102184700_rls).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['payment_links', 'bank_lines'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (app_rls_bypass() OR tenant_id = app_current_tenant()) '
      'WITH CHECK (app_rls_bypass() OR tenant_id = app_current_tenant())', t);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nextai_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON payment_links, bank_lines TO nextai_app;
  END IF;
END $$;
