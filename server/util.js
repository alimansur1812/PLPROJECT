export const LANGUAGES = ['en', 'ru'];
const LETTERS = { en: /^[a-z]+$/, ru: /^[а-я]+$/ };

// Lower-case a word and check it only has letters of the language (Russian: "ё" is treated as "е").
export function normalizeWord(raw, language) {
  if (typeof raw !== 'string' || !LETTERS[language]) return null;
  let word = raw.trim().toLowerCase();
  if (language === 'ru') word = word.replace(/ё/g, 'е');
  return LETTERS[language].test(word) ? word : null;
}

// Themes are free text typed by users and later placed in AI prompts, so keep only harmless characters.
export function sanitizeTheme(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N} '\-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .slice(0, 40);
}

// Level n starts at 60 * (n-1)^2 XP: 0, 60, 240, 540, 960 ...
export function levelInfo(xp) {
  const level = 1 + Math.floor(Math.sqrt(xp / 60));
  const start = 60 * (level - 1) ** 2;
  const next = 60 * level ** 2;
  return { level, xp, start, next, progress: (xp - start) / (next - start) };
}

// "YYYY-MM-DD" in UTC. The daily word changes at 00:00 UTC for everybody.
export const dayKey = (time = Date.now()) => new Date(time).toISOString().slice(0, 10);

export const DAY_MS = 86_400_000;
