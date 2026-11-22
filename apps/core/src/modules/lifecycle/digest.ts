import type { Tenant } from '@prisma/client';
import type { Container } from '../../container.js';
import { tenantDb } from '../../lib/db.js';
import { logger } from '../../lib/logger.js';
import { erpContext } from '../erpnext/mappers.js';
import { localDate, localHour } from '../outbound/jobs.js';
import { sendWhatsApp } from '../outbound/whatsapp.js';
import { dueAt } from './engine.js';

const MAX_LINES = 12;

/**
 * Morning digest: each active staff member gets one WhatsApp message listing the open steps they own,
 * grouped as escalated (an escalation level fired), reminded (an owner level fired) and coming up in the next 24 hours.
 * Runs inside lifecycle.scan; sent once per tenant per local day (Redis NX marker).
 */
export async function sendStaffDigests(c: Container, tenant: Tenant, now = new Date()) {
  const { settings } = erpContext(tenant);
  const cfg = settings.lifecycle;
  if (!cfg.digestEnabled || !tenant.cwBotTokenEnc || localHour(settings.timezone, now) !== cfg.digestHourLocal) return 0;
  const day = localDate(settings.timezone, now);
  const db = tenantDb(c.prisma, tenant.id);
  if ((await db.lifecycleRule.count()) === 0) return 0;
  const first = await c.redis.set(`lc:digest:${tenant.id}:${day}`, '1', 'EX', 36 * 3600, 'NX');
  if (first !== 'OK') return 0;

  const staff = await db.staffMember.findMany({ where: { active: true } });
  const timers = await db.lifecycleTimer.findMany({
    where: { status: 'open', ownerStaffId: { in: staff.map((s) => s.id) }, rule: { enabled: true } },
    include: { rule: { include: { levels: true } } },
    orderBy: { anchorAt: 'asc' },
  });
  const horizon = new Date(now.getTime() + 24 * 3600_000);
  let sent = 0;
  for (const s of staff) {
    const escalated: string[] = [];
    const reminded: string[] = [];
    const upcoming: string[] = [];
    for (const t of timers.filter((x) => x.ownerStaffId === s.id)) {
      const levels = t.rule.levels.filter((l) => l.enabled);
      const fired = (aud: string) => levels.some((l) => l.audience === aud && t.sentLevels.includes(l.level));
      const label = `${t.rule.name}: ${t.customerName ?? t.docName}`;
      if (fired('escalation')) escalated.push(label);
      else if (fired('owner')) reminded.push(label);
      else if (levels.some((l) => !t.sentLevels.includes(l.level) && dueAt(t.anchorAt, l) <= horizon)) upcoming.push(label);
    }
    if (escalated.length + reminded.length + upcoming.length === 0) continue;
    const lines = [`Good morning ${s.name}! Your NextAi steps for ${day}:`];
    const section = (title: string, items: string[]) => {
      if (items.length) lines.push('', `${title} (${items.length}):`, ...items.slice(0, MAX_LINES).map((x) => `• ${x}`), ...(items.length > MAX_LINES ? [`…and ${items.length - MAX_LINES} more`] : []));
    };
    section('🔴 Escalated', escalated);
    section('🟠 Reminded, still open', reminded);
    section('🟡 Coming up in 24h', upcoming);
    const text = lines.join('\n');
    try {
      await sendWhatsApp(c, tenant, { kind: 'summary', channel: 'staff', phone: s.phone, name: s.name, templateKey: 'lifecycle_digest', params: [text], fallbackText: text, ref: `lc:digest:${day}:${s.id}` });
      sent++;
    } catch (err) {
      logger.warn({ tenantId: tenant.id, staffId: s.id, err: (err as Error).message }, 'staff digest failed');
    }
  }
  return sent;
}
