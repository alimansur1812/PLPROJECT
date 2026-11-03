// All settings come from environment variables (see .env.example).
const env = process.env;

// Model ids change often; override with AI_MODEL if your provider returns "model not found".
const DEFAULT_MODELS = {
  gemini: 'gemini-3.1-flash-lite',
  anthropic: 'claude-haiku-5-5',
  openai: '', // no safe default: set AI_MODEL when using OpenAI
};

function pickAi() {
  const forced = (env.AI_PROVIDER || '').toLowerCase();
  if (forced === 'off' || forced === 'none') return null;
  const keys = { gemini: env.GEMINI_API_KEY, anthropic: env.ANTHROPIC_API_KEY, openai: env.OPENAI_API_KEY };
  const name = forced || Object.keys(keys).find((k) => keys[k]);
  if (!name || !keys[name]) return null;
  return { name, key: keys[name], model: env.AI_MODEL || DEFAULT_MODELS[name] || '' };
}

export const config = {
  env: env.NODE_ENV || 'development',
  isProd: env.NODE_ENV === 'production',
  port: Number(env.PORT) || 3000,
  databaseUrl: env.DATABASE_URL || '',
  sqlitePath: env.SQLITE_PATH || './data/wordforge.db',
  jwtSecret: env.JWT_SECRET || '',
  tokenTtlMs: 7 * 24 * 3600 * 1000,
  trustProxy: env.TRUST_PROXY === '1',
  rateScale: 1, // tests raise this to relax rate limits
  ai: pickAi(),
};
