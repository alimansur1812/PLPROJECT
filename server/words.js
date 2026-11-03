import { WORDBANK } from './wordbank.js';
import { generateThemeWords } from './ai.js';

// Список бытового мусора для тем
export const BANNED_GENERIC_WORDS = new Set([
  'failed', 'pocket', 'button', 'window', 'mirror', 'carpet',
  'screen', 'pencil', 'yellow', 'silver', 'sample', 'bottle'
]);

// Кэш допустимых слов для синхронной валидации попыток в игре
const KNOWN_WORDS = new Set();

// Загружаем базовый словарь
if (Array.isArray(WORDBANK)) {
  for (const w of WORDBANK) KNOWN_WORDS.add(String(w).toLowerCase().trim());
} else if (WORDBANK instanceof Set) {
  for (const w of WORDBANK) KNOWN_WORDS.add(String(w).toLowerCase().trim());
}

// Очистка подсказок от префиксов вроде "Подсказка 1:" или "Hint 2 -"
export function sanitizeHintText(text) {
  if (!text) return '';
  return text
    .replace(/^(подсказка|hint|clue|факт|fact)\s*[\d№#]*\s*[:\-–—]\s*/i, '')
    .trim();
}

// Заполнение базы начальными словами
export async function seedBank(db) {
  const count = await db.get('SELECT COUNT(*) as c FROM words');
  if (count && count.c > 0) {
    // Подгружаем уже существующие слова в память
    const rows = await db.all('SELECT word FROM words');
    for (const r of rows) KNOWN_WORDS.add(String(r.word).toLowerCase().trim());
    return;
  }

  const stmt = await db.prepare(
    'INSERT OR IGNORE INTO words (word, length, theme, hint1, hint2, hint3, explanation) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );

  for (const w of WORDBANK) {
    const clean = String(w).trim().toLowerCase();
    if (clean.length === 5 && !BANNED_GENERIC_WORDS.has(clean)) {
      KNOWN_WORDS.add(clean);
      await stmt.run(clean, 5, 'general', 'General vocabulary word', null, null, null);
    }
  }
  await stmt.finalize();
}

// Универсальная проверка введённого слова (отклоняет несуществующие слова и опечатки)
export function isValidGuess(word) {
  if (!word || typeof word !== 'string') return false;
  const clean = word.trim().toLowerCase();
  return KNOWN_WORDS.has(clean);
}

export const isValidWord = isValidGuess;

// Получение слова для игры (с авто-генерацией через ИИ)
export async function getWordForGame(db, theme = 'general', length = 5) {
  const cleanTheme = (theme || 'general').trim().toLowerCase();

  // Подгружаем слова этой темы в кэш валидатора
  const themeWords = await db.all(
    'SELECT word FROM words WHERE LOWER(theme) = ?',
    [cleanTheme]
  );
  for (const r of themeWords) KNOWN_WORDS.add(String(r.word).toLowerCase().trim());

  let row = await db.get(
    'SELECT * FROM words WHERE LOWER(theme) = ? AND length = ? ORDER BY RANDOM() LIMIT 1',
    [cleanTheme, length]
  );

  // Если слов для темы ещё нет — генерируем через нейросеть
  if (!row && cleanTheme !== 'general') {
    const generated = await generateThemeWords(cleanTheme, length);
    if (generated && generated.length > 0) {
      const stmt = await db.prepare(
        'INSERT OR IGNORE INTO words (word, length, theme, hint1, hint2, hint3, explanation) VALUES (?, ?, ?, ?, ?, ?, ?)'
      );
      for (const item of generated) {
        const w = item.word.trim().toLowerCase();
        if (w.length === length && !BANNED_GENERIC_WORDS.has(w)) {
          KNOWN_WORDS.add(w);
          await stmt.run(
            w,
            length,
            cleanTheme,
            sanitizeHintText(item.hint1),
            sanitizeHintText(item.hint2),
            sanitizeHintText(item.hint3),
            item.explanation || null
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

  // Фоллбэк к общему словарю, только если ИИ ничего не вернул
  if (!row) {
    row = await db.get(
      'SELECT * FROM words WHERE length = ? ORDER BY RANDOM() LIMIT 1',
      [length]
    );
  }

  if (row) {
    KNOWN_WORDS.add(String(row.word).toLowerCase().trim());
  }

  return row;
}