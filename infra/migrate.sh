#!/bin/sh
# One-shot deploy step (runs in the `tools` image before core/worker start):
#   1. create/update the non-owner `nextai_app` role (runtime role, subject to RLS)
#   2. apply Prisma migrations as the owner role
#   3. seed plans, templates and the first super_admin (idempotent; skip with SEED_ON_DEPLOY=false)
set -eu
cd /repo/apps/core

: "${DATABASE_MIGRATE_URL:?DATABASE_MIGRATE_URL is required}"

if [ -n "${NEXTAI_APP_PASSWORD:-}" ]; then
  pw=$(printf '%s' "$NEXTAI_APP_PASSWORD" | sed "s/'/''/g")
  echo "Ensuring role nextai_app"
  printf "DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nextai_app') THEN
    CREATE ROLE nextai_app LOGIN PASSWORD '%s';
  ELSE
    ALTER ROLE nextai_app WITH LOGIN PASSWORD '%s';
  END IF;
END \$\$;\n" "$pw" "$pw" | ./node_modules/.bin/prisma db execute --stdin --url "$DATABASE_MIGRATE_URL"
fi

echo "Applying migrations"
DATABASE_URL="$DATABASE_MIGRATE_URL" ./node_modules/.bin/prisma migrate deploy

if [ "${SEED_ON_DEPLOY:-true}" != "false" ] && [ -n "${ADMIN_BOOTSTRAP_PASSWORD:-}" ]; then
  echo "Seeding"
  ./node_modules/.bin/tsx prisma/seed.ts
else
  echo "Skipping seed (SEED_ON_DEPLOY=false or ADMIN_BOOTSTRAP_PASSWORD empty)"
fi
