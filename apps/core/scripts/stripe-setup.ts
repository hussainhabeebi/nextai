/**
 * Creates (idempotently, via lookup_key) Stripe Products + monthly Prices for Starter/Business/Pro
 * in INR and AED and stores the price ids in Plan.providerPriceIds.stripe.{INR,AED}.
 *   STRIPE_SECRET_KEY=sk_... DATABASE_MIGRATE_URL=... pnpm --filter @nextai/core exec tsx scripts/stripe-setup.ts
 */
import { PrismaClient } from '@prisma/client';
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_MIGRATE_URL ?? process.env.DATABASE_URL } } });

for (const plan of await prisma.plan.findMany()) {
  const prices = plan.priceMonthly as Record<string, number>;
  const ids: Record<string, string> = {};
  let product = (await stripe.products.search({ query: `metadata['plan_code']:'${plan.code}'` })).data[0];
  product ??= await stripe.products.create({ name: `NextAi ${plan.name}`, metadata: { plan_code: plan.code } });
  for (const [currency, amount] of Object.entries(prices)) {
    const lookup = `nextai_${plan.code}_${currency.toLowerCase()}_monthly_${amount}`;
    const existing = (await stripe.prices.list({ lookup_keys: [lookup], limit: 1 })).data[0];
    const price =
      existing ??
      (await stripe.prices.create({ product: product.id, currency: currency.toLowerCase(), unit_amount: Math.round(amount * 100), recurring: { interval: 'month' }, lookup_key: lookup }));
    ids[currency] = price.id;
  }
  const providerPriceIds = { ...(plan.providerPriceIds as object), stripe: ids };
  await prisma.plan.update({ where: { id: plan.id }, data: { providerPriceIds } });
  console.warn(plan.code, ids);
}
await prisma.$disconnect();
