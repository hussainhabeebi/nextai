import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { FastifyAdapter } from '@bull-board/fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { isProd } from '../../config/env.js';
import type { Container } from '../../container.js';
import { hmacSha256, safeEqual } from '../../lib/crypto.js';
import { BullJobQueue } from '../../lib/queue.js';
import { env } from '../../config/env.js';
import { audit } from '../../modules/audit/audit.js';
import { adminAuthRoutes } from './auth.js';
import { platformRoutes } from './platform.js';

const BOARD_COOKIE = 'nx_board';
const signBoard = (adminId: string, exp: number) => `${adminId}.${exp}.${hmacSha256(env().JWT_SECRET, `board:${adminId}:${exp}`)}`;
const verifyBoard = (token: string | undefined) => {
  if (!token) return false;
  const [id, exp, sig] = token.split('.');
  return !!id && !!exp && !!sig && Number(exp) > Date.now() / 1000 && safeEqual(sig, hmacSha256(env().JWT_SECRET, `board:${id}:${exp}`));
};

export const adminRoutes =
  (c: Container): FastifyPluginAsyncZod =>
  async (app) => {
    await app.register(adminAuthRoutes(c), { prefix: '/auth' });
    await app.register(platformRoutes(c));

    // Bull Board job monitor (super_admin only). The admin UI fetches a 10-minute token, then opens
    // /admin/v1/queues?t=<token>; the token is moved into an httpOnly cookie scoped to the board path.
    app.post('/jobs/board-token', { onRequest: app.requireAdmin(['super_admin']) }, async (req) => {
      const exp = Math.floor(Date.now() / 1000) + 600;
      await audit(c.prisma, { actorId: req.admin!.sub, actorType: 'admin', channel: 'admin', action: 'jobs.board_open', entity: 'queue', ip: req.ip });
      return { url: `${env().API_URL}/admin/v1/queues?t=${signBoard(req.admin!.sub, exp)}` };
    });

    if (c.queue instanceof BullJobQueue) {
      const queue = c.queue;
      await app.register(async (board) => {
        board.addHook('onRequest', async (req, reply) => {
          const q = (req.query as { t?: string }).t;
          if (verifyBoard(q)) {
            reply.setCookie(BOARD_COOKIE, q!, { httpOnly: true, secure: isProd(), sameSite: 'strict', path: '/admin/v1/queues', maxAge: 600 });
            return;
          }
          if (!verifyBoard(req.cookies[BOARD_COOKIE])) return reply.code(401).send({ error: 'unauthorized' });
        });
        const adapter = new FastifyAdapter();
        createBullBoard({ queues: queue.allQueues().map((q) => new BullMQAdapter(q)), serverAdapter: adapter });
        adapter.setBasePath('/admin/v1/queues');
        await board.register(adapter.registerPlugin(), { prefix: '/queues' });
      });
    }
  };
