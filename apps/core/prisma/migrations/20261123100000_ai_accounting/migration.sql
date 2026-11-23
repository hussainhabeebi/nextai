-- CreateEnum
CREATE TYPE "AuditRunStatus" AS ENUM ('running', 'completed', 'failed');

-- CreateEnum
CREATE TYPE "FindingSeverity" AS ENUM ('low', 'medium', 'high', 'critical');

-- CreateEnum
CREATE TYPE "FindingStatus" AS ENUM ('open', 'resolved', 'dismissed');

-- CreateEnum
CREATE TYPE "EInvoiceStatus" AS ENUM ('pending', 'invalid', 'submitted', 'accepted', 'rejected', 'cancelled', 'failed');

-- CreateTable
CREATE TABLE "audit_runs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "period_from" TEXT NOT NULL,
    "period_to" TEXT NOT NULL,
    "status" "AuditRunStatus" NOT NULL DEFAULT 'running',
    "trigger" TEXT NOT NULL DEFAULT 'manual',
    "txn_count" INTEGER NOT NULL DEFAULT 0,
    "total_value" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "dataset_hash" TEXT,
    "prev_hash" TEXT,
    "evidence_hash" TEXT,
    "summary" JSONB NOT NULL DEFAULT '{}',
    "error" TEXT,
    "requested_by" UUID,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "audit_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_findings" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "rule" TEXT NOT NULL,
    "severity" "FindingSeverity" NOT NULL,
    "title" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "amount" DOUBLE PRECISION,
    "fingerprint" TEXT NOT NULL,
    "txn_refs" JSONB NOT NULL,
    "evidence" JSONB NOT NULL,
    "status" "FindingStatus" NOT NULL DEFAULT 'open',
    "resolution" TEXT,
    "resolved_by" UUID,
    "resolved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_findings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "einvoices" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "scheme" TEXT NOT NULL,
    "invoice_name" TEXT NOT NULL,
    "status" "EInvoiceStatus" NOT NULL DEFAULT 'pending',
    "irn" TEXT,
    "ack_no" TEXT,
    "ack_date" TIMESTAMP(3),
    "qr_payload" TEXT,
    "doc_hash" TEXT,
    "prev_hash" TEXT,
    "counter" INTEGER,
    "r2_key" TEXT,
    "total" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "tax_total" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "buyer_tax_id" TEXT,
    "errors" JSONB NOT NULL DEFAULT '[]',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "submitted_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "einvoices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "audit_runs_tenant_id_started_at_idx" ON "audit_runs"("tenant_id", "started_at");

-- CreateIndex
CREATE INDEX "audit_findings_tenant_id_status_idx" ON "audit_findings"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "audit_findings_run_id_idx" ON "audit_findings"("run_id");

-- CreateIndex
CREATE INDEX "audit_findings_tenant_id_fingerprint_idx" ON "audit_findings"("tenant_id", "fingerprint");

-- CreateIndex
CREATE INDEX "einvoices_tenant_id_status_idx" ON "einvoices"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "einvoices_tenant_id_invoice_name_key" ON "einvoices"("tenant_id", "invoice_name");

-- AddForeignKey
ALTER TABLE "audit_runs" ADD CONSTRAINT "audit_runs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_findings" ADD CONSTRAINT "audit_findings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_findings" ADD CONSTRAINT "audit_findings_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "audit_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "einvoices" ADD CONSTRAINT "einvoices_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Row-Level Security for the new tenant-owned tables (same policy as *_rls).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['audit_runs', 'audit_findings', 'einvoices'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (app_rls_bypass() OR tenant_id = app_current_tenant()) '
      'WITH CHECK (app_rls_bypass() OR tenant_id = app_current_tenant())', t);
  END LOOP;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nextai_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON audit_runs, audit_findings, einvoices TO nextai_app;
    -- Evidence is append-only for the app: findings can change status, never be deleted.
    REVOKE DELETE ON audit_runs, audit_findings FROM nextai_app;
  END IF;
END $$;

-- Plan features: e-invoicing on every plan (statutory), cash forecast from Growth, audit copilot on Pro.
UPDATE plans SET limits = jsonb_set(limits::jsonb, '{features}', (coalesce(limits::jsonb->'features', '[]'::jsonb) || '["e_invoicing"]'::jsonb)) WHERE code = 'base' AND NOT (limits::jsonb->'features' ? 'e_invoicing');
UPDATE plans SET limits = jsonb_set(limits::jsonb, '{features}', (coalesce(limits::jsonb->'features', '[]'::jsonb) || '["e_invoicing","cash_forecast"]'::jsonb)) WHERE code = 'growth' AND NOT (limits::jsonb->'features' ? 'cash_forecast');
UPDATE plans SET limits = jsonb_set(limits::jsonb, '{features}', (coalesce(limits::jsonb->'features', '[]'::jsonb) || '["e_invoicing","cash_forecast","audit_copilot"]'::jsonb)) WHERE code = 'pro' AND NOT (limits::jsonb->'features' ? 'audit_copilot');
