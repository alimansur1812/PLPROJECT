import { HttpError } from './http.js';
import { explainWord, makeHint } from './ai.js';
import { isValidGuess } from './words.js';
import { evaluateAchievements } from './stats.js';
import { levelInfo, normalizeWord } from './util.js';

export const HINT_MAX = 3;
export const HINT_COST = 20;

export const MODE_RULES = {
  classic: { attempts: 6, hints: true, mult: 1 },
  timed: { attempts: 6, hints: true, mult: 1.25, limitMs: 180_000 },
  hardcore: { attempts: 4, hints: false, mult: 2 },
  describe: { attempts: 6, hints: false, mult: 1, showClue: true },
  daily: { attempts: 6, hints: true, mult: 1.5 },
  room: { attempts: 6, hints: false, mult: 1.25 },
};

export function evaluate(secret, guess) {
  const result = Array(secret.length).fill('b');
  const left = {};
  for (let i = 0; i < secret.length; i++) {
    if (guess[i] === secret[i]) result[i] = 'g';
    else left[secret[i]] = (left[secret[i]] ?? 0) + 1;
  }
  for (let i = 0; i < secret.length; i++) {
    if (result[i] !== 'g' && left[guess[i]] > 0) {
      result[i] = 'y';
      left[guess[i]] -= 1;
    }
  }
  return result.join('');
}

export function scoreGame({ status, attempts, maxAttempts, hints, length, mode, elapsedMs, limitMs, reason }) {
  if (status !== 'won') {
    const quit = reason === 'abandoned' || reason === 'left';
    return { score: 0, xp: quit ? 0 : 5 };
  }
  let base = 100 + (maxAttempts - attempts) * 25 + (length - 5) * 10 - hints * HINT_COST;
  if (limitMs) base += Math.max(0, Math.min(60, Math.floor((limitMs - elapsedMs) / 3000)));
  const score = Math.max(20, Math.round(Math.max(20, base) * (MODE_RULES[mode]?.mult ?? 1)));
  return { score, xp: Math.round(score / 2) };
}

export async function createGame(db, { userId, wordRow, theme, mode, language, length, dailyDay = null, roomCode = null }) {
  const rules = MODE_RULES[mode];
  const actualLength = length || wordRow.length;
  return db.get(
    `INSERT INTO games (user_id, word_id, mode, theme, language, length, max_attempts, time_limit_ms, daily_day, room_code, started_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
    [userId, wordRow.id, mode, theme, language, actualLength, rules.attempts, rules.limitMs ?? null, dailyDay, roomCode, Date.now()],
  );
}

export const getGame = (db, id) => db.get(`SELECT * FROM games WHERE id = $1`, [id]);
const getWord = (db, id) => db.get(`SELECT * FROM words WHERE id = $1`, [id]);

const isExpired = (game, grace = 0) =>
  game.status === 'playing' && game.time_limit_ms != null && Date.now() > game.started_at + game.time_limit_ms + grace;

export async function publicGame(db, game) {
  const word = await getWord(db, game.word_id);
  const guesses = await db.all(`SELECT guess, pattern FROM guesses WHERE game_id = $1 ORDER BY idx`, [game.id]);
  const rules = MODE_RULES[game.mode];
  return {
    id: game.id,
    mode: game.mode,
    theme: game.theme,
    language: game.language,
    length: game.length,
    maxAttempts: game.max_attempts,
    status: game.status,
    attempts: game.attempts,
    guesses,
    hints: JSON.parse(game.hints),
    hintsMax: rules.hints ? HINT_MAX : 0,
    clue: rules.showClue ? word.clue : null,
    timeLimitMs: game.time_limit_ms,
    startedAt: game.started_at,
    serverNow: Date.now(),
    daily: Boolean(game.daily_day),
    score: game.score,
    xpGained: game.xp_gained,
    answer: game.status === 'playing' ? null : word.word,
  };
}

// №6. Самообучающаяся сложность слова на основе результатов реальных игр
async function calibrateWordDifficulty(db, game, status, reason) {
  if (reason === 'abandoned' || reason === 'left') return;
  try {
    let target = 2;
    if (status === 'won' && game.attempts <= 2 && game.hints_used === 0) target = 1;
    else if (status === 'lost' || reason === 'surrender' || game.attempts >= 5 || game.hints_used >= 2) target = 3;
    await db.run(`UPDATE words SET difficulty = $1 WHERE id = $2`, [target, game.word_id]);
  } catch { }
}

export async function finalizeGame(db, game, status, { reason } = {}) {
  const fresh = await getGame(db, game.id);
  if (!fresh || fresh.status !== 'playing') return null;
  const finishedAt = Date.now();
  const { score, xp } = scoreGame({
    status,
    attempts: fresh.attempts,
    maxAttempts: fresh.max_attempts,
    hints: fresh.hints_used,
    length: fresh.length,
    mode: fresh.mode,
    elapsedMs: finishedAt - fresh.started_at,
    limitMs: fresh.time_limit_ms,
    reason,
  });
  const claimed = await db.get(
    `UPDATE games SET status = $1, finished_at = $2, score = $3, xp_gained = $4
     WHERE id = $5 AND status = 'playing' RETURNING *`,
    [status, finishedAt, score, xp, fresh.id],
  );
  if (!claimed) return null;
  await calibrateWordDifficulty(db, claimed, status, reason);
  const owner = await db.get(`UPDATE users SET xp = xp + $1 WHERE id = $2 RETURNING xp`, [xp, fresh.user_id]);
  const newAchievements = await evaluateAchievements(db, fresh.user_id, { game: claimed, status, xp: owner.xp });
  return { status, reason, score, xp, ...levelInfo(owner.xp), newAchievements };
}

export async function surrenderGame(db, game) {
  if (game.status !== 'playing') throw new HttpError(409, 'This game is already over', 'game_over');
  const word = await getWord(db, game.word_id);
  const result = await finalizeGame(db, game, 'lost', { reason: 'surrender' });
  return { status: 'lost', surrendered: true, answer: word.word, result };
}

export async function submitGuess(db, game, rawGuess, { surrender = false } = {}) {
  if (surrender || rawGuess === '__SURRENDER__') {
    return surrenderGame(db, game);
  }
  if (game.status !== 'playing') throw new HttpError(409, 'This game is already over', 'game_over');
  const word = await getWord(db, game.word_id);
  if (isExpired(game, 1500)) {
    const result = await finalizeGame(db, game, 'lost', { reason: 'timeout' });
    return { expired: true, status: 'lost', answer: word.word, result };
  }
  const guess = normalizeWord(rawGuess, game.language);
  if (!guess || guess.length !== game.length) {
    throw new HttpError(422, `Enter a ${game.length}-letter word`, 'bad_guess');
  }
  const duplicate = await db.get(`SELECT 1 FROM guesses WHERE game_id = $1 AND guess = $2`, [game.id, guess]);
  if (duplicate) {
    throw new HttpError(422, 'You already tried that word!', 'duplicate_guess');
  }
  if (!(await isValidGuess(db, game.language, guess, game.theme))) {
    throw new HttpError(422, 'Not in the word list (or random letters)', 'invalid_word');
  }
  const slot = await db.get(
    `UPDATE games SET attempts = attempts + 1 WHERE id = $1 AND status = 'playing' AND attempts < max_attempts RETURNING attempts`,
    [game.id],
  );
  if (!slot) throw new HttpError(409, 'This game is already over', 'game_over');
  const pattern = evaluate(word.word, guess);
  await db.run(`INSERT INTO guesses (game_id, idx, guess, pattern, created_at) VALUES ($1, $2, $3, $4, $5)`, [
    game.id,
    slot.attempts,
    guess,
    pattern,
    Date.now(),
  ]);
  const won = pattern === 'g'.repeat(game.length);
  const lost = !won && slot.attempts >= game.max_attempts;
  const status = won ? 'won' : lost ? 'lost' : 'playing';
  const result = status === 'playing' ? null : await finalizeGame(db, game, status);
  return { guess, pattern, attempts: slot.attempts, status, result, answer: status === 'playing' ? null : word.word };
}

export async function requestHint(db, game) {
  const rules = MODE_RULES[game.mode];
  if (game.status !== 'playing') throw new HttpError(409, 'This game is already over', 'game_over');
  if (!rules.hints) throw new HttpError(403, 'Hints are turned off in this mode', 'hints_off');
  const claimed = await db.get(
    `UPDATE games SET hints_used = hints_used + 1 WHERE id = $1 AND status = 'playing' AND hints_used < $2 RETURNING hints_used`,
    [game.id, HINT_MAX],
  );
  if (!claimed) throw new HttpError(409, 'No hints left in this game', 'no_hints');
  const level = claimed.hints_used;
  const word = await getWord(db, game.word_id);
  const guesses = await db.all(`SELECT guess FROM guesses WHERE game_id = $1 ORDER BY idx`, [game.id]);
  const current = await getGame(db, game.id);
  const previousHints = JSON.parse(current.hints);
  let text = null;
  try {
    text = await makeHint({
      word: word.word,
      theme: game.theme,
      language: game.language,
      guesses: guesses.map((g) => g.guess),
      level,
      previousHints,
      clue: word.clue,
    });
  } catch { }
  text ??= offlineHint(word, level);
  const hints = [...previousHints, text];
  await db.run(`UPDATE games SET hints = $1 WHERE id = $2`, [JSON.stringify(hints), game.id]);
  return { hint: text, level, hintsUsed: level, hintsMax: HINT_MAX, cost: HINT_COST };
}

function offlineHint(word, level) {
  const chars = [...word.word];
  const first = chars[0].toUpperCase();
  const last = chars.at(-1).toUpperCase();
  if (level === 1) return word.clue || `An iconic entity or term from "${word.theme}".`;
  if (level === 2) return `It starts with the letter “${first}”.`;
  return `${word.clue ? word.clue + ' — ' : ''}Starts with “${first}” and ends with “${last}”.`;
}

export async function explainGame(db, game) {
  if (game.status === 'playing') throw new HttpError(403, 'Finish the game first', 'not_finished');
  const word = await getWord(db, game.word_id);
  if (word.explanation) return { word: word.word, ...JSON.parse(word.explanation) };
  let explanation = null;
  try {
    explanation = await explainWord({ word: word.word, theme: word.theme, language: game.language });
  } catch { }
  if (explanation) {
    await db.run(`UPDATE words SET explanation = $1 WHERE id = $2`, [JSON.stringify(explanation), word.id]);
    return { word: word.word, ...explanation };
  }
  return { word: word.word, definition: word.clue || '', origin: null, example: null, offline: true };
}

export async function settleStale(db, userId, { abandonOthers = false } = {}) {
  const open = await db.all(`SELECT * FROM games WHERE user_id = $1 AND status = 'playing' AND room_code IS NULL`, [userId]);
  for (const game of open) {
    if (isExpired(game)) await finalizeGame(db, game, 'lost', { reason: 'timeout' });
    else if (abandonOthers && !game.daily_day) await finalizeGame(db, game, 'lost', { reason: 'abandoned' });
  }
}

export { isExpired };