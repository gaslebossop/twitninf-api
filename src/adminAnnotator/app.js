'use strict';

const API_BASE = '/api/moderation/annotator';
const TOKEN_KEY = 'annotator_token';

let CONFIG = null;
let stats = { total: 0, done: 0 };
let history = []; // [{ tweet, form, dirty, wasNew }]
let pointer = -1;

const els = {
  loginScreen: document.getElementById('loginScreen'),
  loginForm: document.getElementById('loginForm'),
  loginUsername: document.getElementById('loginUsername'),
  loginPassword: document.getElementById('loginPassword'),
  loginError: document.getElementById('loginError'),
  appRoot: document.getElementById('appRoot'),
  logoutBtn: document.getElementById('logoutBtn'),
  exportLink: document.getElementById('exportLink'),

  progressText: document.getElementById('progressText'),
  progressFill: document.getElementById('progressFill'),
  doneScreen: document.getElementById('doneScreen'),
  tweetScreen: document.getElementById('tweetScreen'),
  tweetAuthor: document.getElementById('tweetAuthor'),
  tweetDate: document.getElementById('tweetDate'),
  tweetText: document.getElementById('tweetText'),
  dirtyBadge: document.getElementById('dirtyBadge'),
  spamScoreRow: document.getElementById('spamScoreRow'),
  qualityScoreRow: document.getElementById('qualityScoreRow'),
  themeGrid: document.getElementById('themeGrid'),
  ruleGrid: document.getElementById('ruleGrid'),
  rulesField: document.getElementById('rulesField'),
  btnPositif: document.getElementById('btnPositif'),
  btnNegatif: document.getElementById('btnNegatif'),
  btnConforme: document.getElementById('btnConforme'),
  btnNonConforme: document.getElementById('btnNonConforme'),
  btnPrev: document.getElementById('btnPrev'),
  btnSkip: document.getElementById('btnSkip'),
  btnValidate: document.getElementById('btnValidate'),
  statusText: document.getElementById('statusText'),
};

// ---------- auth ----------

function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

function setToken(token) {
  localStorage.setItem(TOKEN_KEY, token);
}

function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

async function apiFetch(path, options = {}) {
  const res = await fetch(API_BASE + path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getToken()}`,
      ...(options.headers || {}),
    },
  });
  if (res.status === 401 || res.status === 403) {
    clearToken();
    showLogin('Session expirée ou accès refusé — reconnecte-toi.');
    throw new Error('unauthorized');
  }
  return res;
}

function showLogin(message) {
  els.appRoot.classList.add('hidden');
  els.loginScreen.classList.remove('hidden');
  els.loginError.textContent = message || '';
}

function showApp() {
  els.loginScreen.classList.add('hidden');
  els.appRoot.classList.remove('hidden');
}

els.loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  els.loginError.textContent = '';
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: els.loginUsername.value.trim(),
        password: els.loginPassword.value,
      }),
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
      els.loginError.textContent = data.message || 'Connexion impossible';
      return;
    }
    const role = data.data.user.role;
    if (!['admin', 'superadmin', 'super_admin'].includes(role)) {
      els.loginError.textContent = 'Ce compte n\'est pas admin.';
      return;
    }
    setToken(data.data.token);
    els.loginPassword.value = '';
    await boot();
  } catch (err) {
    els.loginError.textContent = 'Erreur réseau';
  }
});

els.logoutBtn.addEventListener('click', () => {
  clearToken();
  history = [];
  pointer = -1;
  showLogin();
});

// ---------- form state ----------

function emptyForm() {
  return {
    spamScore: null,
    qualityScore: null,
    theme: null,
    sentiment: null,
    compliant: null,
    violationRule: null,
    insultSpans: [],
  };
}

function currentEntry() {
  return pointer >= 0 ? history[pointer] : null;
}

function markDirty() {
  const entry = currentEntry();
  if (entry) entry.dirty = true;
  renderDirtyBadge();
}

// ---------- data loading ----------

async function loadConfig() {
  const res = await apiFetch('/config');
  const data = await res.json();
  CONFIG = data.data;
  buildScoreRow(els.spamScoreRow, 'spamScore');
  buildScoreRow(els.qualityScoreRow, 'qualityScore');
  buildThemeGrid();
  buildRuleGrid();
}

async function loadStats() {
  const res = await apiFetch('/stats');
  const data = await res.json();
  stats = data.data;
  renderProgress();
}

async function fetchNext() {
  const res = await apiFetch('/next');
  const data = await res.json();
  if (data.data.done) {
    els.tweetScreen.classList.add('hidden');
    els.doneScreen.classList.remove('hidden');
    return;
  }
  const entry = { tweet: data.data.tweet, form: emptyForm(), dirty: false, wasNew: true };
  history.push(entry);
  pointer = history.length - 1;
  loadFromHistory();
}

function loadFromHistory() {
  render(currentEntry());
}

// ---------- rendering ----------

function buildScoreRow(container, field) {
  container.innerHTML = '';
  for (let v = 1; v <= 10; v++) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'score-btn';
    btn.textContent = String(v);
    btn.dataset.value = String(v);
    btn.addEventListener('click', () => setField(field, v));
    container.appendChild(btn);
  }
}

function buildThemeGrid() {
  els.themeGrid.innerHTML = '';
  CONFIG.themes.forEach((t) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'theme-btn';
    btn.textContent = t.label;
    btn.dataset.value = t.id;
    btn.addEventListener('click', () => setField('theme', t.id));
    els.themeGrid.appendChild(btn);
  });
}

function buildRuleGrid() {
  els.ruleGrid.innerHTML = '';
  CONFIG.rules.forEach((r) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'rule-btn';
    btn.textContent = r.label;
    btn.dataset.value = r.id;
    btn.addEventListener('click', () => setField('violationRule', r.id));
    els.ruleGrid.appendChild(btn);
  });
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderTweetText(entry) {
  const text = entry.tweet.content;
  const spans = entry.form.insultSpans;
  let html = '';
  let cursor = 0;
  spans.forEach((s, idx) => {
    html += escapeHtml(text.slice(cursor, s.start));
    html += `<mark class="insult" data-idx="${idx}">${escapeHtml(text.slice(s.start, s.end))}</mark>`;
    cursor = s.end;
  });
  html += escapeHtml(text.slice(cursor));
  els.tweetText.innerHTML = html;
}

function renderProgress() {
  els.progressText.textContent = `${stats.done} / ${stats.total} annotés`;
  const pct = stats.total > 0 ? Math.min(100, (stats.done / stats.total) * 100) : 0;
  els.progressFill.style.width = `${pct}%`;
}

function renderDirtyBadge() {
  const entry = currentEntry();
  els.dirtyBadge.classList.toggle('hidden', !(entry && entry.dirty));
}

function setActive(container, selector, value) {
  container.querySelectorAll(selector).forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.value === String(value));
  });
}

function render(entry) {
  if (!entry) return;
  els.tweetAuthor.textContent = `@${entry.tweet.username}`;
  els.tweetDate.textContent = new Date(entry.tweet.created_at).toLocaleString('fr-FR');
  renderTweetText(entry);

  setActive(els.spamScoreRow, '.score-btn', entry.form.spamScore);
  setActive(els.qualityScoreRow, '.score-btn', entry.form.qualityScore);
  setActive(els.themeGrid, '.theme-btn', entry.form.theme);
  setActive(els.ruleGrid, '.rule-btn', entry.form.violationRule);

  els.btnPositif.classList.toggle('active', entry.form.sentiment === 'positif');
  els.btnNegatif.classList.toggle('active', entry.form.sentiment === 'negatif');
  els.btnConforme.classList.toggle('active', entry.form.compliant === true);
  els.btnNonConforme.classList.toggle('active', entry.form.compliant === false);

  els.rulesField.classList.toggle('hidden', entry.form.compliant !== false);

  els.btnPrev.disabled = pointer <= 0;
  els.statusText.textContent = '';
  renderDirtyBadge();
  renderProgress();
}

// ---------- field mutations ----------

function setField(field, value) {
  const entry = currentEntry();
  if (!entry) return;
  entry.form[field] = value;
  if (field === 'compliant' && value === true) entry.form.violationRule = null;
  markDirty();
  render(entry);
}

function setCompliant(value) {
  setField('compliant', value);
}

function getSelectionOffsetsWithin(container) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  if (!container.contains(range.commonAncestorContainer)) return null;

  const preRange = document.createRange();
  preRange.selectNodeContents(container);
  preRange.setEnd(range.startContainer, range.startOffset);
  const start = preRange.toString().length;
  const end = start + range.toString().length;
  return { start, end };
}

function tryMarkInsult() {
  const entry = currentEntry();
  if (!entry) return;
  const offsets = getSelectionOffsetsWithin(els.tweetText);
  if (!offsets || offsets.start >= offsets.end) return;

  const overlaps = entry.form.insultSpans.some(
    (s) => offsets.start < s.end && offsets.end > s.start,
  );
  if (overlaps) return;

  entry.form.insultSpans.push({
    start: offsets.start,
    end: offsets.end,
    text: entry.tweet.content.slice(offsets.start, offsets.end),
  });
  entry.form.insultSpans.sort((a, b) => a.start - b.start);
  markDirty();
  window.getSelection().removeAllRanges();
  renderTweetText(entry);
}

els.tweetText.addEventListener('click', (e) => {
  const mark = e.target.closest('mark.insult');
  if (!mark) return;
  const entry = currentEntry();
  if (!entry) return;
  const idx = Number(mark.dataset.idx);
  entry.form.insultSpans.splice(idx, 1);
  markDirty();
  renderTweetText(entry);
});

// ---------- validation / navigation ----------

function getMissingFields(form) {
  const missing = [];
  if (!form.spamScore) missing.push('score spam');
  if (!form.qualityScore) missing.push('score qualité');
  if (!form.theme) missing.push('thème');
  if (!form.sentiment) missing.push('sentiment');
  if (form.compliant === null) missing.push('conformité');
  if (form.compliant === false && !form.violationRule) missing.push('règle violée');
  return missing;
}

async function postAnnotate(entry) {
  await apiFetch('/annotate', {
    method: 'POST',
    body: JSON.stringify({
      tweetId: entry.tweet.id,
      content: entry.tweet.content,
      spamScore: entry.form.spamScore,
      qualityScore: entry.form.qualityScore,
      theme: entry.form.theme,
      sentiment: entry.form.sentiment,
      compliant: entry.form.compliant,
      violationRule: entry.form.violationRule,
      insultSpans: entry.form.insultSpans,
    }),
  });
  if (entry.wasNew) {
    stats.done += 1;
    entry.wasNew = false;
  }
  entry.dirty = false;
}

async function postSkip(entry) {
  await apiFetch('/skip', {
    method: 'POST',
    body: JSON.stringify({ tweetId: entry.tweet.id, content: entry.tweet.content }),
  });
  if (entry.wasNew) {
    stats.done += 1;
    entry.wasNew = false;
  }
  entry.dirty = false;
}

function advance() {
  if (pointer < history.length - 1) {
    pointer++;
    loadFromHistory();
  } else {
    fetchNext();
  }
}

async function handleValidate() {
  const entry = currentEntry();
  if (!entry) return;
  const missing = getMissingFields(entry.form);
  if (missing.length) {
    els.statusText.textContent = `Champs manquants : ${missing.join(', ')}`;
    return;
  }
  try {
    await postAnnotate(entry);
    advance();
  } catch (err) {
    /* apiFetch already redirected to login on 401/403 */
  }
}

async function handleSkip() {
  const entry = currentEntry();
  if (!entry) return;
  try {
    await postSkip(entry);
    advance();
  } catch (err) {
    /* apiFetch already redirected to login on 401/403 */
  }
}

function goPrev() {
  if (pointer > 0) {
    pointer--;
    loadFromHistory();
  }
}

// ---------- keyboard ----------

document.addEventListener('keydown', (e) => {
  if (els.appRoot.classList.contains('hidden')) return;
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (els.tweetScreen.classList.contains('hidden')) return;

  switch (e.code) {
    case 'Enter':
    case 'Space':
      e.preventDefault();
      handleValidate();
      return;
    case 'Backspace':
    case 'ArrowLeft':
      e.preventDefault();
      goPrev();
      return;
    case 'KeyS':
      e.preventDefault();
      handleSkip();
      return;
    case 'KeyI':
      e.preventDefault();
      tryMarkInsult();
      return;
    case 'KeyP':
      e.preventDefault();
      setField('sentiment', 'positif');
      return;
    case 'KeyN':
      e.preventDefault();
      setField('sentiment', 'negatif');
      return;
    case 'KeyO':
      e.preventDefault();
      setCompliant(true);
      return;
    case 'KeyX':
      e.preventDefault();
      setCompliant(false);
      return;
    default:
      break;
  }

  if (/^Digit[0-9]$/.test(e.code)) {
    e.preventDefault();
    const d = Number(e.code.replace('Digit', ''));
    const val = d === 0 ? 10 : d;
    setField(e.shiftKey ? 'qualityScore' : 'spamScore', val);
  }
});

els.btnPositif.addEventListener('click', () => setField('sentiment', 'positif'));
els.btnNegatif.addEventListener('click', () => setField('sentiment', 'negatif'));
els.btnConforme.addEventListener('click', () => setCompliant(true));
els.btnNonConforme.addEventListener('click', () => setCompliant(false));
els.btnPrev.addEventListener('click', goPrev);
els.btnSkip.addEventListener('click', handleSkip);
els.btnValidate.addEventListener('click', handleValidate);
els.exportLink.addEventListener('click', (e) => {
  e.preventDefault();
  // L'export exige le header Authorization : un <a href> nu ne peut pas le
  // poser, donc on récupère le fichier via fetch puis on force le download.
  apiFetch('/export').then(async (res) => {
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'tweet_human_labels.jsonl';
    a.click();
    URL.revokeObjectURL(url);
  }).catch(() => {});
});

// ---------- boot ----------

async function boot() {
  try {
    await loadConfig();
    showApp();
    await loadStats();
    await fetchNext();
  } catch (err) {
    /* apiFetch already showed the login screen on auth failure */
  }
}

if (getToken()) {
  boot();
} else {
  showLogin();
}
