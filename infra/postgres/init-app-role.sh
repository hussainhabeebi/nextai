#!/bin/sh
# Creates the non-owner application role used at runtime (subject to RLS). Migrations run as the owner.
set -e
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nextai_app') THEN
    CREATE ROLE nextai_app LOGIN PASSWORD '${NEXTAI_APP_PASSWORD}';
  END IF;
END \$\$;
SQL
