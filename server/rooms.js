// Real-time rooms. 2–4 players get the same secret word and race to solve it; the first solver wins
// and the round ends for everybody. Opponents only see colour patterns, never each other's letters.
//
// Protocol (JSON messages over one WebSocket at /ws):
//   client -> server: auth {token} | room:create {theme, language, length} | room:join {code}
//                     room:start | room:guess {guess} | room:leave
//   server -> client: auth:ok | room:state | room:started | room:guessResult | room:guessRejected
//                     room:progress | room:finished | room:error
import { WebSocketServer } from 'ws';
import { verifyToken } from './auth.js';
import { HttpError } from './http.js';
import { MODE_RULES, createGame, finalizeGame, submitGuess } from './game.js';
import { LANGUAGES, sanitizeTheme } from './util.js';
import { pickWord } from './words.js';

const MAX_PLAYERS = 4;
const ROUND_MS = 5 * 60_000;
const RECONNECT_MS = 20_000; // a page refresh must not forfeit the round
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I to avoid mix-ups

class RoomError extends Error {}

export function attachRooms(server, { db, config }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  let closed = false;
  const rooms = new Map(); // code -> room
  const userRoom = new Map(); // userId -> code

  server.on('upgrade', (req, socket, head) => {
    if (new URL(req.url, 'http://localhost').pathname !== '/ws') return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  const send = (ws, message) => ws?.readyState === 1 && ws.send(JSON.stringify(message));
  const broadcast = (room, message) => room.players.forEach((p) => send(p.ws, message));

  function stateOf(room) {
    return {
      type: 'room:state',
      code: room.code,
      hostId: room.hostId,
      status: room.status,
      round: room.round,
      settings: room.settings,
      theme: room.shownTheme ?? room.settings.theme,
      maxPlayers: MAX_PLAYERS,
      maxAttempts: MODE_RULES.room.attempts,
      endsAt: room.status === 'playing' ? room.startedAt + ROUND_MS : null,
      players: [...room.players.values()].map((p) => ({
        id: p.id, username: p.username, status: p.status, attempts: p.attempts, rows: p.rows, connected: p.connected,
      })),
    };
  }
  const pushState = (room) => broadcast(room, stateOf(room));

  function removePlayer(room, userId) {
    const player = room.players.get(userId);
    if (player) clearTimeout(player.dropTimer);
    room.players.delete(userId);
    userRoom.delete(userId);
    if (!room.players.size) {
      clearTimeout(room.timer);
      rooms.delete(room.code);
      return;
    }
    if (room.hostId === userId) room.hostId = room.players.keys().next().value;
    pushState(room);
  }

  const playersStillPlaying = (room) => [...room.players.values()].filter((p) => p.status === 'playing');

  async function endRound(room, winnerId) {
    if (room.status !== 'playing') return;
    room.status = 'finished'; // set first: the winner's guess and the timer can arrive together
    clearTimeout(room.timer);
    for (const p of room.players.values()) {
      if (p.status !== 'playing') continue;
      p.result = await finalizeGame(db, p.game, 'lost', { reason: winnerId ? 'opponent_won' : 'timeout' });
      p.status = 'lost';
    }
    const results = [...room.players.values()].map((p) => ({
      userId: p.id, username: p.username, status: p.status, attempts: p.attempts, score: p.result?.score ?? 0,
    }));
    const winner = room.players.get(winnerId);
    for (const p of room.players.values()) {
      send(p.ws, {
        type: 'room:finished',
        winnerId: winnerId ?? null,
        winnerName: winner?.username ?? null,
        answer: room.answer,
        results,
        me: { gameId: p.game.id, result: p.result },
      });
    }
    for (const p of [...room.players.values()]) if (!p.connected) removePlayer(room, p.id);
    if (rooms.has(room.code)) pushState(room);
  }

  async function forfeit(room, player) {
    if (room.status === 'playing' && player.status === 'playing') {
      player.status = 'left';
      await finalizeGame(db, player.game, 'lost', { reason: 'left' });
      broadcast(room, { type: 'room:progress', userId: player.id, attempts: player.attempts, status: 'left' });
    }
    if (room.players.get(player.id) === player) removePlayer(room, player.id);
    if (rooms.has(room.code) && room.status === 'playing' && !playersStillPlaying(room).length) await endRound(room, null);
  }

  function attach(room, user, ws) {
    const existing = room.players.get(user.id);
    if (existing) {
      clearTimeout(existing.dropTimer);
      if (existing.ws && existing.ws !== ws) send(existing.ws, { type: 'room:error', message: 'You joined this room from another tab.' });
      existing.ws = ws;
      existing.connected = true;
    } else {
      room.players.set(user.id, {
        id: user.id, username: user.username, ws, connected: true, status: 'waiting', attempts: 0, rows: [], game: null, result: null,
      });
    }
    userRoom.set(user.id, room.code);
    ws.roomCode = room.code;
  }

  async function sendResume(room, player) {
    if (!player.game || room.status !== 'playing') return;
    const guesses = await db.all(`SELECT guess, pattern FROM guesses WHERE game_id = $1 ORDER BY idx`, [player.game.id]);
    send(player.ws, { type: 'room:started', length: room.settings.length, resume: guesses });
  }

  function leaveCurrent(ws) {
    const room = rooms.get(userRoom.get(ws.user.id));
    if (!room) return;
    const player = room.players.get(ws.user.id);
    ws.roomCode = null;
    if (room.status === 'playing' && player?.status === 'playing') {
      player.connected = false;
      return forfeit(room, player);
    }
    removePlayer(room, ws.user.id);
  }

  async function handle(ws, message) {
    const user = ws.user;
    switch (message.type) {
      case 'room:create': {
        await leaveCurrent(ws);
        const language = LANGUAGES.includes(message.language) ? message.language : 'en';
        const length = Number(message.length);
        const settings = {
          theme: sanitizeTheme(message.theme) || 'general',
          language,
          length: Number.isInteger(length) && length >= 4 && length <= 8 ? length : 5,
        };
        let code;
        do code = Array.from({ length: 5 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
        while (rooms.has(code));
        const room = { code, hostId: user.id, settings, status: 'lobby', round: 0, players: new Map(), startedAt: 0, timer: null, answer: null };
        rooms.set(code, room);
        attach(room, user, ws);
        pushState(room);
        return;
      }
      case 'room:join': {
        const code = String(message.code ?? '').toUpperCase().trim();
        const room = rooms.get(code);
        if (!room) throw new RoomError('No room with that code');
        const mine = room.players.get(user.id);
        if (!mine) {
          if (room.status === 'playing') throw new RoomError('That round has already started. Wait for it to finish.');
          if (room.players.size >= MAX_PLAYERS) throw new RoomError('The room is full');
          await leaveCurrent(ws);
        }
        attach(room, user, ws);
        pushState(room);
        if (mine) await sendResume(room, room.players.get(user.id));
        return;
      }
      case 'room:leave':
        await leaveCurrent(ws);
        send(ws, { type: 'room:left' });
        return;
      case 'room:start': {
        const room = rooms.get(ws.roomCode);
        if (!room) throw new RoomError('You are not in a room');
        if (room.hostId !== user.id) throw new RoomError('Only the host can start the round');
        if (room.status === 'playing' || room.starting) throw new RoomError('A round is already running');
        const present = [...room.players.values()].filter((p) => p.connected);
        if (present.length < 2) throw new RoomError('Invite at least one more player first');
        room.starting = true;
        try {
          const picked = await pickWord(db, { ...room.settings, difficulty: 2, userId: room.hostId });
          room.answer = picked.row.word;
          room.shownTheme = picked.theme;
          for (const p of present) {
            p.game = await createGame(db, {
              userId: p.id, wordRow: picked.row, theme: picked.theme, mode: 'room',
              language: room.settings.language, length: room.settings.length, roomCode: room.code,
            });
            Object.assign(p, { status: 'playing', attempts: 0, rows: [], result: null });
          }
          room.status = 'playing';
          room.round += 1;
          room.startedAt = Date.now();
          room.timer = setTimeout(() => endRound(room, null).catch(console.error), ROUND_MS);
          broadcast(room, { type: 'room:started', length: room.settings.length });
          pushState(room);
        } finally {
          room.starting = false;
        }
        return;
      }
      case 'room:guess': {
        const room = rooms.get(ws.roomCode);
        const player = room?.players.get(user.id);
        if (!room || room.status !== 'playing' || player?.status !== 'playing') throw new RoomError('There is no running round for you');
        let out;
        try {
          out = await submitGuess(db, player.game, message.guess);
        } catch (error) {
          if (error instanceof HttpError && error.status === 422) {
            return send(ws, { type: 'room:guessRejected', message: error.message, code: error.code });
          }
          throw error;
        }
        if (out.expired) return endRound(room, null);
        player.attempts = out.attempts;
        player.rows.push(out.pattern);
        if (out.status !== 'playing') {
          player.status = out.status;
          player.result = out.result;
        }
        send(ws, { type: 'room:guessResult', guess: out.guess, pattern: out.pattern, attempts: out.attempts, status: out.status });
        broadcast(room, { type: 'room:progress', userId: player.id, attempts: out.attempts, pattern: out.pattern, status: player.status });
        if (out.status === 'won') await endRound(room, player.id);
        else if (!playersStillPlaying(room).length) await endRound(room, null);
        return;
      }
      default:
        throw new RoomError('Unknown message');
    }
  }

  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.user = null;
    ws.roomCode = null;
    ws.on('pong', () => (ws.isAlive = true));
    const authTimer = setTimeout(() => ws.user || ws.close(4001, 'auth timeout'), 5000);
    let budget = 40; // at most 40 messages per 10 seconds
    const refill = setInterval(() => (budget = 40), 10_000);

    ws.on('message', async (raw) => {
      if (--budget < 0) return ws.close(4008, 'slow down');
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      try {
        if (!ws.user) {
          if (message.type !== 'auth') return;
          const payload = verifyToken(message.token, config.jwtSecret);
          const user = payload && (await db.get(`SELECT id, username FROM users WHERE id = $1`, [payload.sub]));
          if (!user) {
            send(ws, { type: 'auth:error' });
            return ws.close(4003, 'bad token');
          }
          clearTimeout(authTimer);
          ws.user = user;
          send(ws, { type: 'auth:ok', user });
          const room = rooms.get(userRoom.get(user.id));
          if (room?.players.has(user.id)) { // reconnect after a refresh
            attach(room, user, ws);
            pushState(room);
            await sendResume(room, room.players.get(user.id));
          }
          return;
        }
        await handle(ws, message);
      } catch (error) {
        const known = error instanceof RoomError || error instanceof HttpError;
        send(ws, { type: 'room:error', message: known ? error.message : 'Something went wrong' });
        if (!known) console.error('[ws]', error);
      }
    });

    ws.on('close', () => {
      clearTimeout(authTimer);
      clearInterval(refill);
      if (!ws.user || closed) return;
      const room = rooms.get(userRoom.get(ws.user.id));
      const player = room?.players.get(ws.user.id);
      if (!player || player.ws !== ws) return; // replaced by a newer tab, or already gone
      player.connected = false;
      if (room.status === 'playing' && player.status === 'playing') {
        player.dropTimer = setTimeout(() => forfeit(room, player).catch(console.error), RECONNECT_MS);
        player.dropTimer.unref();
        pushState(room);
      } else {
        removePlayer(room, ws.user.id);
      }
    });
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30_000);
  heartbeat.unref();

  return {
    close() {
      closed = true;
      clearInterval(heartbeat);
      for (const room of rooms.values()) {
        clearTimeout(room.timer);
        room.players.forEach((p) => clearTimeout(p.dropTimer));
      }
      for (const ws of wss.clients) ws.terminate();
      wss.close();
    },
  };
}
