import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { start } from '../server/index.js';
import { config } from '../server/config.js';
import { aiAvailable, setProvider } from '../server/ai.js';
import { evaluate, scoreGame } from '../server/game.js';
import { HttpError, rateLimit } from '../server/http.js';
import { dailyStreaks, winStreaks } from '../server/stats.js';
import { levelInfo, normalizeWord, sanitizeTheme } from '../server/util.js';
import { BANK } from '../server/wordbank.js';

let app;
let base;

before(async () => {
  app = await start({ port: 0, sqlitePath: ':memory:', databaseUrl: '', rateScale: 1000, jwtSecret: 'test-secret', ai: null });
  base = `http://localhost:${app.port}`;
});
after(async () => {
  await app.close();
});

async function call(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(body && { 'Content-Type': 'application/json' }), ...(token && { Authorization: `Bearer ${token}` }) },
    body: body && JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
}
const signup = async (username) => (await call('/api/auth/register', { method: 'POST', body: { username, password: 'password123' } })).data;
const secretOf = async (gameId) =>
  (await app.db.get(`SELECT w.word FROM games g JOIN words w ON w.id = g.word_id WHERE g.id = $1`, [gameId])).word;
const newGame = (token, body = {}) => call('/api/games', { method: 'POST', token, body: { mode: 'classic', language: 'en', length: 5, ...body } });
const guess = (token, id, word) => call(`/api/games/${id}/guess`, { method: 'POST', token, body: { guess: word } });

// ---------------------------------------------------------------- pure logic
test('evaluate handles duplicate letters like Wordle', () => {
  assert.equal(evaluate('apple', 'paper'), 'yygyb');
  assert.equal(evaluate('abbey', 'babes'), 'yyggb');
  assert.equal(evaluate('crane', 'crane'), 'ggggg');
  assert.equal(evaluate('light', 'zzzzz'), 'bbbbb');
  assert.equal(evaluate('speed', 'erase'), 'ybbyy');
});

test('scoring: bonuses, hint cost and multipliers', () => {
  const base = { status: 'won', maxAttempts: 6, hints: 0, length: 5, mode: 'classic', elapsedMs: 0, limitMs: null };
  assert.equal(scoreGame({ ...base, attempts: 1 }).score, 225);
  assert.equal(scoreGame({ ...base, attempts: 1, hints: 3 }).score, 165);
  assert.equal(scoreGame({ ...base, attempts: 6 }).score, 100);
  assert.equal(scoreGame({ ...base, attempts: 3, mode: 'hardcore', maxAttempts: 4 }).score, 250);
  assert.equal(scoreGame({ ...base, attempts: 6, length: 8 }).score, 130);
  assert.deepEqual(scoreGame({ ...base, status: 'lost', attempts: 6 }), { score: 0, xp: 5 });
  assert.deepEqual(scoreGame({ ...base, status: 'lost', reason: 'abandoned' }), { score: 0, xp: 0 });
});

test('levels, streaks, normalisation', () => {
  assert.equal(levelInfo(0).level, 1);
  assert.equal(levelInfo(59).level, 1);
  assert.equal(levelInfo(60).level, 2);
  assert.equal(levelInfo(960).level, 5);
  assert.deepEqual(winStreaks([{ status: 'won' }, { status: 'won' }, { status: 'lost' }, { status: 'won' }]), { current: 2, best: 2 });
  assert.deepEqual(winStreaks([{ status: 'lost' }, { status: 'won' }, { status: 'won' }, { status: 'won' }]), { current: 0, best: 3 });
  assert.deepEqual(dailyStreaks(['2026-10-25', '2026-10-26', '2026-10-24'], '2026-10-26'), { current: 3, best: 3 });
  assert.deepEqual(dailyStreaks(['2026-10-24', '2026-10-25'], '2026-10-26'), { current: 2, best: 2 }); // today not played yet
  assert.deepEqual(dailyStreaks(['2026-10-20', '2026-10-25'], '2026-10-26'), { current: 1, best: 1 });
  assert.equal(normalizeWord(' Ёлка ', 'ru'), 'елка');
  assert.equal(normalizeWord('he llo', 'en'), null);
  assert.equal(normalizeWord('привет', 'en'), null);
  assert.equal(sanitizeTheme('  Ignore <this> "prompt"; DROP TABLE!  '), 'ignore this prompt drop table');
});

test('word bank is clean and covers every length', () => {
  const seen = new Set();
  for (const e of BANK) {
    assert.equal(normalizeWord(e.word, e.language), e.word, `${e.word} is not normalised`);
    assert.ok(e.word.length >= 4 && e.word.length <= 8, `${e.word} length`);
    assert.ok(e.clue && !e.clue.toLowerCase().replace(/ё/g, 'е').includes(e.word), `${e.word} clue`);
    const key = `${e.language}|${e.theme}|${e.word}`;
    assert.ok(!seen.has(key), `duplicate ${key}`);
    seen.add(key);
  }
  for (const language of ['en', 'ru']) {
    for (const length of [4, 5, 6, 7, 8]) {
      const n = BANK.filter((e) => e.language === language && e.theme === 'general' && e.word.length === length).length;
      assert.ok(n >= 5, `${language} ${length}`);
    }
    assert.ok(BANK.filter((e) => e.language === language && e.theme === 'general' && e.word.length === 5).length >= 25, 'daily pool');
  }
});

test('rate limiter blocks after the limit', () => {
  const old = config.rateScale;
  config.rateScale = 1;
  const limit = rateLimit({ windowMs: 1000, max: 2, key: () => 'k' });
  limit({});
  limit({});
  assert.throws(() => limit({}), (e) => e instanceof HttpError && e.status === 429);
  config.rateScale = old;
});

// ---------------------------------------------------------------- accounts
test('register, login and token checks', async () => {
  const ok = await call('/api/auth/register', { method: 'POST', body: { username: 'Alice', password: 'password123' } });
  assert.equal(ok.status, 201);
  assert.equal(ok.data.user.username, 'Alice');
  assert.equal(ok.data.user.level, 1);
  assert.equal((await call('/api/auth/register', { method: 'POST', body: { username: 'alice', password: 'password123' } })).status, 409);
  assert.equal((await call('/api/auth/register', { method: 'POST', body: { username: 'a b', password: 'password123' } })).status, 400);
  assert.equal((await call('/api/auth/register', { method: 'POST', body: { username: 'bobby', password: 'short' } })).status, 400);
  const login = await call('/api/auth/login', { method: 'POST', body: { username: 'ALICE', password: 'password123' } });
  assert.equal(login.status, 200);
  assert.equal((await call('/api/auth/login', { method: 'POST', body: { username: 'alice', password: 'wrong-password' } })).status, 401);
  assert.equal((await call('/api/auth/login', { method: 'POST', body: { username: 'nobody', password: 'password123' } })).status, 401);
  assert.equal((await call('/api/me')).status, 401);
  assert.equal((await call('/api/me', { token: login.data.token + 'x' })).status, 401);
  assert.equal((await call('/api/me', { token: login.data.token })).data.user.username, 'Alice');
  const stored = await app.db.get(`SELECT password_hash FROM users WHERE username_lower = 'alice'`);
  assert.ok(stored.password_hash.startsWith('scrypt$') && !stored.password_hash.includes('password123'));
});

// ---------------------------------------------------------------- solo games
test('a full winning game: secret stays hidden, XP and achievements are awarded', async () => {
  const { token } = await signup('solo_win');
  const created = await newGame(token);
  assert.equal(created.status, 201);
  const game = created.data.game;
  assert.equal(game.status, 'playing');
  assert.equal(game.answer, null);
  assert.equal(game.length, 5);
  assert.ok(!JSON.stringify(created.data).includes(await secretOf(game.id)), 'the secret must not be in the response');

  assert.equal((await guess(token, game.id, 'abc')).status, 422); // wrong length
  assert.equal((await guess(token, game.id, '12345')).status, 422); // not letters
  const wrong = await guess(token, game.id, 'zzzzz');
  assert.equal(wrong.data.pattern, 'bbbbb');
  assert.equal(wrong.data.attempts, 1);
  assert.equal(wrong.data.answer, null);

  const secret = await secretOf(game.id);
  const win = await guess(token, game.id, secret.toUpperCase());
  assert.equal(win.data.status, 'won');
  assert.equal(win.data.pattern, 'ggggg');
  assert.equal(win.data.result.score, 100 + 4 * 25);
  assert.ok(win.data.result.newAchievements.some((a) => a.code === 'first_win'));
  assert.equal(win.data.answer, secret);

  assert.equal((await guess(token, game.id, 'zzzzz')).status, 409); // game over
  const view = (await call(`/api/games/${game.id}`, { token })).data.game;
  assert.equal(view.status, 'won');
  assert.equal(view.answer, secret);
  assert.equal(view.guesses.length, 2);
  const me = (await call('/api/me', { token })).data.user;
  assert.equal(me.xp, 100); // score 200 -> 100 XP

  const explain = await call(`/api/games/${game.id}/explain`, { method: 'POST', token });
  assert.equal(explain.status, 200);
  assert.equal(explain.data.word, secret);
  assert.ok(explain.data.definition.length > 0);
});

test("losing, hardcore rules and privacy of other players' games", async () => {
  const { token } = await signup('solo_lose');
  const other = await signup('snooper');
  const game = (await newGame(token, { mode: 'hardcore', length: 6 })).data.game;
  assert.equal(game.maxAttempts, 4);
  assert.equal(game.hintsMax, 0);
  assert.equal((await call(`/api/games/${game.id}/hint`, { method: 'POST', token })).status, 403);
  assert.equal((await call(`/api/games/${game.id}`, { token: other.token })).status, 404);
  assert.equal((await guess(other.token, game.id, 'zzzzzz')).status, 404);
  assert.equal((await call(`/api/games/${game.id}/explain`, { method: 'POST', token })).status, 403); // still playing
  let last;
  for (let i = 0; i < 4; i++) last = await guess(token, game.id, 'zzzzzz');
  assert.equal(last.data.status, 'lost');
  assert.equal(last.data.answer, await secretOf(game.id));
  assert.equal(last.data.result.score, 0);
  assert.equal((await call('/api/users/solo_lose')).data.wins, 0);
});

test('hints: three per game, each one costs points', async () => {
  const { token } = await signup('hinter');
  const game = (await newGame(token)).data.game;
  const secret = await secretOf(game.id);
  const hints = [];
  for (let i = 1; i <= 3; i++) {
    const res = await call(`/api/games/${game.id}/hint`, { method: 'POST', token });
    assert.equal(res.status, 200);
    assert.equal(res.data.level, i);
    hints.push(res.data.hint);
  }
  assert.equal((await call(`/api/games/${game.id}/hint`, { method: 'POST', token })).data.error.code, 'no_hints');
  assert.ok(hints.every((h) => !h.toLowerCase().includes(secret)));
  const win = await guess(token, game.id, secret);
  assert.equal(win.data.result.score, 225 - 60);
  assert.equal((await call(`/api/games/${game.id}`, { token })).data.game.hints.length, 3);
});

test('describe mode shows the clue, timed mode ends when time runs out', async () => {
  const { token } = await signup('modes');
  const describe = (await newGame(token, { mode: 'describe' })).data.game;
  assert.ok(describe.clue && describe.clue.length > 3);
  const timed = (await newGame(token, { mode: 'timed' })).data.game;
  assert.equal(timed.timeLimitMs, 180000);
  await app.db.run(`UPDATE games SET started_at = started_at - 200000 WHERE id = $1`, [timed.id]);
  const late = await guess(token, timed.id, 'zzzzz');
  assert.equal(late.data.status, 'lost');
  assert.equal(late.data.expired, true);
  assert.ok(late.data.answer);
  const timed2 = (await newGame(token, { mode: 'timed' })).data.game;
  await app.db.run(`UPDATE games SET started_at = started_at - 200000 WHERE id = $1`, [timed2.id]);
  assert.equal((await call(`/api/games/${timed2.id}`, { token })).data.game.status, 'lost'); // closed when viewed
});

test('starting a new game abandons the previous one (no free retries)', async () => {
  const { token } = await signup('quitter');
  const first = (await newGame(token)).data.game;
  const second = (await newGame(token)).data.game;
  assert.equal((await call(`/api/games/${first.id}`, { token })).data.game.status, 'lost');
  assert.equal((await call('/api/games/current', { token })).data.game.id, second.id);
  assert.equal((await call('/api/me', { token })).data.user.xp, 0);
});

test('themes without AI fall back to general words, bank themes work', async () => {
  const { token } = await signup('themer');
  const custom = await newGame(token, { theme: 'Pirate Ships!' });
  assert.equal(custom.data.themeFallback, 'pirate ships');
  assert.equal(custom.data.game.theme, 'general');
  const animals = await newGame(token, { theme: 'animals', length: 7 });
  assert.equal(animals.data.themeFallback, null);
  assert.equal(animals.data.game.theme, 'animals');
  const russian = await newGame(token, { language: 'ru', theme: 'космос', length: 6 });
  assert.equal(russian.data.game.language, 'ru');
  const secret = await secretOf(russian.data.game.id);
  assert.match(secret, /^[а-я]{6}$/);
  assert.equal((await guess(token, russian.data.game.id, 'sixlet')).status, 422); // wrong alphabet
  for (const bad of [{ length: 3 }, { length: 9 }, { mode: 'daily' }, { language: 'de' }, { difficulty: 7 }]) {
    assert.equal((await newGame(token, bad)).status, 400, JSON.stringify(bad));
  }
});

// ---------------------------------------------------------------- daily, themes, leaderboards, profile
test('daily challenge: same word for everybody, one game per day', async () => {
  const a = await signup('daily_a');
  const b = await signup('daily_b');
  assert.equal((await call('/api/daily', { token: a.token })).data.game, null);
  const first = (await call('/api/daily', { method: 'POST', token: a.token, body: { language: 'en' } })).data.game;
  const again = (await call('/api/daily', { method: 'POST', token: a.token, body: { language: 'ru' } })).data.game;
  assert.equal(again.id, first.id);
  assert.equal(again.language, 'en');
  const other = (await call('/api/daily', { method: 'POST', token: b.token, body: { language: 'en' } })).data.game;
  assert.notEqual(other.id, first.id);
  assert.equal(await secretOf(other.id), await secretOf(first.id));
  assert.equal(first.length, 5);
  assert.equal(first.daily, true);
  const win = await guess(a.token, first.id, await secretOf(first.id));
  assert.equal(win.data.result.score, 338); // (100 + 5 * 25) * 1.5 = 337.5, rounded
  const status = (await call('/api/daily', { token: a.token })).data.game;
  assert.equal(status.status, 'won');
  const profile = (await call('/api/users/daily_a')).data;
  assert.equal(profile.dailyStreak.current, 1);
});

test('publishing themes, likes, leaderboards and profiles', async () => {
  const a = await signup('author');
  const b = await signup('fan');
  const made = await call('/api/themes', { method: 'POST', token: a.token, body: { name: 'Greek Gods', language: 'en' } });
  assert.equal(made.status, 201);
  assert.ok(made.data.newAchievements.some((x) => x.code === 'theme_maker'));
  assert.equal((await call('/api/themes', { method: 'POST', token: b.token, body: { name: 'greek gods', language: 'en' } })).status, 409);
  assert.equal((await call('/api/themes', { method: 'POST', token: b.token, body: { name: 'x', language: 'en' } })).status, 400);
  const id = made.data.id;
  assert.equal((await call(`/api/themes/${id}/like`, { method: 'POST', token: a.token })).status, 403);
  assert.deepEqual((await call(`/api/themes/${id}/like`, { method: 'POST', token: b.token })).data, { liked: true, likes: 1 });
  const list = (await call('/api/themes', { token: b.token })).data.themes.find((t) => t.id === id);
  assert.equal(list.likes, 1);
  assert.equal(list.liked, true);
  assert.equal(list.author, 'author');
  assert.deepEqual((await call(`/api/themes/${id}/like`, { method: 'POST', token: b.token })).data, { liked: false, likes: 0 });
  await newGame(b.token, { theme: 'greek gods' });
  assert.equal((await app.db.get(`SELECT plays FROM themes WHERE id = $1`, [id])).plays, 1);

  for (const type of ['weekly', 'all', 'daily']) {
    const res = await call(`/api/leaderboard?type=${type}`);
    assert.equal(res.status, 200);
    assert.ok(res.data.rows.length >= 1, type);
    assert.equal(res.data.rows[0].rank, 1);
  }
  const top = (await call('/api/leaderboard?type=all')).data.rows;
  assert.deepEqual(top.map((r) => r.score), [...top.map((r) => r.score)].sort((x, y) => y - x));

  const profile = (await call('/api/users/solo_win')).data;
  assert.equal(profile.games, 1);
  assert.equal(profile.wins, 1);
  assert.equal(profile.winRate, 1);
  assert.equal(profile.streak.current, 1);
  assert.equal(profile.distribution[2], 1);
  assert.ok(profile.achievements.find((x) => x.code === 'first_win').earnedAt > 0);
  assert.equal((await call('/api/users/nobody_here')).status, 404);
});

// ---------------------------------------------------------------- AI
test('AI: words are generated once, cached, validated; hints never leak the word', async () => {
  const { token } = await signup('ai_player');
  let calls = 0;
  const fake = async (prompt) => {
    calls++;
    if (prompt.includes('different single')) {
      return JSON.stringify({
        words: [
          { word: 'T-Rex', clue: 'bad: not letters only' },
          { word: 'raptor', clue: 'wrong length' },
          { word: 'jaws', clue: 'wrong length' },
          { word: 'bones', clue: 'Found in a skeleton' },
          { word: 'Bones', clue: 'duplicate' },
          { word: 'tails', clue: 'These swish behind' },
          { word: 'eggs5', clue: 'digit' },
          { word: 'claws', clue: 'The word is claws' },
          { word: 'giant', clue: 'Very big' },
          { word: 'stone', clue: '' },
          ...['alpha', 'bravo', 'delta', 'ghost', 'camel', 'metal'].map((word, i) => ({ word, clue: `clue ${i}` })),
        ],
      });
    }
    if (prompt.includes('hint number')) return JSON.stringify({ hint: `You will find the answer: ${prompt.match(/secret word is "(\w+)"/)[1]}` });
    if (prompt.includes('valid ')) return JSON.stringify({ valid: !prompt.includes('"zzzzz"') });
    if (prompt.includes('Explain')) return '```json\n{"definition":"A test definition.","origin":"From tests.","example":"This is an example."}\n```';
    throw new Error('unexpected prompt');
  };
  setProvider(fake);
  try {
    assert.ok(aiAvailable());
    const game = (await newGame(token, { theme: 'Dinosaurs', difficulty: 2 })).data;
    assert.equal(calls, 1);
    assert.equal(game.game.theme, 'dinosaurs');
    assert.equal(game.themeFallback, null);
    const stored = await app.db.all(`SELECT word, difficulty FROM words WHERE theme = 'dinosaurs' AND source = 'ai' ORDER BY word`);
    assert.deepEqual(stored.map((w) => w.word), ['alpha', 'bones', 'bravo', 'camel', 'delta', 'ghost', 'giant', 'metal', 'tails']);
    assert.ok(stored.every((w) => w.difficulty === 2));

    // second game: served from the cache, the AI is not asked for new words
    const before = calls;
    await newGame(token, { theme: 'dinosaurs', difficulty: 2 });
    assert.equal(calls, before);

    // guess validation: unknown words go to the AI once, the verdict is cached
    const id = (await newGame(token, { theme: 'dinosaurs', difficulty: 2 })).data.game.id;
    const bad = await guess(token, id, 'zzzzz');
    assert.equal(bad.status, 422);
    assert.equal(bad.data.error.code, 'invalid_word');
    const count = calls;
    assert.equal((await guess(token, id, 'zzzzz')).status, 422);
    assert.equal(calls, count);
    assert.equal((await call(`/api/games/${id}`, { token })).data.game.attempts, 0); // rejected guesses cost nothing
    assert.equal((await guess(token, id, 'hello')).status, 200);

    // a hint that contains the secret word is thrown away and replaced by the offline hint
    const hint = await call(`/api/games/${id}/hint`, { method: 'POST', token });
    assert.equal(hint.status, 200);
    assert.ok(!hint.data.hint.toLowerCase().includes(await secretOf(id)));

    // explanation: fenced JSON is parsed and cached on the word
    await guess(token, id, await secretOf(id));
    const explain = await call(`/api/games/${id}/explain`, { method: 'POST', token });
    assert.equal(explain.data.definition, 'A test definition.');
    const cached = calls;
    await call(`/api/games/${id}/explain`, { method: 'POST', token });
    assert.equal(calls, cached);
  } finally {
    setProvider(null);
  }
});

test('AI failure: the game keeps working with the word bank', async () => {
  const { token } = await signup('ai_down');
  let calls = 0;
  setProvider(async () => {
    calls++;
    throw new Error('boom: 429');
  });
  try {
    const res = await newGame(token, { theme: 'volcanoes' });
    assert.equal(res.status, 201);
    assert.equal(res.data.themeFallback, 'volcanoes');
    assert.equal(calls, 1);
    assert.equal(aiAvailable(), false); // cooling down
    const id = res.data.game.id;
    assert.equal((await guess(token, id, 'hello')).status, 200); // validation fails open
    assert.equal((await call(`/api/games/${id}/hint`, { method: 'POST', token })).status, 200);
    await newGame(token, { theme: 'volcanoes' });
    assert.equal(calls, 1, 'no more AI calls during the cool-down');
  } finally {
    setProvider(null);
  }
});

// ---------------------------------------------------------------- rooms (WebSocket)
function connect() {
  const ws = new WebSocket(`ws://localhost:${app.port}/ws`);
  const queue = [];
  const waiting = [];
  ws.on('message', (raw) => {
    const message = JSON.parse(raw);
    const i = waiting.findIndex((w) => w.type === message.type && w.match(message));
    if (i >= 0) waiting.splice(i, 1)[0].resolve(message);
    else queue.push(message);
  });
  return {
    ws,
    opened: new Promise((resolve) => ws.on('open', resolve)),
    send: (message) => ws.send(JSON.stringify(message)),
    next(type, match = () => true) {
      const i = queue.findIndex((m) => m.type === type && match(m));
      if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]);
      return new Promise((resolve, reject) => {
        waiting.push({ type, match, resolve });
        setTimeout(() => reject(new Error(`timed out waiting for ${type}; unmatched messages: ${JSON.stringify(queue)}`)), 3000).unref();
      });
    },
  };
}
async function login(token) {
  const client = connect();
  await client.opened;
  client.send({ type: 'auth', token });
  await client.next('auth:ok');
  return client;
}

test('rooms: duel flow, privacy of letters, winner, stats, rematch, reconnect', async () => {
  const a = await signup('duel_a');
  const b = await signup('duel_b');
  const c = await signup('duel_c');
  const A = await login(a.token);
  const B = await login(b.token);
  const C = await login(c.token);

  C.send({ type: 'room:join', code: 'NOPE1' });
  assert.match((await C.next('room:error')).message, /No room/);

  A.send({ type: 'room:create', theme: 'general', language: 'en', length: 5 });
  const created = await A.next('room:state');
  assert.equal(created.status, 'lobby');
  assert.equal(created.code.length, 5);
  A.send({ type: 'room:start' });
  assert.match((await A.next('room:error')).message, /one more player/);

  B.send({ type: 'room:join', code: created.code.toLowerCase() });
  const lobby = await A.next('room:state', (m) => m.players.length === 2);
  assert.deepEqual(lobby.players.map((p) => p.username), ['duel_a', 'duel_b']);
  B.send({ type: 'room:start' });
  assert.match((await B.next('room:error')).message, /Only the host/);

  A.send({ type: 'room:start' });
  await A.next('room:started');
  await B.next('room:started');
  C.send({ type: 'room:join', code: created.code });
  assert.match((await C.next('room:error')).message, /already started/);

  const gameOf = (userId) => app.db.get(`SELECT * FROM games WHERE user_id = $1 ORDER BY id DESC LIMIT 1`, [userId]);
  const gameA = await gameOf(a.user.id);
  const gameB = await gameOf(b.user.id);
  assert.equal(gameA.room_code, created.code);
  assert.equal(gameA.word_id, gameB.word_id);
  const secret = await secretOf(gameA.id);

  // HTTP can't be used to play a room game
  assert.equal((await guess(a.token, gameA.id, 'xxxxx')).status, 403);

  A.send({ type: 'room:guess', guess: 'abc' });
  assert.equal((await A.next('room:guessRejected')).code, 'bad_guess');
  A.send({ type: 'room:guess', guess: 'xxxxx' });
  const mine = await A.next('room:guessResult');
  assert.equal(mine.pattern, 'bbbbb');
  const seenByB = await B.next('room:progress', (m) => m.userId === a.user.id);
  assert.equal(seenByB.pattern, 'bbbbb');
  assert.equal(seenByB.guess, undefined, 'opponents never see letters');

  // reconnect (page refresh): the round continues and the guess is restored
  A.ws.close();
  const A2 = await login(a.token);
  const resumed = await A2.next('room:started');
  assert.deepEqual(resumed.resume.map((g) => g.guess), ['xxxxx']);
  assert.equal((await A2.next('room:state', (m) => m.status === 'playing')).status, 'playing');

  B.send({ type: 'room:guess', guess: secret });
  assert.equal((await B.next('room:guessResult')).status, 'won');
  const doneB = await B.next('room:finished');
  const doneA = await A2.next('room:finished');
  assert.equal(doneB.winnerId, b.user.id);
  assert.equal(doneA.winnerName, 'duel_b');
  assert.equal(doneA.answer, secret);
  assert.equal(doneB.me.result.status, 'won');
  assert.ok(doneB.me.result.newAchievements.some((x) => x.code === 'duelist'));
  assert.equal(doneA.me.result.status, 'lost');
  assert.equal((await gameOf(a.user.id)).status, 'lost');
  const won = await gameOf(b.user.id);
  assert.equal(won.status, 'won');
  assert.equal(won.score, Math.round((100 + 5 * 25) * 1.25));
  assert.equal((await call(`/api/games/${gameA.id}/explain`, { method: 'POST', token: a.token })).status, 200);

  // rematch: back in the lobby, the host starts round 2
  A2.send({ type: 'room:start' });
  const round2 = await A2.next('room:state', (m) => m.status === 'playing' && m.round === 2);
  assert.equal(round2.round, 2);
  assert.notEqual((await gameOf(a.user.id)).id, gameA.id);

  // a player who leaves mid-round forfeits; the last one standing is not stuck
  B.send({ type: 'room:leave' });
  await B.next('room:left');
  await A2.next('room:state', (m) => m.players.length === 1);
  A2.send({ type: 'room:leave' });
  await A2.next('room:left');
  for (const client of [A2, B, C]) client.ws.close();
  assert.equal((await gameOf(b.user.id)).status, 'lost');
});

test('websocket rejects bad tokens', async () => {
  const client = connect();
  await client.opened;
  client.send({ type: 'auth', token: 'garbage' });
  await client.next('auth:error');
  await new Promise((resolve) => client.ws.on('close', resolve));
});

test('static files, security headers and error handling', async () => {
  const health = await fetch(`${base}/healthz`);
  assert.equal(health.status, 200);
  assert.ok(health.headers.get('content-security-policy').includes("script-src 'self'"));
  assert.equal(health.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await fetch(`${base}/api/nope`)).status, 404);
  assert.equal((await fetch(`${base}/api/games`)).status, 405);
  assert.equal((await fetch(`${base}/..%2fserver%2fconfig.js`)).status, 403);
  const bad = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{oops' });
  assert.equal(bad.status, 400);
});
