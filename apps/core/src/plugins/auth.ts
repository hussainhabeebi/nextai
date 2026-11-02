import type { PlatformRole, Tenant } from '@prisma/client';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { forbidden, unauthorized } from '../lib/errors.js';
import { verifyAccess, type AdminClaims, type AppClaims } from '../modules/auth/tokens.js';
import type { TenantDb } from '../lib/db.js';

declare module 'fastify' {
  interface FastifyRequest {
    user?: AppClaims;
    admin?: AdminClaims;
    tenant?: Tenant;
    db?: TenantDb;
  }
  interface FastifyInstance {
    requireApp: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireAdmin: (roles?: PlatformRole[]) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

function bearer(req: FastifyRequest): string {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) throw unauthorized();
  return h.slice(7);
}

export default fp(async function authPlugin(app: FastifyInstance) {
  app.decorateRequest('user', undefined);
  app.decorateRequest('admin', undefined);
  app.decorateRequest('tenant', undefined);
  app.decorateRequest('db', undefined);

  /** App (customer) auth. Tenant comes ONLY from the JWT `tid` claim. */
  app.decorate('requireApp', async (req: FastifyRequest) => {
    try {
      req.user = await verifyAccess<AppClaims>(bearer(req), 'app');
    } catch {
      throw unauthorized();
    }
  });

  app.decorate('requireAdmin', (roles?: PlatformRole[]) => async (req: FastifyRequest) => {
    let claims: AdminClaims;
    try {
      claims = await verifyAccess<AdminClaims>(bearer(req), 'admin');
    } catch {
      throw unauthorized();
    }
    if (roles && !roles.includes(claims.prole)) throw forbidden('Insufficient platform role');
    req.admin = claims;
  });
});
