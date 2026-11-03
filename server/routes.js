import { hashPassword, signToken, verifyPassword, verifyToken } from './auth.js';
import { isUniqueViolation } from './db.js';
import { HttpError, createRouter, rateLimit } from './http.js';
import { aiConfigured } from './ai.js';
import {
  MODE_RULES, createGame, explainGame, finalizeGame, getGame, isExpired, publicGame, requestHint, settleStale, submitGuess, surrenderGame,
} from './game.js';
import { ACHIEVEMENTS, adaptiveDifficulty, evaluateAchievements, leaderboard, userStats } from './stats.js';
import { BANK_THEMES } from './wordbank.js';
import { LANGUAGES, dayKey, levelInfo, sanitizeTheme } from './util.js';
import { dailyWord, pickWord, prewarmTheme } from './words.js';

const SOLO_MODES = ['classic', 'timed', 'hardcore', 'describe'];

export function buildRouter({ db, config }) {
  const router = createRouter();

  const authLimit = rateLimit({ windowMs: 60_000, max: 10, key: (c) => `auth:${c.ip}` });
  const guessLimit = rateLimit({ windowMs: 60_000, max: 90, key: (c) => `guess:${c.user.id}` });
  const aiLimit = rateLimit({ windowMs: 60_000, max: 25, key: (c) => `ai:${c.user.id}` });

  async function requireAuth(ctx) {
    const header = String(ctx.req.headers.authorization ?? '');
    const payload = header.startsWith('Bearer ') ? verifyToken(header.slice(7), config.jwtSecret) : null;
    const user = payload && (await db.get(`SELECT id, username, xp FROM users WHERE id = $1`, [payload.sub]));
    if (!user) throw new HttpError(401, 'Please log in', 'unauthorized');
    ctx.user = user;
  }

  const publicUser = (user) => ({ id: user.id, username: user.username, ...levelInfo(user.xp) });
  const session = (user) => ({
    token: signToken({ sub: user.id, name: user.username }, config.jwtSecret, config.tokenTtlMs),
    user: publicUser(user),
  });

  async function ownGame(ctx) {
    const id = Number(ctx.params.id);
    const game = Number.isInteger(id) ? await db.get(`SELECT * FROM games WHERE id = $1 AND user_id = $2`, [id, ctx.user.id]) : null;
    if (!game) throw new HttpError(404, 'Game not found', 'not_found');
    return game;
  }

  async function settled(game) {
    if (isExpired(game)) {
      await finalizeGame(db, game, 'lost', { reason: 'timeout' });
      return getGame(db, game.id);
    }
    return game;
  }

  router.get('/api/config', () => ({
    aiEnabled: aiConfigured(),
    themes: BANK_THEMES,
    modes: Object.fromEntries(SOLO_MODES.map((m) => [m, MODE_RULES[m]])),
  }));

  router.get('/api/achievements', () => ({ achievements: ACHIEVEMENTS }));

  router.post('/api/auth/register', authLimit, async (ctx) => {
    const username = String(ctx.body.username ?? '').trim();
    const password = String(ctx.body.password ?? '');
    if (!/^[A-Za-z0-9_.-]{3,20}$/.test(username)) {
      throw new HttpError(400, 'Username: 3–20 characters, letters, digits, _ . -', 'bad_username');
    }
    if (password.length < 8 || password.length > 100) throw new HttpError(400, 'Password must be 8–100 characters', 'bad_password');
    let user;
    try {
      user = await db.get(
        `INSERT INTO users (username, username_lower, password_hash, created_at) VALUES ($1, $2, $3, $4) RETURNING id, username, xp`,
        [username, username.toLowerCase(), await hashPassword(password), Date.now()],
      );
    } catch (error) {
      if (isUniqueViolation(error)) throw new HttpError(409, 'That username is taken', 'username_taken');
      throw error;
    }
    ctx.status = 201;
    return session(user);
  });

  router.post('/api/auth/login', authLimit, async (ctx) => {
    const username = String(ctx.body.username ?? '').trim().toLowerCase();
    const password = String(ctx.body.password ?? '');
    const user = await db.get(`SELECT * FROM users WHERE username_lower = $1`, [username]);
    const ok = await verifyPassword(password, user?.password_hash ?? 'scrypt$00$00');
    if (!user || !ok) throw new HttpError(401, 'Wrong username or password', 'bad_credentials');
    return session(user);
  });

  router.get('/api/me', requireAuth, async (ctx) => {
    await settleStale(db, ctx.user.id);
    return { user: publicUser(await db.get(`SELECT id, username, xp FROM users WHERE id = $1`, [ctx.user.id])) };
  });

  router.get('/api/users/:username', async (ctx) => {
    const row = await db.get(`SELECT id FROM users WHERE username_lower = $1`, [ctx.params.username.toLowerCase()]);
    if (!row) throw new HttpError(404, 'Player not found', 'not_found');
    return userStats(db, row.id);
  });

  // Фоновый разогрев пула слов при вводе темы в меню
  router.post('/api/themes/prewarm', requireAuth, async (ctx) => {
    const theme = sanitizeTheme(ctx.body.theme);
    const language = LANGUAGES.includes(ctx.body.language) ? ctx.body.language : 'en';
    const rawLen = ctx.body.length === 'any' ? 0 : Number(ctx.body.length ?? 0);
    const length = Number.isInteger(rawLen) && rawLen >= 4 && rawLen <= 8 ? rawLen : 0;
    if (theme && theme.length >= 2) {
      prewarmTheme(db, { theme, language, length });
    }
    return { ok: true };
  });

  router.post('/api/games', requireAuth, aiLimit, async (ctx) => {
    const { mode = 'classic', language = 'en', difficulty = 'auto' } = ctx.body;
    const rawLen = ctx.body.length === 'any' ? 0 : Number(ctx.body.length ?? 5);
    if (!SOLO_MODES.includes(mode)) throw new HttpError(400, 'Unknown mode', 'bad_mode');
    if (!LANGUAGES.includes(language)) throw new HttpError(400, 'Unknown language', 'bad_language');
    if (!Number.isInteger(rawLen) || (rawLen !== 0 && (rawLen < 4 || rawLen > 8))) {
      throw new HttpError(400, 'Word length must be 4–8 or Any', 'bad_length');
    }
    if (difficulty !== 'auto' && ![1, 2, 3].includes(Number(difficulty))) throw new HttpError(400, 'Bad difficulty', 'bad_difficulty');
    const theme = sanitizeTheme(ctx.body.theme) || 'general';

    await settleStale(db, ctx.user.id, { abandonOthers: true });
    const level = difficulty === 'auto' ? await adaptiveDifficulty(db, ctx.user.id) : Number(difficulty);
    const picked = await pickWord(db, { theme, language, length: rawLen, difficulty: level, userId: ctx.user.id });
    const game = await createGame(db, {
      userId: ctx.user.id,
      wordRow: picked.row,
      theme: picked.theme,
      mode,
      language,
      length: picked.row.length,
    });
    await db.run(`UPDATE themes SET plays = plays + 1 WHERE name = $1 AND language = $2`, [theme, language]);
    ctx.status = 201;
    return { game: await publicGame(db, game), themeFallback: picked.fallback ? theme : null, difficulty: level };
  });

  router.get('/api/games/current', requireAuth, async (ctx) => {
    await settleStale(db, ctx.user.id);
    const game = await db.get(
      `SELECT * FROM games WHERE user_id = $1 AND status = 'playing' AND room_code IS NULL ORDER BY id DESC LIMIT 1`,
      [ctx.user.id],
    );
    return { game: game ? await publicGame(db, game) : null };
  });

  router.get('/api/games/:id', requireAuth, async (ctx) => ({ game: await publicGame(db, await settled(await ownGame(ctx))) }));

  router.post('/api/games/:id/guess', requireAuth, guessLimit, async (ctx) => {
    const game = await ownGame(ctx);
    if (game.room_code) throw new HttpError(403, 'Room games are played inside the room', 'room_game');
    return submitGuess(db, game, ctx.body.guess, { surrender: Boolean(ctx.body.surrender) });
  });

  router.post('/api/games/:id/surrender', requireAuth, async (ctx) => {
    const game = await ownGame(ctx);
    if (game.room_code) throw new HttpError(403, 'Cannot surrender room game directly', 'room_game');
    return surrenderGame(db, game);
  });

  router.post('/api/games/:id/hint', requireAuth, aiLimit, async (ctx) => {
    const game = await ownGame(ctx);
    if (game.room_code) throw new HttpError(403, 'Hints are off in rooms', 'hints_off');
    return requestHint(db, game);
  });

  router.post('/api/games/:id/explain', requireAuth, aiLimit, async (ctx) => explainGame(db, await ownGame(ctx)));

  router.get('/api/daily', requireAuth, async (ctx) => {
    const day = dayKey();
    const game = await db.get(`SELECT * FROM games WHERE user_id = $1 AND daily_day = $2`, [ctx.user.id, day]);
    const settledGame = game && (await settled(game));
    return {
      day,
      game: settledGame ? { id: settledGame.id, status: settledGame.status, attempts: settledGame.attempts, language: settledGame.language } : null,
    };
  });

  router.post('/api/daily', requireAuth, async (ctx) => {
    const day = dayKey();
    const language = ctx.body.language ?? 'en';
    if (!LANGUAGES.includes(language)) throw new HttpError(400, 'Unknown language', 'bad_language');
    let game = await db.get(`SELECT * FROM games WHERE user_id = $1 AND daily_day = $2`, [ctx.user.id, day]);
    if (!game) {
      const word = await dailyWord(db, day, language);
      try {
        game = await createGame(db, {
          userId: ctx.user.id, wordRow: word, theme: 'daily', mode: 'daily', language, length: word.length, dailyDay: day,
        });
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        game = await db.get(`SELECT * FROM games WHERE user_id = $1 AND daily_day = $2`, [ctx.user.id, day]);
      }
    }
    return { game: await publicGame(db, game) };
  });

  router.get('/api/themes', requireAuth, async (ctx) => {
    const themes = await db.all(
      `SELECT t.id, t.name, t.language, t.plays, u.username AS author, t.created_by,
              (SELECT COUNT(*) FROM theme_likes l WHERE l.theme_id = t.id) AS likes,
              (SELECT COUNT(*) FROM theme_likes l WHERE l.theme_id = t.id AND l.user_id = $1) AS liked
       FROM themes t JOIN users u ON u.id = t.created_by
       ORDER BY likes DESC, t.plays DESC, t.id DESC LIMIT 50`,
      [ctx.user.id],
    );
    return { themes: themes.map((t) => ({ ...t, liked: t.liked > 0, mine: t.created_by === ctx.user.id })) };
  });

  router.post('/api/themes', requireAuth, async (ctx) => {
    const name = sanitizeTheme(ctx.body.name);
    const language = ctx.body.language ?? 'en';
    if (name.length < 2) throw new HttpError(400, 'Give the theme a name (at least 2 letters)', 'bad_theme');
    if (!LANGUAGES.includes(language)) throw new HttpError(400, 'Unknown language', 'bad_language');
    const { c } = await db.get(`SELECT COUNT(*) AS c FROM themes WHERE created_by = $1`, [ctx.user.id]);
    if (c >= 20) throw new HttpError(429, 'You can publish up to 20 themes', 'too_many_themes');
    const row = await db.get(
      `INSERT INTO themes (name, language, created_by, created_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (name, language) DO NOTHING RETURNING id`,
      [name, language, ctx.user.id, Date.now()],
    );
    if (!row) throw new HttpError(409, 'A theme with this name already exists', 'theme_exists');
    ctx.status = 201;
    return { id: row.id, newAchievements: await evaluateAchievements(db, ctx.user.id, { theme: true }) };
  });

  router.post('/api/themes/:id/like', requireAuth, async (ctx) => {
    const id = Number(ctx.params.id);
    const theme = Number.isInteger(id) ? await db.get(`SELECT id, created_by FROM themes WHERE id = $1`, [id]) : null;
    if (!theme) throw new HttpError(404, 'Theme not found', 'not_found');
    if (theme.created_by === ctx.user.id) throw new HttpError(403, "You can't like your own theme", 'own_theme');
    const removed = await db.run(`DELETE FROM theme_likes WHERE theme_id = $1 AND user_id = $2`, [id, ctx.user.id]);
    if (!removed.changes) {
      await db.run(`INSERT INTO theme_likes (theme_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [id, ctx.user.id]);
    }
    const { c } = await db.get(`SELECT COUNT(*) AS c FROM theme_likes WHERE theme_id = $1`, [id]);
    return { liked: !removed.changes, likes: c };
  });

  router.get('/api/leaderboard', async (ctx) => {
    const kind = ['weekly', 'all', 'daily'].includes(ctx.query.type) ? ctx.query.type : 'weekly';
    return { type: kind, rows: await leaderboard(db, kind) };
  });

  return router;
}