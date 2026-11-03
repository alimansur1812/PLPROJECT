import * as ai from './ai.js';

export const BANNED_GENERIC_WORDS = new Set([
  'failed', 'pocket', 'button', 'window', 'mirror', 'carpet',
  'screen', 'pencil', 'yellow', 'silver', 'sample', 'bottle'
]);

const KNOWN_WORDS = new Set();

export function sanitizeHintText(text) {
  if (!text) return '';
  return text
    .replace(/^(подсказка|hint|clue|факт|fact)\s*[\d№#]*\s*[:\-–—]\s*/i, '')
    .trim();
}

export async function seedBank(db) {
  const rows = await db.all('SELECT word FROM words');
  for (const r of rows) {
    if (r.word) KNOWN_WORDS.add(String(r.word).toLowerCase().trim());
  }
}

export function isValidGuess(word) {
  if (!word || typeof word !== 'string') return false;
  const clean = word.trim().toLowerCase();
  if (KNOWN_WORDS.size === 0) return true;
  return KNOWN_WORDS.has(clean);
}

export const isValidWord = isValidGuess;

export async function getWordForGame(db, theme = 'general', length = 5) {
  const cleanTheme = (theme || 'general').trim().toLowerCase();

  const themeRows = await db.all(
    'SELECT word FROM words WHERE LOWER(theme) = ?',
    [cleanTheme]
  );
  for (const r of themeRows) {
    if (r.word) KNOWN_WORDS.add(String(r.word).toLowerCase().trim());
  }

  let row = await db.get(
    'SELECT * FROM words WHERE LOWER(theme) = ? AND length = ? ORDER BY RANDOM() LIMIT 1',
    [cleanTheme, length]
  );

  if (!row && cleanTheme !== 'general') {
    try {
      // Ищем любую функцию генерации, которая есть в ai.js
      const genFn = ai.generateThemeWords || ai.generateWordsForTheme || ai.generateWords || ai.generateWord;
      if (typeof genFn === 'function') {
        let generated = await genFn(cleanTheme, length);
        if (generated && !Array.isArray(generated)) generated = [generated];
        
        if (Array.isArray(generated) && generated.length > 0) {
          const stmt = await db.prepare(
            'INSERT OR IGNORE INTO words (word, length, theme, hint1, hint2, hint3, explanation) VALUES (?, ?, ?, ?, ?, ?, ?)'
          );
          for (const item of generated) {
            const rawWord = typeof item === 'string' ? item : item?.word;
            const w = rawWord ? String(rawWord).trim().toLowerCase() : '';
            if (w.length === length && !BANNED_GENERIC_WORDS.has(w)) {
              KNOWN_WORDS.add(w);
              await stmt.run(
                w,
                length,
                cleanTheme,
                sanitizeHintText(item?.hint1 || item?.hint),
                sanitizeHintText(item?.hint2),
                sanitizeHintText(item?.hint3),
                item?.explanation || null
              );
            }
          }
          await stmt.finalize();

          row = await db.get(
            'SELECT * FROM words WHERE LOWER(theme) = ? AND length = ? ORDER BY RANDOM() LIMIT 1',
            [cleanTheme, length]
          );
        }
      }
    } catch (e) {
      console.error('[ai] generation error:', e);
    }
  }

  if (!row) {
    row = await db.get(
      'SELECT * FROM words WHERE length = ? ORDER BY RANDOM() LIMIT 1',
      [length]
    );
  }

  if (row && row.word) {
    KNOWN_WORDS.add(String(row.word).toLowerCase().trim());
  }

  return row;
}