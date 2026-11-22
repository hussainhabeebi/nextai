import type { ErpClient } from '@nextai/erpnext-client';
import type { Tenant } from '@prisma/client';
import type { Container } from '../../container.js';
import { tenantDb } from '../../lib/db.js';
import { erpContext } from '../erpnext/mappers.js';
import { localDate } from '../outbound/jobs.js';

export const HEALTH_FIELD = 'custom_health_score';

export interface HealthBreakdown {
  score: number;
  openIssues: number;
  overdueInvoices: number;
  overdueTasks: number;
  escalatedSteps: number;
  reasons: string[];
}

/**
 * Customer health score (0-100) for a project, from facts NextAi can see:
 *   −10 per open Issue (max −30), −20 per overdue unpaid invoice (max −40),
 *   −5 per overdue open Task (max −20), −5 per lifecycle step that reached escalation in the last 30 days (max −20).
 */
export async function computeHealth(c: Container, tenant: Tenant, erp: ErpClient, project: { name: string; customer?: string | null }, now = new Date()): Promise<HealthBreakdown> {
  const { settings } = erpContext(tenant);
  const today = localDate(settings.timezone, now);
  const customer = project.customer ?? undefined;
  const [issues, invoices, tasks] = await Promise.all([
    customer ? erp.list('Issue', { filters: [['customer', '=', customer], ['status', 'in', ['Open', 'Replied', 'On Hold']]], fields: ['name'], limit: 100 }) : Promise.resolve([]),
    customer
      ? erp.list('Sales Invoice', { filters: [['customer', '=', customer], ['docstatus', '=', 1], ['outstanding_amount', '>', 0]], fields: ['name', 'due_date'], limit: 100 })
      : Promise.resolve([]),
    erp.list('Task', { filters: [['project', '=', project.name], ['status', 'in', ['Open', 'Working', 'Pending Review', 'Overdue']]], fields: ['name', 'exp_end_date'], limit: 200 }),
  ]);
  const overdueInvoices = invoices.filter((i) => typeof i.due_date === 'string' && i.due_date < today).length;
  const overdueTasks = tasks.filter((t) => typeof t.exp_end_date === 'string' && t.exp_end_date < today).length;

  const since = new Date(now.getTime() - 30 * 86400_000);
  const timers = await tenantDb(c.prisma, tenant.id).lifecycleTimer.findMany({
    where: { createdAt: { gte: since }, OR: [{ docName: project.name }, ...(customer ? [{ customerName: customer }] : [])] },
    include: { rule: { include: { levels: true } } },
  });
  const escalatedSteps = timers.filter((t) => t.rule.levels.some((l) => (l.audience === 'escalation' || l.audience === 'management') && t.sentLevels.includes(l.level) && !t.rule.key.startsWith('review.') && t.rule.key !== 'golive' && t.rule.key !== 'deal.won')).length;

  const reasons: string[] = [];
  let score = 100;
  const penalty = (n: number, each: number, max: number, label: string) => {
    if (n <= 0) return;
    const p = Math.min(max, n * each);
    score -= p;
    reasons.push(`${n} ${label} (−${p})`);
  };
  penalty(issues.length, 10, 30, 'open issue(s)');
  penalty(overdueInvoices, 20, 40, 'overdue invoice(s)');
  penalty(overdueTasks, 5, 20, 'overdue task(s)');
  penalty(escalatedSteps, 5, 20, 'escalated step(s)');
  return { score: Math.max(0, score), openIssues: issues.length, overdueInvoices, overdueTasks, escalatedSteps, reasons };
}
