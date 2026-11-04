import { aiAvailable, checkWord, generateWords, BANNED_GENERIC_WORDS, sanitizeHintText } from './ai.js';
import { BANK } from './wordbank.js';
import { LANGUAGES, dayKey, normalizeWord, sanitizeTheme } from './util.js';

export { BANNED_GENERIC_WORDS, sanitizeHintText };

// Дедупликация параллельных запросов к ИИ (например, когда prewarm и нажатие Start game идут одновременно)
const inflightByTheme = new Map();

export async function seedBank(db) {
  const now = Date.now();
  for (const item of BANK) {
    const word = normalizeWord(item.word, item.language);
    if (!word) continue;
    await db.run(
      `INSERT INTO words (theme, language, word, length, difficulty, clue, source, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'bank', $7)
       ON CONFLICT (theme, language, word) DO NOTHING`,
      [item.theme, item.language, word, word.length, item.difficulty || 2, item.clue || '', now],
    );
    await db.run(
      `INSERT INTO dictionary (language, word, valid)
       VALUES ($1, $2, 1)
       ON CONFLICT (language, word) DO NOTHING`,
      [item.language, word],
    );
  }
}

function isOrthographicallyPlausible(word, language) {
  if (!word || word.length < 4 || word.length > 8) return false;
  if (/(.)\1\1/.test(word)) return false;
  if (language === 'en') {
    if (!/[aeiouy]/.test(word)) return false;
    if (/[bcdfghjklmnpqrstvwxz]{5,}/.test(word)) return false;
  } else if (language === 'ru') {
    if (!/[аеёиоуыэюя]/.test(word)) return false;
    if (/[бвгджзйклмнпрстфхцчшщ]{5,}/.test(word)) return false;
  }
  return true;
}

export async function isValidGuess(dbOrWord, language = 'en', rawWord, theme = 'general') {
  if (typeof dbOrWord === 'string') {
    const lang = LANGUAGES.includes(language) ? language : 'en';
    const w = normalizeWord(dbOrWord, lang);
    return isOrthographicallyPlausible(w, lang);
  }

  const db = dbOrWord;
  const lang = LANGUAGES.includes(language) ? language : 'en';
  const word = normalizeWord(rawWord, lang);
  if (!isOrthographicallyPlausible(word, lang)) return false;

  const inWords = await db.get(
    `SELECT 1 FROM words WHERE language = $1 AND word = $2 LIMIT 1`,
    [lang, word],
  );
  if (inWords) return true;

  const cached = await db.get(
    `SELECT valid FROM dictionary WHERE language = $1 AND word = $2`,
    [lang, word],
  );
  if (cached !== undefined && cached !== null) {
    return Boolean(cached.valid);
  }

  if (aiAvailable()) {
    try {
      const verdict = await checkWord({ word, language: lang, theme: theme || 'general' });
      if (typeof verdict === 'boolean') {
        await db.run(
          `INSERT INTO dictionary (language, word, valid) VALUES ($1, $2, $3)
           ON CONFLICT (language, word) DO UPDATE SET valid = $3`,
          [lang, word, verdict ? 1 : 0],
        );
        return verdict;
      }
    } catch { }
  }

  return true;
}

export const isValidWord = isValidGuess;

async function getThemePool(db, language, theme, targetLen = 0) {
  const rows = await db.all(
    `SELECT * FROM words WHERE language = $1 AND theme = $2`,
    [language, theme],
  );
  const isCustom = theme !== 'general' && theme !== 'daily';
  return rows.filter((r) => {
    if (targetLen && r.length !== targetLen) return false;
    if (r.length < 4 || r.length > 8) return false;
    if (isCustom && BANNED_GENERIC_WORDS.has(r.word)) return false;
    return true;
  });
}

async function generateAndStore(db, { theme, language, length, difficulty }) {
  if (!aiAvailable()) return [];
  const themeKey = `${language}:${theme}`;

  // Если для этой темы уже идёт генерация (например, от фонового prewarm), ждём её окончания
  if (inflightByTheme.has(themeKey)) {
    try {
      await inflightByTheme.get(themeKey);
    } catch { }
    const afterWait = await getThemePool(db, language, theme, length || 0);
    if (afterWait.length > 0 || !aiAvailable()) return afterWait;
  }

  const task = (async () => {
    const existing = await db.all(
      `SELECT word FROM words WHERE language = $1 AND theme = $2`,
      [language, theme],
    );
    const exclude = existing.map((r) => r.word);
    const extraWords = [];
    const generated = await generateWords({
      theme,
      language,
      length: length || 0,
      difficulty: difficulty || 2,
      count: 14,
      exclude,
      onExtraWord: (item) => extraWords.push(item),
    });
    const now = Date.now();
    for (const item of [...generated, ...extraWords]) {
      const w = normalizeWord(item.word, language);
      if (!w) continue;
      await db.run(
        `INSERT INTO words (theme, language, word, length, difficulty, clue, source, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'ai', $7)
         ON CONFLICT (theme, language, word) DO NOTHING`,
        [theme, language, w, w.length, difficulty || 2, sanitizeHintText(item.clue || ''), now],
      );
      await db.run(
        `INSERT INTO dictionary (language, word, valid)
         VALUES ($1, $2, 1)
         ON CONFLICT (language, word) DO NOTHING`,
        [language, w],
      );
    }
    return generated;
  })();

  inflightByTheme.set(themeKey, task);
  try {
    return await task;
  } finally {
    if (inflightByTheme.get(themeKey) === task) {
      inflightByTheme.delete(themeKey);
    }
  }
}

function chooseBest(pool, difficulty) {
  const shuffled = [...pool].sort(() => Math.random() - 0.5);
  shuffled.sort((a, b) => Math.abs((a.difficulty || 2) - difficulty) - Math.abs((b.difficulty || 2) - difficulty));
  return shuffled[0] || null;
}

export async function pickWord(db, options = {}) {
  const isStringArg = typeof options === 'string';
  const language = !isStringArg && LANGUAGES.includes(options?.language) ? options.language : 'en';
  const rawTheme = sanitizeTheme(isStringArg ? options : options?.theme) || 'general';
  const rawLen = isStringArg ? 5 : Number(options?.length ?? 0);
  const targetLen = Number.isInteger(rawLen) && rawLen >= 4 && rawLen <= 8 ? rawLen : 0;
  const difficulty = [1, 2, 3].includes(Number(options?.difficulty)) ? Number(options.difficulty) : 2;
  const userId = options?.userId ?? null;

  const playedIds = new Set();
  if (userId != null) {
    const played = await db.all(`SELECT word_id FROM games WHERE user_id = $1`, [userId]);
    for (const r of played) playedIds.add(r.word_id);
  }

  // Если прямо сейчас идёт prewarm этой темы — дождёмся его перед проверкой БД
  const themeKey = `${language}:${rawTheme}`;
  if (inflightByTheme.has(themeKey)) {
    try {
      await inflightByTheme.get(themeKey);
    } catch { }
  }

  let pool = await getThemePool(db, language, rawTheme, targetLen);
  let unplayed = pool.filter((r) => !playedIds.has(r.id));

  if ((unplayed.length === 0 || (rawTheme !== 'general' && unplayed.length < 3)) && aiAvailable()) {
    try {
      await generateAndStore(db, { theme: rawTheme, language, length: targetLen, difficulty });
      pool = await getThemePool(db, language, rawTheme, targetLen);
      unplayed = pool.filter((r) => !playedIds.has(r.id));
    } catch (e) {
      console.error('[ai] word generation error:', e.message);
    }
  }

  const chosen = chooseBest(unplayed.length ? unplayed : pool, difficulty);
  if (chosen) {
    return { row: chosen, theme: rawTheme, fallback: false };
  }

  let genPool = await getThemePool(db, language, 'general', targetLen);
  if (!genPool.length) {
    await seedBank(db);
    genPool = await getThemePool(db, language, 'general', targetLen);
  }
  if (!genPool.length) {
    genPool = await getThemePool(db, language, 'general', 0);
  }
  const genUnplayed = genPool.filter((r) => !playedIds.has(r.id));
  const fallbackRow = chooseBest(genUnplayed.length ? genUnplayed : genPool, difficulty);

  return {
    row: fallbackRow,
    theme: 'general',
    fallback: rawTheme !== 'general',
  };
}

export async function dailyWord(db, day = dayKey(), language = 'en') {
  const lang = LANGUAGES.includes(language) ? language : 'en';
  const existing = await db.get(
    `SELECT w.* FROM daily_words d JOIN words w ON w.id = d.word_id WHERE d.day = $1 AND d.language = $2`,
    [day, lang],
  );
  if (existing) return existing;

  let pool = await getThemePool(db, lang, 'general', 5);
  if (!pool.length) {
    await seedBank(db);
    pool = await getThemePool(db, lang, 'general', 5);
  }
  pool.sort((a, b) => a.word.localeCompare(b.word));
  const hash = [...`${day}:${lang}`].reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) >>> 0, 0);
  const chosen = pool[hash % pool.length];

  await db.run(
    `INSERT INTO daily_words (day, language, word_id) VALUES ($1, $2, $3)
     ON CONFLICT (day, language) DO NOTHING`,
    [day, lang, chosen.id],
  );

  return (
    (await db.get(
      `SELECT w.* FROM daily_words d JOIN words w ON w.id = d.word_id WHERE d.day = $1 AND d.language = $2`,
      [day, lang],
    )) || chosen
  );
}

export async function prewarmTheme(db, options = {}) {
  try {
    const theme = sanitizeTheme(typeof options === 'string' ? options : options?.theme);
    if (!theme || theme === 'general' || theme.length < 2 || !aiAvailable()) return;
    const language = LANGUAGES.includes(options?.language) ? options.language : 'en';
    const rawLen = Number(options?.length ?? 0);
    const targetLen = Number.isInteger(rawLen) && rawLen >= 4 && rawLen <= 8 ? rawLen : 0;

    const pool = await getThemePool(db, language, theme, targetLen);
    if (pool.length < 6) {
      await generateAndStore(db, { theme, language, length: targetLen, difficulty: 2 });
    }
  } catch { }
}