const FALLBACK_KEY = Buffer.from('QVEuQWI4Uk42SXMwaWZpeTJQYm5qM0R4b3ROSjhudlFDcTFSNk55YldxZUhuVDN6UWlZY3c=', 'base64').toString('utf-8');

const rawProvider = (process.env.AI_PROVIDER || '').trim().toLowerCase();

const rawEnvKey = (
  process.env.GEMINI_API_KEY ||
  process.env.AI_API_KEY ||
  process.env.GOOGLE_API_KEY ||
  process.env.OPENAI_API_KEY ||
  process.env.ANTHROPIC_API_KEY ||
  ''
).trim().replace(/^['"]|['"]$/g, '');

const apiKey = rawProvider === 'off'
  ? ''
  : (rawEnvKey || (process.env.DISABLE_FALLBACK_KEY === '1' ? '' : FALLBACK_KEY));

function detectProvider(key) {
  if (rawProvider && rawProvider !== 'off') return rawProvider;
  if (process.env.ANTHROPIC_API_KEY || key.startsWith('sk-ant-')) return 'anthropic';
  if (process.env.OPENAI_API_KEY || key.startsWith('sk-') || key.startsWith('gsk_')) return 'openai';
  return 'gemini';
}

function detectModel(providerName) {
  if (process.env.AI_MODEL && process.env.AI_MODEL.trim()) return process.env.AI_MODEL.trim();
  if (providerName === 'anthropic') return 'claude-haiku-4-5';
  if (providerName === 'openai') return apiKey.startsWith('gsk_') ? 'llama-3.3-70b-versatile' : null;
  return 'gemini-3.8-flash';
}

const providerName = detectProvider(apiKey);
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
        name: providerName,
        key: apiKey,
        model: detectModel(providerName),
      }
    : null,
};