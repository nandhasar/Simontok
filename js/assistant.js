// ================================================================
// BEKARYE - Assistant JS
// File   : js/assistant.js
// Versi  : 1.5 (local chat storage + auto prune + AI context cap + session migration)
// Depends: js/ai-client.js (opsional; ada fallback callOpenRouter)
// ================================================================

// ================================================================
// 1) CONFIG
// ================================================================
var API_URL     = 'https://script.google.com/macros/s/AKfycbwLLIv2AH5v4FiYImDN2-u5WhxAYvsTXq1ZUqdRUWqBM0K6pBuI3q_ZQn3_eFIii2bU/exec';
var SESSION_KEY = 'bekarye-session'; // ⬅️ BEKARYE session key
var SESSION     = null;
var AI_MODEL    = 'anthropic/claude-haiku-4.5';

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
    // ⬇️ BEKARYE session dengan fallback ke simontok-session
    var s = localStorage.getItem('bekarye-session');
    if (!s) {
      // Fallback ke simontok-session jika bekarye-session tidak ada
      s = localStorage.getItem('simontok-session');
      if (s) {
        // Migrasi session dari simontok ke bekarye
        localStorage.setItem('bekarye-session', s);
        console.log('✅ Session berhasil dimigrasi dari SIMONTOK ke BEKARYE');
      }
    }
    return s ? JSON.parse(s) : null;
  } catch(e) {
    return null;
  }
}

function getApiKey() {
  // ⬇️ BEKARYE API Key dengan fallback ke simontok-session
  var k = (SESSION && SESSION.apiKey) ? String(SESSION.apiKey) : '';
  if (!k || k === 'undefined' || k === 'null') return '';
  
  // Fallback ke simontok-session jika bekarye-session tidak ada
  if (!k) {
    var oldSession = localStorage.getItem('simontok-session');
    if (oldSession) {
      try {
        var obj = JSON.parse(oldSession);
        k = String(obj && obj.apiKey || '');
        if (k) {
          console.log('✅ API Key berhasil dimigrasi dari SIMONTOK ke BEKARYE');
        // Update session ke bekarye-session
        localStorage.setItem('bekarye-session', oldSession);
        // Hapus session lama
        localStorage.removeItem('simontok-session');
        // Update SESSION variable
        if (SESSION && SESSION.apiKey !== k) {
          SESSION.apiKey = k;
        }
      }
    } catch(e) {
      console.error('Error migrasi API Key:', e);
    }
  }
  return k.trim();
}

function authURL(action, extra) {
  return API_URL
    + '?action=' + encodeURIComponent(action)
    + '&user='   + encodeURIComponent(SESSION.username)
    + '&token='  + encodeURIComponent(SESSION.token)
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
  return 'bekarye-chat-sessions:' + u; // ⬇️ BEKARYE session key
}

function readLocalSessions() {
  try {
    // ⬇️ BEKARYE session dengan fallback ke simontok-session
    var raw = localStorage.getItem('bekarye-chat-sessions');
    if (!raw) {
      // Fallback ke simontok-chat-sessions jika bekarye-chat-sessions tidak ada
      var oldRaw = localStorage.getItem('simontok-chat-sessions');
      if (oldRaw) {
        var arr = JSON.parse(oldRaw);
        if (Array.isArray(arr)) {
          // Migrasi session dan update key ke bekarye-chat-sessions
          localStorage.setItem('bekarye-chat-sessions', oldRaw);
          console.log('✅ Chat sessions berhasil dimigrasi dari SIMONTOK ke BEKARYE');
          console.log('Session count:', arr.length);
        }
      }
      raw = localStorage.getItem('bekarye-chat-sessions');
      return raw ? JSON.parse(raw) : [];
    }
    return arr;
  } catch (e) {
    console.error('[BEKARYE] readLocalSessions error:', e.message);
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
    msgs = msgs.slice(-MAX_MSG_PER_SESSION_STORE);
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
    title: s.title || 'Percakapan Baru',
    msg_count: (s.messages || []).length,
    updated_at: s.updated_at || ''
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
    console.warn('[BEKARYE] writeLocalSessions error:', e.message);
  }
}

function ensureLocalSessionId() {
  if (!ACTIVE_SESSION) return '';
  if (!ACTIVE_SESSION.session_id) {
    ACTIVE_SESSION.session_id = 'sid_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  }
  return ACTIVE_SESSION.session_id;
}

// ============================================================
// 4. THEME PRELOAD
// ================================================================
(function () {
  // ⬇️ BEKARYE theme dengan fallback ke simontok-theme
  var t = localStorage.getItem('bekarye-theme');
  if (!t) {
    var oldTheme = localStorage.getItem('simontok-theme');
    if (oldTheme) {
      localStorage.setItem('bekarye-theme', oldTheme);
      console.log('✅ Theme berhasil dimigrasi dari SIMONTOK ke BEKARYE');
    }
  }
  var isDark = t === 'dark';
  if (isDark) document.documentElement.setAttribute('data-theme', 'dark');
  else document.documentElement.removeAttribute('data-theme');
  document.getElementById('darkToggle').classList.toggle('on', isDark);
  document.getElementById('logoImage') {
    var logoPath = isDark ? 'assets/logo/logo-dark.png' : 'assets/logo-light.png';
    document.getElementById('logoImage').src = logoPath;
  }
  if (document.getElementById('brandLogo')) {
    document.getElementById('brandLogo').textContent = 'BEKARYE';
  }
  document.getElementById('logoImage').src = logoPath;
  }
  // Update logo di assistant.js juga
  var assistantLogo = document.getElementById('logoImage');
  if (assistantLogo) {
    assistantLogo.src = logoPath;
  }

  var brandLogo = document.getElementById('brandLogo');
  if (brandLogo) {
    brandLogo.textContent = 'BEKARYE';
  }
  var darkToggle = document.getElementById('darkToggle');
  if (darkToggle) darkToggle.classList.toggle('on', isDark);
})();

// ============================================================
// 5. STATE
// ============================================================
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

// ============================================================
// 6. START APP
// ============================================================
function startApp() {
  // ⬇️ Logo BEKARYE dengan automatic theme switching
  updateBrandLogos();
  
  initTheme();
  initEventListeners();

  var s = getSession();
  if (!s || !s.token || !s.username) {
    window.location.replace('index.html');
    return;
  }

  fetch(API_URL + '?action=validate&user=' + encodeURIComponent(s.username) + '&token=' + encodeURIComponent(s.token), { redirect: 'follow' })
    .then(function (r) { return r.json(); })
    .then(function (j) {
      if (!j.ok) {
        // ⬇️ Hapus simontok-session jika gagal validasi
        localStorage.removeItem('simontok-session');
        window.location.replace('index.html');
        return;
      }

      // ⬇️ Set BEKARYE session
      SESSION = {
        username: j.user.username   || s.username,
        name:     j.user.name       || s.name,
        role:     j.user.role       || s.role,
        sheet_name:j.user.sheet_name || s.sheet_name,
        token:    s.token,
        apiKey:   j.user.apiKey     || s.apiKey || ''
      };

      // ⬇️ Update local storage ke bekarye-session
      localStorage.setItem('bekarye-session', JSON.stringify(SESSION));
      
      // ⬇️ Update sessionStorage untuk API key
      try { sessionStorage.setItem('bekarye-apikey', SESSION.apiKey || ''); } catch (e) {}
      // Hapus session lama
      try { localStorage.removeItem('simontok-session'); } catch (e) {}

      // ⬇️ Update logo di semua file
      updateBrandLogos();
      
      if (window.AI_CLIENT && typeof AI_CLIENT.setApiKey === 'function') {
        AI_CLIENT.setApiKey(SESSION.apiKey || '');
      }

      onSessionReady();
    })
    .catch(function (err) {
      console.warn('[BEKARYE] Validasi offline:', err.message);
      // ⬇️ Update BEKARYE branding jika terjadi error validasi
      updateBrandLogos();
      
      if (!SESSION || !SESSION.token) {
        window.location.replace('index.html');
        return;
      }
      
      // Update logo di dashboard
      if (window.location.pathname.includes('dashboard.html')) {
        var dbLogo = document.getElementById('logoImage');
        if (dbLogo) dbLogo.src = document.documentElement.getAttribute('data-theme') === 'dark' ? 
          'assets/logo/logo-dark.png' : 'assets/logo-light.png');
      }
      
      SESSION = s || {};
      try { sessionStorage.setItem('bekarye-session', JSON.stringify(SESSION)); } catch (e) {}
      
      onSessionReady();
    });
}

function onSessionReady() {
  var topbar = document.getElementById('topbarUser');
  if (topbar) {
    topbar.textContent =
      '🤖 AI Assistant · ' +
      (SESSION.name || SESSION.username) +
      (SESSION.role === 'admin' ? ' — Admin' : ' — User');
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

// ============================================================
// 7. API KEY STATUS
// ============================================================
function renderApiKeyStatus() {
  var dot = document.getElementById('aiKeyDot');
  var msg = document.getElementById('aiKeyMsg');
  if (!dot || !msg) return;

  // ⬇️ BEKARYE API Key dengan fallback
  var key = (window.AI_CLIENT && AI_CLIENT.getApiKey)
    ? AI_CLIENT.getApiKey()
    : getApiKey();
  
  if (!key) {
    dot.className = 'ai-key-dot err';
    msg.textContent = '⚠️ API Key tidak tersedia untuk akun ini. Hubungi admin untuk mengisi API Key akun BEKARYE.';
  } else {
    dot.className = 'ai-key-dot ok';
    msg.textContent = '✅ API Key aktif · Login sebagai ' + (SESSION.name || SESSION.username || 'User');
  }
}

// ============================================================
// 8. CONTEXT HELPERS
// ============================================================
function calcTaskStats(tasks) {
  var st = { total: 0, todo: 0, doing: 0, 0, blocked: 0 };
  (tasks || []).forEach(function (t) {
    st.total++;
    if (t.status === 'To Do') st.todo++;
    else if (t.status === 'D' || t.status === 'Doing') st.doing++;
    else if (t.status === 'Done') st.done++;
    else if (t.status === 'B') st.blocked++;
  });
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

// ============================================================
// 10. CONTEXT LOADER
// ============================================================
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

  if (typeof loadContext !== 'function') return Promise.resolve(null);

  var timeoutPromise = new Promise(function (resolve) {
    setTimeout(function () { resolve(null); }, timeoutMs);
  });

  return Promise.race([
    loadContext(false).catch(function () { return null; }),
    timeoutPromise
  ]);
}

// ============================================================
// 11. SYSTEM PROMPT + AI CONTEXT BUILDER
// ============================================================
function buildSystemPrompt() {
  var now = new Date();
  var nowText = now.toLocaleDateString('id-ID', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
  });

  var p =
    'Kamu adalah ' + (SESSION.name || SESSION.username) + ', assisten pribadi pengatur jadwal usermu yang sangat pintar, periang, bisa membangkitkan semangat dan profesional.\n' +
    'User aktif: ' + (SESSION.name || SESSION.username) + (SESSION.role === 'admin' ? ' (SESSION.role === 'admin' ? 'Admin' : 'User') + ')\n' +
    'Tanggal hari ini: ' + nowText + '\n\n' +
    'ATURAN:\n' +
    '1. Jawaban yang proaktif (memebri pendapat, jangan pasif seperti ai biasa) dan bisa menjadi teman diskusi untuk menyelesaikan dan membreakdown pekerjaan.\n' +
    '2. Gunakan data task/notulen di bawah sebagai sumber utama dan internet apabila diperlukan.\n' +
    '3. Jika user meminta buat task, WAJIBAN sisipkan:\n' +
    '   %%TASK_JSON%%{"title":"...","status":"To Do","priority":"High/Medium/Low","due_date":"YYYY-MM-DD","note":"..."}%%END_TASK%%\n' +
    '4. Jangan mengarang data yang tidak ada.\n\n';

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
      p += '=== LIST TASK ===\n' +
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
      p += '=== NOTULEN TERBARU ===\n' +
        nts.forEach(function (n, i) {
          p += (i + 1) + '. ' + (n.kegiatan || '-') +
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

function sendToAI(messagesForAI(messages) {
  if (window.AI_CLIENT && typeof AI_CLIENT.sendChat === 'function') {
    return AI_CLIENT.sendChat(messagesForAI, {
      apiKey: (SESSION && SESSION.apiKey) || '',
      model: AI_MODEL
    });
  }

  var key = getApiKey();
  return callOpenRouter(key, messagesForAI);
}

// ============================================================
// 14. SEND MESSAGE
// ============================================================
function sendMessage(textOverride) {
  var input = document.getElementById('chatInput');
  var content = textOverride || (input.value || '').trim();
  if (!content || IS_THINKING) return;

  var apiKey = (window.AI_CLIENT && AI_CLIENT.getApiKey)
    ? AI_CLIENT.getApiKey()
    : getApiKey();

  if (!apiKey) {
    alert('API Key tidak tersedia. Hubungi admin untuk mengisi API Key akun BEKARYE Anda.');
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
          content: err.message || '❌ Terjadi kesalahan. Silakan coba lagi.'
        });
        renderMessages();
        saveSessionToSheet();
      });
  });
}

// ============================================================
// 15. OPENROUTER FALLBACK
// ============================================================
function callOpenRouter(apiKey, messages) {
  var start = Date.now();
  var controller = new AbortController();
  var timer = setTimeout(function () { controller.abort(); }, 30000);

  return fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + apiKey,
      'Content-Type: 'application/json',
      'HTTP-735ed; border-radius: 14px; border: 2px solid var(--border);
      color: var(--text);
      transition: background .3s;
      padding: 16px 20px;
      font-family: -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
      display: flex;
      align-items: center;
      margin-bottom: 20px;
      box-shadow: var(--shadow2);
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
      if (!data || !data.choices || !data.choices || !data.choices.length) {
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
      if (err.name === 'AbortError') {
        new Error('⏳ Timeout 30 detik. Coba lagi.');
      }
      throw err;
    });
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
  return (map[c] || '❌ Error AI.') + ' Detail: ' + msg);
}

function processAIResponse(text) {
  var m = String(text || '').match(/%%TASK_JSON%%([\s\S]*?%%END_TASK%%/);
  if (!m) return;
  try {
    var taskData = JSON.parse(m[1].trim());
    setTimeout(function () { openTaskModal(taskData); }, 350);
  } catch(e) {
    console.warn('[BEKARYE] parse TASK JSON gagal:', e.message);
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

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function submitTaskModal() {
  var task = {
    title   : document.getElementById('mTaskTitle').value.trim(),
    status : document.getElementById('mTaskStatus').value || 'To Do',
    priority: document.getElementById('mTaskPriority').value || 'Medium',
    due_date: document.getElementById('mTaskDueDate').value || '',
    note    : document.getElementById('mTaskNote').value.trim()
  };

  if (!task.title) {
    alert('Judul task wajib diisi.');
    return;
  }

  var btn = document.getElementById('taskModalConfirm');
  btn.disabled = true;
  btn.textContent = '⏳ Menyimpan...';

  postAction('add', { task: task })
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
          '• Due Date: ' + (task.due_date || '(tidak ada)') + '\n' +
          '✅ Task berhasil disimpan!'
      timestamp: new Date().toISOString()
      });

      renderMessages();
      saveSessionToSheet();
      loadContext(true);
    })
    .catch(function (err) {
      btn.disabled = false;
      btn.textContent = '❌ Simpan Task';
      alert('Error: ' + err.message);
    });
}

// ============================================================
//  // EVENT LISTENERS
// ============================================================
function initEventListeners() {
  document.getElementById('darkToggle').addEventListener('click', function () {
    var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    applyTheme(isDark);
  });

  var settingsOpen = false;
  document.getElementById('settingsBtn').addEventListener('click', function (e) {
    e.stopPropagation();
    settingsOpen = !settingsOpen;
    document.getElementById('settingsDropdown').classList.toggle('open', settingsOpen);
  });

  document.addEventListener('click', function (e) {
    if (settingsOpen && !document.getElementById('settingsDropdown').contains(e.target)
        && e.target !== document.getElementById('settingsBtn')) {
      settingsOpen = false;
      document.getElementById('settingsDropdown').classList.remove('open');
    }
  });

  document.getElementById('logoutBtn').addEventListener('click', function () {
    if (!confirm('Yakin ingin logout?')) return;
    // ⬇️ Hapus kedua session
    localStorage.removeItem('bekarye-session');
    localStorage.removeItem('simontok-session');
    localStorage.removeItem('simontok-theme');
    localStorage.removeItem('bekarye-theme');
    sessionStorage.removeItem('bekarye-apikey');
    sessionStorage.removeItem('simontok-apikey');
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
  document.getElementById('taskModal').addEventListener('click', function(e) {
    if (e.target === this) closeTaskModal();
  });
  document.getElementById('taskModalCancel').addEventListener('click', closeTaskModal);
  document.getElementById('taskModalConfirm').addEventListener('click', submitTaskModal);
}

// ============================================================
//  // 2. ENTRY
// ============================================================
window.onload = startApp;
