-- CreateEnum
CREATE TYPE "LifecycleRole" AS ENUM ('sales', 'accountant', 'collections', 'onboarding', 'qa', 'support', 'ai_manager', 'management');

-- CreateEnum
CREATE TYPE "ReminderAudience" AS ENUM ('owner', 'escalation', 'customer', 'management');

-- CreateEnum
CREATE TYPE "LifecycleTimerStatus" AS ENUM ('open', 'done', 'cancelled');

-- AlterEnum
ALTER TYPE "WebhookSource" ADD VALUE 'leadvyne';

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "lead_webhook_secret_enc" TEXT;

-- CreateTable
CREATE TABLE "staff_members" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "erp_user" TEXT,
    "roles" "LifecycleRole"[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "staff_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lifecycle_rules" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "stage" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "owner_role" "LifecycleRole" NOT NULL,
    "escalation_role" "LifecycleRole" NOT NULL DEFAULT 'accountant',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lifecycle_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reminder_levels" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "rule_id" UUID NOT NULL,
    "level" INTEGER NOT NULL,
    "offset_minutes" INTEGER NOT NULL,
    "audience" "ReminderAudience" NOT NULL,
    "template_key" TEXT NOT NULL DEFAULT 'lifecycle_notice',
    "message" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reminder_levels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lifecycle_timers" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "rule_id" UUID NOT NULL,
    "doctype" TEXT NOT NULL,
    "doc_name" TEXT NOT NULL,
    "anchor_at" TIMESTAMP(3) NOT NULL,
    "owner_staff_id" UUID,
    "customer_name" TEXT,
    "customer_phone" TEXT,
    "context" JSONB NOT NULL DEFAULT '{}',
    "status" "LifecycleTimerStatus" NOT NULL DEFAULT 'open',
    "sent_levels" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lifecycle_timers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "staff_members_tenant_id_idx" ON "staff_members"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "staff_members_tenant_id_phone_key" ON "staff_members"("tenant_id", "phone");

-- CreateIndex
CREATE INDEX "lifecycle_rules_tenant_id_idx" ON "lifecycle_rules"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "lifecycle_rules_tenant_id_key_key" ON "lifecycle_rules"("tenant_id", "key");

-- CreateIndex
CREATE INDEX "reminder_levels_tenant_id_idx" ON "reminder_levels"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "reminder_levels_rule_id_level_key" ON "reminder_levels"("rule_id", "level");

-- CreateIndex
CREATE INDEX "lifecycle_timers_tenant_id_status_idx" ON "lifecycle_timers"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "lifecycle_timers_status_anchor_at_idx" ON "lifecycle_timers"("status", "anchor_at");

-- CreateIndex
CREATE UNIQUE INDEX "lifecycle_timers_rule_id_doctype_doc_name_key" ON "lifecycle_timers"("rule_id", "doctype", "doc_name");

-- AddForeignKey
ALTER TABLE "staff_members" ADD CONSTRAINT "staff_members_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lifecycle_rules" ADD CONSTRAINT "lifecycle_rules_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reminder_levels" ADD CONSTRAINT "reminder_levels_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "lifecycle_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lifecycle_timers" ADD CONSTRAINT "lifecycle_timers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lifecycle_timers" ADD CONSTRAINT "lifecycle_timers_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "lifecycle_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lifecycle_timers" ADD CONSTRAINT "lifecycle_timers_owner_staff_id_fkey" FOREIGN KEY ("owner_staff_id") REFERENCES "staff_members"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Row-Level Security for the lifecycle tables (same policy as the other tenant-owned tables).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['staff_members', 'lifecycle_rules', 'reminder_levels', 'lifecycle_timers'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (app_rls_bypass() OR tenant_id = app_current_tenant()) '
      'WITH CHECK (app_rls_bypass() OR tenant_id = app_current_tenant())', t);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nextai_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON staff_members, lifecycle_rules, reminder_levels, lifecycle_timers TO nextai_app;
  END IF;
END $$;
