import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  hasZodFastifySchemaValidationErrors,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { env, isProd } from './config/env.js';
import type { Container } from './container.js';
import { AppError } from './lib/errors.js';
import { loggerOptions } from './lib/logger.js';
import { TenantScopeError } from './lib/db.js';
import authPlugin from './plugins/auth.js';
import tenantPlugin from './plugins/tenant.js';
import { adminRoutes } from './routes/admin/index.js';
import { healthRoutes } from './routes/health.js';
import { v1Routes } from './routes/v1/index.js';
import { webhookRoutes } from './routes/webhooks/index.js';

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

export async function buildApp(c: Container): Promise<FastifyInstance> {
  const e = env();
  const app = Fastify({
    logger: e.NODE_ENV === 'test' ? false : loggerOptions(e.LOG_LEVEL),
    trustProxy: true, // behind Cloudflare Tunnel
    bodyLimit: 2 * 1024 * 1024,
    genReqId: () => crypto.randomUUID(),
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Keep the raw body for webhook signature verification.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body: Buffer, done) => {
    req.rawBody = body;
    if (body.length === 0) return done(null, {});
    try {
      done(null, JSON.parse(body.toString('utf8')));
    } catch (err) {
      (err as AppError & { statusCode: number }).statusCode = 400;
      done(err as Error, undefined);
    }
  });

  await app.register(helmet, { contentSecurityPolicy: false });
  const origins = e.CORS_ORIGINS.length ? e.CORS_ORIGINS : [e.APP_URL];
  await app.register(cors, { origin: origins, credentials: true });
  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: 15 * 1024 * 1024, files: 10 } });
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: '1 minute',
    redis: e.NODE_ENV === 'test' ? undefined : c.redis,
    nameSpace: 'rl:',
    // per-tenant when authenticated (tid in JWT is verified later; here only used as a bucket key), else per IP
    keyGenerator: (req) => req.ip,
  });

  await app.register(swagger, {
    openapi: {
      info: { title: 'NextAi API', version: '0.1.0' },
      servers: [{ url: e.API_URL }],
      components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } },
    },
    transform: jsonSchemaTransform,
  });
  if (!isProd() || e.DOCS_PUBLIC) {
    await app.register(swaggerUi, { routePrefix: '/docs' });
  }

  await app.register(authPlugin);
  await app.register(tenantPlugin, { c });

  app.setErrorHandler((err, req, reply) => {
    if (hasZodFastifySchemaValidationErrors(err)) {
      return reply.code(400).send({ error: 'validation_error', message: 'Invalid request', details: err.validation });
    }
    if (err instanceof AppError) {
      return reply.code(err.statusCode).send({ error: err.code, message: err.message, details: err.details });
    }
    if (err instanceof TenantScopeError) {
      req.log.error({ err: err.message }, 'tenant scope violation');
      return reply.code(403).send({ error: 'forbidden', message: 'Forbidden' });
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) req.log.error({ err }, 'unhandled error');
    return reply.code(status).send({ error: status === 429 ? 'rate_limited' : 'error', message: status >= 500 ? 'Internal error' : (err as Error).message });
  });

  await app.register(healthRoutes(c));
  await app.register(webhookRoutes(c), { prefix: '/webhooks' });
  await app.register(v1Routes(c), { prefix: '/v1' });
  await app.register(adminRoutes(c), { prefix: '/admin/v1' });

  return app;
}
