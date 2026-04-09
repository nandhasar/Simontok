```javascript
// ================================================================
// SIMONTOK - AI Client
// File  : js/ai-client.js
// Versi : 1.0
// Tanggal: 9 April 2026
//
// Deskripsi:
//   Single provider — OpenRouter
//   Model default   — google/gemma-4-31b-it (bisa di-override)
//   Config utama (API_URL, SESSION, AI_MODEL) ada di file induk
//   File ini HANYA menangani komunikasi ke OpenRouter
// ================================================================

var AI_CLIENT = (function () {

  // ============================================================
  // KONSTANTA
  // ============================================================
  var OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
  var REQUEST_TIMEOUT_MS  = 30000;  // 30 detik
  var MAX_TOKENS          = 2048;
  var TEMPERATURE         = 0.7;

  // ============================================================
  // STATE INTERNAL (per page load)
  // ============================================================
  var _stats = {
    requestCount : 0,
    totalTokens  : 0,
    lastModel    : '',
    lastLatencyMs: 0,
    errors       : []      // max 20 error terakhir
  };

  // ============================================================
  // PRIVATE: fetchWithTimeout
  // Wrapper fetch + abort controller untuk timeout
  // ============================================================
  function _fetchWithTimeout(url, options, timeoutMs) {
    var controller = new AbortController();
    var timer = setTimeout(function () {
      controller.abort();
    }, timeoutMs);

    options.signal = controller.signal;

    return fetch(url, options)
      .then(function (res) {
        clearTimeout(timer);
        return res;
      })
      .catch(function (err) {
        clearTimeout(timer);
        // Ubah AbortError menjadi pesan yang lebih ramah
        if (err.name === 'AbortError') {
          throw new Error('Request timeout — server tidak merespons dalam '
            + (timeoutMs / 1000) + ' detik. Coba lagi.');
        }
        throw err;
      });
  }

  // ============================================================
  // PRIVATE: parseErrorResponse
  // Ekstrak pesan error dari response OpenRouter
  // ============================================================
  function _parseErrorResponse(res) {
    return res.json()
      .then(function (body) {
        // Format error OpenRouter: { error: { message, code, type } }
        var msg = body && body.error && body.error.message
          ? body.error.message
          : 'HTTP ' + res.status + ' ' + res.statusText;
        var code = body && body.error && body.error.code
          ? body.error.code
          : res.status;
        return { code: code, message: msg };
      })
      .catch(function () {
        // Kalau response bukan JSON sama sekali
        return { code: res.status, message: 'HTTP ' + res.status + ' ' + res.statusText };
      });
  }

  // ============================================================
  // PRIVATE: logError
  // Simpan error ke _stats.errors untuk debugging
  // ============================================================
  function _logError(code, message) {
    var entry = {
      code     : code,
      message  : message,
      timestamp: new Date().toISOString()
    };
    _stats.errors.push(entry);
    if (_stats.errors.length > 20) _stats.errors.shift(); // rolling buffer
    console.warn('[AI-CLIENT] Error ' + code + ':', message);
  }

  // ============================================================
  // PRIVATE: estimateTokens
  // Estimasi kasar: ~4 karakter per token (hanya fallback
  // jika API tidak mengembalikan usage)
  // ============================================================
  function _estimateTokens(messages) {
    return messages.reduce(function (total, m) {
      return total + Math.ceil((String(m.content || '')).length / 4);
    }, 0);
  }

  // ============================================================
  // PUBLIC: getApiKey
  // Ambil API key dari sessionStorage yang diset saat login
  // sessionStorage key: 'simontok-apikey'
  // Mengembalikan string kosong '' jika tidak ada
  // ============================================================
  function getApiKey() {
    try {
      var key = sessionStorage.getItem('simontok-apikey');
      if (!key || key === 'undefined' || key === 'null') return '';
      return key.trim();
    } catch (e) {
      return '';
    }
  }

  // ============================================================
  // PUBLIC: hasApiKey
  // Cek cepat apakah API key tersedia
  // ============================================================
  function hasApiKey() {
    return getApiKey() !== '';
  }

  // ============================================================
  // PUBLIC: sendChat
  //
  // Parameter:
  //   messages (array) — array lengkap percakapan
  //     Format: [
  //       { role: 'system',    content: '...' },  ← system prompt (opsional, otomatis prepend)
  //       { role: 'user',      content: '...' },
  //       { role: 'assistant', content: '...' },
  //       ...
  //     ]
  //   options (object, opsional):
  //     .model       (string) — override model, default = AI_MODEL global
  //     .maxTokens   (number) — override max_tokens
  //     .temperature (number) — override temperature
  //
  // Return: Promise yang resolve ke object:
  //   {
  //     ok        : true,
  //     text      : '...teks response AI...',
  //     model     : 'google/gemma-4-31b-it',
  //     usage     : { prompt_tokens, completion_tokens, total_tokens } | null,
  //     latencyMs : 1234
  //   }
  //
  // Jika gagal: Promise.reject(Error)
  // ============================================================
  function sendChat(messages, options) {
    options = options || {};

    // Ambil API key
    var apiKey = getApiKey();
    if (!apiKey) {
      return Promise.reject(
        new Error('API Key tidak tersedia. Hubungi admin untuk mengisi kolom API di akun kamu.')
      );
    }

    // Tentukan model
    // Prioritas: options.model → AI_MODEL global → default hardcode
    var model = options.model
      || (typeof AI_MODEL !== 'undefined' ? AI_MODEL : 'google/gemma-4-31b-it');

    // Sanitasi messages — buang field selain role & content
    // agar tidak ada timestamp / field aneh yang dikirim ke API
    var cleanMessages = messages.map(function (m) {
      return {
        role   : String(m.role    || 'user'),
        content: String(m.content || '')
      };
    });

    // Validasi: harus ada minimal 1 pesan
    if (!cleanMessages.length) {
      return Promise.reject(new Error('Messages tidak boleh kosong.'));
    }

    // Request body
    var body = JSON.stringify({
      model      : model,
      messages   : cleanMessages,
      max_tokens : options.maxTokens   || MAX_TOKENS,
      temperature: options.temperature || TEMPERATURE,
      stream     : false
    });

    // Catat waktu mulai untuk latency
    var startTime = Date.now();

    return _fetchWithTimeout(
      OPENROUTER_ENDPOINT,
      {
        method : 'POST',
        headers: {
          'Authorization': 'Bearer ' + apiKey,
          'Content-Type' : 'application/json',
          // HTTP-Referer & X-Title wajib untuk OpenRouter
          'HTTP-Referer' : window.location.origin || 'https://simontok.app',
          'X-Title'      : 'SIMONTOK Assistant'
        },
        body   : body,
        redirect: 'follow'
      },
      REQUEST_TIMEOUT_MS
    )
    .then(function (res) {
      // ── HTTP error ──
      if (!res.ok) {
        return _parseErrorResponse(res).then(function (err) {
          _logError(err.code, err.message);

          // Pesan error yang lebih ramah untuk user
          var friendlyMsg = _friendlyError(err.code, err.message);
          throw new Error(friendlyMsg);
        });
      }
      return res.json();
    })
    .then(function (data) {
      var latencyMs = Date.now() - startTime;

      // ── Validasi struktur response OpenRouter ──
      if (!data || !data.choices || !data.choices.length) {
        _logError('EMPTY_RESPONSE', JSON.stringify(data));
        throw new Error('Response kosong dari OpenRouter. Coba lagi.');
      }

      var choice  = data.choices[0];
      var text    = choice.message && choice.message.content
        ? String(choice.message.content).trim()
        : '';

      if (!text) {
        _logError('EMPTY_CONTENT', 'finish_reason: ' + (choice.finish_reason || '?'));
        throw new Error('AI tidak menghasilkan teks. Finish reason: ' + (choice.finish_reason || 'unknown'));
      }

      // ── Update stats ──
      _stats.requestCount++;
      _stats.lastModel     = model;
      _stats.lastLatencyMs = latencyMs;
      _stats.totalTokens  += data.usage
        ? (data.usage.total_tokens || 0)
        : _estimateTokens(cleanMessages);

      console.info(
        '[AI-CLIENT] ✅ OK | model=' + model +
        ' | latency=' + latencyMs + 'ms' +
        ' | tokens=' + (data.usage ? data.usage.total_tokens : '~' + _estimateTokens(cleanMessages))
      );

      return {
        ok       : true,
        text     : text,
        model    : model,
        usage    : data.usage || null,
        latencyMs: latencyMs
      };
    });
  }

  // ============================================================
  // PRIVATE: _friendlyError
  // Ubah kode error HTTP / OpenRouter menjadi pesan ramah
  // ============================================================
  function _friendlyError(code, originalMsg) {
    var map = {
      400: '❌ Request tidak valid. Periksa konten pesan kamu.',
      401: '🔑 API Key tidak valid atau sudah kedaluwarsa. Hubungi admin.',
      402: '💳 Saldo OpenRouter habis. Hubungi admin untuk top-up.',
      403: '🚫 Akses ditolak oleh OpenRouter.',
      429: '⏳ Terlalu banyak request. Tunggu sebentar lalu coba lagi.',
      500: '🔧 Server OpenRouter sedang bermasalah. Coba lagi dalam beberapa menit.',
      502: '🔧 OpenRouter gateway error. Coba lagi.',
      503: '🔧 OpenRouter sedang maintenance. Coba lagi nanti.'
    };

    var numCode = parseInt(code, 10);
    if (map[numCode]) return map[numCode] + '\n\nDetail: ' + originalMsg;

    // Khusus model tidak ditemukan
    if (String(originalMsg).toLowerCase().includes('model')) {
      return '🤖 Model AI tidak ditemukan atau tidak tersedia. Hubungi admin.';
    }

    return '❌ Error dari AI: ' + originalMsg;
  }

  // ============================================================
  // PUBLIC: getStats
  // Kembalikan statistik pemakaian sesi ini
  // ============================================================
  function getStats() {
    return {
      requestCount : _stats.requestCount,
      totalTokens  : _stats.totalTokens,
      lastModel    : _stats.lastModel,
      lastLatencyMs: _stats.lastLatencyMs,
      errorCount   : _stats.errors.length,
      errors       : _stats.errors.slice() // copy
    };
  }

  // ============================================================
  // PUBLIC: resetStats
  // Reset statistik (biasanya dipanggil saat new session)
  // ============================================================
  function resetStats() {
    _stats.requestCount  = 0;
    _stats.totalTokens   = 0;
    _stats.lastModel     = '';
    _stats.lastLatencyMs = 0;
    _stats.errors        = [];
  }

  // ============================================================
  // EXPOSE public API
  // ============================================================
  return {
    sendChat  : sendChat,
    getApiKey : getApiKey,
    hasApiKey : hasApiKey,
    getStats  : getStats,
    resetStats: resetStats
  };

})();
```
