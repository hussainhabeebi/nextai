import { execSync } from 'node:child_process';
import pg from 'pg';

/**
 * Integration test infrastructure.
 * - If TEST_DATABASE_URL (owner/superuser) is set, a fresh `nextai_test` database is created there.
 * - Otherwise Postgres 16 + Redis 7 are started with testcontainers.
 * Migrations (incl. RLS) are applied with the owner role; tests connect as the non-owner `nextai_app` role.
 */
let stop: Array<() => Promise<unknown>> = [];

export default async function setup() {
  let adminUrl = process.env.TEST_DATABASE_URL;
  let redisUrl = process.env.TEST_REDIS_URL;
  if (!adminUrl) {
    const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
    const c = await new PostgreSqlContainer('postgres:16-alpine').start();
    stop.push(() => c.stop());
    adminUrl = c.getConnectionUri();
  }
  if (!redisUrl) {
    const { RedisContainer } = await import('@testcontainers/redis');
    const r = await new RedisContainer('redis:7-alpine').start();
    stop.push(() => r.stop());
    redisUrl = r.getConnectionUrl();
  }
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS nextai_test WITH (FORCE)`);
  await admin.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nextai_owner_test') THEN CREATE ROLE nextai_owner_test LOGIN PASSWORD 'owner'; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nextai_app') THEN CREATE ROLE nextai_app LOGIN PASSWORD 'nextai_app'; END IF;
  END $$;`);
  await admin.query(`CREATE DATABASE nextai_test OWNER nextai_owner_test`);
  await admin.end();

  const u = new URL(adminUrl);
  const ownerUrl = new URL(u);
  ownerUrl.username = 'nextai_owner_test';
  ownerUrl.password = 'owner';
  ownerUrl.pathname = '/nextai_test';
  const appUrl = new URL(ownerUrl);
  appUrl.username = 'nextai_app';
  appUrl.password = 'nextai_app';

  execSync('npx prisma migrate deploy', {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, DATABASE_URL: ownerUrl.toString() },
    stdio: 'pipe',
  });
  process.env.DATABASE_URL = appUrl.toString();
  process.env.DATABASE_MIGRATE_URL = ownerUrl.toString();
  process.env.REDIS_URL = redisUrl;

  return async () => {
    await Promise.all(stop.map((s) => s()));
    stop = [];
  };
}
