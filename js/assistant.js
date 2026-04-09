// ================================================================
// SIMONTOK - Assistant JS
// File   : js/assistant.js
// Versi  : 1.5 (local chat storage + auto prune + AI context cap)
// Depends: js/ai-client.js (opsional; ada fallback callOpenRouter)
// ================================================================

// ================================================================
// 1) CONFIG
// ================================================================
var API_URL     = 'https://script.google.com/macros/s/AKfycbwLLIv2AH5v4FiYImDN2-u5WhxAYvsTXq1ZUqdRUWqBM0K6pBuI3q_ZQn3_eFIii2bU/exec';
var SESSION_KEY = 'simontok-session';
var SESSION     = null;
var AI_MODEL    = 'openai/gpt-4o-mini';

// Penyimpanan chat: 'local' atau 'remote'
var CHAT_STORAGE_MODE = 'local';

// Limit local storage chat
var MAX_LOCAL_SESSIONS = 40;
var MAX_MSG_PER_SESSION_STORE = 120;
var MAX_CHARS_PER_MSG_STORE = 2000;
var MAX_LOCAL_BYTES_SOFT = 4 * 1024 * 1024; // target aman 4MB

// Limit history ke AI (hindari konteks terlalu panjang)
var MAX_AI_CONTEXT_MESSAGES = 24;
var MAX_AI_CONTEXT_CHARS = 18000;

// ================================================================
// 2) SESSION HELPERS
// ================================================================
function getSession() {
  try {
    var raw = localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

function getApiKey() {
  var k = (SESSION && SESSION.apiKey) ? String(SESSION.apiKey) : '';
  if (!k || k === 'undefined' || k === 'null') return '';
  return k.trim();
}

function authURL(action, extra) {
  return API_URL
    + '?action=' + encodeURIComponent(action)
    + '&user=' + encodeURIComponent(SESSION.username)
    + '&token=' + encodeURIComponent(SESSION.token)
    + (extra || '');
}

function authBody(obj) {
  obj = obj || {};
  obj.user = SESSION.username;
  obj.token = SESSION.token;
  return obj;
}

function postAction(action, bodyData) {
  var url = authURL(action);
  var payload = authBody(Object.assign({}, bodyData || {}));

  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(payload),
    redirect: 'follow'
  })
    .then(function (res) { return res.text(); })
    .then(function (text) {
      var j;
      try { j = JSON.parse(text); }
      catch (e) {
        throw new Error('Response bukan JSON: ' + String(text).substring(0, 180));
      }
      if (!j.ok) throw new Error(j.message || 'Request gagal');
      return j;
    });
}

// ================================================================
// 3) LOCAL CHAT STORAGE HELPERS
// ================================================================
function chatStoreKey() {
  var u = (SESSION && SESSION.username) ? SESSION.username : 'guest';
  return 'simontok-chat-sessions:' + u;
}

function readLocalSessions() {
  try {
    var raw = localStorage.getItem(chatStoreKey());
    var arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
}

function approxBytes(str) {
  try { return new Blob([str]).size; }
  catch (e) { return (str || '').length * 2; }
}

function safeText(s, maxChars) {
  s = String(s || '');
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars) + '…';
}

function compactSessionForStore(s) {
  var msgs = Array.isArray(s.messages) ? s.messages : [];

  if (msgs.length > MAX_MSG_PER_SESSION_STORE) {
    msgs = msgs.slice(msgs.length - MAX_MSG_PER_SESSION_STORE);
  }

  msgs = msgs.map(function (m) {
    return {
      role: m.role || 'user',
      content: safeText(m.content || '', MAX_CHARS_PER_MSG_STORE),
      timestamp: m.timestamp || ''
    };
  });

  return {
    session_id: s.session_id,
    title: safeText(s.title || 'Percakapan Baru', 120),
    messages: msgs,
    updated_at: s.updated_at || new Date().toISOString()
  };
}

function sortByUpdatedDesc(list) {
  return (list || []).sort(function (a, b) {
    return String(b.updated_at || '').localeCompare(String(a.updated_at || ''));
  });
}

function writeLocalSessionsSafe(list) {
  var key = chatStoreKey();
  var work = sortByUpdatedDesc((list || []).map(compactSessionForStore));

  if (work.length > MAX_LOCAL_SESSIONS) {
    work = work.slice(0, MAX_LOCAL_SESSIONS);
  }

  while (work.length > 0) {
    var raw = JSON.stringify(work);

    while (approxBytes(raw) > MAX_LOCAL_BYTES_SOFT && work.length > 1) {
      work.pop();
      raw = JSON.stringify(work);
    }

    try {
      localStorage.setItem(key, raw);
      return true;
    } catch (e) {
      work.pop();
    }
  }

  try {
    localStorage.setItem(key, JSON.stringify([]));
  } catch (e2) {}
  return false;
}

function writeLocalSessions(list) {
  try {
    writeLocalSessionsSafe(list || []);
  } catch (e) {
    console.warn('[SIMONTOK] writeLocalSessions error:', e.message);
  }
}

function ensureLocalSessionId() {
  if (!ACTIVE_SESSION) return '';
  if (!ACTIVE_SESSION.session_id) {
    ACTIVE_SESSION.session_id = 'sid_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  }
  return ACTIVE_SESSION.session_id;
}

// ================================================================
// 4) THEME PRELOAD
// ================================================================
(function () {
  var t = localStorage.getItem('simontok-theme');
  if (t === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
})();

// ================================================================
// 5) STATE
// ================================================================
var USER_CONTEXT   = null;
var SESSIONS_LIST  = [];
var ACTIVE_SESSION = null;
var IS_THINKING    = false;

var CONTEXT_STATE = {
  loading: false,
  loaded : false,
  error  : null,
  promise: null
};

// ================================================================
// 6) START APP
// ================================================================
function startApp() {
  initThemeButton();
  initEventListeners();

  var s = getSession();
  if (!s || !s.token || !s.username) {
    window.location.replace('index.html');
    return;
  }

  fetch(
    API_URL +
    '?action=validate' +
    '&user=' + encodeURIComponent(s.username) +
    '&token=' + encodeURIComponent(s.token)
  )
    .then(function (r) { return r.json(); })
    .then(function (j) {
      if (!j.ok) {
        localStorage.removeItem(SESSION_KEY);
        window.location.replace('index.html');
        return;
      }

      SESSION = {
        username  : j.user.username   || s.username,
        name      : j.user.name       || s.name,
        role      : j.user.role       || s.role,
        sheet_name: j.user.sheet_name || s.sheet_name,
        token     : s.token,
        apiKey    : j.user.apiKey     || s.apiKey || ''
      };

      localStorage.setItem(SESSION_KEY, JSON.stringify(SESSION));
      try { sessionStorage.setItem('simontok-apikey', SESSION.apiKey || ''); } catch (e) {}

      onSessionReady();
    })
    .catch(function (err) {
      console.warn('[SIMONTOK] Validasi offline:', err.message);
      SESSION = s || {};

      localStorage.setItem(SESSION_KEY, JSON.stringify(SESSION));
      try { sessionStorage.setItem('simontok-apikey', SESSION.apiKey || ''); } catch (e) {}

      onSessionReady();
    });
}

function onSessionReady() {
  var topbar = document.getElementById('topbarUser');
  if (topbar) {
    topbar.textContent =
      '🤖 AI Assistant · ' +
      (SESSION.name || SESSION.username) +
      (SESSION.role === 'admin' ? ' — Admin' : '');
  }

  if (window.AI_CLIENT && typeof AI_CLIENT.setApiKey === 'function') {
    AI_CLIENT.setApiKey(SESSION.apiKey || '');
  }

  var wt = document.getElementById('welcomeTitle');
  if (wt) wt.textContent = 'Halo, ' + (SESSION.name || SESSION.username) + '! Ada yang bisa saya bantu?';

  document.getElementById('loadingState').style.display = 'none';
  document.getElementById('app').style.display = '';

  renderApiKeyStatus();
  loadContext(true);
  loadSessions();
}

// ================================================================
// 7) API KEY STATUS
// ================================================================
function renderApiKeyStatus() {
  var dot = document.getElementById('aiKeyDot');
  var msg = document.getElementById('aiKeyMsg');
  if (!dot || !msg) return;

  var key = (window.AI_CLIENT && AI_CLIENT.getApiKey) ? AI_CLIENT.getApiKey() : getApiKey();
  if (!key) {
    dot.className = 'ai-key-dot err';
    msg.textContent = '⚠️ API Key tidak tersedia untuk akun ini. Hubungi admin.';
  } else {
    dot.className = 'ai-key-dot ok';
    msg.textContent = '✅ API Key aktif · Login sebagai ' + (SESSION.name || SESSION.username || 'User');
  }
}

// ================================================================
// 8) THEME
// ================================================================
function initThemeButton() {
  var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  var toggle = document.getElementById('darkToggle');
  if (toggle) toggle.classList.toggle('on', isDark);
}

function applyTheme(isDark) {
  if (isDark) document.documentElement.setAttribute('data-theme', 'dark');
  else document.documentElement.removeAttribute('data-theme');

  var toggle = document.getElementById('darkToggle');
  if (toggle) toggle.classList.toggle('on', isDark);

  localStorage.setItem('simontok-theme', isDark ? 'dark' : 'light');
}

// ================================================================
// 9) CONTEXT HELPERS
// ================================================================
function calcTaskStats(tasks) {
  var st = { total: 0, todo: 0, doing: 0, done: 0, blocked: 0 };
  (tasks || []).forEach(function (t) {
    st.total++;
    if (t.status === 'To Do') st.todo++;
    else if (t.status === 'Doing') st.doing++;
    else if (t.status === 'Done') st.done++;
    else if (t.status === 'Blocked') st.blocked++;
  });
  return st;
}

function normalizeContextFromList(taskRows) {
  var tasks = Array.isArray(taskRows) ? taskRows : [];
  return {
    ok: true,
    tasks: tasks,
    notulen: [],
    task_stats: calcTaskStats(tasks),
    source: 'list-fallback'
  };
}

// ================================================================
// 10) CONTEXT LOADER
// ================================================================
function loadContext(force) {
  force = !!force;

  if (CONTEXT_STATE.loading && CONTEXT_STATE.promise) return CONTEXT_STATE.promise;
  if (!force && CONTEXT_STATE.loaded) return Promise.resolve(USER_CONTEXT);

  CONTEXT_STATE.loading = true;
  CONTEXT_STATE.error = null;

  CONTEXT_STATE.promise = fetch(authURL('get-context'), { redirect: 'follow' })
    .then(function (r) { return r.json(); })
    .then(function (j) {
      if (j && j.ok && Array.isArray(j.tasks)) {
        USER_CONTEXT = j;
        CONTEXT_STATE.loaded = true;
        return USER_CONTEXT;
      }

      return fetch(authURL('list'), { redirect: 'follow' })
        .then(function (r2) { return r2.json(); })
        .then(function (j2) {
          if (!j2 || !j2.ok) throw new Error((j2 && j2.message) || 'list gagal');
          USER_CONTEXT = normalizeContextFromList(j2.data || []);
          CONTEXT_STATE.loaded = true;
          return USER_CONTEXT;
        });
    })
    .catch(function (err) {
      console.warn('[SIMONTOK] Context fallback empty:', err.message);
      USER_CONTEXT = normalizeContextFromList([]);
      USER_CONTEXT.source = 'empty-fallback';
      CONTEXT_STATE.error = err;
      CONTEXT_STATE.loaded = true;
      return USER_CONTEXT;
    })
    .finally(function () {
      CONTEXT_STATE.loading = false;
    });

  return CONTEXT_STATE.promise;
}

function ensureContextLoaded(timeoutMs) {
  timeoutMs = timeoutMs || 8000;

  if (typeof loadContext !== 'function') return Promise.resolve(null);

  var timeoutPromise = new Promise(function (resolve) {
    setTimeout(function () { resolve(null); }, timeoutMs);
  });

  return Promise.race([
    loadContext(false).catch(function () { return null; }),
    timeoutPromise
  ]);
}

// ================================================================
// 11) SYSTEM PROMPT + AI CONTEXT BUILDER
// ================================================================
function buildSystemPrompt() {
  var now = new Date();
  var nowText = now.toLocaleDateString('id-ID', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
  });

  var p =
    'Kamu adalah wanita ramah dan pintar bernama Aurelia assisten pribadi pengatur jadwal usermu yang sangat pintar dan profesional.\n' +
    'User aktif: ' + (SESSION.name || SESSION.username) + ' (role: ' + (SESSION.role || 'user') + ')\n' +
    'Tanggal hari ini: ' + nowText + '\n\n' +
    'ATURAN:\n' +
    '1) Jawab ringkas, jelas, dan ramah dalam Bahasa Indonesia.\n' +
    '2) Gunakan data task/notulen di bawah sebagai sumber utama\n' +
    '3) Jika user meminta buat task, WAJIB sisipkan:\n' +
    '   %%TASK_JSON%%{"title":"...","status":"To Do","priority":"High/Medium/Low","due_date":"YYYY-MM-DD","note":"..."}%%END_TASK%%\n' +
    '4) Jangan mengarang data yang tidak ada.\n\n';

  if (USER_CONTEXT && USER_CONTEXT.ok) {
    var st = USER_CONTEXT.task_stats || {};
    var tasks = USER_CONTEXT.tasks || [];
    var nts = USER_CONTEXT.notulen || [];

    p +=
      '=== TASK STATS ===\n' +
      'Total=' + (st.total || 0) +
      ', To Do=' + (st.todo || 0) +
      ', Doing=' + (st.doing || 0) +
      ', Done=' + (st.done || 0) +
      ', Blocked=' + (st.blocked || 0) + '\n\n';

    if (tasks.length) {
      p += '=== LIST TASK ===\n';
      tasks.forEach(function (t, i) {
        p +=
          (i + 1) + '. [' + (t.status || '-') + '] ' + (t.title || '-') +
          ' | Due: ' + (t.due_date || '-') +
          ' | Priority: ' + (t.priority || '-') +
          (t.note ? ' | Note: ' + String(t.note).substring(0, 80) : '') + '\n';
      });
      p += '\n';
    }

    if (nts.length) {
      p += '=== NOTULEN TERBARU ===\n';
      nts.forEach(function (n, i) {
        p +=
          (i + 1) + '. ' + (n.kegiatan || '-') +
          ' | Tanggal: ' + (n.tanggal || '-') +
          ' | Tempat: ' + (n.tempat || '-') + '\n';
      });
      p += '\n';
    }
  } else {
    p +=
      '=== DATA TASK USER ===\n' +
      'Total=0, To Do=0, Doing=0, Done=0, Blocked=0\n' +
      'Catatan: Jika tidak ada task, sampaikan secara natural bahwa belum ada task tercatat.\n\n';
  }

  p += 'Gunakan bullet points jika menjawab daftar.';
  return p;
}

function buildMessagesForAI(systemPrompt, history) {
  var arr = Array.isArray(history) ? history : [];
  var sliced = arr.slice(-MAX_AI_CONTEXT_MESSAGES);

  var total = 0;
  var kept = [];
  for (var i = sliced.length - 1; i >= 0; i--) {
    var m = sliced[i] || {};
    var c = String(m.content || '');
    if ((total + c.length) > MAX_AI_CONTEXT_CHARS) break;
    kept.unshift({ role: m.role || 'user', content: c });
    total += c.length;
  }

  return [{ role: 'system', content: systemPrompt }].concat(kept);
}

// ================================================================
// 12) SESSION CHAT CRUD
// ================================================================
function loadSessions() {
  var el = document.getElementById('sessionsList');
  if (el) el.innerHTML = '<div class="sessions-loading">⏳ Memuat sesi...</div>';

  if (CHAT_STORAGE_MODE === 'local') {
    var list = readLocalSessions();
    list = sortByUpdatedDesc(list);

    SESSIONS_LIST = list.map(function (s) {
      return {
        session_id: s.session_id,
        title: s.title || 'Percakapan Baru',
        msg_count: (s.messages || []).length,
        updated_at: s.updated_at || ''
      };
    });

    renderSessionsList();
    return;
  }

  fetch(authURL('list-sessions'), { redirect: 'follow' })
    .then(function (r) { return r.json(); })
    .then(function (j) {
      SESSIONS_LIST = j.ok ? (j.data || []) : [];
      renderSessionsList();
    })
    .catch(function () {
      SESSIONS_LIST = [];
      renderSessionsList();
    });
}

function renderSessionsList() {
  var el = document.getElementById('sessionsList');
  if (!el) return;

  if (!SESSIONS_LIST.length) {
    el.innerHTML = '<div class="sessions-empty">💬 Belum ada riwayat chat.<br>Mulai percakapan baru!</div>';
    return;
  }

  var html = '';
  SESSIONS_LIST.forEach(function (s) {
    var active = ACTIVE_SESSION && ACTIVE_SESSION.session_id === s.session_id;
    html +=
      '<div class="session-item' + (active ? ' active' : '') + '" data-sid="' + esc(s.session_id) + '">' +
      '  <div class="session-item-title">' + esc(s.title || 'Percakapan Baru') + '</div>' +
      '  <div class="session-item-meta">💬 ' + (s.msg_count || 0) + ' pesan · ' + String(s.updated_at || '').substring(0, 16) + '</div>' +
      '  <button class="session-del-btn" data-del="' + esc(s.session_id) + '" title="Hapus sesi">🗑</button>' +
      '</div>';
  });
  el.innerHTML = html;

  el.querySelectorAll('.session-item[data-sid]').forEach(function (item) {
    item.addEventListener('click', function (e) {
      if (e.target.closest('[data-del]')) return;
      openSession(item.getAttribute('data-sid'));
    });
  });

  el.querySelectorAll('[data-del]').forEach(function (btn) {
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      confirmDeleteSession(btn.getAttribute('data-del'));
    });
  });
}

function openSession(sessionId) {
  if (CHAT_STORAGE_MODE === 'local') {
    var list = readLocalSessions();
    var d = null;
    for (var i = 0; i < list.length; i++) {
      if (list[i].session_id === sessionId) { d = list[i]; break; }
    }
    if (!d) { alert('Sesi tidak ditemukan.'); return; }

    ACTIVE_SESSION = {
      session_id: d.session_id || sessionId,
      title: d.title || 'Percakapan',
      messages: Array.isArray(d.messages) ? d.messages : [],
      updated_at: d.updated_at || ''
    };

    document.getElementById('chatTitle').textContent = ACTIVE_SESSION.title;
    document.getElementById('chatSubtitle').textContent =
      ACTIVE_SESSION.messages.length + ' pesan · ' + String(ACTIVE_SESSION.updated_at || '').substring(0, 16);

    renderMessages();
    renderSessionsList();
    return;
  }

  fetch(authURL('get-session', '&session_id=' + encodeURIComponent(sessionId)), { redirect: 'follow' })
    .then(function (r) { return r.json(); })
    .then(function (j) {
      if (!j.ok) { alert('Gagal memuat sesi.'); return; }

      var d = j.data || {};
      ACTIVE_SESSION = {
        session_id: d.session_id || sessionId,
        title     : d.title || 'Percakapan',
        messages  : Array.isArray(d.messages) ? d.messages : [],
        updated_at: d.updated_at || ''
      };

      document.getElementById('chatTitle').textContent = ACTIVE_SESSION.title;
      document.getElementById('chatSubtitle').textContent =
        ACTIVE_SESSION.messages.length + ' pesan · ' + String(ACTIVE_SESSION.updated_at || '').substring(0, 16);

      renderMessages();
      renderSessionsList();
    })
    .catch(function (err) {
      alert('Error: ' + err.message);
    });
}

function startNewSession() {
  ACTIVE_SESSION = {
    session_id: '',
    title: 'Percakapan Baru',
    messages: []
  };
  document.getElementById('chatTitle').textContent = 'Percakapan Baru';
  document.getElementById('chatSubtitle').textContent = 'Tanyakan apa saja tentang jadwal & task kamu';
  renderMessages();
  renderSessionsList();
  document.getElementById('chatInput').focus();
}

function saveSessionToSheet() {
  if (!ACTIVE_SESSION) return;

  if (CHAT_STORAGE_MODE === 'local') {
    if (Array.isArray(ACTIVE_SESSION.messages) && ACTIVE_SESSION.messages.length > MAX_MSG_PER_SESSION_STORE) {
      ACTIVE_SESSION.messages = ACTIVE_SESSION.messages.slice(-MAX_MSG_PER_SESSION_STORE);
    }

    var sid = ensureLocalSessionId();
    ACTIVE_SESSION.updated_at = new Date().toISOString();

    var list = readLocalSessions();
    var idx = -1;
    for (var i = 0; i < list.length; i++) {
      if (list[i].session_id === sid) { idx = i; break; }
    }

    var payload = {
      session_id: sid,
      title: ACTIVE_SESSION.title || 'Percakapan Baru',
      messages: ACTIVE_SESSION.messages || [],
      updated_at: ACTIVE_SESSION.updated_at
    };

    if (idx >= 0) list[idx] = payload;
    else list.push(payload);

    writeLocalSessions(list);
    loadSessions();
    return;
  }

  postAction('save-session', {
    session_id: ACTIVE_SESSION.session_id || '',
    title: ACTIVE_SESSION.title || 'Percakapan Baru',
    messages: ACTIVE_SESSION.messages || []
  })
    .then(function (j) {
      if (!ACTIVE_SESSION.session_id && j.session_id) {
        ACTIVE_SESSION.session_id = j.session_id;
      }
      loadSessions();
    })
    .catch(function (err) {
      console.warn('[SIMONTOK] save-session error:', err.message);
    });
}

function confirmDeleteSession(sessionId) {
  if (!confirm('Hapus sesi chat ini?')) return;

  if (CHAT_STORAGE_MODE === 'local') {
    var list = readLocalSessions().filter(function (s) {
      return s.session_id !== sessionId;
    });
    writeLocalSessions(list);

    if (ACTIVE_SESSION && ACTIVE_SESSION.session_id === sessionId) {
      ACTIVE_SESSION = null;
      document.getElementById('chatTitle').textContent = 'AI Assistant SIMONTOK';
      document.getElementById('chatSubtitle').textContent = 'Tanyakan jadwal, buat task, atau minta bantuan apapun';
      renderMessages();
    }

    loadSessions();
    return;
  }

  postAction('delete-session', { session_id: sessionId })
    .then(function () {
      if (ACTIVE_SESSION && ACTIVE_SESSION.session_id === sessionId) {
        ACTIVE_SESSION = null;
        document.getElementById('chatTitle').textContent = 'AI Assistant SIMONTOK';
        document.getElementById('chatSubtitle').textContent = 'Tanyakan jadwal, buat task, atau minta bantuan apapun';
        renderMessages();
      }
      loadSessions();
    })
    .catch(function (err) {
      alert('Error: ' + err.message);
    });
}

// ================================================================
// 13) RENDER CHAT
// ================================================================
function renderMessages() {
  var area = document.getElementById('chatMessages');
  if (!area) return;

  if (!ACTIVE_SESSION || !Array.isArray(ACTIVE_SESSION.messages) || !ACTIVE_SESSION.messages.length) {
    var welcome = document.getElementById('chatWelcome');
    area.innerHTML = '';
    if (welcome) area.appendChild(welcome.cloneNode(true));

    area.querySelectorAll('.tip-item[data-prompt]').forEach(function (el) {
      el.addEventListener('click', function () {
        sendMessage(el.getAttribute('data-prompt'));
      });
    });
    return;
  }

  var html = '';
  ACTIVE_SESSION.messages.forEach(function (m) { html += renderBubble(m); });
  area.innerHTML = html;
  scrollToBottom();
}

function renderBubble(msg) {
  var isUser = msg.role === 'user';
  var cls = isUser ? 'user' : 'ai';
  var avatar = isUser
    ? String(SESSION.name || SESSION.username || 'U').charAt(0).toUpperCase()
    : '🤖';
  var time = msg.timestamp ? String(msg.timestamp).substring(11, 16) : '';
  var content = isUser ? esc(msg.content) : renderMarkdown(msg.content);

  return (
    '<div class="msg-row ' + cls + '">' +
    '  <div class="msg-avatar ' + cls + '">' + avatar + '</div>' +
    '  <div class="msg-col">' +
    '    <div class="msg-bubble ' + cls + '">' + content + '</div>' +
    (time ? '<div class="msg-time">' + time + '</div>' : '') +
    '  </div>' +
    '</div>'
  );
}

function renderMarkdown(text) {
  if (!text) return '';
  var t = esc(text);

  t = t.replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>');
  t = t.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  t = t.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
  t = t.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  t = t.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
  t = t.replace(/^---+$/gm, '<hr>');

  t = t.replace(/%%TASK_JSON%%[\s\S]*?%%END_TASK%%/g, '');
  t = t.replace(/^\s*[-•]\s(.+)$/gm, '<li>$1</li>');
  t = t.replace(/(<li>[\s\S]*?<\/li>(\n|$))+/g, function (m) { return '<ul>' + m + '</ul>'; });

  t = t.split(/\n{2,}/).map(function (p) {
    p = p.trim();
    if (!p) return '';
    if (/^<(h[1-6]|ul|ol|pre|hr|table)/.test(p)) return p;
    return '<p>' + p.replace(/\n/g, '<br>') + '</p>';
  }).join('');

  return t;
}

function showTyping() {
  var area = document.getElementById('chatMessages');
  if (!area) return;
  var el = document.createElement('div');
  el.id = 'typingIndicator';
  el.className = 'typing-row';
  el.innerHTML =
    '<div class="msg-avatar ai">🤖</div>' +
    '<div class="typing-bubble">' +
    '<div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div>' +
    '</div>';
  area.appendChild(el);
  scrollToBottom();
}

function hideTyping() {
  var el = document.getElementById('typingIndicator');
  if (el) el.remove();
}

function scrollToBottom() {
  var area = document.getElementById('chatMessages');
  if (area) setTimeout(function () { area.scrollTop = area.scrollHeight; }, 60);
}

function sendToAI(messagesForAI) {
  if (window.AI_CLIENT && typeof AI_CLIENT.sendChat === 'function') {
    return AI_CLIENT.sendChat(messagesForAI, {
      apiKey: (SESSION && SESSION.apiKey) || '',
      model: AI_MODEL
    });
  }

  var key = getApiKey();
  return callOpenRouter(key, messagesForAI);
}

// ================================================================
// 14) SEND MESSAGE
// ================================================================
function sendMessage(textOverride) {
  var input = document.getElementById('chatInput');
  var content = textOverride || (input.value || '').trim();
  if (!content || IS_THINKING) return;

  var apiKey = (window.AI_CLIENT && AI_CLIENT.getApiKey)
    ? AI_CLIENT.getApiKey()
    : getApiKey();

  if (!apiKey) {
    alert('API Key tidak tersedia. Hubungi admin.');
    return;
  }

  if (!ACTIVE_SESSION) startNewSession();

  ACTIVE_SESSION.messages.push({
    role: 'user',
    content: content,
    timestamp: new Date().toISOString()
  });

  if (!textOverride) {
    input.value = '';
    autoResizeInput();
  }

  renderMessages();
  IS_THINKING = true;
  document.getElementById('btnSend').disabled = true;
  showTyping();

  ensureContextLoaded(8000).finally(function () {
    var messagesForAI = buildMessagesForAI(
      buildSystemPrompt(),
      ACTIVE_SESSION.messages || []
    );

    sendToAI(messagesForAI)
      .then(function (result) {
        hideTyping();
        IS_THINKING = false;
        document.getElementById('btnSend').disabled = false;

        var aiText = result.text || '';
        processAIResponse(aiText);

        ACTIVE_SESSION.messages.push({
          role: 'assistant',
          content: aiText,
          timestamp: new Date().toISOString()
        });

        if (!ACTIVE_SESSION.session_id && ACTIVE_SESSION.messages.length === 2) {
          ACTIVE_SESSION.title = content.length > 45 ? content.substring(0, 45) + '...' : content;
          document.getElementById('chatTitle').textContent = ACTIVE_SESSION.title;
        }

        renderMessages();
        saveSessionToSheet();
      })
      .catch(function (err) {
        hideTyping();
        IS_THINKING = false;
        document.getElementById('btnSend').disabled = false;

        ACTIVE_SESSION.messages.push({
          role: 'assistant',
          content: err.message || '❌ Terjadi kesalahan. Silakan coba lagi.',
          timestamp: new Date().toISOString()
        });
        renderMessages();
        saveSessionToSheet();
      });
  });
}

// ================================================================
// 15) OPENROUTER FALLBACK
// ================================================================
function callOpenRouter(apiKey, messages) {
  var start = Date.now();
  var controller = new AbortController();
  var timer = setTimeout(function () { controller.abort(); }, 30000);

  return fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + apiKey,
      'Content-Type': 'application/json',
      'HTTP-Referer': window.location.origin || 'https://simontok.app',
      'X-Title': 'SIMONTOK Assistant'
    },
    body: JSON.stringify({
      model: AI_MODEL,
      messages: messages,
      max_tokens: 2048,
      temperature: 0.7,
      stream: false
    }),
    signal: controller.signal,
    redirect: 'follow'
  })
    .then(function (res) {
      clearTimeout(timer);
      if (!res.ok) {
        return res.json().then(function (body) {
          var msg = body && body.error && body.error.message
            ? body.error.message
            : ('HTTP ' + res.status);
          throw new Error(friendlyError(res.status, msg));
        }).catch(function (e) {
          if (e.message) throw e;
          throw new Error('❌ HTTP ' + res.status);
        });
      }
      return res.json();
    })
    .then(function (data) {
      if (!data || !data.choices || !data.choices.length) {
        throw new Error('Response AI kosong. Coba lagi.');
      }
      var text = data.choices[0].message && data.choices[0].message.content
        ? String(data.choices[0].message.content).trim()
        : '';
      if (!text) throw new Error('AI tidak menghasilkan teks.');
      return { text: text, latencyMs: Date.now() - start };
    })
    .catch(function (err) {
      clearTimeout(timer);
      if (err.name === 'AbortError') {
        throw new Error('⏳ Timeout 30 detik. Coba lagi.');
      }
      throw err;
    });
}

function friendlyError(code, msg) {
  var map = {
    400: '❌ Request tidak valid.',
    401: '🔑 API Key tidak valid / expired.',
    402: '💳 Saldo OpenRouter habis.',
    403: '🚫 Akses ditolak.',
    429: '⏳ Terlalu banyak request.',
    500: '🔧 Server OpenRouter bermasalah.',
    502: '🔧 Gateway error OpenRouter.',
    503: '🔧 OpenRouter maintenance.'
  };
  var c = parseInt(code, 10);
  return (map[c] || '❌ Error AI.') + ' Detail: ' + msg;
}

// ================================================================
// 16) TASK JSON HANDLER + MODAL
// ================================================================
var PENDING_TASK = null;

function processAIResponse(text) {
  var m = String(text || '').match(/%%TASK_JSON%%([\s\S]*?)%%END_TASK%%/);
  if (!m) return;
  try {
    var taskData = JSON.parse(m[1].trim());
    setTimeout(function () { openTaskModal(taskData); }, 350);
  } catch (e) {
    console.warn('[SIMONTOK] parse TASK_JSON gagal:', e.message);
  }
}

function openTaskModal(taskData) {
  PENDING_TASK = taskData || {};
  document.getElementById('mTaskTitle').value    = PENDING_TASK.title || '';
  document.getElementById('mTaskStatus').value   = PENDING_TASK.status || 'To Do';
  document.getElementById('mTaskPriority').value = PENDING_TASK.priority || 'Medium';
  document.getElementById('mTaskDueDate').value  = PENDING_TASK.due_date || '';
  document.getElementById('mTaskNote').value     = PENDING_TASK.note || '';
  document.getElementById('taskModal').classList.add('active');
}

function closeTaskModal() {
  document.getElementById('taskModal').classList.remove('active');
  PENDING_TASK = null;
}

function submitTaskModal() {
  var task = {
    title   : document.getElementById('mTaskTitle').value.trim(),
    status  : document.getElementById('mTaskStatus').value,
    priority: document.getElementById('mTaskPriority').value,
    due_date: document.getElementById('mTaskDueDate').value,
    note    : document.getElementById('mTaskNote').value.trim()
  };

  if (!task.title) {
    alert('Judul task wajib diisi.');
    return;
  }

  var btn = document.getElementById('taskModalConfirm');
  btn.disabled = true;
  btn.textContent = '⏳ Menyimpan...';

  postAction('ai-add-task', { task: task })
    .then(function () {
      btn.disabled = false;
      btn.textContent = '✅ Simpan Task';

      closeTaskModal();

      ACTIVE_SESSION.messages.push({
        role: 'assistant',
        content:
          '✅ Task berhasil ditambahkan!\n\n' +
          '**' + task.title + '**\n' +
          '• Status: ' + task.status + '\n' +
          '• Prioritas: ' + task.priority + '\n' +
          '• Due Date: ' + (task.due_date || '(tidak ada)'),
        timestamp: new Date().toISOString()
      });

      renderMessages();
      saveSessionToSheet();
      loadContext(true);
    })
    .catch(function (err) {
      btn.disabled = false;
      btn.textContent = '✅ Simpan Task';
      alert('Error: ' + err.message);
    });
}

// ================================================================
// 17) UTIL
// ================================================================
function autoResizeInput() {
  var el = document.getElementById('chatInput');
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}

function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ================================================================
// 18) EVENTS
// ================================================================
function initEventListeners() {
  document.getElementById('darkToggle').addEventListener('click', function () {
    var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    applyTheme(!isDark);
  });

  var settingsOpen = false;
  document.getElementById('settingsBtn').addEventListener('click', function (e) {
    e.stopPropagation();
    settingsOpen = !settingsOpen;
    document.getElementById('settingsDropdown').classList.toggle('open', settingsOpen);
  });

  document.addEventListener('click', function (e) {
    if (!settingsOpen) return;
    var dd = document.getElementById('settingsDropdown');
    if (!dd.contains(e.target) && e.target.id !== 'settingsBtn') {
      settingsOpen = false;
      dd.classList.remove('open');
    }
  });

  document.getElementById('settingsDropdown').addEventListener('click', function (e) {
    e.stopPropagation();
  });

  document.getElementById('logoutBtn').addEventListener('click', function () {
    if (!confirm('Yakin ingin logout?')) return;
        localStorage.removeItem(SESSION_KEY);
    try { sessionStorage.removeItem('simontok-apikey'); } catch (e) {}
    window.location.href = 'index.html';
  });

  document.getElementById('btnNewChat').addEventListener('click', function () {
    startNewSession();
  });

  document.getElementById('btnRefreshCtx').addEventListener('click', function () {
    var btn = this;
    btn.disabled = true;
    btn.textContent = '⏳ Memuat...';

    loadContext(true).finally(function () {
      btn.disabled = false;
      btn.textContent = '🔄 Refresh Data';
    });
  });

  document.querySelectorAll('.qa-btn[data-prompt]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      sendMessage(btn.getAttribute('data-prompt'));
    });
  });

  document.getElementById('chatMessages').addEventListener('click', function (e) {
    var tip = e.target.closest('.tip-item[data-prompt]');
    if (tip) sendMessage(tip.getAttribute('data-prompt'));
  });

  document.getElementById('btnSend').addEventListener('click', function () {
    sendMessage();
  });

  document.getElementById('chatInput').addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  document.getElementById('chatInput').addEventListener('input', autoResizeInput);

  document.getElementById('taskModalClose').addEventListener('click', closeTaskModal);
  document.getElementById('taskModalCancel').addEventListener('click', closeTaskModal);
  document.getElementById('taskModal').addEventListener('click', function (e) {
    if (e.target === this) closeTaskModal();
  });
  document.getElementById('taskModalConfirm').addEventListener('click', submitTaskModal);
}

// ================================================================
// 19) ENTRY
// ================================================================
window.onload = startApp;
