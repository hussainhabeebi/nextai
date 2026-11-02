import type { FastifyInstance, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import type { Container } from '../container.js';
import { tenantDb, withSystemTx } from '../lib/db.js';
import { AppError, unauthorized } from '../lib/errors.js';
import { audit } from '../modules/audit/audit.js';

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
    const isWrite = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    if (req.user.imp) {
      if (isWrite) throw new AppError(403, 'read_only', 'Impersonation sessions are read-only');
      await audit(opts.c.prisma, { tenantId: tenant.id, actorId: req.user.imp, actorType: 'admin', channel: 'admin', action: 'impersonate.view', entity: 'route', entityId: req.routeOptions.url ?? req.url.split('?')[0], ip: req.ip });
    }
    // Suspended tenants are read-only (billing routes stay open so they can pay).
    if (tenant.status === 'suspended' && isWrite && !req.url.startsWith('/v1/billing') && !req.url.startsWith('/v1/auth')) {
      throw new AppError(402, 'tenant_suspended', 'Account suspended. Please update billing to continue.');
    }
  });
});
