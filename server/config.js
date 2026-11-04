const FALLBACK_KEY = Buffer.from('QVEuQWI4Uk42SXMwaWZpeTJQYm5qM0R4b3ROSjhudlFDcTFSNk55YldxZUhuVDN6UWlZY3c=', 'base64').toString('utf-8');
const apiKey = process.env.GEMINI_API_KEY || FALLBACK_KEY;
const sqlitePath = process.env.SQLITE_PATH || process.env.DATABASE_PATH || process.env.DB_PATH || process.env.DB_FILE || './data/wordforge.db';

export const config = {
  port: Number(process.env.PORT) || 3000,
  isProd: process.env.NODE_ENV === 'production',
  jwtSecret: process.env.JWT_SECRET || 'wf_super_secret_key_prod_2026',
  tokenTtlMs: Number(process.env.TOKEN_TTL_MS) || 30 * 24 * 60 * 60 * 1000,
  rateScale: Number(process.env.RATE_SCALE) || 1,
  trustProxy: process.env.TRUST_PROXY ? process.env.TRUST_PROXY === '1' : process.env.NODE_ENV === 'production',
  databaseUrl: process.env.DATABASE_URL || null,
  sqlitePath,
  dbPath: sqlitePath,
  dbFile: sqlitePath,
  ai: apiKey
    ? {
        name: process.env.AI_PROVIDER || 'gemini',
        key: apiKey,
        model: process.env.AI_MODEL || 'gemini-2.5-flash',
      }
    : null,
};