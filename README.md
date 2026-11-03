# WordForge

A themed Wordle. Pick any theme (space, 90s cartoons, Greek gods…) and AI forges the secret words for it.
Play solo, take on the daily word, or race friends in real-time rooms. Accounts, XP levels, badges and leaderboards included.

**Stack:** plain JavaScript everywhere. Node.js backend (no framework), vanilla JS single-page frontend, SQLite or PostgreSQL, WebSockets, Gemini / Claude / OpenAI for the AI parts. Only two npm dependencies: `ws` and `pg`.

## Run it

You need **Node.js 22.13 or newer** (`node -v`).

```bash
npm install
npm start
# open http://localhost:3000
```

That is all: with no configuration it uses a local SQLite file (`data/wordforge.db`) and the built-in word bank.
Node prints an "SQLite is an experimental feature" warning. It is harmless.

### Turn the AI on (optional)

Copy `.env.example` to `.env` and set one key:

```
GEMINI_API_KEY=...      # free tier at https://aistudio.google.com
# or ANTHROPIC_API_KEY=...   or   OPENAI_API_KEY=... (OpenAI also needs AI_MODEL)
```

Restart the server. The home page then says "AI forges words for any theme you type".
If you get a "model not found" error in the server log, set `AI_MODEL` to a model name from your provider's docs (model names change often).
Without a key everything still works: the built-in bank has the themes *animals, food, space, sports* in English and *животные, еда, космос* in Russian, plus general words.

### Tests

```bash
npm test
```

19 tests cover the game rules, accounts, scoring, hints, modes, daily word, themes, leaderboards, the AI module (with a fake provider, so no key or network is needed) and the whole real-time room flow with WebSocket clients.

## What is in it

| Area | What it does |
|---|---|
| **Frontend** | Single page app (`public/`). Stamped metal-type tiles, on-screen and physical keyboard, English and Russian layouts, light and dark mode, mobile layout, reduced-motion support, keyboard accessible. |
| **Backend** | REST API + WebSocket server on Node's `http` module (`server/`). Scrypt password hashing, signed JWT sessions, rate limiting, input validation, security headers (CSP). The secret word never leaves the server until the game is over. |
| **Database** | 9 related tables: users, games, guesses, words, themes, theme_likes, daily_words, dictionary, user_achievements. SQLite for development, PostgreSQL in production (just set `DATABASE_URL`). Same SQL runs on both. |
| **AI** | Generates words for any theme, writes hints, judges whether a guess is a real word, explains the word after the game. Every AI answer is validated, cached in the database and has an offline fallback. |
| **Deploy** | `Dockerfile`, `docker-compose.yml` (app + PostgreSQL), health check at `/healthz`, step-by-step guide for Google Cloud and AWS in [DEPLOY.md](DEPLOY.md). |

### Game features

- **Modes:** Classic (6 tries), Timed (3 minutes, speed bonus), Hardcore (4 tries, no hints, double points), Describe (a clue is shown from the start), word length 4–8, English or Russian.
- **Daily word:** one 5-letter word per UTC day, the same for everyone, with its own leaderboard and daily streak.
- **Rooms:** 2–4 players, share a 5-character code, same word, first to solve wins. Opponents see only colours, never letters. A page refresh does not forfeit the round.
- **Themes:** publish your own theme, others can play and like it.
- **Progress:** points, XP and levels, win and daily streaks, guess distribution, 14 badges, weekly / all-time / daily leaderboards.
- **Adaptive difficulty:** the server looks at your last 10 games and picks easier or harder words.
- **Hints:** up to 3 per game, each costs 20 points. The AI writes them with your guesses in mind and never reveals the word (checked on the server).

### Scoring

`100 + (tries left × 25) + (length − 5) × 10 − 20 × hints`, then × 1.25 timed, × 2 hardcore, × 1.5 daily, × 1.25 room win. XP is half the points; a loss gives 5 XP; quitting a game gives 0.

## How the AI is used (and kept safe)

`server/ai.js` is the only file that talks to a provider (plain `fetch`).

1. **Words:** the pool for *(language, theme, length, difficulty)* is stored in the `words` table. Only when it runs dry does the server ask the AI for 10 new words. The answer is parsed and each word is checked: right length, letters only, no duplicates, and the clue must not contain the word.
2. **Guess validation:** unknown words are checked by the AI once, and the verdict is cached in `dictionary`.
3. **Hints and explanations:** the hint is thrown away if it contains the secret word; explanations are cached on the word.
4. **Failure handling:** if the AI errors or hits a quota, it is skipped for 30 seconds and the game uses the built-in bank, so players never see a broken game.
5. **Prompt injection:** a theme is free text from users, so it is reduced to letters, digits, spaces, `-` and `'` (max 40 characters), and the prompt tells the model to treat it as data.

Because of the caching, a typical game makes **zero** AI calls once a theme has been played a few times, which matters on free API tiers.

## Project layout

```
server/
  index.js      start-up, shutdown
  config.js     environment variables
  http.js       router, JSON bodies, static files, security headers, rate limiter
  auth.js       scrypt + JWT
  db.js         SQLite / PostgreSQL adapter and schema
  routes.js     REST API
  game.js       rules: evaluate, score, guess, hint, explain
  stats.js      streaks, badges, adaptive difficulty, leaderboards
  words.js      word pool, daily word, guess validation
  ai.js         Gemini / Anthropic / OpenAI, prompts, validation
  rooms.js      WebSocket rooms
  wordbank.js   built-in words
public/         index.html, styles.css, app.js, favicon.svg
test/           server.test.js
```

## API

All endpoints are under `/api`. Send `Authorization: Bearer <token>` except where noted.

| Method and path | Purpose |
|---|---|
| `GET /config` (public) | AI on/off, suggested themes |
| `POST /auth/register`, `POST /auth/login` (public) | returns `{ token, user }` |
| `GET /me` | current user, XP, level |
| `POST /games` | new game `{ theme, language, length, mode, difficulty }` |
| `GET /games/current`, `GET /games/:id` | resume a game |
| `POST /games/:id/guess` | `{ guess }` → `{ pattern, attempts, status, result? }` |
| `POST /games/:id/hint`, `POST /games/:id/explain` | AI hint, meaning of the word after the game |
| `GET /daily`, `POST /daily` | today's daily game |
| `GET /themes`, `POST /themes`, `POST /themes/:id/like` | player themes |
| `GET /leaderboard?type=weekly\|all\|daily` (public) | rankings |
| `GET /users/:username` (public) | profile and stats |
| `GET /healthz` (public, not under `/api`) | health check |

WebSocket: `/ws`. The first message must be `{ "type": "auth", "token": "..." }`. Message types are listed at the top of `server/rooms.js`.

## Honest notes and limits

- **PostgreSQL:** the development and the tests run on SQLite. The PostgreSQL path uses the same portable SQL and is written to be compatible, but it could not be run where this project was built. Check it once with `docker compose up --build` before you rely on it.
- **Without AI** any string of letters of the right length is accepted as a guess (there is no dictionary file). With AI on, unknown guesses are verified.
- **Rooms and rate limits live in memory,** so run **one** server instance (see DEPLOY.md).
- The login token is kept in `localStorage`. All user text is inserted with `textContent`, and a strict CSP is sent, to keep XSS out.
- No password reset or email; this is a course project, not a product.
