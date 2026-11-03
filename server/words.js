import { HttpError } from './http.js';
import { BANNED_GENERIC_WORDS, aiAvailable, checkWord, generateWords, isRealAi } from './ai.js';
import { BANK } from './wordbank.js';
import { DAY_MS } from './util.js';

export async function seedBank(db) {
  await db.run(`DELETE FROM dictionary WHERE valid = 0`).catch(() => {});

  // Изолируем старые бытовые слова (вроде failed и pocket), чтобы они больше никогда не выпадали
  for (const bad of BANNED_GENERIC_WORDS) {
    await db
      .run(`UPDATE words SET theme = '_purged_' || id WHERE source = 'ai' AND word = $1`, [bad])
      .catch(() => {});
  }

  const { c } = await db.get(`SELECT COUNT(*) AS c FROM words WHERE source = 'bank'`);
  if (c >= BANK.length) return;
  for (const e of BANK) {
    await db.run(
      `INSERT INTO words (theme, language, word, length, difficulty, clue, source, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'bank', $7)
       ON CONFLICT (theme, language, word) DO NOTHING`,
      [e.theme, e.language, e.word, e.word.length, e.difficulty, e.clue, Date.now()],
    );
  }
}

function draw(db, { language, theme, length }, { difficulty = 0, userId = 0 }) {
  const params = [language, theme];
  let sql = 'SELECT * FROM words WHERE language = $1 AND theme = $2';
  if (length) {
    params.push(length);
    sql += ` AND length = $${params.length}`;
  }
  if (difficulty) {
    params.push(difficulty);
    sql += ` AND difficulty = $${params.length}`;
  }
  if (userId) {
    params.push(userId);
    sql += ` AND id NOT IN (SELECT word_id FROM games WHERE user_id = $${params.length})`;
  }
  return db.get(sql + ' ORDER BY random() LIMIT 1', params);
}

async function countUnseen(db, { language, theme, length }, userId) {
  const params = [language, theme];
  let sql = 'SELECT COUNT(*) AS c FROM words WHERE language = $1 AND theme = $2';
  if (length) {
    params.push(length);
    sql += ` AND length = $${params.length}`;
  }
  if (userId) {
    params.push(userId);
    sql += ` AND id NOT IN (SELECT word_id FROM games WHERE user_id = $${params.length})`;
  }
  const row = await db.get(sql, params);
  return Number(row?.c ?? 0);
}

const inflight = new Map();

export async function refill(db, key, difficulty = 2) {
  const id = `${key.language}|${key.theme}|${key.length}`;
  if (!inflight.has(id)) {
    inflight.set(
      id,
      (async () => {
        try {
          const existingRows = await db.all(
            `SELECT word FROM words WHERE language = $1 AND theme = $2`,
            [key.language, key.theme],
          );
          const exclude = existingRows.map((r) => r.word);
          const items = await generateWords({ ...key, difficulty, count: 12, exclude });
          for (const item of items) {
            if (key.theme !== 'general' && BANNED_GENERIC_WORDS.has(item.word)) continue;
            await db.run(
              `INSERT INTO words (theme, language, word, length, difficulty, clue, source, created_at)
               VALUES ($1, $2, $3, $4, $5, $6, 'ai', $7)
               ON CONFLICT (theme, language, word) DO NOTHING`,
              [key.theme, key.language, item.word, item.word.length, difficulty, item.clue, Date.now()],
            );
          }
        } catch (error) {
          console.warn('[ai] word generation failed:', error.message);
        } finally {
          inflight.delete(id);
        }
      })(),
    );
  }
  await inflight.get(id);
}

// Фоновый прогрев темы (вызывается заранее, пока игрок выбирает настройки)
export function prewarmTheme(db, { theme, language, length = 0, difficulty = 2 }) {
  if (!isRealAi() || !theme || theme === 'general') return;
  const key = { language, theme, length };
  countUnseen(db, key, 0)
    .then((c) => {
      if (c < 6) void refill(db, key, difficulty);
    })
    .catch(() => {});
}

export async function pickWord(db, { theme, language, length, difficulty, userId }) {
  const key = { language, theme, length };

  // 1. Ищем новое, еще не сыгранное игроком слово нужной сложности или любой сложности
  let row = (await draw(db, key, { difficulty, userId })) ?? (await draw(db, key, { userId }));

  // 2. Если все слова в БД по этой теме уже сыграны — генерируем свежую партию с исключением старых
  if (!row && aiAvailable()) {
    await refill(db, key, difficulty);
    row = (await draw(db, key, { difficulty, userId })) ?? (await draw(db, key, { userId }));
  }

  // 3. Если это реальный AI и запас несыгранных слов подходит к концу (< 4), пополняем базу в фоне!
  if (row && isRealAi()) {
    countUnseen(db, key, userId)
      .then((left) => {
        if (left < 4) void refill(db, key, difficulty);
      })
      .catch(() => {});
  }

  row ??= await draw(db, key, {});
  if (row) return { row, theme, fallback: false };

  const general = { language, theme: 'general', length: length || 5 };
  row =
    (await draw(db, general, { difficulty, userId })) ??
    (await draw(db, general, { userId })) ??
    (await draw(db, general, {}));
  if (!row) throw new HttpError(503, 'No words available for this setup', 'no_words');
  return { row, theme: 'general', fallback: true };
}

export async function dailyWord(db, day, language) {
  const find = () =>
    db.get(
      `SELECT w.* FROM daily_words d JOIN words w ON w.id = d.word_id WHERE d.day = $1 AND d.language = $2`,
      [day, language],
    );
  const existing = await find();
  if (existing) return existing;
  const pool = await db.all(
    `SELECT id FROM words WHERE language = $1 AND theme = 'general' AND length = 5 ORDER BY id`,
    [language],
  );
  const epochDay = Math.floor(Date.parse(day) / DAY_MS);
  const pick = pool[(epochDay * 7919) % pool.length];
  await db.run(
    `INSERT INTO daily_words (day, language, word_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [day, language, pick.id],
  );
  return find();
}

function isObviousGibberish(word, language) {
  if (/(.)\1\1/.test(word)) return true;
  const mash = ['qwerty', 'asdfgh', 'zxcvbn', 'йцукен', 'фывапр', 'ячсмит', 'abcdef'];
  if (mash.some((m) => word.includes(m.slice(0, Math.min(word.length, 5))))) return true;

  if (language === 'en') {
    if (!/[aeiouy]/.test(word)) return true;
    if (/[bcdfghjklmnpqrstvwxz]{5,}/.test(word)) return true;
    const badStart =
      /^[bcdfghjklmnpqrstvwxz]{2}/.test(word) &&
      !/^(bl|br|ch|cl|cr|cz|dr|dw|fl|fr|gh|gl|gr|kh|kl|kn|kr|ph|pl|pn|pr|ps|qu|rh|sc|sh|sk|sl|sm|sn|sp|sq|st|sv|sw|th|tr|ts|tw|vl|vr|wh|wr|zh|zv)/.test(
        word,
      );
    const badEnd =
      /[bcdfghjklmnpqrstvwxz]{3}$/.test(word) &&
      !/((ch|sh|th|ph|ck|ng|nk|nt|nd|mp|lt|lk|lp|lf|ld|rk|rd|rt|rp|rm|rn|rl|rs|st|sp|sk|ct|pt|xt)s?|ght|tch|nch|rch|rst|rth|nth|lth|dth|xth|mph|lph|mpt|nct)$/.test(
        word,
      );
    if (badStart || badEnd) return true;
  } else if (language === 'ru') {
    if (!/[аеёиоуыэюя]/.test(word)) return true;
    if (/[бвгджзйклмнпрстфхцчшщ]{5,}/.test(word)) return true;
  }
  return false;
}

export async function isValidGuess(db, language, word, theme = 'general') {
  if (await db.get(`SELECT 1 AS ok FROM words WHERE language = $1 AND word = $2 LIMIT 1`, [language, word])) return true;
  const cached = await db.get(`SELECT valid FROM dictionary WHERE language = $1 AND word = $2`, [language, word]);
  if (cached) return cached.valid === 1;
  if (!aiAvailable()) return true;
  if (isObviousGibberish(word, language)) return false;

  let verdict = null;
  try {
    verdict = await checkWord({ word, language, theme });
  } catch {
    return true;
  }
  if (verdict === null) return true;
  await db.run(
    `INSERT INTO dictionary (language, word, valid) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [language, word, verdict ? 1 : 0],
  );
  return verdict;
}