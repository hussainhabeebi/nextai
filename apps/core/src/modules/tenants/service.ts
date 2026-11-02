import { tenantSettingsSchema, type TenantCreate } from '@nextai/shared';
import type { PrismaClient, Tenant } from '@prisma/client';
import { withSystemTx } from '../../lib/db.js';
import { normalizePhone } from '@nextai/shared';

/** Create tenant + owner (system context). Connections are added later by the provisioning wizard. */
export async function createTenantRecord(prisma: PrismaClient, input: TenantCreate): Promise<{ tenant: Tenant; ownerId: string }> {
  return withSystemTx(prisma, async (tx) => {
    const plan = await tx.plan.findUnique({ where: { code: input.planCode } });
    const tenant = await tx.tenant.create({
      data: {
        name: input.name,
        slug: input.slug,
        country: input.country,
        currency: input.currency,
        language: input.language,
        status: 'trial',
        planId: plan?.id,
        trialEndsAt: new Date(Date.now() + 14 * 86400_000),
        settings: tenantSettingsSchema.parse({
          companyName: input.name,
          erpCompany: input.name,
          timezone: input.country === 'IN' ? 'Asia/Kolkata' : 'Asia/Dubai',
          taxRegime: input.country === 'IN' ? 'gst_regular' : 'vat',
        }),
      },
    });
    const owner = await tx.user.create({
      data: {
        tenantId: tenant.id,
        phone: normalizePhone(input.ownerPhone, input.country),
        email: input.ownerEmail,
        name: input.ownerName,
        role: 'owner',
        status: 'invited',
      },
    });
    return { tenant, ownerId: owner.id };
  });
}
