import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Container } from '../../container.js';
import { signupRequestSchema, startSignup, verifySignup } from '../../modules/signup/service.js';

/** Public self-signup from the website: email code first, nothing is created until it's verified. */
export const signupRoutes =
  (c: Container): FastifyPluginAsyncZod =>
  async (app) => {
    const strict = { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } };
    app.post(
      '/',
      { ...strict, schema: { tags: ['signup'], body: signupRequestSchema, response: { 200: z.object({ signupId: z.string(), devCode: z.string().optional() }) } } },
      async (req) => startSignup(c, req.body),
    );
    app.post(
      '/verify',
      {
        config: { rateLimit: { max: 10, timeWindow: '10 minutes' } },
        schema: { tags: ['signup'], body: z.object({ signupId: z.string().regex(/^[a-f0-9]{32}$/), code: z.string().regex(/^\d{6}$/) }) },
      },
      async (req) => verifySignup(c, req.body.signupId, req.body.code, req.ip),
    );
  };
