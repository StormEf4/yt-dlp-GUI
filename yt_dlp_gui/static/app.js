'use strict';

const TOKEN = document.querySelector('meta[name="api-token"]').content;
const $ = (sel) => document.querySelector(sel);

const state = { settings: null, formats: [], jobs: [], ffmpeg: true, busy: false };
const jobEls = new Map();
let pollTimer = null;

// ---------- API ----------

async function api(method, path, body) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { 'X-Token': TOKEN, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { data });
  return data;
}

// ---------- helpers ----------

function toast(message, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  $('#toasts').append(el);
  setTimeout(() => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 300);
  }, kind === 'error' ? 5000 : 2600);
}

function fmtBytes(n) {
  if (!n) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i > 1 ? 1 : 0)} ${units[i]}`;
}

function fmtTime(sec) {
  if (sec == null || !isFinite(sec)) return '';
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

// Paths are shown with `direction: rtl` so long ones are cut at the start; the marks keep slashes in place
const ltr = (text) => `\u200E${text}\u200E`;

function basename(path) {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

// ---------- theme ----------

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
}

function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem('theme'); } catch { /* storage unavailable */ }
  const system = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  applyTheme(saved || system);
  $('#theme-toggle').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    applyTheme(next);
    try { localStorage.setItem('theme', next); } catch { /* storage unavailable */ }
  });
}

// ---------- settings ----------

function renderSettings() {
  const s = state.settings;
  const fmt = state.formats.find((f) => f.id === s.format) || {};

  const fg = $('#format-group');
  if (!fg.children.length) {
    for (const f of state.formats) {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.dataset.value = f.id;
      b.textContent = f.label;
      b.title = f.lossless ? `${f.label} — lossless` : f.label;
      fg.append(b);
    }
  }
  for (const b of fg.children) b.setAttribute('aria-checked', String(b.dataset.value === s.format));
  for (const b of $('#quality-group').children) b.setAttribute('aria-checked', String(b.dataset.value === s.quality));

  $('#quality-group').hidden = !!fmt.lossless;
  $('#lossless-note').hidden = !fmt.lossless;

  $('#folder-path').textContent = ltr(s.outdir);
  $('#folder-path').title = s.outdir;

  $('#opt-thumbnail').checked = s.thumbnail && fmt.cover !== false;
  $('#opt-thumbnail').disabled = fmt.cover === false;
  const coverLabel = $('#opt-thumbnail').closest('.toggle');
  coverLabel.classList.toggle('disabled', fmt.cover === false);
  coverLabel.title = fmt.cover === false
    ? (fmt.id === 'wav' ? 'WAV files can\'t hold cover art' : `Cover art for ${fmt.label} needs the "mutagen" Python package`)
    : 'Use the video thumbnail as album art';
  const browserSel = $('#opt-browser');
  if (browserSel.options.length === 1) {
    for (const b of state.browsers) browserSel.add(new Option(`Use my ${b.label} login`, b.id));
  }
  browserSel.value = s.browser;
  $('#opt-metadata').checked = s.metadata;
  $('#opt-playlist').checked = s.playlist;
}

async function saveSettings(changes) {
  Object.assign(state.settings, changes);
  renderSettings();
  try {
    const data = await api('POST', '/settings', changes);
    state.settings = data.settings;
  } catch (e) {
    if (e.data && e.data.settings) state.settings = e.data.settings;
    toast(e.message, 'error');
  }
  renderSettings();
}

function initSettings() {
  $('#format-group').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) saveSettings({ format: b.dataset.value });
  });
  $('#quality-group').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) saveSettings({ quality: b.dataset.value });
  });
  for (const key of ['thumbnail', 'metadata', 'playlist']) {
    $(`#opt-${key}`).addEventListener('change', (e) => saveSettings({ [key]: e.target.checked }));
  }
  // Arrow keys move between options in a radio group
  for (const group of document.querySelectorAll('.segmented')) {
    group.addEventListener('keydown', (e) => {
      if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
      const buttons = [...group.children];
      const i = buttons.indexOf(document.activeElement);
      if (i < 0) return;
      const next = buttons[(i + (e.key === 'ArrowRight' ? 1 : buttons.length - 1)) % buttons.length];
      next.focus();
      next.click();
      e.preventDefault();
    });
  }
  $('#opt-browser').addEventListener('change', (e) => {
    saveSettings({ browser: e.target.value });
    if (e.target.value) toast('Make sure you\'re logged in to YouTube in that browser');
  });
  $('#open-folder').addEventListener('click', () => reveal(state.settings.outdir));
}

// ---------- adding downloads ----------

function autoGrow() {
  const ta = $('#url');
  ta.style.height = 'auto';
  ta.style.height = `${Math.min(ta.scrollHeight, 140)}px`;
}

function setHint(text, isError = false) {
  const hint = $('#hint');
  hint.textContent = text || 'Tip: paste several YouTube links at once, or drag a link from your browser onto this window.';
  hint.classList.toggle('error', isError);
}

function shake() {
  const field = $('.url-field');
  field.classList.remove('shake');
  void field.offsetWidth;
  field.classList.add('shake');
}

async function submitUrl(text) {
  text = (text ?? $('#url').value).trim();
  if (!text) {
    shake();
    setHint('Paste a link first.', true);
    $('#url').focus();
    return;
  }
  const btn = $('#go-btn');
  btn.disabled = true;
  try {
    const data = await api('POST', '/jobs', { url: text });
    $('#url').value = '';
    autoGrow();
    setHint();
    const n = data.jobs.length;
    toast(n > 1 ? `Added ${n} downloads` : 'Download started');
    await refresh();
  } catch (e) {
    shake();
    setHint(e.message, true);
  } finally {
    btn.disabled = false;
  }
}

function initComposer() {
  const ta = $('#url');
  $('#add-form').addEventListener('submit', (e) => {
    e.preventDefault();
    submitUrl();
  });
  ta.addEventListener('input', () => { autoGrow(); setHint(); });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submitUrl();
    }
  });
  $('#paste-btn').addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text.trim()) {
        ta.value = text.trim();
        autoGrow();
        submitUrl();
        return;
      }
      toast('Your clipboard is empty');
    } catch {
      toast('Press Ctrl+V (⌘V on Mac) to paste');
    }
    ta.focus();
  });

  // Drag and drop links from the browser's address bar or another page
  let depth = 0;
  const hasLink = (e) => [...e.dataTransfer.types].some((t) => t === 'text/uri-list' || t === 'text/plain');
  window.addEventListener('dragenter', (e) => {
    if (!hasLink(e)) return;
    depth++;
    document.body.classList.add('dragging');
  });
  window.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (!depth) document.body.classList.remove('dragging');
  });
  window.addEventListener('dragover', (e) => { if (hasLink(e)) e.preventDefault(); });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    document.body.classList.remove('dragging');
    const text = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
    if (text) submitUrl(text.split('\n').filter((l) => !l.startsWith('#')).join('\n'));
  });
}

// ---------- downloads list ----------

function jobSubtitle(j) {
  if (j.is_playlist) {
    const parts = [];
    if (j.playlist_index && j.playlist_count) parts.push(`Song ${j.playlist_index} of ${j.playlist_count}`);
    else if (j.playlist_count) parts.push(`${j.playlist_count} songs`);
    if (j.item_title && ['downloading', 'converting'].includes(j.status)) parts.push(j.item_title);
    return parts.join(' · ');
  }
  return [j.uploader, fmtTime(j.duration)].filter(Boolean).join(' · ');
}

function jobStats(j) {
  if (j.status === 'downloading') {
    return [
      `${Math.round(j.progress * 100)}%`,
      j.speed ? `${fmtBytes(j.speed)}/s` : '',
      j.eta != null ? `${fmtTime(j.eta)} left` : '',
    ].filter(Boolean).join('  ·  ');
  }
  if (j.status === 'converting') return `${Math.round(j.progress * 100)}%`;
  if (j.status === 'done' && j.files.length === 1) return basename(j.files[0]);
  if (j.status === 'done') return `${j.files.length} files`;
  return '';
}

function createJobEl(j) {
  const li = $('#job-template').content.firstElementChild.cloneNode(true);
  li.dataset.id = j.id;
  const img = li.querySelector('img');
  img.addEventListener('load', () => img.classList.add('loaded'));
  img.addEventListener('error', () => img.removeAttribute('src'));
  li.querySelector('.act-cancel').addEventListener('click', () => api('POST', `/jobs/${j.id}/cancel`).then(refresh).catch((e) => toast(e.message, 'error')));
  li.querySelector('.act-remove').addEventListener('click', () => {
    li.style.transition = 'opacity .2s, transform .2s';
    li.style.opacity = '0';
    li.style.transform = 'scale(.97)';
    api('DELETE', `/jobs/${j.id}`).then(refresh).catch((e) => toast(e.message, 'error'));
  });
  li.querySelector('.act-retry').addEventListener('click', () => {
    const job = state.jobs.find((x) => x.id === j.id);
    api('DELETE', `/jobs/${j.id}`).catch(() => {});
    submitUrl(job ? job.url : j.url);
  });
  li.querySelector('.act-reveal').addEventListener('click', () => {
    const job = state.jobs.find((x) => x.id === j.id);
    if (job && job.files.length) reveal(job.files[job.files.length - 1]);
  });
  return li;
}

function updateJobEl(li, j) {
  li.dataset.status = j.status;
  li.classList.toggle('has-files', j.files.length > 0);
  const img = li.querySelector('img');
  if (j.thumbnail && img.getAttribute('src') !== j.thumbnail) {
    img.classList.remove('loaded');
    img.src = j.thumbnail;
  }
  li.querySelector('.badge').textContent = j.format;
  li.querySelector('.job-title').textContent = j.title || j.url;
  li.querySelector('.job-title').title = j.title || j.url;
  li.querySelector('.job-sub').textContent = jobSubtitle(j);
  li.querySelector('.fill').style.width = `${(j.status === 'done' ? 1 : j.progress) * 100}%`;
  li.querySelector('.stage').textContent = j.stage;
  li.querySelector('.stats').textContent = jobStats(j);
  const err = j.status === 'error' || (j.status === 'done' && j.error_count) ? j.error || '' : '';
  li.querySelector('.job-error').textContent = err;
  li.querySelector('.job-error').title = err;
}

function renderJobs() {
  const list = $('#job-list');
  const jobs = [...state.jobs].sort((a, b) => b.id - a.id);
  const seen = new Set();
  for (const j of jobs) {
    seen.add(j.id);
    let li = jobEls.get(j.id);
    if (!li) {
      li = createJobEl(j);
      jobEls.set(j.id, li);
    }
    updateJobEl(li, j);
  }
  for (const [id, li] of jobEls) {
    if (!seen.has(id)) {
      li.remove();
      jobEls.delete(id);
    }
  }
  // Keep newest first without re-inserting nodes that are already in place
  jobs.forEach((j, i) => {
    const li = jobEls.get(j.id);
    if (list.children[i] !== li) list.insertBefore(li, list.children[i] || null);
  });

  const finished = jobs.filter((j) => ['done', 'error', 'cancelled'].includes(j.status)).length;
  const active = jobs.length - finished;
  $('#empty').hidden = jobs.length > 0;
  $('#clear-btn').hidden = finished === 0;
  $('#count').textContent = jobs.length ? String(jobs.length) : '';
  document.body.classList.toggle('busy', active > 0);
  document.title = active ? `(${active}) yt-dlp Audio` : 'yt-dlp Audio';
}

async function reveal(path) {
  try {
    await api('POST', '/reveal', { path });
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ---------- folder picker ----------

const FOLDER_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
let browsePath = null;
let browseParent = null;

async function browse(path) {
  let data;
  try {
    data = await api('GET', `/browse?path=${encodeURIComponent(path ?? '')}`);
  } catch (e) {
    toast(e.message, 'error');
    return;
  }
  browsePath = data.path;
  browseParent = data.parent;
  $('#dir-path').textContent = data.path ? ltr(data.path) : 'This PC';
  $('#dir-path').title = data.path;
  $('#dir-up').disabled = data.parent == null;
  $('#dir-select').disabled = !data.path;

  const places = $('#places');
  places.replaceChildren(...data.places.map((p) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = p.name;
    b.addEventListener('click', () => browse(p.path));
    return b;
  }));

  const list = $('#dir-list');
  if (!data.dirs.length) {
    const li = document.createElement('li');
    li.className = 'note';
    li.textContent = data.error ? `Can't open this folder: ${data.error}` : 'No folders in here';
    list.replaceChildren(li);
    return;
  }
  list.replaceChildren(...data.dirs.map((d) => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.innerHTML = FOLDER_SVG;
    b.append(document.createTextNode(d.name));
    b.addEventListener('click', () => browse(d.path));
    li.append(b);
    return li;
  }));
  list.scrollTop = 0;
}

function initFolderPicker() {
  const dialog = $('#folder-dialog');
  $('#folder-btn').addEventListener('click', () => {
    browse(state.settings.outdir);
    dialog.showModal();
  });
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog || e.target.closest('[data-close]')) dialog.close();
  });
  $('#dir-up').addEventListener('click', () => { if (browseParent != null) browse(browseParent); });
  $('#dir-select').addEventListener('click', async () => {
    dialog.close();
    await saveSettings({ outdir: browsePath });
    toast(`Saving to ${basename(browsePath)}`);
  });
}

// ---------- polling ----------

async function refresh() {
  try {
    const data = await api('GET', '/state');
    const first = !state.settings;
    Object.assign(state, data);
    if (first) {
      renderSettings();
      $('#version').textContent = data.version;
    }
    $('#ffmpeg-banner').hidden = data.ffmpeg;
    const missing = data.youtube_missing || [];
    $('#yt-banner').hidden = !missing.length || !data.ffmpeg;
    $('#yt-missing').textContent = missing.map((m) => (m === 'deno' ? 'Deno (a JavaScript runtime)' : 'the yt-dlp-ejs package')).join(' and ');
    $('#yt-fix').textContent = `pip install ${missing.join(' ')}`;
    $('#go-btn').disabled = !data.ffmpeg;
    renderJobs();
  } catch {
    // The app was probably closed; try again on the next tick
  }
}

function schedulePoll() {
  clearTimeout(pollTimer);
  const delay = state.busy ? 600 : 2500;
  pollTimer = setTimeout(async () => {
    await refresh();
    schedulePoll();
  }, delay);
}

// ---------- startup ----------

initTheme();
initSettings();
initComposer();
initFolderPicker();
$('#clear-btn').addEventListener('click', () => api('POST', '/jobs/clear').then(refresh));
refresh().then(() => {
  schedulePoll();
  $('#url').focus();
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refresh();
});

// Tell the app the window was closed, so it can quit when nothing is downloading
window.addEventListener('pagehide', () => {
  navigator.sendBeacon(`/api/bye?token=${encodeURIComponent(TOKEN)}`);
});
