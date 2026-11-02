-- Row-Level Security: every tenant-owned table is only visible when
--   app.tenant_id = row.tenant_id    (set per transaction by the Prisma tenant extension)
-- or app.bypass_rls = 'on'           (system/admin context, always audited at the app layer).
-- FORCE ensures even the table owner is subject to the policy.

CREATE OR REPLACE FUNCTION app_current_tenant() RETURNS uuid
  LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;

CREATE OR REPLACE FUNCTION app_rls_bypass() RETURNS boolean
  LANGUAGE sql STABLE AS $$ SELECT coalesce(current_setting('app.bypass_rls', true), '') = 'on' $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'users', 'sessions', 'documents', 'drafts', 'vendor_mappings', 'subscriptions',
    'usage_counters', 'audit_logs', 'outbound_messages', 'push_subscriptions', 'webhook_events'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (app_rls_bypass() OR tenant_id = app_current_tenant()) '
      'WITH CHECK (app_rls_bypass() OR tenant_id = app_current_tenant())', t);
  END LOOP;
END $$;

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenants
  USING (app_rls_bypass() OR id = app_current_tenant())
  WITH CHECK (app_rls_bypass() OR id = app_current_tenant());

-- Application role (non-owner). Audit log is append-only for the app.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nextai_app') THEN
    GRANT USAGE ON SCHEMA public TO nextai_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO nextai_app;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO nextai_app;
    REVOKE UPDATE, DELETE ON audit_logs FROM nextai_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO nextai_app;
  END IF;
END $$;
