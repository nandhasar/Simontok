// ================================================================
// SIMONTOK - Assistant JS
// File   : js/assistant.js
// Versi  : 1.1
// Depends: js/ai-client.js (AI_CLIENT harus di-load duluan)
// Pola   : sama persis dengan notulen.html (validate token dulu)
// ================================================================

// ================================================================
// 1. CONFIG
// ================================================================
var API_URL     = 'https://script.google.com/macros/s/AKfycbwLLIv2AH5v4FiYImDN2-u5WhxAYvsTXq1ZUqdRUWqBM0K6pBuI3q_ZQn3_eFIii2bU/exec';
var SESSION_KEY = 'simontok-session';
var SESSION     = null;
var AI_MODEL    = 'google/gemma-4-31b-it';

// ================================================================
// 2. SESSION HELPERS
// ================================================================
function getSession() {
  try {
    var raw = localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

function getApiKey() {
  return (SESSION && SESSION.apiKey) ? SESSION.apiKey : null;
}

function authURL(action, extra) {
  return API_URL
    + '?action=' + encodeURIComponent(action)
    + '&user='   + encodeURIComponent(SESSION.username)
    + '&token='  + encodeURIComponent(SESSION.token)
    + (extra || '');
}

// ================================================================
// 3. THEME — jalan sebelum startApp, tidak butuh SESSION
// ================================================================
(function () {
  var t = localStorage.getItem('simontok-theme');
  if (t === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
})();

// ================================================================
// 4. STATE
// ================================================================
var USER_CONTEXT   = null;
var SESSIONS_LIST  = [];
var ACTIVE_SESSION = null;
var IS_THINKING    = false;

// ================================================================
// 5. startApp — PINTU MASUK UTAMA
//    Dipanggil window.onload.
//    Semua fungsi yang butuh SESSION dipanggil dari sini.
// ================================================================
function startApp() {

  // -- UI yang tidak butuh SESSION --
  initThemeButton();
  initEventListeners();

  // -- Cek session lokal dulu --
  var s = getSession();
  if (!s || !s.token || !s.username) {
    window.location.replace('index.html');
    return;
  }

  // -- Validasi token ke server --
  fetch(
    API_URL +
    '?action=validate' +
    '&user='  + encodeURIComponent(s.username) +
    '&token=' + encodeURIComponent(s.token)
  )
    .then(function (r) { return r.json(); })
    .then(function (j) {
      if (j.ok) {
        // Token valid — isi SESSION global dari server (apiKey ada di sini)
        SESSION = {
          username:   j.user.username   || s.username,
          name:       j.user.name       || s.name,
          role:       j.user.role       || s.role,
          sheet_name: j.user.sheet_name || s.sheet_name,
          token:      s.token,
          apiKey:     j.user.apiKey     || s.apiKey   // ← kunci utama
        };
        // Perbarui localStorage agar apiKey tersimpan lokal juga
        localStorage.setItem(SESSION_KEY, JSON.stringify(SESSION));
        onSessionReady(); // lanjut init semua fitur
      } else {
        localStorage.removeItem(SESSION_KEY);
        window.location.replace('index.html');
      }
    })
    .catch(function (err) {
      // Offline / gagal koneksi — pakai data lokal
      console.warn('[SIMONTOK] Validasi offline:', err.message);
      SESSION = s;
      onSessionReady();
    });
}

// ================================================================
// 6. onSessionReady — dipanggil SETELAH SESSION pasti terisi
//    Semua fungsi yang butuh apiKey / username ada di sini
// ================================================================
function onSessionReady() {
  // Topbar info
  var topbar = document.getElementById('topbarUser');
  if (topbar) {
    topbar.textContent =
      '🤖 AI Assistant · ' +
      (SESSION.name || SESSION.username) +
      (SESSION.role === 'admin' ? ' — Admin' : '');
  }

  // Welcome title
  var wt = document.getElementById('welcomeTitle');
  if (wt) {
    wt.textContent =
      'Halo, ' + (SESSION.name || SESSION.username) + '! Ada yang bisa saya bantu?';
  }

  // Tampilkan app, sembunyikan loading
  document.getElementById('loadingState').style.display = 'none';
  document.getElementById('app').style.display          = '';

  // Render status API key — baru bisa akurat setelah SESSION.apiKey terisi
  renderApiKeyStatus();

  // Load data
  loadContext();
  loadSessions();
}

// ================================================================
// 7. RENDER API KEY STATUS
//    Hanya dipanggil setelah SESSION terisi (dari onSessionReady)
// ================================================================
function renderApiKeyStatus() {
  var dot = document.getElementById('aiKeyDot');
  var msg = document.getElementById('aiKeyMsg');
  if (!dot || !msg) return;

  var key = getApiKey();
  if (!key || key === 'undefined' || key === 'null' || key.trim() === '') {
    dot.className   = 'ai-key-dot err';
    msg.textContent = '⚠️ API Key tidak tersedia untuk akun ini. Hubungi admin.';
  } else {
    dot.className   = 'ai-key-dot ok';
    msg.textContent = '✅ API Key aktif · Login sebagai '
      + (SESSION.name || SESSION.username || 'User');
  }
}

// ================================================================
// 8. INIT THEME BUTTON
// ================================================================
function initThemeButton() {
  // Sinkronkan tombol toggle dengan tema saat ini
  var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  var toggle = document.getElementById('darkToggle');
  if (toggle) toggle.classList.toggle('on', isDark);
}

function applyTheme(isDark) {
  if (isDark) {
    document.documentElement.setAttribute('data-theme', 'dark');
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
  var toggle = document.getElementById('darkToggle');
  if (toggle) toggle.classList.toggle('on', isDark);
  localStorage.setItem('simontok-theme', isDark ? 'dark' : 'light');
}

// ================================================================
// 9. LOAD CONTEXT — task + notulen dari GAS
// ================================================================
function loadContext() {
  fetch(authURL('get-context'), { redirect: 'follow' })
    .then(function (r) { return r.json(); })
    .then(function (j) {
      if (j.ok) {
        USER_CONTEXT = j;
        console.info('[SIMONTOK] Context loaded — tasks:', j.task_stats);
      } else {
        console.warn('[SIMONTOK] Context error:', j.message || j.error);
      }
    })
    .catch(function (err) {
      console.warn('[SIMONTOK] Context fetch failed:', err.message);
    });
}

// ================================================================
// 10. BUILD SYSTEM PROMPT
// ================================================================
function buildSystemPrompt() {
  var today    = new Date();
  var todayStr = today.toLocaleDateString('id-ID', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });

  var prompt =
    'Kamu adalah AI Assistant bernama SIMONTOK Assistant.\n' +
    'Sistem: SIMONTOK — Sistem Monitoring Organisasi Kerja BAPENDA Lombok Tengah.\n' +
    'Berbicara dengan: ' + (SESSION.name || SESSION.username) +
      ' (role: ' + (SESSION.role || 'user') + ').\n' +
    'Tanggal hari ini: ' + todayStr + '.\n\n' +

    'TUGASMU:\n' +
    '1. Jawab pertanyaan tentang jadwal dan task berdasarkan DATA NYATA di bawah.\n' +
    '2. Bantu buat task baru jika diminta — WAJIB sertakan JSON khusus.\n' +
    '3. Berikan ringkasan progress, analisis deadline, dan saran prioritas.\n' +
    '4. Gunakan Bahasa Indonesia yang profesional dan ramah.\n\n' +

    'ATURAN BUAT TASK:\n' +
    '- Jika user meminta membuat task, WAJIB sisipkan blok ini di respons:\n' +
    '  %%TASK_JSON%%{"title":"...","status":"To Do","priority":"High/Medium/Low",' +
      '"due_date":"YYYY-MM-DD","note":"..."}%%END_TASK%%\n' +
    '- Jika due_date tidak disebutkan, kosongi saja ("").\n' +
    '- Jangan mengarang data task yang tidak ada.\n\n';

  if (USER_CONTEXT && USER_CONTEXT.ok) {
    var st = USER_CONTEXT.task_stats || {};
    prompt +=
      '=== DATA TASK USER (' + (USER_CONTEXT.tasks || []).length + ' total) ===\n' +
      'Statistik: Total=' + st.total +
        ', To Do=' + st.todo +
        ', Doing=' + st.doing +
        ', Done=' + st.done +
        ', Blocked=' + st.blocked + '\n\n';

    var tasks = USER_CONTEXT.tasks || [];
    if (tasks.length) {
      prompt += 'DAFTAR TASK:\n';
      tasks.forEach(function (t, i) {
        prompt +=
          (i + 1) + '. [' + t.status + '] ' + t.title +
          ' | Due: '       + (t.due_date  || '(tidak ada)') +
          ' | Prioritas: ' + (t.priority  || '-') +
          (t.note ? ' | Catatan: ' + String(t.note).substring(0, 80) : '') + '\n';
      });
      prompt += '\n';
    }

    var notulen = USER_CONTEXT.notulen || [];
    if (notulen.length) {
      prompt += 'NOTULEN TERBARU (' + notulen.length + '):\n';
      notulen.forEach(function (n, i) {
        prompt +=
          (i + 1) + '. ' + n.kegiatan +
          ' | Tanggal: ' + (n.tanggal || '-') +
          ' | Tempat: '  + (n.tempat  || '-') + '\n';
      });
      prompt += '\n';
    }
  } else {
    prompt += '=== DATA TASK: Belum tersedia (sedang dimuat) ===\n\n';
  }

  prompt += 'Jawab ringkas, terstruktur, dan gunakan emoji agar mudah dibaca.';
  return prompt;
}

// ================================================================
// 11. SESSIONS — load, render, open, save, delete
// ================================================================
function loadSessions() {
  var el = document.getElementById('sessionsList');
  el.innerHTML = '<div class="sessions-loading">⏳ Memuat sesi...</div>';

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

  if (!SESSIONS_LIST.length) {
    el.innerHTML =
      '<div class="sessions-empty">' +
      '💬 Belum ada riwayat chat.<br>Mulai percakapan baru!' +
      '</div>';
    return;
  }

  var html = '';
  SESSIONS_LIST.forEach(function (s) {
    var isActive = ACTIVE_SESSION && ACTIVE_SESSION.session_id === s.session_id;
    html +=
      '<div class="session-item' + (isActive ? ' active' : '') +
        '" data-sid="' + esc(s.session_id) + '">' +
      '  <div class="session-item-title">'
        + esc(s.title || 'Percakapan Baru') + '</div>' +
      '  <div class="session-item-meta">💬 '
        + (s.msg_count || 0) + ' pesan · '
        + String(s.updated_at || '').substring(0, 16) + '</div>' +
      '  <button class="session-del-btn"'
        + ' data-del="' + esc(s.session_id) + '" title="Hapus">🗑</button>' +
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
  document.querySelectorAll('.session-item').forEach(function (el) {
    el.classList.toggle('active', el.getAttribute('data-sid') === sessionId);
  });

  fetch(
    authURL('get-session', '&session_id=' + encodeURIComponent(sessionId)),
    { redirect: 'follow' }
  )
    .then(function (r) { return r.json(); })
    .then(function (j) {
      if (!j.ok) { alert('Gagal memuat sesi: ' + (j.message || '')); return; }
      ACTIVE_SESSION = j.data;
      document.getElementById('chatTitle').textContent =
        ACTIVE_SESSION.title || 'Percakapan';
      document.getElementById('chatSubtitle').textContent =
        ACTIVE_SESSION.messages.length + ' pesan · ' +
        String(ACTIVE_SESSION.updated_at || '').substring(0, 16);
      renderMessages();
    })
    .catch(function (err) { alert('Error: ' + err.message); });
}

function startNewSession() {
  ACTIVE_SESSION = { session_id: '', title: 'Percakapan Baru', messages: [] };
  document.getElementById('chatTitle').textContent    = 'Percakapan Baru';
  document.getElementById('chatSubtitle').textContent =
    'Tanyakan apa saja tentang jadwal & task kamu';
  document.querySelectorAll('.session-item').forEach(function (el) {
    el.classList.remove('active');
  });
  renderMessages();
  document.getElementById('chatInput').focus();
}

function saveSessionToSheet() {
  if (!ACTIVE_SESSION) return;
  fetch(API_URL, {
    method:   'POST',
    headers:  { 'Content-Type': 'application/json' },
    redirect: 'follow',
    body: JSON.stringify({
      action:     'save-session',
      user:        SESSION.username,
      token:       SESSION.token,
      session_id:  ACTIVE_SESSION.session_id || '',
      title:       ACTIVE_SESSION.title      || 'Percakapan Baru',
      messages:    ACTIVE_SESSION.messages
    })
  })
    .then(function (r) { return r.json(); })
    .then(function (j) {
      if (j.ok) {
        if (!ACTIVE_SESSION.session_id && j.session_id) {
          ACTIVE_SESSION.session_id = j.session_id;
        }
        loadSessions();
      }
    })
    .catch(function (err) {
      console.warn('[SIMONTOK] saveSession error:', err.message);
    });
}

function confirmDeleteSession(sessionId) {
  if (!confirm('Hapus sesi chat ini?')) return;
  fetch(API_URL, {
    method:   'POST',
    headers:  { 'Content-Type': 'application/json' },
    redirect: 'follow',
    body: JSON.stringify({
      action:     'delete-session',
      user:        SESSION.username,
      token:       SESSION.token,
      session_id:  sessionId
    })
  })
    .then(function (r) { return r.json(); })
    .then(function (j) {
      if (!j.ok) { alert('Gagal hapus: ' + (j.message || '')); return; }
      if (ACTIVE_SESSION && ACTIVE_SESSION.session_id === sessionId) {
        ACTIVE_SESSION = null;
        document.getElementById('chatTitle').textContent    = 'AI Assistant SIMONTOK';
        document.getElementById('chatSubtitle').textContent =
          'Tanyakan jadwal, buat task, atau minta bantuan apapun';
        renderMessages();
      }
      loadSessions();
    })
    .catch(function (err) { alert('Error: ' + err.message); });
}

// ================================================================
// 12. RENDER MESSAGES
// ================================================================
function renderMessages() {
  var area = document.getElementById('chatMessages');

  if (!ACTIVE_SESSION || !ACTIVE_SESSION.messages || !ACTIVE_SESSION.messages.length) {
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
  ACTIVE_SESSION.messages.forEach(function (msg) {
    html += renderBubble(msg);
  });
  area.innerHTML = html;
  scrollToBottom();
}

// ================================================================
// 13. RENDER BUBBLE
// ================================================================
function renderBubble(msg) {
  var isUser    = msg.role === 'user';
  var avatarTxt = isUser
    ? String(SESSION.name || SESSION.username || 'U').charAt(0).toUpperCase()
    : '🤖';
  var cls     = isUser ? 'user' : 'ai';
  var time    = msg.timestamp ? String(msg.timestamp).substring(11, 16) : '';
  var content = isUser ? esc(msg.content) : renderMarkdown(msg.content);

  return (
    '<div class="msg-row ' + cls + '">' +
    '  <div class="msg-avatar ' + cls + '">' + avatarTxt + '</div>' +
    '  <div class="msg-col">' +
    '    <div class="msg-bubble ' + cls + '">' + content + '</div>' +
    (time ? '<div class="msg-time">' + time + '</div>' : '') +
    '  </div>' +
    '</div>'
  );
}

// ================================================================
// 14. RENDER MARKDOWN
// ================================================================
function renderMarkdown(text) {
  if (!text) return '';
  var t = esc(text);

  t = t.replace(/```([\s\S]*?)```/g,  '<pre><code>$1</code></pre>');
  t = t.replace(/`([^`\n]+)`/g,       '<code>$1</code>');
  t = t.replace(/\*\*(.+?)\*\*/g,     '<strong>$1</strong>');
  t = t.replace(/\*([^*\n]+)\*/g,     '<em>$1</em>');
  t = t.replace(/^---+$/gm,           '<hr>');
  t = t.replace(/^### (.+)$/gm,       '<h3>$1</h3>');
  t = t.replace(/^#### (.+)$/gm,      '<h4>$1</h4>');
  t = t.replace(/^\s*[-•]\s(.+)$/gm,  '<li>$1</li>');
  t = t.replace(/(<li>[\s\S]*?<\/li>(\n|$))+/g, function (m) {
    return '<ul>' + m + '</ul>';
  });
  t = t.replace(/^\s*\d+\.\s(.+)$/gm, '<li>$1</li>');

  // Sembunyikan tag task JSON dari tampilan
  t = t.replace(/%%TASK_JSON%%[\s\S]*?%%END_TASK%%/g, '');

  // Paragraf
  t = t.split(/\n{2,}/).map(function (para) {
    para = para.trim();
    if (!para) return '';
    if (/^<(h[1-6]|ul|ol|pre|hr|table)/.test(para)) return para;
    return '<p>' + para.replace(/\n/g, '<br>') + '</p>';
  }).join('');

  return t;
}

// ================================================================
// 15. TYPING INDICATOR
// ================================================================
function showTyping() {
  var area = document.getElementById('chatMessages');
  var el   = document.createElement('div');
  el.id    = 'typingIndicator';
  el.className = 'typing-row';
  el.innerHTML =
    '<div class="msg-avatar ai">🤖</div>' +
    '<div class="typing-bubble">' +
    '  <div class="typing-dot"></div>' +
    '  <div class="typing-dot"></div>' +
    '  <div class="typing-dot"></div>' +
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
// 16. SEND MESSAGE
// ================================================================
function sendMessage(textOverride) {
  var input   = document.getElementById('chatInput');
  var content = textOverride || input.value.trim();
  if (!content || IS_THINKING) return;

  // Cek apiKey dari SESSION (bukan sessionStorage)
  var apiKey = getApiKey();
  if (!apiKey) {
    alert('API Key tidak tersedia. Hubungi admin untuk mengisi API Key di akun kamu.');
    return;
  }

  if (!ACTIVE_SESSION) startNewSession();

  ACTIVE_SESSION.messages.push({
    role:      'user',
    content:   content,
    timestamp: new Date().toISOString()
  });

  if (!textOverride) { input.value = ''; autoResizeInput(); }

  renderMessages();
  IS_THINKING = true;
  document.getElementById('btnSend').disabled = true;
  showTyping();

  // Bangun messages untuk OpenRouter
  var apiMessages = [{ role: 'system', content: buildSystemPrompt() }]
    .concat(ACTIVE_SESSION.messages.map(function (m) {
      return { role: m.role, content: m.content };
    }));

  // Panggil AI — kirim apiKey langsung karena AI_CLIENT.getApiKey()
  // membaca sessionStorage yang mungkin kosong.
  // Kita override dengan apiKey dari SESSION.
  callOpenRouter(apiKey, apiMessages)
    .then(function (result) {
      hideTyping();
      IS_THINKING = false;
      document.getElementById('btnSend').disabled = false;

      processAIResponse(result.text);

      ACTIVE_SESSION.messages.push({
        role:      'assistant',
        content:   result.text,
        timestamp: new Date().toISOString()
      });

      if (ACTIVE_SESSION.messages.length === 2 && !ACTIVE_SESSION.session_id) {
        ACTIVE_SESSION.title = content.length > 45
          ? content.substring(0, 45) + '...'
          : content;
        document.getElementById('chatTitle').textContent = ACTIVE_SESSION.title;
      }

      renderMessages();
      saveSessionToSheet();

      console.info('[SIMONTOK] AI OK | latency ' + result.latencyMs + 'ms');
    })
    .catch(function (err) {
      hideTyping();
      IS_THINKING = false;
      document.getElementById('btnSend').disabled = false;

      ACTIVE_SESSION.messages.push({
        role:      'assistant',
        content:   err.message || '❌ Terjadi kesalahan. Silakan coba lagi.',
        timestamp: new Date().toISOString()
      });
      renderMessages();
    });
}

// ================================================================
// 17. callOpenRouter — langsung pakai apiKey dari SESSION
//     Tidak bergantung pada AI_CLIENT.getApiKey() / sessionStorage
// ================================================================
function callOpenRouter(apiKey, messages) {
  var startTime = Date.now();

  var controller = new AbortController();
  var timer = setTimeout(function () { controller.abort(); }, 30000);

  return fetch('https://openrouter.ai/api/v1/chat/completions', {
    method:  'POST',
    headers: {
      'Authorization': 'Bearer ' + apiKey,
      'Content-Type':  'application/json',
      'HTTP-Referer':  window.location.origin || 'https://simontok.app',
      'X-Title':       'SIMONTOK Assistant'
    },
    body: JSON.stringify({
      model:       AI_MODEL,
      messages:    messages,
      max_tokens:  2048,
      temperature: 0.7,
      stream:      false
    }),
    signal:   controller.signal,
    redirect: 'follow'
  })
    .then(function (res) {
      clearTimeout(timer);
      if (!res.ok) {
        return res.json().then(function (e) {
          var msg = e && e.error && e.error.message
            ? e.error.message : 'HTTP ' + res.status;
          throw new Error(_friendlyError(res.status, msg));
        }).catch(function (err) {
          if (err.message) throw err;
          throw new Error('HTTP ' + res.status);
        });
      }
      return res.json();
    })
    .then(function (data) {
      if (!data.choices || !data.choices.length) {
        throw new Error('Response kosong dari OpenRouter. Coba lagi.');
      }
      var text = data.choices[0].message && data.choices[0].message.content
        ? String(data.choices[0].message.content).trim()
        : '';
      if (!text) throw new Error('AI tidak menghasilkan teks. Coba lagi.');

      return { text: text, latencyMs: Date.now() - startTime };
    })
    .catch(function (err) {
      clearTimeout(timer);
      if (err.name === 'AbortError') {
        throw new Error('⏳ Request timeout 30 detik. Periksa koneksi internet kamu.');
      }
      throw err;
    });
}

// ================================================================
// 18. FRIENDLY ERROR — HTTP code → pesan ramah
// ================================================================
function _friendlyError(code, original) {
  var map = {
    401: '🔑 API Key tidak valid atau kedaluwarsa. Hubungi admin.',
    402: '💳 Saldo OpenRouter habis. Hubungi admin untuk top-up.',
    429: '⏳ Terlalu banyak request. Tunggu sebentar lalu coba lagi.',
    500: '🔧 Server OpenRouter bermasalah. Coba lagi dalam beberapa menit.',
    503: '🔧 OpenRouter sedang maintenance. Coba lagi nanti.'
  };
  return map[parseInt(code, 10)] || ('❌ Error dari AI: ' + original);
}

// ================================================================
// 19. PROCESS AI RESPONSE — deteksi %%TASK_JSON%%
// ================================================================
function processAIResponse(text) {
  var match = text.match(/%%TASK_JSON%%([\s\S]*?)%%END_TASK%%/);
  if (!match) return;
  try {
    var taskData = JSON.parse(match[1].trim());
    setTimeout(function () { openTaskModal(taskData); }, 400);
  } catch (e) {
    console.warn('[SIMONTOK] Gagal parse task JSON:', e.message);
  }
}

// ================================================================
// 20. TASK MODAL
// ================================================================
var PENDING_TASK = null;

function openTaskModal(taskData) {
  PENDING_TASK = taskData;
  document.getElementById('mTaskTitle').value    = taskData.title    || '';
  document.getElementById('mTaskStatus').value   = taskData.status   || 'To Do';
  document.getElementById('mTaskPriority').value = taskData.priority || 'Medium';
  document.getElementById('mTaskDueDate').value  = taskData.due_date || '';
  document.getElementById('mTaskNote').value     = taskData.note     || '';
  document.getElementById('taskModal').classList.add('active');
}

function closeTaskModal() {
  document.getElementById('taskModal').classList.remove('active');
  PENDING_TASK = null;
}

function submitTaskModal() {
  var task = {
    title:    document.getElementById('mTaskTitle').value.trim(),
    status:   document.getElementById('mTaskStatus').value,
    priority: document.getElementById('mTaskPriority').value,
    due_date: document.getElementById('mTaskDueDate').value,
    note:     document.getElementById('mTaskNote').value.trim()
  };
  if (!task.title) { alert('Judul task wajib diisi!'); return; }

  var btn = document.getElementById('taskModalConfirm');
  btn.disabled    = true;
  btn.textContent = '⏳ Menyimpan...';

  fetch(API_URL, {
    method:   'POST',
    headers:  { 'Content-Type': 'application/json' },
    redirect: 'follow',
    body: JSON.stringify({
      action: 'ai-add-task',
      user:    SESSION.username,
      token:   SESSION.token,
      task:    task
    })
  })
    .then(function (r) { return r.json(); })
    .then(function (j) {
      btn.disabled    = false;
      btn.textContent = '✅ Simpan Task';
      if (!j.ok) { alert('Gagal menyimpan task: ' + (j.message || '')); return; }

      closeTaskModal();
      ACTIVE_SESSION.messages.push({
        role: 'assistant',
        content:
          '✅ Task berhasil ditambahkan!\n\n' +
          '**' + task.title + '**\n' +
          '• Status    : ' + task.status   + '\n' +
          '• Prioritas : ' + task.priority + '\n' +
          '• Due Date  : ' + (task.due_date || '(tidak ada)') + '\n\n' +
          'Kamu bisa cek di halaman [Dashboard](dashboard.html).',
        timestamp: new Date().toISOString()
      });
      renderMessages();
      saveSessionToSheet();
      loadContext(); // refresh agar task baru terbaca AI
    })
    .catch(function (err) {
      btn.disabled    = false;
      btn.textContent = '✅ Simpan Task';
      alert('Error: ' + err.message);
    });
}

// ================================================================
// 21. AUTO RESIZE TEXTAREA
// ================================================================
function autoResizeInput() {
  var el = document.getElementById('chatInput');
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}

// ================================================================
// 22. ESCAPE HTML
// ================================================================
function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ================================================================
// 23. INIT EVENT LISTENERS
// ================================================================
function initEventListeners() {

  // Dark mode
  document.getElementById('darkToggle').addEventListener('click', function () {
    var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    applyTheme(!isDark);
  });

  // Settings dropdown
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

  // Logout
  document.getElementById('logoutBtn').addEventListener('click', function () {
    if (!confirm('Yakin ingin logout?')) return;
    localStorage.removeItem(SESSION_KEY);
    sessionStorage.removeItem('simontok-apikey');
    window.location.href = 'index.html';
  });

  // New chat
  document.getElementById('btnNewChat').addEventListener('click', function () {
    startNewSession();
  });

  // Refresh context
  document.getElementById('btnRefreshCtx').addEventListener('click', function () {
    var btn = this;
    btn.textContent = '⏳ Memuat...';
    btn.disabled    = true;
    loadContext();
    setTimeout(function () {
      btn.textContent = '🔄 Refresh Data';
      btn.disabled    = false;
    }, 1800);
  });

  // Quick action buttons
  document.querySelectorAll('.qa-btn[data-prompt]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      sendMessage(btn.getAttribute('data-prompt'));
    });
  });

  // Tip items di welcome (event delegation)
  document.getElementById('chatMessages').addEventListener('click', function (e) {
    var tip = e.target.closest('.tip-item[data-prompt]');
    if (tip) sendMessage(tip.getAttribute('data-prompt'));
  });

  // Tombol kirim
  document.getElementById('btnSend').addEventListener('click', function () {
    sendMessage();
  });

  // Textarea Enter / Shift+Enter
  document.getElementById('chatInput').addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // Textarea auto resize
  document.getElementById('chatInput').addEventListener('input', autoResizeInput);

  // Modal
  document.getElementById('taskModalClose').addEventListener('click',   closeTaskModal);
  document.getElementById('taskModalCancel').addEventListener('click',  closeTaskModal);
  document.getElementById('taskModal').addEventListener('click', function (e) {
    if (e.target === this) closeTaskModal();
  });
  document.getElementById('taskModalConfirm').addEventListener('click', submitTaskModal);
}

// ================================================================
// 24. ENTRY POINT
// ================================================================
window.onload = startApp;
