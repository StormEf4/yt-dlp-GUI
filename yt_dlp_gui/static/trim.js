'use strict';

// Trim panel: a YouTube preview above a filmstrip timeline with start/end handles, like the Windows Photos trimmer.
// The filmstrip uses YouTube's storyboard images (sprite sheets of evenly spaced frames) found by yt-dlp.
// Uses `$`, `api`, `toast`, `shake` and `setHint` from app.js

const MIN_CLIP = 0.5;
const URL_PATTERN = /https?:\/\/\S+/g;

const trim = {
  open: false,
  url: null,
  info: null,
  start: 0,
  end: 0,
  pos: 0,
  player: null,
  playerReady: false,
  started: false,
  playing: false,
  token: 0,
  drag: null,
  lastSeek: 0,
};

// ---------- time helpers ----------

function fmtClock(sec) {
  sec = Math.max(0, sec || 0);
  const tenths = Math.round(sec * 10) / 10;
  const whole = Math.floor(tenths);
  const frac = tenths - whole >= 0.05 ? `.${Math.round((tenths - whole) * 10)}` : '';
  const h = Math.floor(whole / 3600), m = Math.floor((whole % 3600) / 60), s = whole % 60;
  return h
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}${frac}`
    : `${m}:${String(s).padStart(2, '0')}${frac}`;
}

function parseClock(text) {
  const m = String(text).trim().match(/^(?:(?:(\d+):)?(\d+):)?(\d+(?:[.,]\d+)?)$/);
  if (!m) return null;
  const [, h, min, s] = m;
  const sec = parseFloat(s.replace(',', '.'));
  if ((h !== undefined && +min >= 60) || (min !== undefined && sec >= 60)) return null;
  return (+h || 0) * 3600 + (+min || 0) * 60 + sec;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const trimmed = () => trim.info && (trim.start > 0.05 || trim.end < trim.info.duration - 0.05);

// ---------- storyboard frames ----------

function frameStyle(t) {
  const sb = trim.info && trim.info.storyboard;
  if (!sb) return null;
  const perSheet = sb.columns * sb.rows;
  const k = clamp(Math.floor((t / trim.info.duration) * sb.count), 0, sb.count - 1);
  const sheet = Math.min(Math.floor(k / perSheet), sb.urls.length - 1);
  const idx = k - sheet * perSheet;
  // The last sheet only holds the frames that are left, so it can be smaller
  const left = sheet === sb.urls.length - 1 ? sb.count - sheet * perSheet : perSheet;
  const cols = left < sb.columns ? Math.max(left, 1) : sb.columns;
  const rows = Math.max(1, Math.min(sb.rows, Math.ceil(left / sb.columns)));
  const col = idx % sb.columns, row = Math.min(Math.floor(idx / sb.columns), rows - 1);
  return {
    backgroundImage: `url("${sb.urls[sheet]}")`,
    backgroundSize: `${cols * 100}% ${rows * 100}%`,
    backgroundPosition: `${cols > 1 ? (col / (cols - 1)) * 100 : 0}% ${rows > 1 ? (row / (rows - 1)) * 100 : 0}%`,
  };
}

function applyFrame(el, t) {
  const style = frameStyle(t);
  if (style) {
    Object.assign(el.style, style);
  } else if (trim.info && trim.info.thumbnail) {
    Object.assign(el.style, {
      backgroundImage: `url("${trim.info.thumbnail}")`, backgroundSize: 'cover', backgroundPosition: 'center',
    });
  } else {
    el.style.backgroundImage = '';
  }
}

function renderFilmstrip() {
  const strip = $('#filmstrip');
  if (!trim.info || !trim.info.storyboard) {
    strip.replaceChildren();
    return;
  }
  const { width, height } = strip.getBoundingClientRect();
  const n = clamp(Math.round(width / Math.max(height * (16 / 9), 1)), 3, 24);
  const tiles = [];
  for (let i = 0; i < n; i++) {
    const tile = document.createElement('div');
    applyFrame(tile, ((i + 0.5) / n) * trim.info.duration);
    tiles.push(tile);
  }
  strip.replaceChildren(...tiles);
}

// ---------- YouTube player ----------

let ytApi = null;

function loadYouTubeApi() {
  if (!ytApi) {
    ytApi = new Promise((resolve, reject) => {
      if (window.YT && window.YT.Player) return resolve(window.YT);
      window.onYouTubeIframeAPIReady = () => resolve(window.YT);
      const script = document.createElement('script');
      script.src = 'https://www.youtube.com/iframe_api';
      script.onerror = () => {
        ytApi = null;
        reject(new Error('The YouTube player could not be loaded'));
      };
      document.head.append(script);
    });
  }
  return ytApi;
}

function destroyPlayer() {
  if (trim.player) {
    try { trim.player.destroy(); } catch { /* already gone */ }
  }
  trim.player = null;
  trim.playerReady = trim.started = trim.playing = false;
  $('.trim-player-wrap').replaceChildren();
  updatePlayState();
}

function noPreview(token) {
  if (token !== trim.token) return;
  destroyPlayer();
  $('#trim').classList.add('no-player');
  $('#trim-note').hidden = false;
  $('#trim-play').disabled = true;
}

async function createPlayer(videoId, token) {
  const timeout = (ms) => new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms));
  try {
    const YT = await Promise.race([loadYouTubeApi(), timeout(12000)]);
    if (token !== trim.token) return;
    const el = document.createElement('div');
    $('.trim-player-wrap').replaceChildren(el);
    await Promise.race([timeout(15000), new Promise((resolve, reject) => {
      trim.player = new YT.Player(el, {
        host: 'https://www.youtube-nocookie.com',
        videoId,
        playerVars: {
          controls: 0, disablekb: 1, fs: 0, rel: 0, iv_load_policy: 3, playsinline: 1, origin: location.origin,
        },
        events: {
          onReady: resolve,
          onError: (e) => (trim.playerReady ? noPreview(token) : reject(new Error(`YouTube player error ${e.data}`))),
          onStateChange: (e) => onPlayerState(e, token),
        },
      });
    })]);
    if (token !== trim.token) return;
    trim.playerReady = true;
    $('#trim-play').disabled = false;
  } catch {
    noPreview(token);
  }
}

function onPlayerState(e, token) {
  if (token !== trim.token) return;
  const S = window.YT.PlayerState;
  trim.playing = e.data === S.PLAYING || e.data === S.BUFFERING;
  if (e.data === S.PLAYING) {
    trim.started = true;
    $('#trim').classList.remove('no-player');
  }
  updatePlayState();
}

function seekPlayer(t, final) {
  if (!trim.playerReady || !trim.started) return;  // until it has played, the storyboard frame stands in
  const now = performance.now();
  if (!final && now - trim.lastSeek < 120) return;
  trim.lastSeek = now;
  try { trim.player.seekTo(t, final); } catch { /* player went away */ }
}

function play() {
  if (!trim.playerReady) return;
  if (trim.pos < trim.start || trim.pos >= trim.end - 0.1) trim.pos = trim.start;
  update();
  trim.player.seekTo(trim.pos, true);
  trim.player.playVideo();
}

function pause() {
  if (trim.playerReady && trim.playing) trim.player.pauseVideo();
}

function updatePlayState() {
  const panel = $('#trim');
  panel.classList.toggle('playing', trim.playing);
  // Before the video has played, show the storyboard frame at the playhead instead of YouTube's cover
  $('#trim-still').hidden = trim.started;
  $('#trim-play').setAttribute('aria-label', trim.playing ? 'Pause' : 'Play');
}

function tick() {
  if (!trim.open) return;
  if (trim.playerReady && trim.playing && !trim.drag) {
    const t = trim.player.getCurrentTime();
    if (typeof t === 'number') {
      trim.pos = t;
      if (t >= trim.end - 0.05) {
        // Like the Windows trimmer: stop at the end of the clip
        trim.player.pauseVideo();
        trim.pos = trim.end;
      }
      update();
    }
  }
  requestAnimationFrame(tick);
}

// ---------- rendering ----------

function update() {
  if (!trim.info) return;
  const d = trim.info.duration;
  const pct = (t) => `${(t / d) * 100}%`;
  const track = $('#trim-track');
  track.style.setProperty('--start', pct(trim.start));
  track.style.setProperty('--end', pct(trim.end));
  track.style.setProperty('--pos', pct(trim.pos));
  track.setAttribute('aria-valuemax', String(Math.round(d)));
  track.setAttribute('aria-valuenow', String(Math.round(trim.pos)));
  track.setAttribute('aria-valuetext', fmtClock(trim.pos));
  for (const [id, t] of [['#handle-start', trim.start], ['#handle-end', trim.end]]) {
    $(id).setAttribute('aria-valuetext', fmtClock(t));
  }
  for (const [id, t] of [['#trim-start', trim.start], ['#trim-end', trim.end]]) {
    const input = $(id);
    if (document.activeElement !== input) input.value = fmtClock(t);
  }
  $('#trim-now').textContent = fmtClock(trim.pos);
  $('#trim-total').textContent = fmtClock(d);
  $('#clip-len').textContent = fmtClock(trim.end - trim.start);
  if (!trim.started) applyFrame($('#trim-still'), trim.pos);
  $('#go-btn span').textContent = trim.open && trimmed() ? 'Download clip' : 'Download';
}

function showTip(t, fraction) {
  const tip = $('#tip');
  const track = $('#trim-track');
  tip.hidden = false;
  $('#tip-time').textContent = fmtClock(t);
  const frame = $('#tip-frame');
  frame.hidden = !(trim.info && trim.info.storyboard);
  if (!frame.hidden) applyFrame(frame, t);
  const half = tip.offsetWidth / 2;
  tip.style.left = `${clamp(fraction * track.clientWidth, half - 12, track.clientWidth - half + 12)}px`;
}

// ---------- interaction ----------

function timeAt(e) {
  const rect = $('#trim-track').getBoundingClientRect();
  const fraction = clamp((e.clientX - rect.left) / rect.width, 0, 1);
  return { t: fraction * trim.info.duration, fraction };
}

function setStart(t, final = true) {
  trim.start = clamp(t, 0, trim.end - MIN_CLIP);
  trim.pos = trim.start;
  seekPlayer(trim.pos, final);
  update();
}

function setEnd(t, final = true) {
  trim.end = clamp(t, trim.start + MIN_CLIP, trim.info.duration);
  trim.pos = trim.end;
  seekPlayer(trim.pos, final);
  update();
}

function setPos(t, final = true) {
  trim.pos = clamp(t, 0, trim.info.duration);
  seekPlayer(trim.pos, final);
  update();
}

function dragTo(e, final) {
  const { t, fraction } = timeAt(e);
  ({ start: setStart, end: setEnd, scrub: setPos })[trim.drag.kind](t, final);
  showTip(trim.drag.kind === 'start' ? trim.start : trim.drag.kind === 'end' ? trim.end : trim.pos,
    trim.drag.kind === 'start' ? trim.start / trim.info.duration
      : trim.drag.kind === 'end' ? trim.end / trim.info.duration : fraction);
}

function initTrackDragging() {
  const track = $('#trim-track');
  track.addEventListener('pointerdown', (e) => {
    if (!trim.info || e.button !== 0) return;
    const handle = e.target.closest('.handle');
    trim.drag = { kind: handle ? (handle.id === 'handle-start' ? 'start' : 'end') : 'scrub' };
    if (handle) handle.classList.add('dragging');
    pause();
    track.setPointerCapture(e.pointerId);
    (handle || track).focus({ preventScroll: true });
    dragTo(e, false);
    e.preventDefault();
  });
  track.addEventListener('pointermove', (e) => {
    if (!trim.info) return;
    if (trim.drag) {
      dragTo(e, false);
    } else {
      const { t, fraction } = timeAt(e);
      showTip(t, fraction);
    }
  });
  const end = (e) => {
    if (!trim.drag) return;
    dragTo(e, true);
    trim.drag = null;
    document.querySelectorAll('.handle.dragging').forEach((h) => h.classList.remove('dragging'));
    if (!track.matches(':hover')) $('#tip').hidden = true;
  };
  track.addEventListener('pointerup', end);
  track.addEventListener('pointercancel', end);
  track.addEventListener('pointerleave', () => { if (!trim.drag) $('#tip').hidden = true; });

  // Keyboard: arrows move by 1s (Shift: 5s, Alt: 0.1s); on the strip itself they move the playhead
  const step = (e) => (e.shiftKey ? 5 : e.altKey ? 0.1 : 1);
  const keys = (setter, get) => (e) => {
    if (!trim.info) return;
    const moves = {
      ArrowLeft: get() - step(e), ArrowDown: get() - step(e), ArrowRight: get() + step(e), ArrowUp: get() + step(e),
      Home: 0, End: trim.info.duration, PageDown: get() - 10, PageUp: get() + 10,
    };
    if (e.key in moves) {
      e.preventDefault();
      e.stopPropagation();
      pause();
      setter(moves[e.key]);
    }
  };
  $('#handle-start').addEventListener('keydown', keys(setStart, () => trim.start));
  $('#handle-end').addEventListener('keydown', keys(setEnd, () => trim.end));
  track.addEventListener('keydown', (e) => {
    if (e.target === track) keys(setPos, () => trim.pos)(e);
  });
}

function initTimeFields() {
  for (const [id, setter, get] of [['#trim-start', setStart, () => trim.start], ['#trim-end', setEnd, () => trim.end]]) {
    const input = $(id);
    const commit = () => {
      if (!trim.info) return;
      const t = parseClock(input.value);
      const ok = t !== null && t <= trim.info.duration
        && (id === '#trim-start' ? t <= trim.end - MIN_CLIP : t >= trim.start + MIN_CLIP);
      if (!ok) {
        input.classList.remove('invalid');
        void input.offsetWidth;
        input.classList.add('invalid');
        toast(t === null ? 'Type a time like 1:30 or 1:02:30'
          : id === '#trim-start' ? 'The start has to be before the end' : 'The end has to be after the start (and within the video)', 'error');
        input.value = fmtClock(get());
        return;
      }
      input.classList.remove('invalid');
      pause();
      setter(t);
    };
    input.addEventListener('change', commit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        input.blur();
      } else if (e.key === 'Escape') {
        input.value = fmtClock(get());
        input.blur();
      }
    });
    input.addEventListener('blur', () => { if (!input.classList.contains('invalid')) input.value = fmtClock(get()); });
  }
  $('#set-start').addEventListener('click', () => { if (trim.info) setStart(Math.min(trim.pos, trim.end - MIN_CLIP)); });
  $('#set-end').addEventListener('click', () => { if (trim.info) setEnd(Math.max(trim.pos, trim.start + MIN_CLIP)); });
  $('#trim-reset').addEventListener('click', () => {
    if (!trim.info) return;
    pause();
    trim.start = 0;
    trim.end = trim.info.duration;
    setPos(0);
  });
}

// ---------- opening and loading ----------

function linksIn(text) {
  return [...new Set(String(text).match(URL_PATTERN) || [])];
}

async function loadTrim(url) {
  const token = ++trim.token;
  destroyPlayer();
  Object.assign(trim, { url, info: null, start: 0, end: 0, pos: 0 });
  const panel = $('#trim');
  panel.classList.add('loading', 'no-player');
  panel.classList.remove('failed');
  $('#trim-error').hidden = true;
  $('#trim-note').hidden = true;
  $('#trim-play').disabled = true;
  $('#trim-title').textContent = 'Loading video…';
  $('#trim-sub').textContent = '';
  $('#trim-still').style.backgroundImage = '';
  $('#filmstrip').replaceChildren();
  $('#go-btn span').textContent = 'Download';

  let info;
  try {
    info = await api('GET', `/info?url=${encodeURIComponent(url)}`);
  } catch (e) {
    if (token !== trim.token) return;
    panel.classList.remove('loading');
    panel.classList.add('failed');
    $('#trim-title').textContent = 'Can\'t trim this link';
    $('#trim-error').textContent = e.message;
    $('#trim-error').hidden = false;
    return;
  }
  if (token !== trim.token) return;
  Object.assign(trim, { info, start: 0, end: info.duration, pos: 0 });
  panel.classList.remove('loading');
  $('#trim-title').textContent = info.title || 'Trim';
  $('#trim-title').title = info.title || '';
  $('#trim-sub').textContent = [info.uploader, fmtClock(info.duration)].filter(Boolean).join(' · ');
  renderFilmstrip();
  update();
  if (info.embed) createPlayer(info.id, token);
  else noPreview(token);
}

function openTrim() {
  const links = linksIn($('#url').value);
  if (!links.length) {
    shake();
    setHint('Paste a YouTube link first, then press Trim.', true);
    $('#url').focus();
    return;
  }
  if (links.length > 1) {
    shake();
    setHint('Trim works on one link at a time.', true);
    return;
  }
  trim.open = true;
  $('#trim').hidden = false;
  $('#trim-btn').setAttribute('aria-expanded', 'true');
  requestAnimationFrame(tick);
  if (links[0] !== trim.url || !trim.info) loadTrim(links[0]);
  else update();
}

function closeTrim() {
  trim.open = false;
  trim.token++;
  destroyPlayer();
  Object.assign(trim, { url: null, info: null });
  $('#trim').hidden = true;
  $('#trim-btn').setAttribute('aria-expanded', 'false');
  $('#go-btn span').textContent = 'Download';
}

// Called by app.js when adding downloads: the clip range for `text`, if it is being trimmed
function trimRange(text) {
  if (!trim.open || !trim.info || !trimmed()) return null;
  const links = linksIn(text);
  if (links.length !== 1 || links[0] !== trim.url) return null;
  const round = (t) => Math.round(t * 10) / 10;
  return {
    start: trim.start > 0.05 ? round(trim.start) : null,
    end: trim.end < trim.info.duration - 0.05 ? round(trim.end) : null,
  };
}

// Called by app.js when the link box changes
let reloadTimer = null;
function trimLinkChanged() {
  if (!trim.open) return;
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    const links = linksIn($('#url').value);
    if (links.length === 1 && links[0] !== trim.url) loadTrim(links[0]);
  }, 600);
}

function initTrim() {
  $('#trim-btn').addEventListener('click', () => (trim.open ? closeTrim() : openTrim()));
  $('#trim-close').addEventListener('click', closeTrim);
  $('#trim-play').addEventListener('click', () => (trim.playing ? pause() : play()));
  initTrackDragging();
  initTimeFields();
  // Space plays/pauses while trimming (unless typing)
  document.addEventListener('keydown', (e) => {
    if (!trim.open || e.key !== ' ' || e.target.closest('input, textarea, select, button')) return;
    e.preventDefault();
    if (trim.playing) pause();
    else play();
  });
  new ResizeObserver(() => { if (trim.open) renderFilmstrip(); }).observe($('#filmstrip'));
}

initTrim();
