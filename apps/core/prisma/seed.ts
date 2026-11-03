/* Seed: plans, WhatsApp templates, demo tenant + owner, super_admin. Idempotent. */
import { tenantSettingsSchema } from '@nextai/shared';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { withSystemTx } from '../src/lib/db.js';
import { DEFAULT_PLANS, DEFAULT_TEMPLATES } from '../src/modules/billing/plans.js';

export async function seed(prisma: PrismaClient, opts: { ownerPhone?: string; adminEmail?: string; adminPassword?: string } = {}) {
  return withSystemTx(prisma, async (tx) => {
    for (const p of DEFAULT_PLANS) {
      await tx.plan.upsert({
        where: { code: p.code },
        update: { name: p.name, priceMonthly: p.priceMonthly, limits: p.limits },
        create: { code: p.code, name: p.name, priceMonthly: p.priceMonthly, limits: p.limits, currency: 'INR' },
      });
    }
    for (const t of DEFAULT_TEMPLATES) {
      await tx.messageTemplate.upsert({ where: { key_language: { key: t.key, language: t.language } }, update: t, create: t });
    }
    const business = await tx.plan.findUniqueOrThrow({ where: { code: 'growth' } });
    const tenant = await tx.tenant.upsert({
      where: { slug: 'aiingo' },
      update: {},
      create: {
        name: 'Aiingo Technologies India LLP',
        slug: 'aiingo',
        country: 'IN',
        currency: 'INR',
        language: 'en',
        status: 'trial',
        planId: business.id,
        trialEndsAt: new Date(Date.now() + 14 * 86400_000),
        erpSiteUrl: 'https://aiingo.nextaierp.com',
        settings: tenantSettingsSchema.parse({ companyName: 'Aiingo Technologies India LLP', erpCompany: 'Aiingo Technologies India LLP', timezone: 'Asia/Kolkata' }),
      },
    });
    const ownerPhone = opts.ownerPhone ?? process.env.SEED_OWNER_PHONE ?? '+919999999999';
    await tx.user.upsert({
      where: { tenantId_phone: { tenantId: tenant.id, phone: ownerPhone } },
      update: {},
      create: { tenantId: tenant.id, phone: ownerPhone, name: 'Demo Owner', role: 'owner' },
    });
    const email = (opts.adminEmail ?? process.env.ADMIN_BOOTSTRAP_EMAIL ?? 'admin@nextaierp.com').toLowerCase();
    const password = opts.adminPassword ?? process.env.ADMIN_BOOTSTRAP_PASSWORD;
    const existing = await tx.user.findFirst({ where: { email, platformRole: { not: null } } });
    if (!existing) {
      if (!password) throw new Error('ADMIN_BOOTSTRAP_PASSWORD is required to create the super_admin');
      await tx.user.create({
        data: { email, name: 'Super Admin', platformRole: 'super_admin', passwordHash: await bcrypt.hash(password, 12) },
      });
    }
    return { tenantId: tenant.id };
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_MIGRATE_URL ?? process.env.DATABASE_URL } } });
  seed(prisma)
    .then((r) => console.warn('Seeded', r))
    .finally(() => prisma.$disconnect());
}
