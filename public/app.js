const state = {
  token: localStorage.getItem('wf_token'),
  user: null,
  config: { aiEnabled: false, themes: { en: [], ru: [] } },
  cleanup: null,
};
let renderId = 0;

const LANGS = { en: 'English', ru: 'Русский' };
const MODES = {
  classic: ['Classic', '6 tries, hints allowed.'],
  timed: ['Timed', '3 minutes, bonus points for speed.'],
  hardcore: ['Hardcore', '4 tries, no hints, double points.'],
  describe: ['Describe', 'A clue about the word is shown from the start.'],
  daily: ['Daily', ''],
  room: ['Room', ''],
};
const DEFAULTS = { theme: '', language: 'en', length: 0, mode: 'classic', difficulty: 'auto' };

const $ = (selector, root = document) => root.querySelector(selector);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const go = (path) => { location.hash = '#' + path; };
const loadSettings = () => {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('wf_settings')) }; } catch { return { ...DEFAULTS }; }
};
const saveSettings = (settings) => localStorage.setItem('wf_settings', JSON.stringify(settings));

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key === 'value' || key === 'checked' || key === 'disabled') el[key] = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  el.append(...children.flat(Infinity).filter((child) => child != null && child !== false));
  return el;
}

const clean = (children) => children.flat(Infinity).filter((child) => child != null && child !== false);
const put = (parent, ...children) => parent.replaceChildren(...clean(children));
const add = (parent, ...children) => parent.append(...clean(children));

function toast(message) {
  const el = h('div', { class: 'toast' }, message);
  $('#toasts').append(el);
  setTimeout(() => el.remove(), 3400);
}

async function api(path, { method = 'GET', body } = {}) {
  const response = await fetch(path, {
    method,
    headers: { ...(body && { 'Content-Type': 'application/json' }), ...(state.token && { Authorization: `Bearer ${state.token}` }) },
    body: body && JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && state.token) logout();
    const error = new Error(data.error?.message ?? 'Request failed');
    error.code = data.error?.code;
    error.status = response.status;
    throw error;
  }
  return data;
}

function logout() {
  state.token = null;
  state.user = null;
  localStorage.removeItem('wf_token');
  net.ws?.close();
  go('/login');
}

async function refreshUser() {
  try {
    state.user = (await api('/api/me')).user;
    $('.me')?.replaceWith(meChip());
  } catch { }
}

const net = {
  ws: null,
  ready: null,
  listeners: new Set(),
  connect() {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
      this.ws = ws;
      ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token: state.token }));
      ws.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.type === 'auth:ok') resolve();
        if (message.type === 'auth:error') reject(new Error('Authentication failed'));
        this.listeners.forEach((listener) => listener(message));
      };
      ws.onclose = () => {
        this.ws = null;
        this.ready = null;
        reject(new Error('Connection closed'));
        this.listeners.forEach((listener) => listener({ type: 'ws:closed' }));
      };
    });
    this.ready.catch(() => {});
    return this.ready;
  },
  send(message) { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(message)); },
  on(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  },
};

const LAYOUTS = { en: ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'], ru: ['йцукенгшщзхъ', 'фывапролджэ', 'ячсмитьбю'] };
const PATTERN_NAME = { g: 'correct', y: 'in the word, wrong place', b: 'not in the word' };

function createBoard(length, rows) {
  const el = h('div', { class: 'board', role: 'grid', 'aria-label': 'Guesses' });
  el.style.setProperty('--len', length);
  const rowEls = [];
  const tiles = [];
  for (let r = 0; r < rows; r++) {
    const rowTiles = Array.from({ length }, () => h('div', { class: 'tile', role: 'gridcell' }));
    const rowEl = h('div', { class: 'row', role: 'row' }, rowTiles);
    el.append(rowEl);
    rowEls.push(rowEl);
    tiles.push(rowTiles);
  }
  const paint = (r, guess, pattern) => tiles[r].forEach((tile, i) => {
    tile.textContent = guess[i];
    tile.className = `tile ${pattern[i]}`;
    tile.setAttribute('aria-label', `${guess[i]}, ${PATTERN_NAME[pattern[i]]}`);
  });
  return {
    el,
    paint,
    setLetters(r, text) {
      tiles[r].forEach((tile, i) => {
        tile.textContent = text[i] ?? '';
        tile.className = text[i] ? 'tile filled' : 'tile';
      });
    },
    async reveal(r, guess, pattern) {
      const delay = reducedMotion() ? 0 : 110;
      for (let i = 0; i < length; i++) {
        const tile = tiles[r][i];
        tile.textContent = guess[i];
        tile.className = `tile ${pattern[i]} stamp`;
        tile.setAttribute('aria-label', `${guess[i]}, ${PATTERN_NAME[pattern[i]]}`);
        if (delay) await sleep(delay);
      }
      if (delay) await sleep(250);
    },
    shake(r) {
      rowEls[r]?.classList.add('shake');
      setTimeout(() => rowEls[r]?.classList.remove('shake'), 450);
    },
  };
}

function createKeyboard(language, onKey) {
  const keys = new Map();
  const key = (label, value, extra = '') => h('button', {
    type: 'button', class: `key ${extra}`, 'aria-label': value.length > 1 ? value : label,
    onclick: (event) => { event.currentTarget.blur(); onKey(value); },
  }, label);
  const el = h('div', { class: 'kb' }, LAYOUTS[language].map((row, i) => h('div', { class: 'kb-row' },
    i === 2 ? key('Enter', 'Enter', 'wide') : null,
    [...row].map((ch) => { const button = key(ch, ch); keys.set(ch, button); return button; }),
    i === 2 ? key('⌫', 'Backspace', 'wide') : null,
  )));
  const rank = { b: 1, y: 2, g: 3 };
  return {
    el,
    mark(guess, pattern) {
      [...guess].forEach((ch, i) => {
        const button = keys.get(ch);
        if (!button) return;
        const current = ['b', 'y', 'g'].find((c) => button.classList.contains(c));
        if ((rank[current] ?? 0) < rank[pattern[i]]) {
          button.classList.remove('b', 'y', 'g');
          button.classList.add(pattern[i]);
        }
      });
    },
  };
}

function createPlay({ language, length, maxAttempts, guesses = [], submit, onResult }) {
  const board = createBoard(length, maxAttempts);
  const keyboard = createKeyboard(language, handleKey);
  let current = '';
  let row = guesses.length;
  let busy = false;
  let over = false;
  const usedGuesses = new Set(guesses.map((g) => g.guess.toLowerCase()));
  guesses.forEach((g, r) => { board.paint(r, g.guess, g.pattern); keyboard.mark(g.guess, g.pattern); });

  function handleKey(k) {
    if (over || busy) return;
    if (k === 'Enter') return enter();
    current = k === 'Backspace' ? current.slice(0, -1) : current.length < length ? current + k : current;
    board.setLetters(row, current);
  }

  async function enter() {
    if (current.length < length) {
      board.shake(row);
      return toast(`Enter ${length} letters`);
    }
    const cleanGuess = current.toLowerCase();
    if (usedGuesses.has(cleanGuess)) {
      board.shake(row);
      return toast('You already tried that word!');
    }
    busy = true;
    try {
      const result = await submit(current);
      if (result.expired) {
        over = true;
      } else {
        usedGuesses.add(cleanGuess);
        await board.reveal(row, result.guess, result.pattern);
        keyboard.mark(result.guess, result.pattern);
        row += 1;
        current = '';
      }
      onResult?.(result);
    } catch (error) {
      board.shake(row);
      toast(error.message);
    }
    busy = false;
  }

  const letter = language === 'ru' ? /^[а-яё]$/ : /^[a-z]$/;
  function onKeyDown(event) {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'A'].includes(document.activeElement?.tagName)) return;
    if (event.key === 'Enter' || event.key === 'Backspace') {
      event.preventDefault();
      handleKey(event.key);
    } else if (letter.test(event.key.toLowerCase())) {
      handleKey(event.key.toLowerCase() === 'ё' ? 'е' : event.key.toLowerCase());
    }
  }
  document.addEventListener('keydown', onKeyDown);

  return {
    el: h('div', {}, board.el, keyboard.el),
    attempts: () => row,
    finish() { over = true; },
    destroy() { document.removeEventListener('keydown', onKeyDown); },
  };
}

function xpBar(user) {
  const bar = h('span');
  bar.style.width = `${Math.round(Math.min(1, Math.max(0, user.progress)) * 100)}%`;
  return h('div', { class: 'xp', title: `${user.xp} XP` }, h('small', {}, `Level ${user.level}`), h('div', { class: 'bar' }, bar));
}

function meChip() {
  if (!state.user) return h('div', { class: 'me' });
  return h('div', { class: 'me' },
    h('a', { class: 'who', href: '#/profile' }, state.user.username),
    xpBar(state.user),
    h('button', { class: 'btn ghost sm', onclick: logout }, 'Log out'));
}

function seg(name, options, value, onChange) {
  return h('div', { class: 'seg', role: 'radiogroup' }, options.map(([optionValue, label]) => h('label', {},
    h('input', { type: 'radio', name, value: String(optionValue), checked: String(optionValue) === String(value), onchange: () => onChange(optionValue) }),
    h('span', {}, label))));
}

function answerTiles(word) {
  return h('div', { class: 'answer', 'aria-label': `The word was ${word}` }, [...word].map((ch) => h('div', { class: 'tile g' }, ch)));
}

async function startGame(settings, button) {
  if (button) { button.disabled = true; button.textContent = state.config.aiEnabled ? 'Forging words…' : 'Starting…'; }
  try {
    const result = await api('/api/games', { method: 'POST', body: settings });
    saveSettings(settings);
    if (result.themeFallback) toast(`No words for “${result.themeFallback}” yet, so this game uses general words.`);
    go(`/game/${result.game.id}`);
  } catch (error) {
    toast(error.message);
    if (button) { button.disabled = false; button.textContent = 'Start game'; }
  }
}

async function viewAuth(main) {
  let registering = false;
  const draw = () => {
    const error = h('p', { class: 'error', role: 'alert' });
    const username = h('input', { type: 'text', id: 'u', autocomplete: 'username', required: true, maxlength: 20 });
    const password = h('input', { type: 'password', id: 'p', autocomplete: registering ? 'new-password' : 'current-password', required: true });
    const submit = h('button', { class: 'btn big', type: 'submit' }, registering ? 'Create account' : 'Log in');
    const form = h('form', {
      onsubmit: async (event) => {
        event.preventDefault();
        submit.disabled = true;
        error.textContent = '';
        try {
          const session = await api(`/api/auth/${registering ? 'register' : 'login'}`, { method: 'POST', body: { username: username.value, password: password.value } });
          state.token = session.token;
          state.user = session.user;
          localStorage.setItem('wf_token', session.token);
          go('/');
        } catch (e) {
          error.textContent = e.message;
          submit.disabled = false;
        }
      },
    },
      h('div', { class: 'field' }, h('label', { for: 'u' }, 'Username'), username),
      h('div', { class: 'field' }, h('label', { for: 'p' }, 'Password'), password,
        registering ? h('span', { class: 'hint-text' }, 'At least 8 characters.') : null),
      error, submit);
    main.replaceChildren(h('div', { class: 'auth' },
      h('h1', {}, registering ? 'Join WordForge' : 'Welcome back'),
      h('p', { class: 'muted' }, 'Pick any theme, play the daily word, challenge friends.'),
      form,
      h('p', { class: 'muted' }, registering ? 'Already have an account? ' : 'New here? ',
        h('a', { href: '#/login', onclick: (e) => { e.preventDefault(); registering = !registering; draw(); } }, registering ? 'Log in' : 'Create an account'))));
    username.focus();
  };
  draw();
}

async function viewHome(main, ctx) {
  const settings = loadSettings();
  const [daily, current, themes] = await Promise.all([api('/api/daily'), api('/api/games/current'), api('/api/themes')]);
  const datalist = h('datalist', { id: 'theme-suggestions' });
  const fillSuggestions = () => {
    const names = [...state.config.themes[settings.language], ...themes.themes.filter((t) => t.language === settings.language).map((t) => t.name)];
    datalist.replaceChildren(...[...new Set(names)].map((name) => h('option', { value: name })));
  };
  fillSuggestions();

  let prewarmTimer = null;
  const triggerPrewarm = (val) => {
    clearTimeout(prewarmTimer);
    if (!state.config.aiEnabled || !val || val.trim().length < 2) return;
    prewarmTimer = setTimeout(() => {
      api('/api/themes/prewarm', {
        method: 'POST',
        body: { theme: val.trim(), language: settings.language, length: settings.length },
      }).catch(() => {});
    }, 600);
  };
  ctx.cleanup(() => clearTimeout(prewarmTimer));

  const theme = h('input', {
    type: 'text',
    id: 'theme',
    maxlength: 40,
    list: 'theme-suggestions',
    value: settings.theme,
    placeholder: 'Space, 90s cartoons, Greek gods…',
    autocomplete: 'off',
    oninput: (e) => triggerPrewarm(e.target.value),
  });
  if (settings.theme) triggerPrewarm(settings.theme);

  const modeNote = h('p', { class: 'hint-text' }, MODES[settings.mode][1]);
  const start = h('button', { class: 'btn big', type: 'submit' }, 'Start game');
  const aiNote = state.config.aiEnabled
    ? 'AI forges words for any theme you type.'
    : 'AI is off on this server. The built-in themes (animals, food, space, sports) work; other themes use general words.';

  const form = h('form', {
    class: 'stack',
    onsubmit: (event) => {
      event.preventDefault();
      settings.theme = theme.value;
      startGame(settings, start);
    },
  },
    h('div', { class: 'field' }, h('label', { for: 'theme' }, 'Theme'), theme, datalist, h('span', { class: 'hint-text' }, aiNote)),
    h('div', { class: 'field' }, h('span', { class: 'label' }, 'Language'),
      seg('language', Object.entries(LANGS), settings.language, (v) => { settings.language = v; fillSuggestions(); triggerPrewarm(theme.value); })),
    h('div', { class: 'field' }, h('span', { class: 'label' }, 'Word length'),
      seg('length', [[0, 'Any'], ...[4, 5, 6, 7, 8].map((n) => [n, `${n}`])], settings.length, (v) => { settings.length = Number(v); triggerPrewarm(theme.value); })),
    h('div', { class: 'field' }, h('span', { class: 'label' }, 'Mode'),
      seg('mode', ['classic', 'timed', 'hardcore', 'describe'].map((m) => [m, MODES[m][0]]), settings.mode, (v) => { settings.mode = v; modeNote.textContent = MODES[v][1]; }), modeNote),
    h('div', { class: 'field' }, h('span', { class: 'label' }, 'Difficulty'),
      seg('difficulty', [['auto', 'Adaptive'], [1, 'Easy'], [2, 'Medium'], [3, 'Hard']], settings.difficulty, (v) => { settings.difficulty = v; }),
      h('span', { class: 'hint-text' }, 'Adaptive picks harder words when you win easily and easier ones when you struggle.')),
    h('div', {}, start));

  let dailyLanguage = settings.language;
  const dailyBox = h('div');
  const drawDaily = () => {
    const game = daily.game;
    if (!game) {
      dailyBox.replaceChildren(
        h('p', { class: 'muted' }, 'One five-letter word, the same for everyone. One try per day.'),
        h('div', { class: 'field' }, seg('daily-language', Object.entries(LANGS), dailyLanguage, (v) => { dailyLanguage = v; })),
        h('p', {}, h('button', { class: 'btn', onclick: async (e) => {
          e.currentTarget.disabled = true;
          try { go(`/game/${(await api('/api/daily', { method: 'POST', body: { language: dailyLanguage } })).game.id}`); } catch (error) { toast(error.message); }
        } }, 'Play today’s word')));
    } else if (game.status === 'playing') {
      dailyBox.replaceChildren(h('p', { class: 'muted' }, `In progress: ${game.attempts} guesses used.`),
        h('p', {}, h('a', { class: 'btn', href: `#/game/${game.id}` }, 'Continue')));
    } else {
      dailyBox.replaceChildren(h('p', {}, game.status === 'won' ? `Solved in ${game.attempts}. Come back tomorrow.` : 'Missed today’s word. Come back tomorrow.'),
        h('p', {}, h('a', { class: 'btn ghost', href: `#/game/${game.id}` }, 'See your game')));
    }
  };
  drawDaily();

  const side = h('aside', { class: 'side' },
    h('section', {}, h('h2', {}, 'Daily word'), dailyBox));
  if (current.game && !current.game.daily) {
    const g = current.game;
    side.append(h('section', {}, h('h2', {}, 'Unfinished game'),
      h('p', { class: 'muted' }, `${g.theme}, ${g.length} letters, ${g.attempts} of ${g.maxAttempts} guesses used. Starting a new game counts this one as lost.`),
      h('p', {}, h('a', { class: 'btn ghost', href: `#/game/${g.id}` }, 'Resume'))));
  }
  side.append(h('section', {}, h('h2', {}, 'Play with friends'),
    h('p', { class: 'muted' }, 'Same word, same time, first to solve it wins.'),
    h('p', {}, h('a', { class: 'btn ghost', href: '#/rooms' }, 'Open a room'))));

  main.append(h('div', {}, h('h1', {}, 'Pick a theme, forge a word'), h('p', { class: 'muted' }, `Hi ${state.user.username}. Win games to earn XP and badges.`)),
    h('div', { class: 'home' }, h('div', { class: 'panel' }, form), side));
}

async function viewGame(main, ctx, id) {
  const { game } = await api(`/api/games/${id}`);
  const offset = game.serverNow - Date.now();
  let timerId = null;
  const tools = h('div', { class: 'tools' });
  const hintList = h('ul', { class: 'hints' }, game.hints.map((text) => h('li', {}, text)));
  const resultBox = h('div');
  const sub = [MODES[game.mode][0], `${game.length} letters`, `${game.maxAttempts} tries`].join(', ');

  const play = createPlay({
    language: game.language, length: game.length, maxAttempts: game.maxAttempts, guesses: game.guesses,
    submit: (guess) => api(`/api/games/${id}/guess`, { method: 'POST', body: { guess } }),
    onResult: (result) => { if (result.status !== 'playing') finish(result); },
  });
  ctx.cleanup(() => { play.destroy(); clearInterval(timerId); });

  add(main,
    h('div', { class: 'game-head' }, h('h1', {}, game.daily ? 'Daily word' : game.theme), h('p', { class: 'sub' }, sub)),
    game.clue ? h('p', { class: 'clue' }, `Clue: ${game.clue}`) : null,
    tools, hintList, play.el, resultBox);

  if (game.status === 'playing') {
    if (game.hintsMax) {
      let used = game.hints.length;
      const button = h('button', { class: 'btn ghost sm', type: 'button' }, 'Hint');
      const note = h('span', { class: 'hint-text' });
      const redraw = () => { note.textContent = `${game.hintsMax - used} left, −20 points each`; button.disabled = used >= game.hintsMax; };
      button.addEventListener('click', async () => {
        button.disabled = true;
        button.blur();
        try {
          const result = await api(`/api/games/${id}/hint`, { method: 'POST' });
          used = result.hintsUsed;
          hintList.append(h('li', {}, result.hint));
        } catch (error) { toast(error.message); }
        redraw();
      });
      redraw();
      tools.append(button, note);
    }
    const giveUpBtn = h('button', { class: 'btn ghost sm', type: 'button', style: 'margin-left:auto;' }, 'Give up');
    giveUpBtn.addEventListener('click', async () => {
      if (!confirm('Give up and reveal the secret word?')) return;
      giveUpBtn.disabled = true;
      try {
        let res;
        try {
          res = await api(`/api/games/${id}/surrender`, { method: 'POST' });
        } catch (err) {
          if (err.status === 404) {
            res = await api(`/api/games/${id}/guess`, { method: 'POST', body: { guess: '__SURRENDER__', surrender: true } });
          } else {
            throw err;
          }
        }
        finish(res);
      } catch (error) { toast(error.message); giveUpBtn.disabled = false; }
    });
    tools.append(giveUpBtn);

    if (game.timeLimitMs) {
      const timer = h('span', { class: 'timer' });
      const tick = async () => {
        const left = game.startedAt + game.timeLimitMs - (Date.now() + offset);
        timer.textContent = `${Math.floor(Math.max(0, left) / 60000)}:${String(Math.floor((Math.max(0, left) % 60000) / 1000)).padStart(2, '0')}`;
        timer.classList.toggle('low', left < 30000);
        if (left <= 0) {
          clearInterval(timerId);
          const latest = (await api(`/api/games/${id}`)).game;
          if (latest.status !== 'playing') finish({ status: latest.status, answer: latest.answer, expired: true, result: { score: latest.score, xp: latest.xpGained } });
        }
      };
      timerId = setInterval(tick, 250);
      tick();
      tools.prepend(timer);
    }
  } else {
    finish({ status: game.status, answer: game.answer, result: { score: game.score, xp: game.xpGained } }, true);
  }

  async function finish(result, revisit = false) {
    play.finish();
    clearInterval(timerId);
    tools.replaceChildren();
    const won = result.status === 'won';
    const info = result.result;
    const previousLevel = state.user.level;
    const explainSlot = h('div', { class: 'facts' }, h('p', { class: 'muted' }, 'Looking up the word…'));
    const heading = won ? `Solved in ${result.attempts ?? play.attempts()}.` : result.expired ? 'Time’s up.' : result.surrendered ? 'You gave up.' : 'Out of tries.';
    resultBox.replaceChildren(h('section', { class: 'result' },
      h('h2', {}, heading),
      h('p', { class: 'muted' }, 'The word was'),
      answerTiles(result.answer),
      info ? h('p', { class: 'lead' }, won ? `+${info.score} points, +${info.xp} XP` : info.xp ? `+${info.xp} XP for playing` : 'No points this time.') : null,
      info?.level > previousLevel ? h('p', { class: 'badge-new' }, `Level up! You are now level ${info.level}.`) : null,
      info?.newAchievements?.length ? h('div', { class: 'badge-list' }, info.newAchievements.map((a) => h('span', { class: 'badge-new', title: a.desc }, `Badge: ${a.title}`))) : null,
      explainSlot,
      h('div', { class: 'row-flex' },
        game.daily ? h('a', { class: 'btn', href: '#/' }, 'Back home')
          : h('button', { class: 'btn', onclick: (e) => startGame(loadSettings(), e.currentTarget) }, 'Play again'),
        h('a', { class: 'btn ghost', href: '#/leaderboard' }, 'Leaderboard'))));
    resultBox.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'nearest' });
    if (!revisit) refreshUser();
    try {
      const explanation = await api(`/api/games/${id}/explain`, { method: 'POST' });
      put(explainSlot,
        explanation.definition ? h('p', { class: 'lead' }, explanation.definition) : null,
        explanation.origin ? h('p', { class: 'muted' }, `Origin: ${explanation.origin}`) : null,
        explanation.example ? h('p', {}, h('em', {}, explanation.example)) : null);
    } catch { explainSlot.replaceChildren(); }
  }
}

async function viewRooms(main, ctx) {
  const settings = loadSettings();
  const roomLength = settings.length >= 4 && settings.length <= 8 ? settings.length : 5;
  const code = h('input', { type: 'text', id: 'code', maxlength: 5, placeholder: 'ABCDE', autocomplete: 'off' });
  const theme = h('input', { type: 'text', id: 'rtheme', maxlength: 40, value: settings.theme, placeholder: 'Anything, or leave empty', autocomplete: 'off' });
  const status = h('p', { class: 'muted', role: 'status' });
  let chosenLen = roomLength;
  const off = net.on((m) => {
    if (m.type === 'room:state') go(`/room/${m.code}`);
    if (m.type === 'room:error') toast(m.message);
  });
  ctx.cleanup(off);
  try { await net.connect(); } catch { status.textContent = 'Could not connect to the game server.'; }

  main.append(
    h('div', {}, h('h1', {}, 'Rooms'), h('p', { class: 'muted' }, 'Two to four players get the same word. The first to solve it wins.')),
    h('div', { class: 'home' },
      h('form', { class: 'panel stack', onsubmit: (e) => {
        e.preventDefault();
        net.send({ type: 'room:create', theme: theme.value, language: settings.language, length: chosenLen });
      } },
      h('h2', {}, 'Create a room'),
      h('div', { class: 'field' }, h('label', { for: 'rtheme' }, 'Theme'), theme),
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'Language'), seg('rlang', Object.entries(LANGS), settings.language, (v) => { settings.language = v; })),
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'Word length'), seg('rlen', [4, 5, 6, 7, 8].map((n) => [n, `${n}`]), chosenLen, (v) => { chosenLen = Number(v); })),
      h('div', {}, h('button', { class: 'btn big', type: 'submit' }, 'Create room'))),
      h('form', { class: 'stack', onsubmit: (e) => { e.preventDefault(); net.send({ type: 'room:join', code: code.value }); } },
        h('h2', {}, 'Join with a code'),
        h('div', { class: 'field' }, h('label', { for: 'code' }, 'Room code'), code),
        h('div', {}, h('button', { class: 'btn', type: 'submit' }, 'Join')),
        status)));
}

function miniBoard(rows, length, maxAttempts) {
  const el = h('div', { class: 'mini', 'aria-hidden': 'true' });
  el.style.setProperty('--len', length);
  for (let r = 0; r < maxAttempts; r++) {
    el.append(h('div', {}, Array.from({ length }, (_, i) => h('i', { class: rows[r]?.[i] ?? '' }))));
  }
  return el;
}

async function viewRoom(main, ctx, rawCode) {
  const code = rawCode.toUpperCase();
  let rs = null;
  let play = null;
  let finished = null;
  let explained = null;
  let pending = null;
  let alive = true;
  let countdown = null;
  const stage = h('div', { class: 'stack-lg' }, h('p', { class: 'muted' }, 'Joining room…'));
  main.append(stage);
  const isHost = () => rs.hostId === state.user.id;

  const off = net.on(onMessage);
  ctx.cleanup(() => { alive = false; off(); play?.destroy(); clearInterval(countdown); });
  try {
    await net.connect();
    net.send({ type: 'room:join', code });
  } catch { stage.replaceChildren(h('p', { class: 'error' }, 'Could not connect to the game server.')); }

  function onMessage(m) {
    switch (m.type) {
      case 'room:state':
        rs = m;
        if (m.status === 'playing') { if (play) drawOpponents(); }
        else if (m.status === 'finished' && finished) drawFinished();
        else { if (m.status === 'lobby') { finished = null; play?.destroy(); play = null; } drawLobby(); }
        break;
      case 'room:started': startPlay(m.resume); break;
      case 'room:guessResult': pending?.resolve(m); pending = null; break;
      case 'room:guessRejected': pending?.reject(new Error(m.message)); pending = null; break;
      case 'room:progress': {
        const p = rs?.players.find((x) => x.id === m.userId);
        if (p) {
          p.attempts = m.attempts;
          p.status = m.status;
          if (m.pattern) p.rows.push(m.pattern);
          if (play) drawOpponents();
        }
        break;
      }
      case 'room:finished': finished = m; explained = null; play?.finish(); if (rs) { drawFinished(); refreshUser(); } break;
      case 'room:error': toast(m.message); if (!rs) go('/rooms'); break;
      case 'room:left': go('/rooms'); break;
      case 'ws:closed':
        if (!alive) break;
        toast('Connection lost. Reconnecting…');
        setTimeout(async () => { try { await net.connect(); net.send({ type: 'room:join', code }); } catch { } }, 1500);
        break;
    }
  }

  const playerList = () => h('ul', { class: 'players' }, rs.players.map((p) => h('li', {},
    h('strong', {}, p.username),
    p.id === rs.hostId ? h('span', { class: 'tag' }, 'Host') : null,
    p.id === state.user.id ? h('span', { class: 'tag' }, 'You') : null,
    p.connected ? null : h('span', { class: 'muted' }, 'reconnecting…'))));
  const leaveButton = () => h('button', { class: 'btn ghost', onclick: () => net.send({ type: 'room:leave' }) }, 'Leave room');
  const startButton = (label) => {
    const enough = rs.players.length >= 2;
    return h('button', { class: 'btn big', disabled: !enough, onclick: () => net.send({ type: 'room:start' }) }, enough ? label : 'Waiting for a second player');
  };
  const summary = () => `${rs.settings.theme}, ${rs.settings.length} letters, ${LANGS[rs.settings.language]}. Up to ${rs.maxPlayers} players.`;

  function drawLobby() {
    stage.replaceChildren(
      h('div', { class: 'stack' },
        h('p', { class: 'muted' }, 'Room code'),
        h('div', { class: 'code', 'aria-label': `Room code ${[...rs.code].join(' ')}` }, rs.code),
        h('p', { class: 'muted' }, summary()),
        h('button', { class: 'btn ghost sm', onclick: () => navigator.clipboard?.writeText(location.href).then(() => toast('Invite link copied')) }, 'Copy invite link')),
      h('div', { class: 'stack' }, h('h2', {}, `Players (${rs.players.length})`), playerList()),
      h('div', { class: 'row-flex' },
        isHost() ? startButton('Start round') : h('p', { class: 'muted' }, 'Waiting for the host to start.'),
        leaveButton()));
  }

  function startPlay(resume) {
    if (!rs) return;
    play?.destroy();
    finished = null;
    play = createPlay({
      language: rs.settings.language, length: rs.settings.length, maxAttempts: rs.maxAttempts, guesses: resume ?? [],
      submit: (guess) => new Promise((resolve, reject) => {
        pending = { resolve, reject };
        net.send({ type: 'room:guess', guess });
        setTimeout(() => { if (pending?.resolve === resolve) { pending = null; reject(new Error('No answer from the server')); } }, 10_000);
      }),
      onResult: (result) => {
        if (result.status === 'won') toast('Solved it! Waiting for the final result…');
        else if (result.status === 'lost') toast('Out of tries. Waiting for the others…');
      },
    });
    const timer = h('span', { class: 'timer' });
    clearInterval(countdown);
    const tick = () => {
      const left = Math.max(0, (rs.endsAt ?? 0) - Date.now());
      timer.textContent = `${Math.floor(left / 60000)}:${String(Math.floor((left % 60000) / 1000)).padStart(2, '0')}`;
    };
    countdown = setInterval(tick, 500);
    tick();
    stage.replaceChildren(h('div', { class: 'arena' },
      h('div', {}, h('div', { class: 'game-head' }, h('h1', {}, rs.theme), h('p', { class: 'sub' }, `Room ${rs.code}, ${rs.settings.length} letters`), timer), play.el),
      h('div', { class: 'opp', id: 'opp' })));
    drawOpponents();
  }

  function drawOpponents() {
    const box = $('#opp');
    if (!box) return;
    const label = { playing: 'typing', won: 'solved it', lost: 'out of tries', left: 'left', waiting: '' };
    box.replaceChildren(h('h2', {}, 'Opponents'),
      ...rs.players.filter((p) => p.id !== state.user.id).map((p) => h('div', {},
        h('h3', {}, h('span', {}, p.username), h('span', { class: 'muted' }, label[p.status] ?? '')),
        miniBoard(p.rows, rs.settings.length, rs.maxAttempts))));
  }

  async function drawFinished() {
    play?.destroy();
    clearInterval(countdown);
    const won = finished.winnerId === state.user.id;
    const mine = finished.me.result;
    const heading = won ? 'You won the duel.' : finished.winnerName ? `${finished.winnerName} solved it first.` : 'Nobody solved it.';
    const explainSlot = h('div', { class: 'facts' });
    const rows = finished.results.map((r) => h('tr', {},
      h('td', {}, r.username), h('td', {}, r.status === 'won' ? 'Solved' : r.status === 'left' ? 'Left' : 'Not solved'),
      h('td', { class: 'num' }, String(r.attempts)), h('td', { class: 'num' }, String(r.score))));
    stage.replaceChildren(h('section', { class: 'stack' },
      h('h1', {}, heading),
      h('p', { class: 'muted' }, 'The word was'),
      answerTiles(finished.answer),
      mine ? h('p', { class: 'lead' }, won ? `+${mine.score} points, +${mine.xp} XP` : `+${mine.xp} XP for playing`) : null,
      mine?.newAchievements?.length ? h('div', { class: 'badge-list' }, mine.newAchievements.map((a) => h('span', { class: 'badge-new', title: a.desc }, `Badge: ${a.title}`))) : null,
      h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Player'), h('th', {}, 'Result'), h('th', { class: 'num' }, 'Tries'), h('th', { class: 'num' }, 'Points'))), h('tbody', {}, rows))),
      explainSlot,
      h('div', { class: 'row-flex' }, isHost() ? startButton('Play another round') : h('p', { class: 'muted' }, 'Waiting for the host to start another round.'), leaveButton())));
    if (!explained) {
      try { explained = await api(`/api/games/${finished.me.gameId}/explain`, { method: 'POST' }); } catch { return; }
    }
    put(explainSlot,
      explained.definition ? h('p', { class: 'lead' }, explained.definition) : null,
      explained.origin ? h('p', { class: 'muted' }, `Origin: ${explained.origin}`) : null,
      explained.example ? h('p', {}, h('em', {}, explained.example)) : null);
  }
}

async function viewThemes(main) {
  const list = h('ul', { class: 'theme-list' });
  const name = h('input', { type: 'text', id: 'tname', maxlength: 40, placeholder: 'Greek gods, 90s cartoons…', required: true, autocomplete: 'off' });
  let language = loadSettings().language;
  const load = async () => {
    const { themes } = await api('/api/themes');
    list.replaceChildren(...(themes.length ? themes.map((t) => {
      const like = h('button', { class: 'btn ghost sm like', 'aria-pressed': String(t.liked), disabled: t.mine, title: t.mine ? 'This is your theme' : 'Like this theme' }, `♥ ${t.likes}`);
      like.addEventListener('click', async () => {
        try {
          const result = await api(`/api/themes/${t.id}/like`, { method: 'POST' });
          like.setAttribute('aria-pressed', String(result.liked));
          like.textContent = `♥ ${result.likes}`;
        } catch (error) { toast(error.message); }
      });
      return h('li', {},
        h('span', { class: 'name' }, t.name),
        h('span', { class: 'muted' }, `${LANGS[t.language]}, by ${t.author}, ${t.plays} plays`),
        like,
        h('button', { class: 'btn sm', onclick: (e) => startGame({ ...loadSettings(), theme: t.name, language: t.language }, e.currentTarget) }, 'Play'));
    }) : [h('li', { class: 'muted' }, 'No themes yet. Be the first to publish one.')]));
  };
  await load();
  main.append(
    h('div', {}, h('h1', {}, 'Themes'), h('p', { class: 'muted' }, 'Publish a theme and anybody can play it. The most liked ones rise to the top.')),
    h('form', { class: 'row-flex', onsubmit: async (e) => {
      e.preventDefault();
      try {
        const result = await api('/api/themes', { method: 'POST', body: { name: name.value, language } });
        name.value = '';
        toast('Theme published');
        result.newAchievements.forEach((a) => toast(`Badge: ${a.title}`));
        load();
      } catch (error) { toast(error.message); }
    } },
    h('div', { class: 'field' }, h('label', { for: 'tname' }, 'New theme'), name),
    seg('tlang', Object.entries(LANGS), language, (v) => { language = v; }),
    h('button', { class: 'btn', type: 'submit' }, 'Publish')),
    list);
}

async function viewLeaderboard(main) {
  const TABS = [['weekly', 'This week'], ['all', 'All time'], ['daily', 'Today’s daily word']];
  const body = h('div');
  const tabs = h('div', { class: 'tabs', role: 'tablist' });
  const show = async (type) => {
    tabs.replaceChildren(...TABS.map(([key, label]) => h('button', { role: 'tab', 'aria-selected': String(key === type), onclick: () => show(key) }, label)));
    const { rows } = await api(`/api/leaderboard?type=${type}`);
    const player = (r) => h('td', {}, h('a', { href: `#/profile/${r.username}` }, r.username));
    const head = type === 'daily' ? ['Player', 'Result', 'Tries', 'Points'] : ['Player', 'Points', 'Wins', 'Games'];
    const line = (r) => type === 'daily'
      ? h('tr', {}, h('td', { class: 'rank' }, String(r.rank)), player(r), h('td', {}, r.status === 'won' ? 'Solved' : 'Missed'), h('td', { class: 'num' }, String(r.attempts)), h('td', { class: 'num' }, String(r.score)))
      : h('tr', {}, h('td', { class: 'rank' }, String(r.rank)), player(r), h('td', { class: 'num' }, String(r.score)), h('td', { class: 'num' }, String(r.wins)), h('td', { class: 'num' }, String(r.games)));
    body.replaceChildren(rows.length
      ? h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, '#'), ...head.map((t, i) => h('th', { class: i > 1 || (type !== 'daily' && i === 1) ? 'num' : '' }, t)))),
        h('tbody', {}, rows.map(line))))
      : h('p', { class: 'muted' }, 'Nobody has played yet. Be the first.'));
  };
  main.append(h('h1', {}, 'Leaderboard'), tabs, body);
  await show('weekly');
}

async function viewProfile(main, ctx, name) {
  const s = await api(`/api/users/${encodeURIComponent(name ?? state.user.username)}`);
  const figure = (value, label) => h('div', {}, h('strong', {}, value), h('span', {}, label));
  const most = Math.max(1, ...Object.values(s.distribution));
  const distribution = [1, 2, 3, 4, 5, 6].map((n) => {
    const count = s.distribution[n] ?? 0;
    const fill = h('span');
    fill.style.width = `${(count / most) * 100}%`;
    return h('div', {}, h('span', {}, String(n)), h('div', { class: 'bar' }, fill), h('span', {}, String(count)));
  });
  add(main,
    h('div', {}, h('h1', {}, s.user.username), h('p', { class: 'muted' }, `Level ${s.user.level}, ${s.user.xp} XP, ${s.user.next - s.user.xp} XP to level ${s.user.level + 1}`)),
    h('div', {}, xpBar(s.user)),
    h('div', { class: 'figures' },
      figure(String(s.games), 'games'), figure(`${Math.round(s.winRate * 100)}%`, 'win rate'),
      figure(String(s.streak.current), 'win streak'), figure(String(s.streak.best), 'best streak'),
      figure(String(s.dailyStreak.current), 'daily streak')),
    h('section', { class: 'stack' }, h('h2', {}, 'Guesses per win'), s.wins ? h('div', { class: 'dist' }, distribution) : h('p', { class: 'muted' }, 'No wins yet.')),
    s.themes.length ? h('section', { class: 'stack' }, h('h2', {}, 'Favorite themes'),
      h('ul', { class: 'players' }, s.themes.map((t) => h('li', {}, h('strong', {}, t.theme), h('span', { class: 'muted' }, `${t.games} games, ${t.wins} won`))))) : null,
    h('section', { class: 'stack' }, h('h2', {}, 'Badges'),
      h('div', { class: 'badges' }, s.achievements.map((a) => h('div', { class: `badge${a.earnedAt ? ' earned' : ''}` }, h('strong', {}, a.title), h('span', { class: 'muted' }, a.desc))))));
}

const ROUTES = [
  [/^\/$/, viewHome],
  [/^\/login$/, viewAuth],
  [/^\/game\/(\d+)$/, viewGame],
  [/^\/rooms$/, viewRooms],
  [/^\/room\/([A-Za-z0-9]+)$/, viewRoom],
  [/^\/themes$/, viewThemes],
  [/^\/leaderboard$/, viewLeaderboard],
  [/^\/profile(?:\/([\w.-]+))?$/, viewProfile],
];

function header(path) {
  const link = (to, label, active) => h('a', { href: `#${to}`, 'aria-current': active ? 'page' : null }, label);
  return h('header', { class: 'top' },
    h('a', { class: 'brand', href: '#/' }, h('span', { class: 'mark' }, h('i'), h('i'), h('i')), 'WordForge'),
    state.user ? h('nav', { class: 'nav', 'aria-label': 'Main' },
      link('/', 'Play', path === '/' || path.startsWith('/game')),
      link('/rooms', 'Rooms', path.startsWith('/room')),
      link('/themes', 'Themes', path === '/themes'),
      link('/leaderboard', 'Leaderboard', path === '/leaderboard')) : h('span', { class: 'nav' }),
    meChip());
}

async function render() {
  const id = ++renderId;
  state.cleanup?.();
  state.cleanup = null;
  const path = location.hash.slice(1) || '/';
  if (!state.user && path !== '/login') return go('/login');
  if (state.user && path === '/login') return go('/');
  const main = h('main', { class: 'stack-lg' });
  $('#app').replaceChildren(h('div', { class: 'shell' }, header(path), main));
  const ctx = { cleanup: (fn) => { if (id === renderId) state.cleanup = fn; else fn(); } };
  for (const [pattern, view] of ROUTES) {
    const match = pattern.exec(path);
    if (!match) continue;
    try {
      await view(main, ctx, ...match.slice(1));
    } catch (error) {
      if (id === renderId) main.replaceChildren(h('p', { class: 'error' }, error.message));
    }
    return;
  }
  main.append(h('p', {}, 'Page not found. ', h('a', { href: '#/' }, 'Go home')));
}

window.addEventListener('hashchange', render);

(async function boot() {
  try { state.config = await api('/api/config'); } catch { }
  if (state.token) {
    try {
      state.user = (await api('/api/me')).user;
    } catch {
      state.token = null;
      localStorage.removeItem('wf_token');
    }
  }
  render();
})();