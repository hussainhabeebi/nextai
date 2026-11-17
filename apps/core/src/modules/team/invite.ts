/**
 * Staff invites. A business can't message a new number on WhatsApp until a template is approved, so the owner
 * gets a ready-made invite to send from their own WhatsApp (a wa.me link); with an approved "staff_invite"
 * template NextAi also sends it itself.
 */
import type { Tenant, User } from '@prisma/client';
import type { Container } from '../../container.js';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { erpContext } from '../erpnext/mappers.js';
import { sendWhatsApp } from '../outbound/whatsapp.js';

export interface Invite {
  text: string;
  /** Opens WhatsApp with the invite addressed to the staff member. */
  whatsappLink: string;
}

export function inviteFor(tenant: Tenant, member: Pick<User, 'name' | 'phone' | 'email' | 'role'>): Invite {
  const bot = erpContext(tenant).settings.whatsappNumber;
  const app = `${env().APP_URL.replace(/\/+$/, '')}/login`;
  const codeBy = tenant.cwBotTokenEnc ? 'on WhatsApp' : member.email ? `by email (${member.email})` : 'once our WhatsApp is connected';
  const text = [
    `Hi ${member.name}! ${tenant.name} has added you to NextAi, our accounts assistant${member.role === 'tenant_accountant' ? ' (as our accountant)' : ''}.`,
    bot ? `• Send bills, payments and questions on WhatsApp to ${bot}` : '• Send bills, payments and questions to our NextAi WhatsApp number',
    `• Or open the app: ${app} and enter ${member.phone}; your login code comes ${codeBy}.`,
  ].join('\n');
  return { text, whatsappLink: `https://wa.me/${(member.phone ?? '').replace(/\D/g, '')}?text=${encodeURIComponent(text)}` };
}

/** Send the invite from the business's WhatsApp when an approved "staff_invite" template exists. */
export async function sendInvite(c: Container, tenant: Tenant, member: User): Promise<boolean> {
  if (!tenant.cwBotTokenEnc || !member.phone) return false;
  const approved = await c.prisma.messageTemplate.findFirst({ where: { key: 'staff_invite', approved: true } });
  if (!approved) return false;
  const inv = inviteFor(tenant, member);
  try {
    await sendWhatsApp(c, tenant, {
      kind: 'notice',
      phone: member.phone,
      name: member.name,
      templateKey: 'staff_invite',
      params: [member.name, tenant.name, `${env().APP_URL.replace(/\/+$/, '')}/login`],
      fallbackText: inv.text,
      ref: `invite-${member.id}`,
    });
    return true;
  } catch (err) {
    logger.warn({ tenantId: tenant.id, err: (err as Error).message }, 'staff invite not sent');
    return false;
  }
}
