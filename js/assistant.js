// ================================================================
// BEKARYE - Assistant JS
// File   : js/assistant.js
// Versi  : 1.7 (fixed: ID mismatch, logo path, markdown render, welcome UX)
// Depends: js/ai-client.js
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
  var CHAT_STORAGE_MODE = 'local';

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

  function nowISO() {
    return new Date().toISOString();
  }

  function timeStr() {
    var d = new Date();
    return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
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

  // FIX #4: Markdown formatter untuk AI bubble
  function formatAIMarkdown(text) {
    if (!text) return '';
    var s = esc(text);
    // code blocks
    s = s.replace(/```(\w*)\n?([\s\S]*?)```/g, function (m, lang, code) {
      return '<pre><code>' + code.trim() + '</code></pre>';
    });
    // bold
    s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    // italic
    s = s.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>');
    // inline code
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    // bullet lists
    s = s.replace(/^[\-\*]\s+(.+)$/gm, '~~LI~~$1~~ENDLI~~');
    s = s.replace(/(~~LI~~[\s\S]*?~~ENDLI~~\n?)+/g, function (block) {
      return '<ul>' + block.replace(/~~LI~~/g, '<li>').replace(/~~ENDLI~~/g, '</li>') + '</ul>';
    });
    // numbered lists
    s = s.replace(/^\d+\.\s+(.+)$/gm, '<li>$1</li>');
    // headings
    s = s.replace(/^####\s+(.+)$/gm, '<h4>$1</h4>');
    s = s.replace(/^###\s+(.+)$/gm, '<h4>$1</h4>');
    s = s.replace(/^##\s+(.+)$/gm, '<h3>$1</h3>');
    // hr
    s = s.replace(/^---$/gm, '<hr>');
    // line breaks (sisanya)
    s = s.replace(/\n/g, '<br>');
    return s;
  }

  // Toast notification
  function showToast(msg, duration) {
    var toast = el('appToast');
    if (!toast) return;
    toast.textContent = msg;
    toast.classList.add('show');
    clearTimeout(toast._tid);
    toast._tid = setTimeout(function () {
      toast.classList.remove('show');
    }, duration || 2800);
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
      localStorage.setItem(SESSION_KEY, JSON.stringify(s));
      return s;
    } catch (e) {
      return null;
    }
  }

  function getApiKey() {
    // Prioritas: AI_CLIENT > SESSION > sessionStorage
    if (window.AI_CLIENT && typeof AI_CLIENT.getApiKey === 'function') {
      var k = AI_CLIENT.getApiKey();
      if (k) return k;
    }
    var k2 = (SESSION && SESSION.apiKey) ? String(SESSION.apiKey).trim() : '';
    if (k2 && k2 !== 'undefined' && k2 !== 'null') return k2;
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
        catch (e) { throw new Error('Response bukan JSON: ' + String(text).substring(0, 180)); }
        if (!j.ok) throw new Error(j.message || 'Request gagal');
        return j;
      });
  }

  // ================================================================
  // 5) THEME
  // ================================================================
  // FIX #3: Logo path yang benar
  function updateBrandLogos() {
    var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    var logo = el('logoImage');
    if (logo) logo.src = isDark ? 'assets/logo/logo-dark.png' : 'assets/logo/logo-light.png';
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
    try { t = localStorage.getItem(THEME_KEY) || localStorage.getItem(LEGACY_THEME_KEY) || 'light'; } catch (e) {}
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
        if (oldRaw) { localStorage.setItem(key, oldRaw); raw = oldRaw; }
      }
      if (!raw) return [];
      var arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }

  function writeLocalSessionsSafe(list) {
    var key = chatStoreKey();
    var work = sortByUpdatedDesc((list || []).map(compactSessionForStore));
    if (work.length > MAX_LOCAL_SESSIONS) work = work.slice(0, MAX_LOCAL_SESSIONS);
    while (work.length > 0) {
      var raw = JSON.stringify(work);
      while (approxBytes(raw) > MAX_LOCAL_BYTES_SOFT && work.length > 1) {
        work.pop(); raw = JSON.stringify(work);
      }
      try { localStorage.setItem(key, raw); return true; }
      catch (e) { work.pop(); }
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
    var idx = -1;
    for (var i = 0; i < list.length; i++) {
      if (list[i].session_id === id) { idx = i; break; }
    }
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
    return { ok: true, tasks: tasks, notulen: [], task_stats: calcTaskStats(tasks), source: 'list-fallback' };
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
      .finally(function () { CONTEXT_STATE.loading = false; });

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
      '4. Jangan mengarang data.\n' +
      '5. Gunakan Markdown formatting: **bold**, *italic*, - bullet, 1. numbered list.\n\n';

    if (USER_CONTEXT && USER_CONTEXT.ok) {
      var st = USER_CONTEXT.task_stats || {};
      var tasks = USER_CONTEXT.tasks || [];
      var nts = USER_CONTEXT.notulen || [];

      p += '=== TASK STATS ===\n' +
        'Total=' + (st.total || 0) + ', To Do=' + (st.todo || 0) +
        ', Doing=' + (st.doing || 0) + ', Done=' + (st.done || 0) +
        ', Blocked=' + (st.blocked || 0) + '\n\n';

      if (tasks.length) {
        p += '=== LIST TASK ===\n';
        tasks.forEach(function (t, i) {
          p += (i + 1) + '. [' + (t.status || '-') + '] ' + (t.title || '-') +
            ' | Due: ' + (t.due_date || '-') + ' | Priority: ' + (t.priority || '-') +
            (t.note ? ' | Note: ' + String(t.note).substring(0, 80) : '') + '\n';
        });
        p += '\n';
      }

      if (nts.length) {
        p += '=== NOTULEN TERBARU ===\n';
        nts.forEach(function (n, i) {
          p += (i + 1) + '. ' + (n.kegiatan || '-') +
            ' | Tanggal: ' + (n.tanggal || '-') +
            ' | Tempat: ' + (n.tempat || '-') + '\n';
        });
        p += '\n';
      }
    } else {
      p += '=== DATA TASK USER ===\nBelum ada data task.\n\n';
    }

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

  function sendToAI(messagesForAI) {
    // Selalu gunakan AI_CLIENT jika tersedia
    if (window.AI_CLIENT && typeof AI_CLIENT.sendChat === 'function') {
      return AI_CLIENT.sendChat(messagesForAI, {
        apiKey: getApiKey(),
        model: AI_MODEL
      });
    }
    return Promise.reject(new Error('AI Client tidak tersedia. Pastikan ai-client.js sudah di-load.'));
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
  // 9) CHAT UI — FIX #4 & #5: Proper rendering
  // ================================================================
  function renderMessages() {
    var box = el('chatMessages');
    if (!box) return;

    var msgs = (ACTIVE_SESSION && Array.isArray(ACTIVE_SESSION.messages)) ? ACTIVE_SESSION.messages : [];

    // Manage welcome visibility
    var welcome = el('chatWelcome');

    if (!msgs.length) {
      if (welcome) welcome.style.display = 'flex';
      // Hapus bubble lama tapi pertahankan welcome
      var oldBubbles = box.querySelectorAll('.msg-row,.typing-row,.empty-chat');
      oldBubbles.forEach(function (b) { b.remove(); });
      return;
    }

    if (welcome) welcome.style.display = 'none';

    // Build HTML bubbles
    var userInitial = (SESSION && (SESSION.name || SESSION.username) || 'U').charAt(0).toUpperCase();
    var html = '';

    msgs.forEach(function (m) {
      var t = m.timestamp ? new Date(m.timestamp) : null;
      var tStr = t ? (('0' + t.getHours()).slice(-2) + ':' + ('0' + t.getMinutes()).slice(-2)) : '';

      if (m.role === 'user') {
        html +=
          '<div class="msg-row user">' +
            '<div class="msg-avatar user">' + userInitial + '</div>' +
            '<div class="msg-col">' +
              '<div class="msg-bubble user">' + esc(m.content) + '</div>' +
              '<div class="msg-time">' + tStr + '</div>' +
            '</div>' +
          '</div>';
      } else if (m.role === 'assistant') {
        html +=
          '<div class="msg-row">' +
            '<div class="msg-avatar ai">🤖</div>' +
            '<div class="msg-col">' +
              '<div class="msg-bubble ai">' + formatAIMarkdown(m.content) + '</div>' +
              '<div class="msg-time">' + tStr + '</div>' +
            '</div>' +
          '</div>';
      }
    });

    // Preserve welcome element, clear rest
    var welcomeHTML = welcome ? welcome.outerHTML : '';
    box.innerHTML = welcomeHTML + html;
    // Re-hide welcome since we have messages
    var newWelcome = el('chatWelcome');
    if (newWelcome) newWelcome.style.display = 'none';

    box.scrollTop = box.scrollHeight;
  }

  function showTyping() {
    var box = el('chatMessages');
    if (!box) return;
    hideTyping();
    var div = document.createElement('div');
    div.className = 'typing-row';
    div.id = 'typingIndicator';
    div.innerHTML =
      '<div class="msg-avatar ai">🤖</div>' +
      '<div class="typing-bubble">' +
        '<div class="typing-dot"></div>' +
        '<div class="typing-dot"></div>' +
        '<div class="typing-dot"></div>' +
      '</div>';
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

  // FIX #5: Render ke ID "sessionsList" (sesuai HTML)
  function renderSessionList() {
    var listEl = el('sessionsList');
    if (!listEl) return;

    if (!SESSIONS_LIST.length) {
      listEl.innerHTML = '<div class="sessions-empty">📭 Belum ada riwayat chat</div>';
      return;
    }

    var html = '';
    SESSIONS_LIST.forEach(function (s) {
      var isActive = ACTIVE_SESSION && ACTIVE_SESSION.session_id === s.session_id;
      var d = s.updated_at ? new Date(s.updated_at) : new Date(s.created_at || Date.now());
      var meta = ('0' + d.getDate()).slice(-2) + '/' + ('0' + (d.getMonth() + 1)).slice(-2) +
        ' ' + ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
      var msgCount = (s.messages && s.messages.length) || s.msg_count || 0;

      html +=
        '<div class="session-item' + (isActive ? ' active' : '') + '" data-sid="' + s.session_id + '" style="cursor:pointer">' +
          '<div style="font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding-right:24px">' +
            esc(s.title || 'Percakapan Baru') +
          '</div>' +
          '<div style="font-size:11px;color:var(--text4);margin-top:2px">' + meta + ' · ' + msgCount + ' pesan</div>' +
          '<button class="session-del-btn" data-del="' + s.session_id + '" title="Hapus" style="position:absolute;top:50%;right:8px;transform:translateY(-50%);width:22px;height:22px;border-radius:6px;background:transparent;border:none;color:var(--text4);font-size:13px;display:flex;align-items:center;justify-content:center;opacity:0;cursor:pointer">🗑</button>' +
        '</div>';
    });
    listEl.innerHTML = html;

    // Attach click listeners
    listEl.querySelectorAll('.session-item').forEach(function (item) {
      item.addEventListener('click', function (e) {
        if (e.target.closest('[data-del]')) return;
        var sid = item.getAttribute('data-sid');
        if (sid) openSessionById(sid);
      });
      // Show/hide delete btn on hover
      item.addEventListener('mouseenter', function () {
        var btn = item.querySelector('.session-del-btn');
        if (btn) btn.style.opacity = '1';
      });
      item.addEventListener('mouseleave', function () {
        var btn = item.querySelector('.session-del-btn');
        if (btn) btn.style.opacity = '0';
      });
    });

    listEl.querySelectorAll('[data-del]').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        deleteSession(btn.getAttribute('data-del'));
      });
    });
  }

  function deleteSession(sid) {
    if (!confirm('Hapus sesi chat ini?')) return;
    var list = readLocalSessions().filter(function (s) { return s.session_id !== sid; });
    writeLocalSessions(list);
    SESSIONS_LIST = sortByUpdatedDesc(list);

    if (ACTIVE_SESSION && ACTIVE_SESSION.session_id === sid) {
      ACTIVE_SESSION = SESSIONS_LIST.length ? SESSIONS_LIST[0] : null;
      if (!ACTIVE_SESSION) startNewSession();
    }
    renderSessionList();
    renderMessages();
    if (ACTIVE_SESSION) {
      var titleEl = el('chatTitle');
      if (titleEl) titleEl.textContent = ACTIVE_SESSION.title || 'AI Assistant';
    }
    showToast('🗑 Sesi chat dihapus');
  }

  function loadSessions() {
    SESSIONS_LIST = sortByUpdatedDesc(readLocalSessions());
    renderSessionList();

    if (!ACTIVE_SESSION) {
      if (SESSIONS_LIST.length) ACTIVE_SESSION = SESSIONS_LIST[0];
      else startNewSession();
    }

    var titleEl = el('chatTitle');
    if (titleEl && ACTIVE_SESSION) titleEl.textContent = ACTIVE_SESSION.title || 'Percakapan Baru';

    renderMessages();
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

    var input = el('chatInput');
    if (input) input.focus();
  }

  function openSessionById(id) {
    var list = readLocalSessions();
    var found = null;
    for (var i = 0; i < list.length; i++) {
      if (list[i].session_id === id) { found = list[i]; break; }
    }
    if (!found) return;
    ACTIVE_SESSION = found;
    var titleEl = el('chatTitle');
    if (titleEl) titleEl.textContent = ACTIVE_SESSION.title || 'Percakapan Baru';
    renderSessionList();
    renderMessages();
  }

  function saveSessionToSheet() {
    persistActiveSession();
    SESSIONS_LIST = sortByUpdatedDesc(readLocalSessions());
    renderSessionList();
    if (CHAT_STORAGE_MODE !== 'remote') return Promise.resolve({ ok: true });
    return postAction('save-chat-session', {
      session_id: ACTIVE_SESSION.session_id,
      title: ACTIVE_SESSION.title || 'Percakapan Baru',
      messages: ACTIVE_SESSION.messages || []
    }).catch(function () { return { ok: false }; });
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
      title: (el('mTaskTitle') ? el('mTaskTitle').value : '').trim(),
      status: (el('mTaskStatus') ? el('mTaskStatus').value : 'To Do'),
      priority: (el('mTaskPriority') ? el('mTaskPriority').value : 'Medium'),
      due_date: (el('mTaskDueDate') ? el('mTaskDueDate').value : ''),
      note: (el('mTaskNote') ? el('mTaskNote').value : '').trim()
    };
    if (!task.title) {
      showToast('⚠️ Judul task wajib diisi!');
      return;
    }
    var btn = el('taskModalConfirm');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Menyimpan...'; }

    postAction('add', { task: task })
      .then(function () {
        if (btn) { btn.disabled = false; btn.textContent = '✅ Simpan Task'; }
        closeTaskModal();
        ACTIVE_SESSION.messages.push({
          role: 'assistant',
          content: '✅ Task berhasil ditambahkan!\n\n**' + task.title + '**\n- Status: ' + task.status + '\n- Prioritas: ' + task.priority + '\n- Due Date: ' + (task.due_date || '(tidak ada)'),
          timestamp: nowISO()
        });
        renderMessages();
        saveSessionToSheet();
        loadContext(true);
        showToast('✅ Task berhasil disimpan!');
      })
      .catch(function (err) {
        if (btn) { btn.disabled = false; btn.textContent = '✅ Simpan Task'; }
        showToast('❌ Error: ' + err.message);
      });
  }

  // ================================================================
  // 11) SEND MESSAGE
  // ================================================================
  function sendMessage(textOverride) {
    var input = el('chatInput');
    var content = textOverride || ((input && input.value) || '').trim();
    if (!content || IS_THINKING) return;

    var apiKey = getApiKey();
    if (!apiKey) {
      showToast('⚠️ API Key tidak tersedia. Hubungi admin.');
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
    if (input) input.disabled = true;
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
          if (el('chatInput')) el('chatInput').disabled = false;

          var aiTextRaw = (result && result.text) ? result.text : '';
          processAIResponse(aiTextRaw);
          var aiText = stripTaskJsonBlock(aiTextRaw) || '✅ Siap.';

          ACTIVE_SESSION.messages.push({
            role: 'assistant',
            content: aiText,
            timestamp: nowISO()
          });

          // Update title dari pesan pertama
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
          if (el('chatInput')) el('chatInput').disabled = false;

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

    var key = getApiKey();
    if (!key) {
      dot.className = 'ai-key-dot err';
      msg.textContent = '⚠️ API Key tidak tersedia untuk akun ini. Hubungi admin.';
    } else {
      dot.className = 'ai-key-dot ok';
      msg.textContent = '✅ AI aktif · Model: ' + AI_MODEL + ' · ' + (SESSION.name || SESSION.username);
    }
  }

  // ================================================================
  // 13) APP START
  // ================================================================
  function onSessionReady() {
    var topbar = el('topbarUser');
    if (topbar) {
      topbar.textContent = '🤖 AI Assistant · ' +
        (SESSION.name || SESSION.username) +
        (SESSION.role === 'admin' ? ' — Admin' : ' — User');
    }

    // Sync API key ke AI_CLIENT
    if (window.AI_CLIENT && typeof AI_CLIENT.setApiKey === 'function') {
      AI_CLIENT.setApiKey(SESSION.apiKey || '');
    }

    var wt = el('welcomeTitle');
    if (wt) wt.textContent = 'Halo, ' + (SESSION.name || SESSION.username) + '! 👋';

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
        console.warn('[BEKARYE] Validasi offline, lanjut dengan session lokal:', err.message);
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
    // Dark toggle
    var darkToggle = el('darkToggle');
    if (darkToggle) {
      darkToggle.addEventListener('click', function () {
        var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
        applyTheme(!isDark);
      });
    }

    // Settings dropdown — variabel lokal di dalam closure
    var settingsOpen = false;
    var settingsBtn = el('settingsBtn');
    var settingsDropdown = el('settingsDropdown');

    if (settingsBtn && settingsDropdown) {
      settingsBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        settingsOpen = !settingsOpen;
        settingsDropdown.classList.toggle('open', settingsOpen);
      });

      settingsDropdown.addEventListener('click', function (e) {
        e.stopPropagation();
      });

      document.addEventListener('click', function (e) {
        if (!settingsOpen) return;
        if (!settingsDropdown.contains(e.target) && e.target !== settingsBtn) {
          settingsOpen = false;
          settingsDropdown.classList.remove('open');
        }
      });
    }

    // Logout
    var logoutBtn = el('logoutBtn');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', function () {
        if (!confirm('Yakin ingin logout?')) return;
        localStorage.removeItem(SESSION_KEY);
        localStorage.removeItem(LEGACY_SESSION_KEY);
        sessionStorage.removeItem('bekarye-apikey');
        window.location.href = 'index.html';
      });
    }

    // New chat
    var btnNewChat = el('btnNewChat');
    if (btnNewChat) btnNewChat.addEventListener('click', startNewSession);

    // Refresh context
    var btnRefresh = el('btnRefreshCtx');
    if (btnRefresh) {
      btnRefresh.addEventListener('click', function () {
        btnRefresh.disabled = true;
        btnRefresh.textContent = '⏳ Memuat...';
        loadContext(true).finally(function () {
          btnRefresh.disabled = false;
          btnRefresh.textContent = '🔄 Refresh Data';
          var taskCount = (USER_CONTEXT && USER_CONTEXT.tasks) ? USER_CONTEXT.tasks.length : 0;
          showToast('✅ Data diperbarui (' + taskCount + ' task)');
        });
      });
    }

    // Quick action buttons
    Array.prototype.forEach.call(document.querySelectorAll('.qa-btn[data-prompt]'), function (btn) {
      btn.addEventListener('click', function () {
        sendMessage(btn.getAttribute('data-prompt'));
      });
    });

    // Welcome tips
    var chatMessages = el('chatMessages');
    if (chatMessages) {
      chatMessages.addEventListener('click', function (e) {
        var tip = e.target.closest('.tip-item[data-prompt]');
        if (tip) sendMessage(tip.getAttribute('data-prompt'));
      });
    }

    // Send button
    var btnSend = el('btnSend');
    if (btnSend) btnSend.addEventListener('click', function () { sendMessage(); });

    // Input
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

    // Task modal
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
  // 15) ENTRY POINT
  // ================================================================
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startApp);
  } else {
    startApp();
  }

})();
