import { DAY_MS, dayKey, levelInfo } from './util.js';

export const ACHIEVEMENTS = [
  { code: 'first_win', title: 'First win', desc: 'Win a game.' },
  { code: 'lucky_one', title: 'In one', desc: 'Win on the first guess.' },
  { code: 'streak_5', title: 'Five in a row', desc: 'Win 5 games in a row.' },
  { code: 'streak_10', title: 'Ten in a row', desc: 'Win 10 games in a row.' },
  { code: 'daily_3', title: 'Three days running', desc: 'Win the daily word 3 days in a row.' },
  { code: 'daily_7', title: 'A full week', desc: 'Win the daily word 7 days in a row.' },
  { code: 'wins_10', title: 'Ten wins', desc: 'Win 10 games.' },
  { code: 'wins_50', title: 'Fifty wins', desc: 'Win 50 games.' },
  { code: 'hardcore', title: 'No safety net', desc: 'Win a hardcore game.' },
  { code: 'quick_hands', title: 'Quick hands', desc: 'Win a timed game in under 60 seconds.' },
  { code: 'polyglot', title: 'Two languages', desc: 'Win in both English and Russian.' },
  { code: 'duelist', title: 'Duel winner', desc: 'Win a room game against friends.' },
  { code: 'theme_maker', title: 'Theme maker', desc: 'Publish a theme for others to play.' },
  { code: 'level_5', title: 'Level 5', desc: 'Reach level 5.' },
];
const BY_CODE = Object.fromEntries(ACHIEVEMENTS.map((a) => [a.code, a]));

// ---------- streaks ----------
// rows: finished games, newest first. Returns the current and the best run of consecutive wins.
export function winStreaks(rows) {
  let current = 0, best = 0, run = 0, counting = true;
  for (const row of rows) {
    if (row.status === 'won') {
      run += 1;
      best = Math.max(best, run);
      if (counting) current = run;
    } else {
      run = 0;
      counting = false;
    }
  }
  return { current, best };
}

// days: "YYYY-MM-DD" strings on which the daily word was won. Today not played yet doesn't break a streak.
export function dailyStreaks(days, today = dayKey()) {
  const set = new Set(days);
  let current = 0;
  let cursor = Date.parse(today);
  if (!set.has(today)) cursor -= DAY_MS;
  while (set.has(dayKey(cursor))) {
    current += 1;
    cursor -= DAY_MS;
  }
  let best = 0, run = 0, previous = null;
  for (const day of [...set].sort()) {
    run = previous !== null && Date.parse(day) - previous === DAY_MS ? run + 1 : 1;
    best = Math.max(best, run);
    previous = Date.parse(day);
  }
  return { current, best };
}

async function recentFinished(db, userId) {
  return db.all(
    `SELECT status, daily_day FROM games WHERE user_id = $1 AND status <> 'playing'
     ORDER BY finished_at DESC, id DESC LIMIT 1000`,
    [userId],
  );
}

async function wonDailyDays(db, userId) {
  const rows = await db.all(`SELECT daily_day FROM games WHERE user_id = $1 AND status = 'won' AND daily_day IS NOT NULL`, [userId]);
  return rows.map((r) => r.daily_day);
}

// ---------- achievements ----------
// event: { game, status, xp, theme }. Returns the achievements that were earned just now.
export async function evaluateAchievements(db, userId, event = {}) {
  const earned = new Set();
  const { game } = event;
  if (game && event.status === 'won') {
    const { c: wins } = await db.get(`SELECT COUNT(*) AS c FROM games WHERE user_id = $1 AND status = 'won'`, [userId]);
    if (wins >= 1) earned.add('first_win');
    if (wins >= 10) earned.add('wins_10');
    if (wins >= 50) earned.add('wins_50');
    if (game.attempts === 1) earned.add('lucky_one');
    if (game.mode === 'hardcore') earned.add('hardcore');
    if (game.mode === 'timed' && game.finished_at - game.started_at < 60_000) earned.add('quick_hands');
    if (game.room_code) earned.add('duelist');
    const { current } = winStreaks(await recentFinished(db, userId));
    if (current >= 5) earned.add('streak_5');
    if (current >= 10) earned.add('streak_10');
    if (game.daily_day) {
      const daily = dailyStreaks(await wonDailyDays(db, userId)).current;
      if (daily >= 3) earned.add('daily_3');
      if (daily >= 7) earned.add('daily_7');
    }
    const { c: languages } = await db.get(
      `SELECT COUNT(DISTINCT language) AS c FROM games WHERE user_id = $1 AND status = 'won'`,
      [userId],
    );
    if (languages >= 2) earned.add('polyglot');
  }
  if (event.theme) earned.add('theme_maker');
  if (event.xp != null && levelInfo(event.xp).level >= 5) earned.add('level_5');

  const fresh = [];
  for (const code of earned) {
    const inserted = await db.get(
      `INSERT INTO user_achievements (user_id, code, earned_at) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING RETURNING code`,
      [userId, code, Date.now()],
    );
    if (inserted) fresh.push(BY_CODE[code]);
  }
  return fresh;
}

// ---------- adaptive difficulty ----------
// Looks at the last 10 solo games: winning easily -> harder words, struggling -> easier words.
export async function adaptiveDifficulty(db, userId) {
  const rows = await db.all(
    `SELECT status, attempts FROM games WHERE user_id = $1 AND status <> 'playing' AND room_code IS NULL
     ORDER BY finished_at DESC, id DESC LIMIT 10`,
    [userId],
  );
  if (rows.length < 3) return 2;
  const wins = rows.filter((r) => r.status === 'won');
  const winRate = wins.length / rows.length;
  const avgAttempts = wins.length ? wins.reduce((sum, r) => sum + r.attempts, 0) / wins.length : 6;
  if (winRate >= 0.8 && avgAttempts <= 3.5) return 3;
  if (winRate <= 0.4) return 1;
  return 2;
}

// ---------- profile ----------
export async function userStats(db, userId) {
  const user = await db.get(`SELECT id, username, xp, created_at FROM users WHERE id = $1`, [userId]);
  if (!user) return null;
  const finished = await recentFinished(db, userId);
  const wins = finished.filter((g) => g.status === 'won').length;
  const { current, best } = winStreaks(finished);
  const daily = dailyStreaks(await wonDailyDays(db, userId));
  const attempts = await db.all(
    `SELECT attempts, COUNT(*) AS c FROM games WHERE user_id = $1 AND status = 'won' GROUP BY attempts`,
    [userId],
  );
  const distribution = {};
  let attemptsTotal = 0;
  for (const row of attempts) {
    distribution[row.attempts] = row.c;
    attemptsTotal += row.attempts * row.c;
  }
  const themes = await db.all(
    `SELECT theme, COUNT(*) AS games, CAST(SUM(CASE WHEN status = 'won' THEN 1 ELSE 0 END) AS INTEGER) AS wins
     FROM games WHERE user_id = $1 AND status <> 'playing'
     GROUP BY theme ORDER BY games DESC, theme LIMIT 5`,
    [userId],
  );
  const earned = await db.all(`SELECT code, earned_at FROM user_achievements WHERE user_id = $1`, [userId]);
  const earnedAt = Object.fromEntries(earned.map((r) => [r.code, r.earned_at]));
  return {
    user: { id: user.id, username: user.username, createdAt: user.created_at, ...levelInfo(user.xp) },
    games: finished.length,
    wins,
    winRate: finished.length ? wins / finished.length : 0,
    avgAttempts: wins ? attemptsTotal / wins : 0,
    streak: { current, best },
    dailyStreak: daily,
    distribution,
    themes,
    achievements: ACHIEVEMENTS.map((a) => ({ ...a, earnedAt: earnedAt[a.code] ?? null })),
  };
}

// ---------- leaderboards ----------
export async function leaderboard(db, kind, day = dayKey()) {
  if (kind === 'daily') {
    const rows = await db.all(
      `SELECT u.username, g.status, g.attempts, g.score, (g.finished_at - g.started_at) AS ms
       FROM games g JOIN users u ON u.id = g.user_id
       WHERE g.daily_day = $1 AND g.status <> 'playing'
       ORDER BY g.score DESC, g.attempts ASC, ms ASC LIMIT 25`,
      [day],
    );
    return rows.map((row, i) => ({ rank: i + 1, ...row }));
  }
  const since = kind === 'weekly' ? Date.now() - 7 * DAY_MS : 0;
  const rows = await db.all(
    `SELECT u.username, CAST(SUM(g.score) AS INTEGER) AS score, COUNT(*) AS games,
            CAST(SUM(CASE WHEN g.status = 'won' THEN 1 ELSE 0 END) AS INTEGER) AS wins
     FROM games g JOIN users u ON u.id = g.user_id
     WHERE g.status <> 'playing' AND g.finished_at >= $1
     GROUP BY u.id, u.username
     ORDER BY score DESC, wins DESC LIMIT 25`,
    [since],
  );
  return rows.map((row, i) => ({ rank: i + 1, ...row }));
}
