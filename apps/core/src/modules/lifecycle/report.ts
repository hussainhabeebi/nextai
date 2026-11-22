import type { Container } from '../../container.js';
import { tenantDb } from '../../lib/db.js';

/** Funnel stages, in order: the rule whose timers count documents reaching that stage. */
const FUNNEL = [
  { key: 'lead.assign', label: 'Leads' },
  { key: 'demo.reminder', label: 'Demos scheduled' },
  { key: 'proposal.followup', label: 'Proposals sent' },
  { key: 'deal.won', label: 'Deals won' },
  { key: 'handover.project', label: 'Paid / onboarding' },
  { key: 'golive', label: 'Live' },
] as const;

/**
 * Lifecycle report for the last `days` days:
 * - funnel (documents reaching each stage) and lead sources,
 * - per stage: started, done, cancelled, open and escalated,
 * - per owner: open, escalated, done,
 * - open escalations (the current overdue list).
 */
export async function lifecycleReport(c: Container, tenantId: string, days: number, now = new Date()) {
  const db = tenantDb(c.prisma, tenantId);
  const since = new Date(now.getTime() - days * 86400_000);
  const [rules, timers, openTimers] = await Promise.all([
    db.lifecycleRule.findMany({ include: { levels: true }, orderBy: [{ stage: 'asc' }, { key: 'asc' }] }),
    db.lifecycleTimer.findMany({ where: { createdAt: { gte: since } }, include: { owner: { select: { id: true, name: true } } } }),
    db.lifecycleTimer.findMany({ where: { status: 'open' }, include: { owner: { select: { id: true, name: true } } }, orderBy: { anchorAt: 'asc' } }),
  ]);
  const ruleById = new Map(rules.map((r) => [r.id, r]));
  const escalated = (t: { ruleId: string; sentLevels: number[] }) =>
    ruleById.get(t.ruleId)?.levels.some((l) => (l.audience === 'escalation' || l.audience === 'management') && t.sentLevels.includes(l.level) && l.offsetMinutes > 0) ?? false;
  const keyOf = (t: { ruleId: string }) => ruleById.get(t.ruleId)?.key;

  const funnel = FUNNEL.map((f) => ({ ...f, count: timers.filter((t) => keyOf(t) === f.key).length }));
  const funnelWithRate = funnel.map((f, i) => ({ ...f, conversion: i === 0 || !funnel[i - 1]!.count ? null : Math.round((f.count / funnel[i - 1]!.count) * 100) }));

  const sources: Record<string, number> = {};
  for (const t of timers.filter((x) => keyOf(x) === 'lead.assign')) {
    const src = (t.context as Record<string, string>).source ?? 'unknown';
    sources[src] = (sources[src] ?? 0) + 1;
  }

  const stages = rules.map((r) => {
    const mine = timers.filter((t) => t.ruleId === r.id);
    return {
      key: r.key,
      stage: r.stage,
      name: r.name,
      enabled: r.enabled,
      started: mine.length,
      done: mine.filter((t) => t.status === 'done').length,
      cancelled: mine.filter((t) => t.status === 'cancelled').length,
      open: openTimers.filter((t) => t.ruleId === r.id).length,
      escalated: mine.filter(escalated).length,
    };
  });

  const owners = new Map<string, { name: string; open: number; escalated: number; done: number }>();
  const row = (o: { id: string; name: string } | null) => {
    const id = o?.id ?? 'unassigned';
    if (!owners.has(id)) owners.set(id, { name: o?.name ?? 'Unassigned', open: 0, escalated: 0, done: 0 });
    return owners.get(id)!;
  };
  for (const t of openTimers) {
    const r = row(t.owner);
    r.open++;
    if (escalated(t)) r.escalated++;
  }
  for (const t of timers.filter((x) => x.status === 'done')) row(t.owner).done++;

  const overdue = openTimers.filter(escalated).map((t) => ({
    id: t.id,
    rule: ruleById.get(t.ruleId)?.name ?? '',
    doctype: t.doctype,
    docName: t.docName,
    customerName: t.customerName,
    owner: t.owner?.name ?? null,
    anchorAt: t.anchorAt,
  }));

  return { days, funnel: funnelWithRate, sources, stages, owners: [...owners.values()].sort((a, b) => b.escalated - a.escalated || b.open - a.open), overdue };
}
