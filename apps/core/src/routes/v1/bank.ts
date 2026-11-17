import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Container } from '../../container.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { importStatement } from '../../modules/banking/service.js';

/** Bank matching: upload a statement, see what still needs an answer. */
export const bankRoutes =
  (c: Container): FastifyPluginAsyncZod =>
  async (app) => {
    app.post('/bank/statement', { schema: { tags: ['app'], consumes: ['multipart/form-data'] } }, async (req) => {
      const part = await req.file();
      if (!part) throw badRequest('Attach a statement file');
      const name = part.filename ?? '';
      const csv = /csv|comma-separated|text\/plain|vnd\.ms-excel/i.test(part.mimetype) || /\.csv$/i.test(name);
      if (!csv && !/pdf|image\//.test(part.mimetype)) throw badRequest('Send the statement as CSV (best) or PDF.');
      const r = await importStatement(c, req.tenant!, { content: await part.toBuffer(), mime: csv ? 'text/csv' : part.mimetype, name }, { userId: req.user!.sub });
      return r;
    });

    app.get(
      '/bank/lines',
      { schema: { tags: ['app'], querystring: z.object({ status: z.enum(['open', 'all']).default('open') }) } },
      async (req) => {
        const where = req.query.status === 'open' ? { OR: [{ status: 'unmatched' }, { status: 'suggested', draftId: null }] } : {};
        const [items, waiting, matched] = await Promise.all([
          req.db!.bankLine.findMany({ where, orderBy: [{ date: 'desc' }, { createdAt: 'desc' }], take: 200 }),
          req.db!.bankLine.count({ where: { status: 'suggested', draftId: { not: null } } }),
          req.db!.bankLine.count({ where: { status: 'matched' } }),
        ]);
        return {
          items: items.map((l) => ({ id: l.id, date: l.date, amount: Number(l.amount), direction: l.direction, description: l.description, reference: l.reference, source: l.source, status: l.status, matchType: l.matchType, matchName: l.matchName, draftId: l.draftId })),
          waitingApproval: waiting,
          matched,
        };
      },
    );

    app.post('/bank/lines/:id/ignore', { schema: { tags: ['app'], params: z.object({ id: z.string().uuid() }) } }, async (req) => {
      const line = await req.db!.bankLine.findUnique({ where: { id: req.params.id } });
      if (!line) throw notFound('Bank line');
      await req.db!.bankLine.update({ where: { id: line.id }, data: { status: 'ignored' } });
      return { ok: true };
    });
  };
