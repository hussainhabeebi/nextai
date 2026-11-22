import type { Container } from '../../container.js';
import { withSystemTx } from '../../lib/db.js';
import { importStatement } from './service.js';

/** bank.statement: a statement sent on WhatsApp → imported, matched, summary back in the chat. */
export async function processStatementJob(c: Container, job: { tenantId: string; r2Key: string; mime: string; name?: string; conversationId?: number; userId?: string }) {
  const tenant = await withSystemTx(c.prisma, (tx) => tx.tenant.findUniqueOrThrow({ where: { id: job.tenantId } }));
  const obj = await c.storage.get(tenant.id, job.r2Key);
  const r = await importStatement(c, tenant, { content: obj.body, mime: job.mime, name: job.name }, { userId: job.userId });
  if (job.conversationId) await c.chatwoot(tenant).sendText(job.conversationId, r.text);
  return r;
}
