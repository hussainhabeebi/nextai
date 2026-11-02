import type { FastifyInstance, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import type { Container } from '../container.js';
import { tenantDb, withSystemTx } from '../lib/db.js';
import { AppError, unauthorized } from '../lib/errors.js';

declare module 'fastify' {
  interface FastifyInstance {
    loadTenant: (req: FastifyRequest) => Promise<void>;
  }
}

/** Resolves request.tenant + request.db from the verified JWT claim (never from body/query). */
export default fp(async function tenantPlugin(app: FastifyInstance, opts: { c: Container }) {
  app.decorate('loadTenant', async (req: FastifyRequest) => {
    if (!req.user) throw unauthorized();
    const tenantId = req.user.tid;
    const tenant = await withSystemTx(opts.c.prisma, (tx) => tx.tenant.findUnique({ where: { id: tenantId } }));
    if (!tenant) throw unauthorized();
    req.tenant = tenant;
    req.db = tenantDb(opts.c.prisma, tenant.id);
    // Suspended tenants are read-only (billing routes stay open so they can pay).
    const isWrite = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    if (tenant.status === 'suspended' && isWrite && !req.url.startsWith('/v1/billing') && !req.url.startsWith('/v1/auth')) {
      throw new AppError(402, 'tenant_suspended', 'Account suspended. Please update billing to continue.');
    }
  });
});
