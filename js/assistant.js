// ================================================================
// SIMONTOK - Assistant JS
// File   : js/assistant.js
// Versi  : 1.2 (stable context-aware)
// Depends: js/ai-client.js (opsional; file ini tidak bergantung langsung)
// ================================================================

// ================================================================
// 1) CONFIG
// ================================================================
var API_URL     = 'https://script.google.com/macros/s/AKfycbwLLIv2AH5v4FiYImDN2-u5WhxAYvsTXq1ZUqdRUWqBM0K6pBuI3q_ZQn3_eFIii2bU/exec';
var SESSION_KEY = 'simontok-session';
var SESSION     = null;
var AI_MODEL    = 'google/gemma-4-31b-it';

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

// ================================================================
// 3) THEME PRELOAD (boleh jalan sebelum startApp)
// ================================================================
(function () {
  var t = localStorage.getItem('simontok-theme');
  if (t === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
})();

// ================================================================
// 4) STATE
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
// 5) START APP (pola notulen: validate dulu)
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

      // Sinkronkan juga ke sessionStorage agar kompatibel dengan modul lain (jika dipakai)
      try { sessionStorage.setItem('simontok-apikey', SESSION.apiKey || ''); } catch (e) {}

      onSessionReady();
    })
    .catch(function (err) {
      console.warn('[SIMONTOK] Validasi offline:', err.message);
      SESSION = s;

      // Sinkronkan juga local/session storage semampunya
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

  var wt = document.getElementById('welcomeTitle');
  if (wt) wt.textContent = 'Halo, ' + (SESSION.name || SESSION.username) + '! Ada yang bisa saya bantu?';

  document.getElementById('loadingState').style.display = 'none';
  document.getElementById('app').style.display = '';

  renderApiKeyStatus();
  loadContext(true); // preload awal
  loadSessions();
}

// ================================================================
// 6) API KEY STATUS
// ================================================================
function renderApiKeyStatus() {
  var dot = document.getElementById('aiKeyDot');
  var msg = document.getElementById('aiKeyMsg');
  if (!dot || !msg) return;

  var key = getApiKey();
  if (!key) {
    dot.className = 'ai-key-dot err';
    msg.textContent = '⚠️ API Key tidak tersedia untuk akun ini. Hubungi admin.';
  } else {
    dot.className = 'ai-key-dot ok';
    msg.textContent = '✅ API Key aktif · Login sebagai ' + (SESSION.name || SESSION.username || 'User');
  }
}

// ================================================================
// 7) THEME
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
// 8) CONTEXT LOADER (promise-aware)
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
      // sukses normal get-context
      if (j && j.ok && Array.isArray(j.tasks)) {
        USER_CONTEXT = j;
        CONTEXT_STATE.loaded = true;
        return USER_CONTEXT;
      }

      // fallback ke list jika format/context tidak siap
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
      // fallback terakhir: context kosong tapi "siap"
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
// ================================================================
// 9) SYSTEM PROMPT
// ================================================================
function buildSystemPrompt() {
  var now = new Date();
  var nowText = now.toLocaleDateString('id-ID', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
  });

  var p =
    'Kamu adalah SIMONTOK Assistant untuk BAPENDA Lombok Tengah.\n' +
    'User aktif: ' + (SESSION.name || SESSION.username) + ' (role: ' + (SESSION.role || 'user') + ')\n' +
    'Tanggal hari ini: ' + nowText + '\n\n' +
    'ATURAN:\n' +
    '1) Jawab ringkas, jelas, dan ramah dalam Bahasa Indonesia.\n' +
    '2) Gunakan data task/notulen di bawah sebagai sumber utama.\n' +
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
  prompt +=
    '=== DATA TASK USER ===\n' +
    'Total=0, To Do=0, Doing=0, Done=0, Blocked=0\n' +
    'Catatan: Jika tidak ada task, sampaikan secara natural bahwa belum ada task tercatat.\n\n';
}
  p += 'Gunakan bullet points jika menjawab daftar.';
  return p;
}

// ================================================================
// 10) SESSION CHAT CRUD
// ================================================================
function loadSessions() {
  var el = document.getElementById('sessionsList');
  if (el) el.innerHTML = '<div class="sessions-loading">⏳ Memuat sesi...</div>';

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

  fetch(API_URL, {
    method : 'POST',
    headers: { 'Content-Type': 'application/json' },
    redirect: 'follow',
    body: JSON.stringify({
      action    : 'save-session',
      user      : SESSION.username,
      token     : SESSION.token,
      session_id: ACTIVE_SESSION.session_id || '',
      title     : ACTIVE_SESSION.title || 'Percakapan Baru',
      messages  : ACTIVE_SESSION.messages || []
    })
  })
    .then(function (r) { return r.json(); })
    .then(function (j) {
      if (j.ok && !ACTIVE_SESSION.session_id && j.session_id) {
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

  fetch(API_URL, {
    method : 'POST',
    headers: { 'Content-Type': 'application/json' },
    redirect: 'follow',
    body: JSON.stringify({
      action    : 'delete-session',
      user      : SESSION.username,
      token     : SESSION.token,
      session_id: sessionId
    })
  })
    .then(function (r) { return r.json(); })
    .then(function (j) {
      if (!j.ok) { alert('Gagal menghapus sesi.'); return; }

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
// 11) RENDER CHAT
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

  // hide task JSON block
  t = t.replace(/%%TASK_JSON%%[\s\S]*?%%END_TASK%%/g, '');

  // list item sederhana
  t = t.replace(/^\s*[-•]\s(.+)$/gm, '<li>$1</li>');
  t = t.replace(/(<li>[\s\S]*?<\/li>(\n|$))+/g, function (m) { return '<ul>' + m + '</ul>'; });

  // paragraph split
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

// ================================================================
// 12) SEND MESSAGE (wait context first)
// ================================================================
function sendMessage(textOverride) {
  var input = document.getElementById('chatInput');
  var content = textOverride || (input.value || '').trim();
  if (!content || IS_THINKING) return;

  var apiKey = getApiKey();
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

  // Tunggu context (max 8 detik), lalu kirim
  ensureContextLoaded(8000).finally(function () {
    var messagesForAI = [{ role: 'system', content: buildSystemPrompt() }]
      .concat((ACTIVE_SESSION.messages || []).map(function (m) {
        return { role: m.role, content: m.content };
      }));

    callOpenRouter(apiKey, messagesForAI)
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
      });
  });
}

// ================================================================
// 13) OPENROUTER CALL
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
// 14) TASK JSON HANDLER + MODAL
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

  fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    redirect: 'follow',
    body: JSON.stringify({
      action: 'ai-add-task',
      user: SESSION.username,
      token: SESSION.token,
      task: task
    })
  })
    .then(function (r) { return r.json(); })
    .then(function (j) {
      btn.disabled = false;
      btn.textContent = '✅ Simpan Task';

      if (!j.ok) {
        alert('Gagal simpan task: ' + (j.message || 'Unknown error'));
        return;
      }

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
      loadContext(true); // refresh context setelah add task
    })
    .catch(function (err) {
      btn.disabled = false;
      btn.textContent = '✅ Simpan Task';
      alert('Error: ' + err.message);
    });
}

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
// 15) UTIL
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
// 16) EVENTS
// ================================================================
function initEventListeners() {
  // dark toggle
  document.getElementById('darkToggle').addEventListener('click', function () {
    var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    applyTheme(!isDark);
  });

  // settings dropdown
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

  // logout
  document.getElementById('logoutBtn').addEventListener('click', function () {
    if (!confirm('Yakin ingin logout?')) return;
    localStorage.removeItem(SESSION_KEY);
    try { sessionStorage.removeItem('simontok-apikey'); } catch (e) {}
    window.location.href = 'index.html';
  });

  // new chat
  document.getElementById('btnNewChat').addEventListener('click', function () {
    startNewSession();
  });

  // refresh context
  document.getElementById('btnRefreshCtx').addEventListener('click', function () {
    var btn = this;
    btn.disabled = true;
    btn.textContent = '⏳ Memuat...';

    loadContext(true).finally(function () {
      btn.disabled = false;
      btn.textContent = '🔄 Refresh Data';
    });
  });

  // quick actions
  document.querySelectorAll('.qa-btn[data-prompt]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      sendMessage(btn.getAttribute('data-prompt'));
    });
  });

  // tip click delegation
  document.getElementById('chatMessages').addEventListener('click', function (e) {
    var tip = e.target.closest('.tip-item[data-prompt]');
    if (tip) sendMessage(tip.getAttribute('data-prompt'));
  });

  // send button
  document.getElementById('btnSend').addEventListener('click', function () {
    sendMessage();
  });

  // textarea key
  document.getElementById('chatInput').addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  document.getElementById('chatInput').addEventListener('input', autoResizeInput);

  // modal
  document.getElementById('taskModalClose').addEventListener('click', closeTaskModal);
  document.getElementById('taskModalCancel').addEventListener('click', closeTaskModal);
  document.getElementById('taskModal').addEventListener('click', function (e) {
    if (e.target === this) closeTaskModal();
  });
  document.getElementById('taskModalConfirm').addEventListener('click', submitTaskModal);
}

// ================================================================
// 17) ENTRY
// ================================================================
window.onload = startApp;
