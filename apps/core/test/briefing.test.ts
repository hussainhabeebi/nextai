import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tenantSettingsSchema } from '@nextai/shared';
import { seed } from '../prisma/seed.js';
import { buildApp } from '../src/app.js';
import { tenantDb, withSystemTx } from '../src/lib/db.js';
import { buildBriefing, sendDeadlineWarnings } from '../src/modules/briefing/briefing.js';
import { upcomingDeadlines } from '../src/modules/briefing/deadlines.js';
import { closeShared, createTenant, testContainer } from './helpers.js';
import { cwMessage, postCw } from './webhook-helpers.js';

const cal = (over: Record<string, unknown> = {}, regime = 'gst_regular') => tenantSettingsSchema.parse({ taxRegime: regime, taxCalendar: over });
const keys = (country: 'IN' | 'AE', s: ReturnType<typeof cal>, today: string, days = 14) => upcomingDeadlines(country, s, today, days).map((d) => `${d.what} @ ${d.due}`);

describe('tax deadline calendar', () => {
  it('India, monthly GST: GSTR-1 by the 11th and GSTR-3B by the 20th for last month', () => {
    expect(keys('IN', cal(), '2026-11-06')).toEqual(['GSTR-1 for October 2026 @ 2026-11-11', 'GSTR-3B for October 2026 @ 2026-11-20']);
    expect(keys('IN', cal(), '2026-11-17')).toEqual(['GSTR-3B for October 2026 @ 2026-11-20']);
    expect(keys('IN', cal(), '2026-12-28', 7)).toEqual(['GSTR-9 annual return for FY 2024-25 @ 2026-12-31']);
  });

  it('India, quarterly (QRMP), composition, TDS, advance tax, ITR', () => {
    expect(keys('IN', cal({ gstFiling: 'quarterly' }), '2026-01-05', 20)).toEqual(['GSTR-1 for October–December 2025 @ 2026-01-13', 'GSTR-3B for October–December 2025 @ 2026-01-22']);
    expect(keys('IN', cal({ gstFiling: 'quarterly' }), '2026-02-20', 10)).toEqual(['GST payment (PMT-06) for January 2026 @ 2026-02-25']);
    expect(keys('IN', cal({}, 'gst_composition'), '2026-07-10')).toEqual(['CMP-08 for April–June 2026 @ 2026-07-18']);
    expect(keys('IN', cal({ tds: true }, 'none'), '2026-04-01', 30)).toEqual(['TDS payment for March 2026 @ 2026-04-30']);
    expect(keys('IN', cal({}, 'none'), '2026-06-10')).toEqual(['Advance tax instalment (15% of the year\'s tax) @ 2026-06-15']);
    expect(keys('IN', cal({ advanceTax: false }, 'none'), '2026-07-25')).toEqual(['Income tax return for FY 2025-26 @ 2026-07-31']);
    expect(keys('IN', cal({ advanceTax: false, taxAudit: true }, 'none'), '2026-07-25')).toEqual([]);
  });

  it('UAE: VAT 28 days after the quarter (by stagger) or month, Corporate Tax 9 months after year end', () => {
    expect(keys('AE', cal({ vatQuarterEnds: [1, 4, 7, 10] }, 'vat'), '2026-02-10', 30)).toEqual(['VAT return (VAT201) for November 2025–January 2026 @ 2026-02-28']);
    expect(keys('AE', cal({}, 'vat'), '2026-10-10', 30)).toEqual(['VAT return (VAT201) for July–September 2026 @ 2026-10-28']);
    expect(keys('AE', cal({ vatQuarterEnds: [1, 4, 7, 10] }, 'vat'), '2026-11-01', 30)).toEqual(['VAT return (VAT201) for August–October 2026 @ 2026-11-28']);
    expect(keys('AE', cal({ vatPeriod: 'monthly' }, 'vat'), '2026-11-20')).toEqual(['VAT return (VAT201) for October 2026 @ 2026-11-28']);
    expect(keys('AE', cal({}, 'vat_ct'), '2026-09-20')).toEqual(['Corporate Tax return for 2025 @ 2026-09-30']);
  });
});

describe('daily briefing and deadline warnings', () => {
  const c = testContainer();
  let app: FastifyInstance;
  let A: Awaited<ReturnType<typeof createTenant>>;
  type Fake = { create: (d: string, x: Record<string, unknown>) => Promise<unknown>; docs: Map<string, Map<string, Record<string, unknown>>> };
  beforeAll(async () => {
    await seed(c.prisma);
    A = await createTenant(c.prisma, { settings: { companyAbbr: 'AIL', timezone: 'Asia/Kolkata' } });
    const erp = c.erp(A.tenant) as unknown as Fake;
    await erp.create('Sales Invoice', { name: 'SINV-1', customer: 'Ravi Traders', outstanding_amount: 12000, due_date: '2026-10-30', docstatus: 1 });
    erp.docs.get('Sales Invoice')!.get('SINV-1')!.docstatus = 1;
    await erp.create('Sales Invoice', { name: 'SINV-2', customer: 'Not Due Yet', outstanding_amount: 5000, due_date: '2026-12-30' });
    erp.docs.get('Sales Invoice')!.get('SINV-2')!.docstatus = 1;
    const db = tenantDb(c.prisma, A.tenant.id);
    await db.draft.create({ data: { tenantId: A.tenant.id, type: 'journal_entry', status: 'needs_review', payload: { date: '2026-11-16', currency: 'INR', lines: [], total: 500, validationIssues: [] } } });
    await db.draft.create({ data: { tenantId: A.tenant.id, type: 'purchase_invoice', status: 'posted', payload: { partyName: 'No GSTIN Co', date: '2026-11-10', currency: 'INR', lines: [], total: 900, validationIssues: [] } } });
    await db.bankLine.create({ data: { tenantId: A.tenant.id, date: '2026-11-15', amount: 3200, direction: 'out', description: 'KSEB', source: 'sms', fingerprint: 'f1' } });
    app = await buildApp(c);
  });
  afterAll(async () => {
    await app.close();
    await closeShared();
  });

  it('lists who to chase, the next deadline with what blocks filing, approvals and bank lines', async () => {
    const b = await buildBriefing(c, A.tenant, new Date('2026-11-17T04:00:00Z'));
    expect(b.day).toBe('2026-11-17');
    expect(b.text).toMatch(/To collect: Ravi Traders ₹12,000.00 \(18 days late\)/);
    expect(b.text).not.toMatch(/Not Due Yet/);
    expect(b.text).toMatch(/Reply "remind Ravi Traders"/);
    expect(b.text).toMatch(/📅 GSTR-3B for October 2026: due 20 Nov \(in 3 days\)/);
    expect(b.text).toMatch(/Before filing: 1 entry waiting for approval in NextAi · 1 purchase bill without the supplier's GSTIN/);
    expect(b.text).toMatch(/⏳ 1 item needs your approval/);
    expect(b.text).toMatch(/🏦 1 bank line to check/);
  });

  it('answers "briefing" on WhatsApp', async () => {
    c.chatwoot(A.tenant);
    await postCw(app, cwMessage({ inboxId: A.tenant.cwInboxId!, phone: A.owner.phone!, content: 'briefing', conversationId: 7001 }));
    expect(c.cws.get(A.tenant.id)!.lastText(7001)).toMatch(/☀️ .*\n.*Sales .* today[\s\S]*Cash & bank/);
  });

  it('warns the accountant 7, 2 and 0 days before, once each', async () => {
    const acct = await withSystemTx(c.prisma, (tx) => tx.user.create({ data: { tenantId: A.tenant.id, phone: '+919800000777', name: 'CA Anil', role: 'tenant_accountant' } }));
    const at = new Date('2026-11-13T04:00:00Z'); // 7 days before 20 Nov
    expect(await sendDeadlineWarnings(c, A.tenant, at)).toEqual({ sent: 1 }); // owner gets it in the briefing instead
    expect(await sendDeadlineWarnings(c, A.tenant, at)).toEqual({ sent: 0 });
    const msg = c.cws.get(A.tenant.id)!.sent.at(-1)!;
    expect(msg.content).toMatch(/GSTR-3B for October 2026 is due in 7 days \(20 Nov\)[\s\S]*Before filing/);
    expect(await sendDeadlineWarnings(c, A.tenant, new Date('2026-11-15T04:00:00Z'))).toEqual({ sent: 0 }); // 5 days: no warning
    expect(await sendDeadlineWarnings(c, A.tenant, new Date('2026-11-18T04:00:00Z'))).toEqual({ sent: 1 }); // 2 days
    void acct;
  });
});
