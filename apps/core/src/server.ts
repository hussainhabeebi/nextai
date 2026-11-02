import { buildApp } from './app.js';
import { createContainer } from './bootstrap.js';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';

const c = createContainer();
const app = await buildApp(c);
const e = env();
await app.listen({ port: e.PORT, host: e.HOST });

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    logger.info({ sig }, 'shutting down');
    await app.close();
    await c.close();
    process.exit(0);
  });
}
