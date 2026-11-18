import { formatMoney, type Currency, type DraftPayload } from '@nextai/shared';
import type { Tenant } from '@prisma/client';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Container } from '../../container.js';
import { tenantDb } from '../../lib/db.js';
import { daysBetween, upcomingDeadlines } from '../../modules/briefing/deadlines.js';
import { erpContext } from '../../modules/erpnext/mappers.js';
import { localDate } from '../../modules/outbound/time.js';
import { membershipsForPhone } from './auth.js';

const OPEN = ['needs_review', 'pending', 'failed'] as const;
const withTimeout = <T>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<undefined>((r) => setTimeout(() => r(undefined), ms))]);

/** Overdue receivables from ERPNext; undefined when the site doesn't answer in time (never a made-up zero). */
async function overdue(c: Container, t: Tenant, today: string) {
  try {
    const rows = await withTimeout(
      c.erp(t).list<{ outstanding_amount: number }>('Sales Invoice', { filters: [['docstatus', '=', 1], ['outstanding_amount', '>', 0], ['due_date', '<', today]], fields: ['outstanding_amount'], limit: 1000 }),
      4000,
    );
    return rows ? { count: rows.length, amount: rows.reduce((s, r) => s + Number(r.outstanding_amount), 0) } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Accountant portal: every business this person (by phone) works on, with what needs attention, and one review
 * queue across all of them. Read-only: acting on a business switches into it (POST /v1/auth/switch).
 */
export const portalRoutes =
  (c: Container): FastifyPluginAsyncZod =>
  async (app) => {
    app.get('/portal', { schema: { tags: ['app'] } }, async (req) => {
      const me = await req.db!.user.findUnique({ where: { id: req.user!.sub } });
      const members = (me?.phone ? await membershipsForPhone(c, me.phone) : []).flatMap((m) => (m.tenant ? [{ ...m, tenant: m.tenant, tenantId: m.tenant.id }] : []));
      const businesses = await Promise.all(
        members.slice(0, 60).map(async (m) => {
          const t = m.tenant;
          const db = tenantDb(c.prisma, t.id);
          const settings = erpContext(t).settings;
          const today = localDate(settings.timezone);
          const [counts, bankToCheck, last, owed] = await Promise.all([
            db.draft.groupBy({ by: ['status'], where: { status: { in: [...OPEN] } }, _count: true }),
            db.bankLine.count({ where: { OR: [{ status: 'unmatched' }, { status: 'suggested', draftId: null }] } }),
            db.draft.findFirst({ orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
            overdue(c, t, today),
          ]);
          const n = (s: string) => counts.find((x) => x.status === s)?._count ?? 0;
          const next = upcomingDeadlines(t.country, settings, today, 45)[0];
          const cur = t.currency as Currency;
          return {
            tenantId: t.id,
            name: t.name,
            role: m.role,
            country: t.country,
            status: t.status,
            needsReview: n('needs_review'),
            pending: n('pending'),
            failed: n('failed'),
            bankToCheck,
            overdue: owed ? { count: owed.count, amount: owed.amount, text: formatMoney(owed.amount, cur) } : null,
            nextDeadline: next ? { what: next.what, due: next.due, daysLeft: daysBetween(today, next.due) } : null,
            lastActivity: last?.createdAt ?? null,
            current: t.id === req.tenant!.id,
          };
        }),
      );
      const attention = (b: (typeof businesses)[number]) => b.failed * 100 + b.needsReview * 10 + b.pending + b.bankToCheck + (b.nextDeadline && b.nextDeadline.daysLeft <= 7 ? 50 : 0);
      businesses.sort((a, b) => attention(b) - attention(a) || a.name.localeCompare(b.name));

      // One queue across businesses: failed first, then needs review, oldest first.
      const queue = (
        await Promise.all(
          members.slice(0, 60).map(async (m) =>
            (await tenantDb(c.prisma, m.tenantId).draft.findMany({ where: { status: { in: [...OPEN] } }, orderBy: { createdAt: 'asc' }, take: 20 })).map((d) => {
              const p = d.payload as DraftPayload;
              return {
                tenantId: m.tenantId,
                business: m.tenant.name,
                draftId: d.id,
                type: d.type,
                status: d.status,
                party: p.partyName ?? p.remarks ?? null,
                total: formatMoney(p.total, (p.currency ?? m.tenant.currency) as Currency),
                date: p.date,
                error: d.error,
                createdAt: d.createdAt,
              };
            }),
          ),
        )
      )
        .flat()
        .sort((a, b) => ['failed', 'needs_review', 'pending'].indexOf(a.status) - ['failed', 'needs_review', 'pending'].indexOf(b.status) || +a.createdAt - +b.createdAt)
        .slice(0, 100);
      return { businesses, queue };
    });
  };
