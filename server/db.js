// One tiny async interface over two engines:
//   - SQLite (built into Node 22+, zero setup)   -> local development
//   - PostgreSQL (the "pg" package)              -> production (set DATABASE_URL)
// All SQL in the project uses $1, $2 placeholders and portable syntax so both engines run the same queries.
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export async function openDb({ databaseUrl, sqlitePath }) {
  return databaseUrl ? openPostgres(databaseUrl) : openSqlite(sqlitePath);
}

async function openSqlite(path) {
  const { DatabaseSync } = await import('node:sqlite');
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const raw = new DatabaseSync(path);
  raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  const cache = new Map();
  // SQLite understands numbered parameters as ?1, ?2 ... so "$1" is rewritten to "?1".
  const stmt = (sql) => {
    if (!cache.has(sql)) cache.set(sql, raw.prepare(sql.replace(/\$(\d+)/g, '?$1')));
    return cache.get(sql);
  };
  return {
    dialect: 'sqlite',
    async all(sql, params = []) { return stmt(sql).all(...params); },
    async get(sql, params = []) { return stmt(sql).get(...params); },
    async run(sql, params = []) { return { changes: Number(stmt(sql).run(...params).changes) }; },
    async close() { raw.close(); },
  };
}

async function openPostgres(url) {
  const pg = (await import('pg')).default;
  pg.types.setTypeParser(20, Number); // BIGINT / COUNT(*) arrive as numbers, not strings
  const pool = new pg.Pool({
    connectionString: url,
    max: 10,
    // Managed databases usually need TLS. Put ?sslmode=require in the URL, or set PGSSL=1.
    ssl: process.env.PGSSL === '1' ? { rejectUnauthorized: false } : undefined,
  });
  return {
    dialect: 'pg',
    async all(sql, params = []) { return (await pool.query(sql, params)).rows; },
    async get(sql, params = []) { return (await pool.query(sql, params)).rows[0]; },
    async run(sql, params = []) { return { changes: (await pool.query(sql, params)).rowCount }; },
    async close() { await pool.end(); },
  };
}

export function isUniqueViolation(error) {
  return error?.code === '23505' || /UNIQUE constraint failed/i.test(error?.message ?? '');
}

export async function migrate(db) {
  const PK = db.dialect === 'pg' ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
  const statements = [
    `CREATE TABLE IF NOT EXISTS users (
       id ${PK},
       username TEXT NOT NULL,
       username_lower TEXT NOT NULL UNIQUE,
       password_hash TEXT NOT NULL,
       xp INTEGER NOT NULL DEFAULT 0,
       created_at BIGINT NOT NULL
     )`,
    // Themes that players published for everybody to play.
    `CREATE TABLE IF NOT EXISTS themes (
       id ${PK},
       name TEXT NOT NULL,
       language TEXT NOT NULL,
       created_by INTEGER NOT NULL REFERENCES users(id),
       plays INTEGER NOT NULL DEFAULT 0,
       created_at BIGINT NOT NULL,
       UNIQUE (name, language)
     )`,
    `CREATE TABLE IF NOT EXISTS theme_likes (
       theme_id INTEGER NOT NULL REFERENCES themes(id) ON DELETE CASCADE,
       user_id INTEGER NOT NULL REFERENCES users(id),
       PRIMARY KEY (theme_id, user_id)
     )`,
    // Word pool: the built-in bank and every word the AI generated (cached so the AI is called rarely).
    `CREATE TABLE IF NOT EXISTS words (
       id ${PK},
       theme TEXT NOT NULL,
       language TEXT NOT NULL,
       word TEXT NOT NULL,
       length INTEGER NOT NULL,
       difficulty INTEGER NOT NULL DEFAULT 2,
       clue TEXT NOT NULL DEFAULT '',
       explanation TEXT,
       source TEXT NOT NULL DEFAULT 'ai',
       created_at BIGINT NOT NULL,
       UNIQUE (theme, language, word)
     )`,
    `CREATE INDEX IF NOT EXISTS idx_words_pool ON words (language, theme, length, difficulty)`,
    // Cache of "is this a real word?" answers for guesses.
    `CREATE TABLE IF NOT EXISTS dictionary (
       language TEXT NOT NULL,
       word TEXT NOT NULL,
       valid INTEGER NOT NULL,
       PRIMARY KEY (language, word)
     )`,
    `CREATE TABLE IF NOT EXISTS daily_words (
       day TEXT NOT NULL,
       language TEXT NOT NULL,
       word_id INTEGER NOT NULL REFERENCES words(id),
       PRIMARY KEY (day, language)
     )`,
    `CREATE TABLE IF NOT EXISTS games (
       id ${PK},
       user_id INTEGER NOT NULL REFERENCES users(id),
       word_id INTEGER NOT NULL REFERENCES words(id),
       mode TEXT NOT NULL,
       theme TEXT NOT NULL,
       language TEXT NOT NULL,
       length INTEGER NOT NULL,
       max_attempts INTEGER NOT NULL,
       time_limit_ms BIGINT,
       status TEXT NOT NULL DEFAULT 'playing',
       attempts INTEGER NOT NULL DEFAULT 0,
       hints_used INTEGER NOT NULL DEFAULT 0,
       hints TEXT NOT NULL DEFAULT '[]',
       score INTEGER NOT NULL DEFAULT 0,
       xp_gained INTEGER NOT NULL DEFAULT 0,
       daily_day TEXT,
       room_code TEXT,
       started_at BIGINT NOT NULL,
       finished_at BIGINT,
       UNIQUE (user_id, daily_day)
     )`,
    `CREATE INDEX IF NOT EXISTS idx_games_user ON games (user_id, status)`,
    `CREATE INDEX IF NOT EXISTS idx_games_finished ON games (finished_at)`,
    `CREATE TABLE IF NOT EXISTS guesses (
       id ${PK},
       game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
       idx INTEGER NOT NULL,
       guess TEXT NOT NULL,
       pattern TEXT NOT NULL,
       created_at BIGINT NOT NULL,
       UNIQUE (game_id, idx)
     )`,
    `CREATE TABLE IF NOT EXISTS user_achievements (
       user_id INTEGER NOT NULL REFERENCES users(id),
       code TEXT NOT NULL,
       earned_at BIGINT NOT NULL,
       PRIMARY KEY (user_id, code)
     )`,
  ];
  for (const sql of statements) await db.run(sql);
}
