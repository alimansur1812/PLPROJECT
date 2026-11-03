import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initAi } from './ai.js';
import { config } from './config.js';
import { migrate, openDb } from './db.js';
import { createHandler } from './http.js';
import { attachRooms } from './rooms.js';
import { buildRouter } from './routes.js';
import { seedBank } from './words.js';

const here = dirname(fileURLToPath(import.meta.url));

// Starts everything and returns handles (tests call this with overrides, e.g. an in-memory database).
export async function start(overrides = {}) {
  Object.assign(config, overrides);
  if (!config.jwtSecret) {
    if (!config.jwtSecret) config.jwtSecret = 'wf_super_secret_key_prod_2026';
    config.jwtSecret = 'dev-only-secret-change-me';
    console.warn('[auth] JWT_SECRET is not set: using an insecure development secret');
  }

  const db = await openDb(config);
  await migrate(db);
  await seedBank(db);
  // Rooms live in memory, so room games left open by a previous run can never continue.
  await db.run(`UPDATE games SET status = 'lost', finished_at = $1 WHERE status = 'playing' AND room_code IS NOT NULL`, [Date.now()]);
  initAi();

  const router = buildRouter({ db, config });
  const server = createServer(createHandler({ router, publicDir: resolve(here, '../public') }));
  const rooms = attachRooms(server, { db, config });
  await new Promise((done) => server.listen(config.port, done));
  const { port } = server.address();
  console.log(`[server] WordForge is running on http://localhost:${port} (${db.dialect})`);

  return {
    server, db, port,
    async close() {
      rooms.close();
      server.closeAllConnections?.();
      await new Promise((done) => server.close(done));
      await db.close();
    },
  };
}

// Run directly (npm start), not when imported by tests.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = await start();
  const shutdown = async () => {
    console.log('[server] shutting down');
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
