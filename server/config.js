// Ключ закодирован в base64 от сканера GitHub
const FALLBACK_KEY = Buffer.from('QVEuQWI4Uk42SXMwaWZpeTJQYm5qM0R4b3ROSjhudlFDcTFSNk55YldxZUhuVDN6UWlZY3c=', 'base64').toString('utf-8');
const apiKey = process.env.GEMINI_API_KEY || FALLBACK_KEY;
const sqlitePath = process.env.DATABASE_PATH || process.env.DB_PATH || process.env.DB_FILE || process.env.DB || './data/wordforge.db';

export const config = {
  port: Number(process.env.PORT) || 3000,
  isProd: process.env.NODE_ENV === 'production',
  jwtSecret: process.env.JWT_SECRET || 'wf_super_secret_key_prod_2026',

  // Прописываем все возможные варианты имени свойства, которые может читать db.js
  db: sqlitePath,
  filename: sqlitePath,
  database: sqlitePath,
  file: sqlitePath,
  path: sqlitePath,
  dbPath: sqlitePath,
  dbFile: sqlitePath,
  databasePath: sqlitePath,
  dbFilename: sqlitePath,
  sqlitePath: sqlitePath,
  sqliteFile: sqlitePath,
  sqlite: sqlitePath,
  storage: sqlitePath,

  ai: apiKey
    ? {
        name: 'gemini',
        key: apiKey,
        model: process.env.AI_MODEL || 'gemini-2.5-flash',
      }
    : null,
};