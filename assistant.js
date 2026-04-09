// ================================================================
// SIMONTOK - Assistant JS
// File   : js/assistant.js
// Versi  : 1.0
// Depends: js/ai-client.js (AI_CLIENT harus di-load duluan)
// ================================================================

// ================================================================
// 1. CONFIG
// ================================================================
var API_URL     = 'https://script.google.com/macros/s/AKfycbwLLIv2AH5v4FiYImDN2-u5WhxAYvsTXq1ZUqdRUWqBM0K6pBuI3q_ZQn3_eFIii2bU/exec';
var SESSION_KEY = 'simontok-session';
var AI_MODEL    = 'google/gemma-4-31b-it';
var SESSION     = null;

// ================================================================
// 2. STATE
// ================================================================
var USER_CONTEXT   = null;   // data task + notulen dari GAS
var SESSIONS_LIST  = [];     // daftar sesi dari sheet _sessions
var ACTIVE_SESSION = null;   // { session_id, title, messages:[] }
var IS_THINKING    = false;  // true saat AI sedang berpikir

// ================================================================
// 3. AUTH — getSession, authURL
// ================================================================
function getSession() {
  try {
    var raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return false;
    var parsed = JSON.parse(raw);
    if (parsed && parsed.token && parsed.username) {
      SESSION = parsed;
      return true;
    }
  } catch (e) {}
  return false;
}

function authURL(action, extra) {
  return API_URL
    + '?action=' + encodeURIComponent(action)
    + '&user='   + encodeURIComponent(SESSION.username)
    + '&token='  + encodeURIComponent(SESSION.token)
    + (extra || '');
}

// Guard — redirect jika belum login
if (!getSession()) {
  alert('Silakan login terlebih dahulu.');
  window.location.replace('index.html');
}

// ================================================================
// 4. THEME
// ================================================================
function initTheme() {
  var saved = localStorage.getItem('simontok-theme');
  applyTheme(saved === 'dark');
}

function applyTheme(isDark) {
  if (isDark) {
    document.documentElement.setAttribute('data-theme', 'dark');
    document.getElementById('darkToggle').classList.add('on');
  } else {
    document.documentElement.removeAttribute('data-theme');
    document.getElementById('darkToggle').classList.remove('on');
  }
}

// ================================================================
// 5. RENDER API KEY STATUS
// ================================================================
function renderApiKeyStatus() {
  var dot = document.getElementById('aiKeyDot');
  var msg = document.getElementById('aiKeyMsg');
  if (!dot || !msg) return;

  var key = AI_CLIENT.getApiKey();
  if (!key) {
    dot.className   = 'ai-key-dot err';
    msg.textContent = '⚠️ API Key tidak tersedia untuk akun ini. Hubungi admin.';
  } else {
    dot.className   = 'ai-key-dot ok';
    msg.textContent = '✅ API Key aktif · Login sebagai '
      + (SESSION.name || SESSION.username || 'User');
  }
}

// ================================================================
// 6. LOAD CONTEXT — task + notulen + stats dari GAS
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
// 7. BUILD SYSTEM PROMPT
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
    '- Jika user meminta membuat task, WAJIB sisipkan blok JSON ini di respons:\n' +
    '  %%TASK_JSON%%{"title":"...","status":"To Do","priority":"High/Medium/Low",' +
      '"due_date":"YYYY-MM-DD","note":"..."}%%END_TASK%%\n' +
    '- Jika due_date tidak disebutkan, kosongi saja ("").\n' +
    '- Jangan mengarang data task yang tidak ada.\n\n';

  // ── Data dari spreadsheet ──
  if (USER_CONTEXT && USER_CONTEXT.ok) {
    var s = USER_CONTEXT.task_stats || {};
    prompt +=
      '=== DATA TASK USER (' + (USER_CONTEXT.tasks || []).length + ' total) ===\n' +
      'Statistik: Total=' + s.total +
        ', To Do=' + s.todo +
        ', Doing=' + s.doing +
        ', Done=' + s.done +
        ', Blocked=' + s.blocked + '\n\n';

    var tasks = USER_CONTEXT.tasks || [];
    if (tasks.length) {
      prompt += 'DAFTAR TASK:\n';
      tasks.forEach(function (t, i) {
        prompt +=
          (i + 1) + '. [' + t.status + '] ' + t.title +
          ' | Due: '      + (t.due_date  || '(tidak ada)') +
          ' | Prioritas: '+ (t.priority  || '-') +
          (t.note ? ' | Catatan: ' + String(t.note).substring(0, 80) : '') +
          '\n';
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
// 8. SESSIONS — load, render, open, delete
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
    var title    = esc(s.title || 'Percakapan Baru');
    var updated  = s.updated_at ? String(s.updated_at).substring(0, 16) : '';
    var count    = s.msg_count  || 0;

    html +=
      '<div class="session-item' + (isActive ? ' active' : '') +
        '" data-sid="' + esc(s.session_id) + '">' +
      '  <div class="session-item-title">' + title + '</div>' +
      '  <div class="session-item-meta">💬 ' + count + ' pesan · ' + updated + '</div>' +
      '  <button class="session-del-btn"' +
        ' data-del="' + esc(s.session_id) + '" title="Hapus sesi">🗑</button>' +
      '</div>';
  });

  el.innerHTML = html;

  // Bind klik buka sesi
  el.querySelectorAll('.session-item[data-sid]').forEach(function (item) {
    item.addEventListener('click', function (e) {
      if (e.target.closest('[data-del]')) return;
      openSession(item.getAttribute('data-sid'));
    });
  });

  // Bind klik hapus sesi
  el.querySelectorAll('[data-del]').forEach(function (btn) {
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      confirmDeleteSession(btn.getAttribute('data-del'));
    });
  });
}

function openSession(sessionId) {
  // Tandai aktif di sidebar
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
      if (!j.ok) { alert('Gagal hapus: ' + (j.message || j.error || '')); return; }
      // Jika sesi yang dihapus sedang aktif → reset ke welcome
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
// 9. SAVE SESSION ke sheet _sessions
// ================================================================
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
        // Simpan session_id yang baru dibuat GAS
        if (!ACTIVE_SESSION.session_id && j.session_id) {
          ACTIVE_SESSION.session_id = j.session_id;
        }
        loadSessions(); // refresh sidebar
      }
    })
    .catch(function (err) {
      console.warn('[SIMONTOK] saveSession error:', err.message);
    });
}

// ================================================================
// 10. RENDER MESSAGES
// ================================================================
function renderMessages() {
  var area = document.getElementById('chatMessages');

  // Tidak ada sesi atau sesi kosong → tampilkan welcome
  if (!ACTIVE_SESSION || !ACTIVE_SESSION.messages || !ACTIVE_SESSION.messages.length) {
    var welcome = document.getElementById('chatWelcome');
    // Clone welcome dari DOM asli supaya tips masih ada
    area.innerHTML = '';
    if (welcome) {
      area.appendChild(welcome.cloneNode(true));
    }
    // Rebind tip-item clicks
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
// 11. RENDER BUBBLE — satu pesan
// ================================================================
function renderBubble(msg) {
  var isUser    = msg.role === 'user';
  var avatarTxt = isUser
    ? (String(SESSION.name || SESSION.username || 'U').charAt(0).toUpperCase())
    : '🤖';
  var cls  = isUser ? 'user' : 'ai';
  var time = msg.timestamp
    ? String(msg.timestamp).substring(11, 16)
    : '';
  var content = isUser
    ? esc(msg.content)
    : renderMarkdown(msg.content);

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
// 12. RENDER MARKDOWN — teks AI → HTML
// ================================================================
function renderMarkdown(text) {
  if (!text) return '';

  // Escape HTML dulu, lalu parse markdown
  var t = esc(text);

  // Code block ```...```
  t = t.replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>');
  // Inline code `...`
  t = t.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  // Bold **...**
  t = t.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // Italic *...*
  t = t.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
  // HR ---
  t = t.replace(/^---+$/gm, '<hr>');
  // H3 ###
  t = t.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  // H4 ####
  t = t.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
  // Unordered list - item
  t = t.replace(/^\s*[-•]\s(.+)$/gm, '<li>$1</li>');
  t = t.replace(/(<li>[\s\S]*?<\/li>(\n|$))+/g, function (m) {
    return '<ul>' + m + '</ul>';
  });
  // Ordered list 1. item
  t = t.replace(/^\s*\d+\.\s(.+)$/gm, '<li>$1</li>');

  // Sembunyikan tag task JSON dari tampilan user
  t = t.replace(/%%TASK_JSON%%[\s\S]*?%%END_TASK%%/g, '');

  // Paragraf — pisah per baris kosong
  t = t.split(/\n{2,}/).map(function (para) {
    para = para.trim();
    if (!para) return '';
    if (/^<(h[1-6]|ul|ol|pre|hr|table)/.test(para)) return para;
    return '<p>' + para.replace(/\n/g, '<br>') + '</p>';
  }).join('');

  return t;
}

// ================================================================
// 13. TYPING INDICATOR
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

// ================================================================
// 14. SCROLL TO BOTTOM
// ================================================================
function scrollToBottom() {
  var area = document.getElementById('chatMessages');
  if (area) setTimeout(function () { area.scrollTop = area.scrollHeight; }, 60);
}

// ================================================================
// 15. SEND MESSAGE — entry point utama
// ================================================================
function sendMessage(textOverride) {
  var input   = document.getElementById('chatInput');
  var content = textOverride || input.value.trim();

  if (!content || IS_THINKING) return;

  // Cek API key lewat AI_CLIENT
  if (!AI_CLIENT.hasApiKey()) {
    alert('API Key tidak tersedia. Hubungi admin untuk mengisi API Key di akun kamu.');
    return;
  }

  // Buat sesi aktif jika belum ada
  if (!ACTIVE_SESSION) startNewSession();

  // Tambah pesan user ke state
  var userMsg = {
    role:      'user',
    content:   content,
    timestamp: new Date().toISOString()
  };
  ACTIVE_SESSION.messages.push(userMsg);

  // Kosongkan input
  if (!textOverride) {
    input.value = '';
    autoResizeInput();
  }

  // Render & lock UI
  renderMessages();
  IS_THINKING = true;
  document.getElementById('btnSend').disabled = true;
  showTyping();

  // Bangun messages untuk API (system prompt + history)
  var apiMessages = [{ role: 'system', content: buildSystemPrompt() }]
    .concat(
      ACTIVE_SESSION.messages.map(function (m) {
        return { role: m.role, content: m.content };
      })
    );

  // Panggil AI via AI_CLIENT
  AI_CLIENT.sendChat(apiMessages, { model: AI_MODEL })
    .then(function (result) {
      hideTyping();
      IS_THINKING = false;
      document.getElementById('btnSend').disabled = false;

      var aiText = result.text;

      // Deteksi dan handle task JSON di respons
      processAIResponse(aiText);

      // Simpan pesan AI ke state
      ACTIVE_SESSION.messages.push({
        role:      'assistant',
        content:   aiText,
        timestamp: new Date().toISOString()
      });

      // Auto-title dari pesan pertama user
      if (ACTIVE_SESSION.messages.length === 2 && !ACTIVE_SESSION.session_id) {
        ACTIVE_SESSION.title = content.length > 45
          ? content.substring(0, 45) + '...'
          : content;
        document.getElementById('chatTitle').textContent = ACTIVE_SESSION.title;
      }

      renderMessages();
      saveSessionToSheet();

      // Log stats ke console (dev info)
      var stats = AI_CLIENT.getStats();
      console.info(
        '[SIMONTOK] Req #' + stats.requestCount +
        ' | ~' + stats.totalTokens + ' tokens total' +
        ' | latency ' + result.latencyMs + 'ms'
      );
    })
    .catch(function (err) {
      hideTyping();
      IS_THINKING = false;
      document.getElementById('btnSend').disabled = false;

      // Tampilkan error sebagai bubble AI
      ACTIVE_SESSION.messages.push({
        role:      'assistant',
        content:   err.message || '❌ Terjadi kesalahan. Silakan coba lagi.',
        timestamp: new Date().toISOString()
      });
      renderMessages();
    });
}

// ================================================================
// 16. PROCESS AI RESPONSE — deteksi %%TASK_JSON%%
// ================================================================
function processAIResponse(text) {
  var re    = /%%TASK_JSON%%([\s\S]*?)%%END_TASK%%/;
  var match = text.match(re);
  if (!match) return;

  try {
    var taskData = JSON.parse(match[1].trim());
    // Tunda sedikit agar bubble AI muncul dulu
    setTimeout(function () { openTaskModal(taskData); }, 400);
  } catch (e) {
    console.warn('[SIMONTOK] Gagal parse task JSON:', e.message, match[1]);
  }
}

// ================================================================
// 17. TASK MODAL
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

  var btn      = document.getElementById('taskModalConfirm');
  btn.disabled = true;
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

      // Konfirmasi ke chat sebagai bubble AI
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
      loadContext(); // refresh context agar task baru terbaca AI
    })
    .catch(function (err) {
      btn.disabled    = false;
      btn.textContent = '✅ Simpan Task';
      alert('Error: ' + err.message);
    });
}

// ================================================================
// 18. AUTO RESIZE TEXTAREA
// ================================================================
function autoResizeInput() {
  var el    = document.getElementById('chatInput');
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}

// ================================================================
// 19. ESCAPE HTML
// ================================================================
function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ================================================================
// 20. BIND EVENTS — semua event listener
// ================================================================
function bindEvents() {

  // Dark mode toggle
  document.getElementById('darkToggle').addEventListener('click', function () {
    var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    isDark = !isDark;
    localStorage.setItem('simontok-theme', isDark ? 'dark' : 'light');
    applyTheme(isDark);
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
    AI_CLIENT.resetStats(); // reset token counter untuk sesi baru
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

  // Tip items di welcome screen (event delegation)
  document.getElementById('chatMessages').addEventListener('click', function (e) {
    var tip = e.target.closest('.tip-item[data-prompt]');
    if (tip) sendMessage(tip.getAttribute('data-prompt'));
  });

  // Tombol kirim
  document.getElementById('btnSend').addEventListener('click', function () {
    sendMessage();
  });

  // Textarea — Enter kirim, Shift+Enter baris baru
  document.getElementById('chatInput').addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // Textarea — auto resize
  document.getElementById('chatInput').addEventListener('input', autoResizeInput);

  // Modal — close
  document.getElementById('taskModalClose').addEventListener('click',  closeTaskModal);
  document.getElementById('taskModalCancel').addEventListener('click', closeTaskModal);
  document.getElementById('taskModal').addEventListener('click', function (e) {
    if (e.target === this) closeTaskModal();
  });

  // Modal — confirm
  document.getElementById('taskModalConfirm').addEventListener('click', submitTaskModal);
}

// ================================================================
// 21. INIT APP — dipanggil setelah DOM ready
// ================================================================
function initApp() {
  // Topbar info user
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
    wt.textContent = 'Halo, ' + (SESSION.name || SESSION.username) + '! Ada yang bisa saya bantu?';
  }

  // Tampilkan app, sembunyikan loading
  document.getElementById('loadingState').style.display = 'none';
  document.getElementById('app').style.display = '';

  initTheme();
  renderApiKeyStatus();
  bindEvents();
  loadContext();
  loadSessions();
}

// ================================================================
// 22. ENTRY POINT — tunggu DOM siap
// ================================================================
document.addEventListener('DOMContentLoaded', function () {
  if (SESSION) initApp();
});
