// ================================================================
// BEKARYE - Assistant JS
// File   : js/assistant.js
// Versi  : 1.6 (clean + stable + migration safe)
// Depends: js/ai-client.js (optional; fallback OpenRouter included)
// ================================================================

(function () {
  'use strict';

  // ================================================================
  // 1) CONFIG
  // ================================================================
  var API_URL = 'https://script.google.com/macros/s/AKfycbwLLIv2AH5v4FiYImDN2-u5WhxAYvsTXq1ZUqdRUWqBM0K6pBuI3q_ZQn3_eFIii2bU/exec';
  var SESSION_KEY = 'bekarye-session';
  var LEGACY_SESSION_KEY = 'simontok-session';
  var THEME_KEY = 'bekarye-theme';
  var LEGACY_THEME_KEY = 'simontok-theme';

  var AI_MODEL = 'anthropic/claude-haiku-4.5';
  var CHAT_STORAGE_MODE = 'local'; // 'local' | 'remote'

  var MAX_LOCAL_SESSIONS = 40;
  var MAX_MSG_PER_SESSION_STORE = 120;
  var MAX_CHARS_PER_MSG_STORE = 2000;
  var MAX_LOCAL_BYTES_SOFT = 4 * 1024 * 1024;

  var MAX_AI_CONTEXT_MESSAGES = 24;
  var MAX_AI_CONTEXT_CHARS = 18000;

  // ================================================================
  // 2) STATE
  // ================================================================
  var SESSION = null;
  var USER_CONTEXT = null;
  var SESSIONS_LIST = [];
  var ACTIVE_SESSION = null;
  var IS_THINKING = false;
  var PENDING_TASK = null;

  var CONTEXT_STATE = {
    loading: false,
    loaded: false,
    error: null,
    promise: null
  };

  // ================================================================
  // 3) BASIC HELPERS
  // ================================================================
  function el(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function nl2br(s) {
    return esc(s).replace(/\n/g, '<br>');
  }

  function nowISO() {
    return new Date().toISOString();
  }

  function safeText(s, maxChars) {
    s = String(s || '');
    if (s.length <= maxChars) return s;
    return s.slice(0, maxChars) + '…';
  }

  function approxBytes(str) {
    try { return new Blob([str]).size; }
    catch (e) { return String(str || '').length * 2; }
  }

  function sortByUpdatedDesc(list) {
    return (list || []).sort(function (a, b) {
      return String(b.updated_at || '').localeCompare(String(a.updated_at || ''));
    });
  }

  // ================================================================
  // 4) MIGRATION + SESSION HELPERS
  // ================================================================
  function migrateSessionAndTheme() {
    try {
      if (!localStorage.getItem(SESSION_KEY)) {
        var oldS = localStorage.getItem(LEGACY_SESSION_KEY);
        if (oldS) localStorage.setItem(SESSION_KEY, oldS);
      }
    } catch (e) {}

    try {
      if (!localStorage.getItem(THEME_KEY)) {
        var oldT = localStorage.getItem(LEGACY_THEME_KEY);
        if (oldT) localStorage.setItem(THEME_KEY, oldT);
      }
    } catch (e) {}
  }

  function getSession() {
    try {
      var raw = localStorage.getItem(SESSION_KEY) || localStorage.getItem(LEGACY_SESSION_KEY);
      if (!raw) return null;
      var s = JSON.parse(raw);
      if (!s || !s.username || !s.token) return null;

      // persist ke key baru
      localStorage.setItem(SESSION_KEY, JSON.stringify(s));
      return s;
    } catch (e) {
      return null;
    }
  }

  function getApiKey() {
    var k = (SESSION && SESSION.apiKey) ? String(SESSION.apiKey).trim() : '';
    if (k && k !== 'undefined' && k !== 'null') return k;

    try {
      var sess = getSession();
      k = String((sess && sess.apiKey) || '').trim();
      if (k) return k;
    } catch (e) {}

    try {
      k = String(sessionStorage.getItem('bekarye-apikey') || sessionStorage.getItem('simontok-apikey') || '').trim();
      if (k) return k;
    } catch (e2) {}

    return '';
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
  // 5) THEME
  // ================================================================
  function updateBrandLogos() {
    var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    var logoPath = isDark ? 'assets/logo/logo-dark.png' : 'assets/logo-light.png';

    var logo = el('logoImage');
    if (logo) logo.src = logoPath;

    var brand = el('brandLogo');
    if (brand) brand.textContent = 'BEKARYE';
  }

  function applyTheme(isDark) {
    if (isDark) document.documentElement.setAttribute('data-theme', 'dark');
    else document.documentElement.removeAttribute('data-theme');

    try { localStorage.setItem(THEME_KEY, isDark ? 'dark' : 'light'); } catch (e) {}

    var darkToggle = el('darkToggle');
    if (darkToggle) darkToggle.classList.toggle('on', isDark);

    updateBrandLogos();
  }

  function initTheme() {
    var t = 'light';
    try {
      t = localStorage.getItem(THEME_KEY) || localStorage.getItem(LEGACY_THEME_KEY) || 'light';
    } catch (e) {}
    applyTheme(t === 'dark');
  }

  // ================================================================
  // 6) LOCAL CHAT STORAGE
  // ================================================================
  function chatStoreKey() {
    var u = (SESSION && SESSION.username) ? SESSION.username : 'guest';
    return 'bekarye-chat-sessions:' + u;
  }

  function legacyChatStoreKey() {
    var u = (SESSION && SESSION.username) ? SESSION.username : 'guest';
    return 'simontok-chat-sessions:' + u;
  }

  function compactSessionForStore(s) {
    var msgs = Array.isArray(s.messages) ? s.messages : [];
    if (msgs.length > MAX_MSG_PER_SESSION_STORE) msgs = msgs.slice(-MAX_MSG_PER_SESSION_STORE);

    msgs = msgs.map(function (m) {
      return {
        role: m.role || 'user',
        content: safeText(m.content || '', MAX_CHARS_PER_MSG_STORE),
        timestamp: m.timestamp || ''
      };
    });

    return {
      session_id: s.session_id,
      title: s.title || 'Percakapan Baru',
      messages: msgs,
      msg_count: msgs.length,
      updated_at: s.updated_at || nowISO()
    };
  }

  function readLocalSessions() {
    try {
      var key = chatStoreKey();
      var raw = localStorage.getItem(key);

      if (!raw) {
        var oldRaw = localStorage.getItem(legacyChatStoreKey());
        if (oldRaw) {
          localStorage.setItem(key, oldRaw);
          raw = oldRaw;
        }
      }

      if (!raw) return [];
      var arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch (e) {
      console.warn('[BEKARYE] readLocalSessions error:', e.message);
      return [];
    }
  }

  function writeLocalSessionsSafe(list) {
    var key = chatStoreKey();
    var work = sortByUpdatedDesc((list || []).map(compactSessionForStore));

    if (work.length > MAX_LOCAL_SESSIONS) work = work.slice(0, MAX_LOCAL_SESSIONS);

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

    try { localStorage.setItem(key, JSON.stringify([])); } catch (e2) {}
    return false;
  }

  function writeLocalSessions(list) {
    try { writeLocalSessionsSafe(list || []); }
    catch (e) { console.warn('[BEKARYE] writeLocalSessions error:', e.message); }
  }

  function ensureLocalSessionId() {
    if (!ACTIVE_SESSION) return '';
    if (!ACTIVE_SESSION.session_id) {
      ACTIVE_SESSION.session_id = 'sid_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    }
    return ACTIVE_SESSION.session_id;
  }

  function persistActiveSession() {
    if (!ACTIVE_SESSION) return;
    ensureLocalSessionId();
    ACTIVE_SESSION.updated_at = nowISO();

    var list = readLocalSessions();
    var id = ACTIVE_SESSION.session_id;
    var idx = list.findIndex(function (x) { return x.session_id === id; });

    if (idx >= 0) list[idx] = ACTIVE_SESSION;
    else list.unshift(ACTIVE_SESSION);

    writeLocalSessions(list);
  }

  // ================================================================
  // 7) CONTEXT
  // ================================================================
  function calcTaskStats(tasks) {
    var st = { total: 0, todo: 0, doing: 0, done: 0, blocked: 0 };
    (tasks || []).forEach(function (t) {
      st.total++;
      if (t.status === 'To Do') st.todo++;
      else if (t.status === 'D' || t.status === 'Doing') st.doing++;
      else if (t.status === 'Done') st.done++;
      else if (t.status === 'B' || t.status === 'Blocked') st.blocked++;
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
        console.warn('[BEKARYE] Context fallback empty:', err.message);
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

    var timeoutPromise = new Promise(function (resolve) {
      setTimeout(function () { resolve(null); }, timeoutMs);
    });

    return Promise.race([
      loadContext(false).catch(function () { return null; }),
      timeoutPromise
    ]);
  }

  // ================================================================
  // 8) AI
  // ================================================================
  function buildSystemPrompt() {
    var now = new Date();
    var nowText = now.toLocaleDateString('id-ID', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
    });

    var roleText = SESSION && SESSION.role === 'admin' ? 'Admin' : 'User';
    var userText = (SESSION && (SESSION.name || SESSION.username)) || 'User';

    var p =
      'Kamu adalah asisten pribadi BEKARYE yang profesional, proaktif, dan suportif.\n' +
      'User aktif: ' + userText + ' (' + roleText + ')\n' +
      'Tanggal hari ini: ' + nowText + '\n\n' +
      'ATURAN:\n' +
      '1. Jawaban proaktif dan bantu breakdown pekerjaan.\n' +
      '2. Gunakan data task/notulen di bawah sebagai sumber utama.\n' +
      '3. Jika user meminta buat task, sisipkan:\n' +
      '%%TASK_JSON%%{"title":"...","status":"To Do","priority":"High/Medium/Low","due_date":"YYYY-MM-DD","note":"..."}%%END_TASK%%\n' +
      '4. Jangan mengarang data.\n\n';

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
        'Jika belum ada task, sampaikan secara natural.\n\n';
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

  function friendlyError(code, msg) {
    var map = {
      400: '❌ Request tidak valid.',
      401: '🔑 API Key tidak valid / expired.',
      402: '💳 Saldo OpenRouter habis.',
      403: '🚫 Akses ditolak oleh OpenRouter.',
      404: '🤖 Model tidak ditemukan.',
      408: '⏳ Request timeout. Coba lagi.',
      409: '⚠️ Terjadi konflik request. Coba lagi.',
      413: '📦 Payload terlalu besar.',
      429: '⏳ Terlalu banyak request. Tunggu sebentar.',
      500: '🔧 Server OpenRouter bermasalah.',
      502: '🔧 Gateway error OpenRouter.',
      503: '🔧 OpenRouter maintenance.',
      504: '⏳ Gateway timeout dari OpenRouter.'
    };
    var c = parseInt(code, 10);
    return (map[c] || '❌ Error AI.') + ' Detail: ' + msg;
  }

  function callOpenRouter(apiKey, messages) {
    var start = Date.now();
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, 30000);

    return fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'application/json',
        'HTTP-Referer': window.location.origin || 'https://bekarye.app',
        'X-Title': 'BEKARYE Assistant'
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
              : ('HTTP ' + res.status + ' ' + res.statusText);
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
        if (!text) throw new Error('AI tidak menghasilkan teks. Coba lagi.');
        return { text: text, latencyMs: Date.now() - start };
      })
      .catch(function (err) {
        clearTimeout(timer);
        if (err && err.name === 'AbortError') {
          throw new Error('⏳ Timeout 30 detik. Coba lagi.');
        }
        throw err;
      });
  }

  function sendToAI(messagesForAI) {
    if (window.AI_CLIENT && typeof AI_CLIENT.sendChat === 'function') {
      return AI_CLIENT.sendChat(messagesForAI, {
        apiKey: getApiKey(),
        model: AI_MODEL
      });
    }

    var key = getApiKey();
    if (!key) return Promise.reject(new Error('API Key tidak tersedia.'));
    return callOpenRouter(key, messagesForAI);
  }

  function stripTaskJsonBlock(text) {
    return String(text || '').replace(/%%TASK_JSON%%[\s\S]*?%%END_TASK%%/g, '').trim();
  }

  function processAIResponse(text) {
    var m = String(text || '').match(/%%TASK_JSON%%([\s\S]*?)%%END_TASK%%/);
    if (!m) return;
    try {
      var taskData = JSON.parse(m[1].trim());
      setTimeout(function () { openTaskModal(taskData); }, 350);
    } catch (e) {
      console.warn('[BEKARYE] parse TASK JSON gagal:', e.message);
    }
  }

  // ================================================================
  // 9) CHAT UI
  // ================================================================
  function renderMessages() {
    var box = el('chatMessages');
    if (!box) return;

    var msgs = (ACTIVE_SESSION && Array.isArray(ACTIVE_SESSION.messages)) ? ACTIVE_SESSION.messages : [];
    box.innerHTML = '';

    if (!msgs.length) {
      box.innerHTML = '<div class="empty-chat">Mulai percakapan dengan mengetik pesan di bawah 👇</div>';
      return;
    }

    msgs.forEach(function (m) {
      var div = document.createElement('div');
      div.className = 'msg ' + (m.role === 'assistant' ? 'assistant' : 'user');

      var content = document.createElement('div');
      content.className = 'msg-content';
      content.innerHTML = nl2br(m.content || '');

      div.appendChild(content);
      box.appendChild(div);
    });

    box.scrollTop = box.scrollHeight;
  }

  function showTyping() {
    var box = el('chatMessages');
    if (!box) return;
    hideTyping();

    var div = document.createElement('div');
    div.id = 'typingIndicator';
    div.className = 'msg assistant';
    div.innerHTML = '<div class="msg-content">⏳ Assistant sedang mengetik...</div>';
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
  }

  function hideTyping() {
    var t = el('typingIndicator');
    if (t && t.parentNode) t.parentNode.removeChild(t);
  }

  function autoResizeInput() {
    var input = el('chatInput');
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 220) + 'px';
  }

  function renderSessionList() {
    var listEl = el('chatSessionList');
    if (!listEl) return;

    listEl.innerHTML = '';
    if (!SESSIONS_LIST.length) {
      listEl.innerHTML = '<div class="empty-sessions">Belum ada sesi</div>';
      return;
    }

    SESSIONS_LIST.forEach(function (s) {
      var btn = document.createElement('button');
      btn.className = 'session-item' + (ACTIVE_SESSION && ACTIVE_SESSION.session_id === s.session_id ? ' active' : '');
      btn.textContent = s.title || 'Percakapan Baru';
      btn.addEventListener('click', function () {
        openSessionById(s.session_id);
      });
      listEl.appendChild(btn);
    });
  }

  function loadSessions() {
    if (CHAT_STORAGE_MODE === 'local') {
      SESSIONS_LIST = readLocalSessions();
      SESSIONS_LIST = sortByUpdatedDesc(SESSIONS_LIST);
      renderSessionList();

      if (!ACTIVE_SESSION) {
        if (SESSIONS_LIST.length) ACTIVE_SESSION = SESSIONS_LIST[0];
        else startNewSession();
      }

      var titleEl = el('chatTitle');
      if (titleEl) titleEl.textContent = ACTIVE_SESSION.title || 'Percakapan Baru';

      renderMessages();
      return;
    }

    // Remote mode (optional)
    fetch(authURL('list-chat-sessions'), { redirect: 'follow' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || !j.ok || !Array.isArray(j.data)) throw new Error('Gagal load remote chat');
        SESSIONS_LIST = j.data;
        renderSessionList();
        if (!ACTIVE_SESSION) startNewSession();
        renderMessages();
      })
      .catch(function () {
        // fallback local
        SESSIONS_LIST = readLocalSessions();
        SESSIONS_LIST = sortByUpdatedDesc(SESSIONS_LIST);
        renderSessionList();
        if (!ACTIVE_SESSION) startNewSession();
        renderMessages();
      });
  }

  function startNewSession() {
    ACTIVE_SESSION = {
      session_id: 'sid_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
      title: 'Percakapan Baru',
      messages: [],
      updated_at: nowISO()
    };

    var titleEl = el('chatTitle');
    if (titleEl) titleEl.textContent = ACTIVE_SESSION.title;

    persistActiveSession();
    SESSIONS_LIST = sortByUpdatedDesc(readLocalSessions());
    renderSessionList();
    renderMessages();
  }

  function openSessionById(id) {
    var list = readLocalSessions();
    var found = list.find(function (x) { return x.session_id === id; });
    if (!found) return;

    ACTIVE_SESSION = found;
    var titleEl = el('chatTitle');
    if (titleEl) titleEl.textContent = ACTIVE_SESSION.title || 'Percakapan Baru';

    renderSessionList();
    renderMessages();
  }

  function saveSessionToSheet() {
    // selalu simpan local dulu
    persistActiveSession();
    SESSIONS_LIST = sortByUpdatedDesc(readLocalSessions());
    renderSessionList();

    if (CHAT_STORAGE_MODE !== 'remote') return Promise.resolve({ ok: true });

    // optional remote save
    return postAction('save-chat-session', {
      session_id: ACTIVE_SESSION.session_id,
      title: ACTIVE_SESSION.title || 'Percakapan Baru',
      messages: ACTIVE_SESSION.messages || []
    }).catch(function () {
      return { ok: false };
    });
  }

  // ================================================================
  // 10) TASK MODAL
  // ================================================================
  function openTaskModal(taskData) {
    PENDING_TASK = taskData || {};
    if (el('mTaskTitle')) el('mTaskTitle').value = PENDING_TASK.title || '';
    if (el('mTaskStatus')) el('mTaskStatus').value = PENDING_TASK.status || 'To Do';
    if (el('mTaskPriority')) el('mTaskPriority').value = PENDING_TASK.priority || 'Medium';
    if (el('mTaskDueDate')) el('mTaskDueDate').value = PENDING_TASK.due_date || '';
    if (el('mTaskNote')) el('mTaskNote').value = PENDING_TASK.note || '';
    if (el('taskModal')) el('taskModal').classList.add('active');
  }

  function closeTaskModal() {
    if (el('taskModal')) el('taskModal').classList.remove('active');
    PENDING_TASK = null;
  }

  function submitTaskModal() {
    var task = {
      title: (el('mTaskTitle') && el('mTaskTitle').value || '').trim(),
      status: (el('mTaskStatus') && el('mTaskStatus').value) || 'To Do',
      priority: (el('mTaskPriority') && el('mTaskPriority').value) || 'Medium',
      due_date: (el('mTaskDueDate') && el('mTaskDueDate').value) || '',
      note: (el('mTaskNote') && el('mTaskNote').value || '').trim()
    };

    if (!task.title) {
      alert('Judul task wajib diisi.');
      return;
    }

    var btn = el('taskModalConfirm');
    if (btn) {
      btn.disabled = true;
      btn.textContent = '⏳ Menyimpan...';
    }

    postAction('add', { task: task })
      .then(function () {
        if (btn) {
          btn.disabled = false;
          btn.textContent = '✅ Simpan Task';
        }
        closeTaskModal();

        ACTIVE_SESSION.messages.push({
          role: 'assistant',
          content:
            '✅ Task berhasil ditambahkan!\n\n' +
            '**' + task.title + '**\n' +
            '• Status: ' + task.status + '\n' +
            '• Prioritas: ' + task.priority + '\n' +
            '• Due Date: ' + (task.due_date || '(tidak ada)') + '\n' +
            '✅ Task berhasil disimpan!',
          timestamp: nowISO()
        });

        renderMessages();
        saveSessionToSheet();
        loadContext(true);
      })
      .catch(function (err) {
        if (btn) {
          btn.disabled = false;
          btn.textContent = '❌ Simpan Task';
        }
        alert('Error: ' + err.message);
      });
  }

  // ================================================================
  // 11) SEND MESSAGE
  // ================================================================
  function sendMessage(textOverride) {
    var input = el('chatInput');
    var content = textOverride || ((input && input.value) || '').trim();
    if (!content || IS_THINKING) return;

    var apiKey = (window.AI_CLIENT && AI_CLIENT.getApiKey) ? AI_CLIENT.getApiKey() : getApiKey();
    if (!apiKey) {
      alert('API Key tidak tersedia. Hubungi admin untuk mengisi API Key akun BEKARYE Anda.');
      return;
    }

    if (!ACTIVE_SESSION) startNewSession();
    if (!Array.isArray(ACTIVE_SESSION.messages)) ACTIVE_SESSION.messages = [];

    ACTIVE_SESSION.messages.push({
      role: 'user',
      content: content,
      timestamp: nowISO()
    });

    if (!textOverride && input) {
      input.value = '';
      autoResizeInput();
    }

    renderMessages();
    IS_THINKING = true;
    if (el('btnSend')) el('btnSend').disabled = true;
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
          if (el('btnSend')) el('btnSend').disabled = false;

          var aiTextRaw = (result && result.text) ? result.text : '';
          processAIResponse(aiTextRaw);
          var aiText = stripTaskJsonBlock(aiTextRaw) || '✅ Siap.';

          ACTIVE_SESSION.messages.push({
            role: 'assistant',
            content: aiText,
            timestamp: nowISO()
          });

          if (ACTIVE_SESSION.title === 'Percakapan Baru') {
            ACTIVE_SESSION.title = content.length > 45 ? content.substring(0, 45) + '...' : content;
            if (el('chatTitle')) el('chatTitle').textContent = ACTIVE_SESSION.title;
          }

          renderMessages();
          saveSessionToSheet();
        })
        .catch(function (err) {
          hideTyping();
          IS_THINKING = false;
          if (el('btnSend')) el('btnSend').disabled = false;

          ACTIVE_SESSION.messages.push({
            role: 'assistant',
            content: (err && err.message) ? err.message : '❌ Terjadi kesalahan. Silakan coba lagi.',
            timestamp: nowISO()
          });

          renderMessages();
          saveSessionToSheet();
        });
    });
  }

  // ================================================================
  // 12) UI STATUS
  // ================================================================
  function renderApiKeyStatus() {
    var dot = el('aiKeyDot');
    var msg = el('aiKeyMsg');
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
  // 13) APP START
  // ================================================================
  function onSessionReady() {
    var topbar = el('topbarUser');
    if (topbar) {
      topbar.textContent =
        '🤖 AI Assistant · ' +
        (SESSION.name || SESSION.username) +
        (SESSION.role === 'admin' ? ' — Admin' : ' — User');
    }

    if (window.AI_CLIENT && typeof AI_CLIENT.setApiKey === 'function') {
      AI_CLIENT.setApiKey(SESSION.apiKey || '');
    }

    var wt = el('welcomeTitle');
    if (wt) wt.textContent = 'Halo, ' + (SESSION.name || SESSION.username) + '! Ada yang bisa saya bantu?';

    if (el('loadingState')) el('loadingState').style.display = 'none';
    if (el('app')) el('app').style.display = '';

    var input = el('chatInput');
    var btnSend = el('btnSend');
    if (input) input.disabled = false;
    if (btnSend) btnSend.disabled = false;

    renderApiKeyStatus();
    loadContext(true);
    loadSessions();
  }

  function startApp() {
    migrateSessionAndTheme();
    initTheme();
    updateBrandLogos();
    initEventListeners();

    var s = getSession();
    if (!s || !s.token || !s.username) {
      window.location.replace('index.html');
      return;
    }

    fetch(API_URL + '?action=validate&user=' + encodeURIComponent(s.username) + '&token=' + encodeURIComponent(s.token), {
      redirect: 'follow'
    })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || !j.ok) {
          localStorage.removeItem(LEGACY_SESSION_KEY);
          window.location.replace('index.html');
          return;
        }

        SESSION = {
          username: (j.user && j.user.username) || s.username,
          name: (j.user && j.user.name) || s.name,
          role: (j.user && j.user.role) || s.role,
          sheet_name: (j.user && j.user.sheet_name) || s.sheet_name,
          token: s.token,
          apiKey: (j.user && j.user.apiKey) || s.apiKey || ''
        };

        localStorage.setItem(SESSION_KEY, JSON.stringify(SESSION));
        try { sessionStorage.setItem('bekarye-apikey', SESSION.apiKey || ''); } catch (e) {}
        try { localStorage.removeItem(LEGACY_SESSION_KEY); } catch (e2) {}

        onSessionReady();
      })
      .catch(function (err) {
        console.warn('[BEKARYE] Validasi offline:', err.message);

        SESSION = s;
        if (!SESSION || !SESSION.token) {
          window.location.replace('index.html');
          return;
        }

        onSessionReady();
      });
  }

  // ================================================================
  // 14) EVENTS
  // ================================================================
  function initEventListeners() {
    var darkToggle = el('darkToggle');
    if (darkToggle) {
      darkToggle.addEventListener('click', function () {
        var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
        applyTheme(!isDark);
      });
    }

    var settingsOpen = false;
    var settingsBtn = el('settingsBtn');
    var settingsDropdown = el('settingsDropdown');

    if (settingsBtn && settingsDropdown) {
      settingsBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        settingsOpen = !settingsOpen;
        settingsDropdown.classList.toggle('open', settingsOpen);
      });

      document.addEventListener('click', function (e) {
        if (!settingsOpen) return;
        if (!settingsDropdown.contains(e.target) && e.target !== settingsBtn) {
          settingsOpen = false;
          settingsDropdown.classList.remove('open');
        }
      });
    }

    var logoutBtn = el('logoutBtn');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', function () {
        if (!confirm('Yakin ingin logout?')) return;
        localStorage.removeItem('bekarye-session');
        localStorage.removeItem('simontok-session');
        localStorage.removeItem('bekarye-theme');
        localStorage.removeItem('simontok-theme');
        sessionStorage.removeItem('bekarye-apikey');
        sessionStorage.removeItem('simontok-apikey');
        window.location.href = 'index.html';
      });
    }

    var btnNewChat = el('btnNewChat');
    if (btnNewChat) btnNewChat.addEventListener('click', startNewSession);

    var btnRefresh = el('btnRefreshCtx');
    if (btnRefresh) {
      btnRefresh.addEventListener('click', function () {
        btnRefresh.disabled = true;
        btnRefresh.textContent = '⏳ Memuat...';
        loadContext(true).finally(function () {
          btnRefresh.disabled = false;
          btnRefresh.textContent = '🔄 Refresh Data';
        });
      });
    }

    Array.prototype.forEach.call(document.querySelectorAll('.qa-btn[data-prompt]'), function (btn) {
      btn.addEventListener('click', function () {
        sendMessage(btn.getAttribute('data-prompt'));
      });
    });

    var chatMessages = el('chatMessages');
    if (chatMessages) {
      chatMessages.addEventListener('click', function (e) {
        var tip = e.target.closest('.tip-item[data-prompt]');
        if (tip) sendMessage(tip.getAttribute('data-prompt'));
      });
    }

    var btnSend = el('btnSend');
    if (btnSend) btnSend.addEventListener('click', function () { sendMessage(); });

    var input = el('chatInput');
    if (input) {
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          sendMessage();
        }
      });
      input.addEventListener('input', autoResizeInput);
    }

    var taskModalClose = el('taskModalClose');
    if (taskModalClose) taskModalClose.addEventListener('click', closeTaskModal);

    var taskModal = el('taskModal');
    if (taskModal) {
      taskModal.addEventListener('click', function (e) {
        if (e.target === taskModal) closeTaskModal();
      });
    }

    var taskModalCancel = el('taskModalCancel');
    if (taskModalCancel) taskModalCancel.addEventListener('click', closeTaskModal);

    var taskModalConfirm = el('taskModalConfirm');
    if (taskModalConfirm) taskModalConfirm.addEventListener('click', submitTaskModal);
  }

  // ================================================================
  // 15) ENTRY
  // ================================================================
  window.onload = startApp;
})();
