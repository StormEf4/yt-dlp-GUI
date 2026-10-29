'use strict';

const TOKEN = document.querySelector('meta[name="api-token"]').content;
const $ = (sel) => document.querySelector(sel);

const state = { settings: null, formats: [], video_formats: [], jobs: [], ffmpeg: true, busy: false, mode: 'audio' };
const APP_NAME = 'YouTubevert by StormEf4';
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

function fillSegmented(group, items) {
  if (group.children.length) return;
  for (const item of items) {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.dataset.value = item.value;
    b.textContent = item.label;
    b.title = item.title;
    group.append(b);
  }
}

function fillBrowsers(select) {
  if (select.options.length > 1) return;
  const usable = state.browsers.filter((b) => !b.blocked);
  const blocked = state.browsers.filter((b) => b.blocked);
  for (const b of usable) select.add(new Option(`Use my ${b.label} login`, b.id));
  if (blocked.length) {
    // Chrome, Edge & co. lock their logins on Windows; list them so people know why they can't be picked
    const group = document.createElement('optgroup');
    group.label = 'Locked by the browser on Windows';
    for (const b of blocked) {
      const opt = new Option(b.label, b.id);
      opt.disabled = true;
      group.append(opt);
    }
    select.add(group);
  }
}

function setCoverToggle(input, on, supported, title) {
  input.checked = on && supported;
  input.disabled = !supported;
  const label = input.closest('.toggle');
  label.classList.toggle('disabled', !supported);
  label.title = title;
}

// Every control carries the name of the setting it changes in `data-key`
function renderSettings() {
  const s = state.settings;
  fillSegmented($('.segmented[data-key="format"]'), state.formats.map((f) => (
    { value: f.id, label: f.label, title: f.lossless ? `${f.label} — lossless` : f.label })));
  fillSegmented($('.segmented[data-key="video_format"]'), state.video_formats.map((f) => (
    { value: f.id, label: f.label, title: `${f.label} — ${f.description}` })));

  for (const group of document.querySelectorAll('.segmented[data-key]')) {
    for (const b of group.children) b.setAttribute('aria-checked', String(b.dataset.value === s[group.dataset.key]));
  }
  for (const btn of document.querySelectorAll('.folder-btn[data-key]')) {
    const path = s[btn.dataset.key];
    btn.querySelector('.folder-path').textContent = ltr(path);
    btn.title = `${path}\nClick to choose another folder`;
  }
  for (const input of document.querySelectorAll('input[type="checkbox"][data-key]')) input.checked = !!s[input.dataset.key];
  for (const select of document.querySelectorAll('.browser-select')) {
    fillBrowsers(select);
    select.value = s.browser;
  }

  // Audio: lossless formats have no quality choice, and not every format can hold cover art
  const fmt = state.formats.find((f) => f.id === s.format) || {};
  const audio = $('.options[data-mode="audio"]');
  audio.querySelector('.segmented[data-key="quality"]').hidden = !!fmt.lossless;
  audio.querySelector('.lossless-note').hidden = !fmt.lossless;
  setCoverToggle(audio.querySelector('[data-key="thumbnail"]'), s.thumbnail, fmt.cover !== false,
    fmt.cover === false
      ? (fmt.id === 'wav' ? 'WAV files can\'t hold cover art' : `Cover art for ${fmt.label} needs the "mutagen" Python package`)
      : 'Use the video thumbnail as album art');

  const vfmt = state.video_formats.find((f) => f.id === s.video_format) || {};
  $('#video-format-note').textContent = vfmt.description || '';
  setCoverToggle($('[data-key="video_thumbnail"]'), s.video_thumbnail, vfmt.cover !== false,
    vfmt.cover === false ? `${vfmt.label} files can't hold a thumbnail` : 'Embed the video thumbnail as the cover image');
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
  document.addEventListener('click', (e) => {
    const b = e.target.closest('.segmented[data-key] > button');
    if (b) saveSettings({ [b.parentElement.dataset.key]: b.dataset.value });
    const open = e.target.closest('.open-folder');
    if (open) reveal(state.settings[open.dataset.key]);
  });
  for (const input of document.querySelectorAll('input[type="checkbox"][data-key]')) {
    input.addEventListener('change', () => saveSettings({ [input.dataset.key]: input.checked }));
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
  for (const select of document.querySelectorAll('.browser-select')) {
    select.addEventListener('change', () => {
      saveSettings({ browser: select.value });
      if (select.value) toast('Make sure you\'re logged in to YouTube in that browser');
    });
  }
}

// ---------- tabs ----------

function setMode(mode) {
  state.mode = mode;
  document.body.dataset.mode = mode;
  for (const tab of document.querySelectorAll('.tab')) {
    const selected = tab.dataset.mode === mode;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
  }
  for (const panel of document.querySelectorAll('.options[data-mode]')) panel.hidden = panel.dataset.mode !== mode;
  $('#empty-text').textContent = mode === 'video'
    ? 'Your videos will show up here as they download.'
    : 'Your audio files will show up here as they download.';
  try { localStorage.setItem('mode', mode); } catch { /* storage unavailable */ }
  renderJobs();
}

function initTabs() {
  let saved = 'audio';
  try { saved = localStorage.getItem('mode') || 'audio'; } catch { /* storage unavailable */ }
  const tabs = [...document.querySelectorAll('.tab')];
  for (const tab of tabs) {
    tab.addEventListener('click', () => setMode(tab.dataset.mode));
    tab.addEventListener('keydown', (e) => {
      if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
      const next = tabs[(tabs.indexOf(tab) + 1) % tabs.length];
      next.focus();
      setMode(next.dataset.mode);
    });
  }
  setMode(saved === 'video' ? 'video' : 'audio');
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

async function submitUrl(text, mode = state.mode) {
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
    const range = trimRange(text);
    const data = await api('POST', '/jobs', { url: text, mode, ...range });
    if (mode !== state.mode) setMode(mode);
    if (trim.open) closeTrim();
    $('#url').value = '';
    autoGrow();
    setHint();
    const n = data.jobs.length;
    toast(n > 1 ? `Added ${n} downloads` : range ? 'Downloading your clip' : mode === 'video' ? 'Video download started' : 'Download started');
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
  ta.addEventListener('input', () => { autoGrow(); setHint(); trimLinkChanged(); });
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
        // While trimming, pasting loads the new video instead of downloading straight away
        if (trim.open) trimLinkChanged();
        else submitUrl();
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
  const clip = j.section ? `✂ Clip ${j.section}` : '';
  const sub = jobSubtitleBase(j);
  return [clip, sub].filter(Boolean).join(' · ');
}

function jobSubtitleBase(j) {
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
  li.querySelector('.act-retry').addEventListener('click', async () => {
    const job = state.jobs.find((x) => x.id === j.id) || j;
    try {
      await api('POST', '/jobs', { url: job.url, mode: job.mode, start: job.start, end: job.end });
      await api('DELETE', `/jobs/${j.id}`);
    } catch (e) {
      toast(e.message, 'error');
    }
    refresh();
  });
  li.querySelector('.act-reveal').addEventListener('click', () => {
    const job = state.jobs.find((x) => x.id === j.id);
    if (job && job.files.length) reveal(job.files[job.files.length - 1]);
  });
  return li;
}

function updateJobEl(li, j) {
  li.dataset.status = j.status;
  // Some downloads (eg: clips) don't report progress; show that work is happening anyway
  li.classList.toggle('indeterminate', j.status === 'downloading' && !j.progress);
  li.classList.toggle('has-files', j.files.length > 0);
  const img = li.querySelector('img');
  if (j.thumbnail && img.getAttribute('src') !== j.thumbnail) {
    img.classList.remove('loaded');
    img.src = j.thumbnail;
  }
  const res = { best: '', 2160: '4K' }[j.quality] ?? `${j.quality}p`;
  const format = j.format.toUpperCase();
  li.querySelector('.badge').textContent = j.mode === 'video' ? [format, res].filter(Boolean).join(' · ') : format;
  li.querySelector('.job-title').textContent = j.title || j.url;
  li.querySelector('.job-title').title = j.title || j.url;
  li.querySelector('.job-sub').textContent = jobSubtitle(j);
  li.querySelector('.fill').style.width = `${(j.status === 'done' ? 1 : j.progress) * 100}%`;
  li.querySelector('.stage').textContent = j.stage;
  li.querySelector('.stats').textContent = jobStats(j);
  const err = j.status === 'error' || (j.status === 'done' && j.error_count) ? j.error || '' : '';
  li.querySelector('.job-error').textContent = err;
  li.querySelector('.job-error').title = err;
  const detail = err && j.error_detail && j.error_detail !== err ? j.error_detail : '';
  li.querySelector('.job-detail').hidden = !detail;
  li.querySelector('.job-detail code').textContent = detail;
}

function renderJobs() {
  const list = $('#job-list');
  const all = [...state.jobs].sort((a, b) => b.id - a.id);
  const jobs = all.filter((j) => j.mode === state.mode);
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

  const isActive = (j) => !['done', 'error', 'cancelled'].includes(j.status);
  const finished = jobs.filter((j) => !isActive(j)).length;
  $('#empty').hidden = jobs.length > 0;
  $('#clear-btn').hidden = finished === 0;
  $('#count').textContent = jobs.length ? String(jobs.length) : '';
  // Each tab shows how many of its downloads are still running
  for (const badge of document.querySelectorAll('.tab-count')) {
    const n = all.filter((j) => j.mode === badge.dataset.count && isActive(j)).length;
    badge.textContent = n ? String(n) : '';
  }
  const active = all.filter(isActive).length;
  document.body.classList.toggle('busy', active > 0);
  document.title = active ? `(${active}) ${APP_NAME}` : APP_NAME;
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

let pickerKey = 'outdir';

function initFolderPicker() {
  const dialog = $('#folder-dialog');
  for (const btn of document.querySelectorAll('.folder-btn[data-key]')) {
    btn.addEventListener('click', () => {
      pickerKey = btn.dataset.key;
      $('#folder-title').textContent = pickerKey === 'video_outdir' ? 'Where should videos go?' : 'Where should audio go?';
      browse(state.settings[pickerKey]);
      dialog.showModal();
    });
  }
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog || e.target.closest('[data-close]')) dialog.close();
  });
  $('#dir-up').addEventListener('click', () => { if (browseParent != null) browse(browseParent); });
  $('#dir-select').addEventListener('click', async () => {
    dialog.close();
    await saveSettings({ [pickerKey]: browsePath });
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
initTabs();
$('#clear-btn').addEventListener('click', () => api('POST', '/jobs/clear', { mode: state.mode }).then(refresh));
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
