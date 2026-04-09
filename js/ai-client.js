// ================================================================
// SIMONTOK - AI Client
// File  : js/ai-client.js
// Versi : 1.1 (storage-compatible)
// Tanggal: 9 April 2026
//
// Deskripsi:
//   Single provider — OpenRouter
//   Model default   — google/gemma-4-31b-it (bisa di-override)
//   Kompatibel dengan SESSION di localStorage + sessionStorage
// ================================================================

var AI_CLIENT = (function () {
  'use strict';

  // ============================================================
  // KONSTANTA
  // ============================================================
  var OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
  var REQUEST_TIMEOUT_MS  = 30000; // 30 detik
  var MAX_TOKENS          = 2048;
  var TEMPERATURE         = 0.7;

  // ============================================================
  // STATE INTERNAL
  // ============================================================
  var _runtimeApiKey = '';
  var _stats = {
    requestCount : 0,
    totalTokens  : 0,
    lastModel    : '',
    lastLatencyMs: 0,
    errors       : []
  };

  // ============================================================
  // PRIVATE HELPERS
  // ============================================================
  function _safeTrim(v) {
    var s = String(v || '').trim();
    if (!s || s === 'undefined' || s === 'null') return '';
    return s;
  }

  function _readApiKeyFromSessionStorage() {
    try {
      return _safeTrim(sessionStorage.getItem('simontok-apikey'));
    } catch (e) {
      return '';
    }
  }

  function _readApiKeyFromLocalSession() {
    try {
      var raw = localStorage.getItem('simontok-session');
      if (!raw) return '';
      var obj = JSON.parse(raw);
      return _safeTrim(obj && obj.apiKey);
    } catch (e) {
      return '';
    }
  }

  function _persistApiKey(key) {
    var k = _safeTrim(key);
    if (!k) return;
    _runtimeApiKey = k;
    try { sessionStorage.setItem('simontok-apikey', k); } catch (e) {}
  }

  function _fetchWithTimeout(url, options, timeoutMs) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, timeoutMs);
    options.signal = controller.signal;

    return fetch(url, options)
      .then(function (res) {
        clearTimeout(timer);
        return res;
      })
      .catch(function (err) {
        clearTimeout(timer);
        if (err && err.name === 'AbortError') {
          throw new Error('Request timeout — server tidak merespons dalam ' + (timeoutMs / 1000) + ' detik.');
        }
        throw err;
      });
  }

  function _parseErrorResponse(res) {
    return res.text()
      .then(function (raw) {
        try {
          var body = JSON.parse(raw || '{}');
          var msg = body && body.error && body.error.message
            ? body.error.message
            : ('HTTP ' + res.status + ' ' + res.statusText);
          var code = body && body.error && body.error.code
            ? body.error.code
            : res.status;
          return { code: code, message: msg };
        } catch (e) {
          return { code: res.status, message: raw || ('HTTP ' + res.status + ' ' + res.statusText) };
        }
      })
      .catch(function () {
        return { code: res.status, message: 'HTTP ' + res.status + ' ' + res.statusText };
      });
  }

  function _logError(code, message) {
    _stats.errors.push({
      code: code,
      message: message,
      timestamp: new Date().toISOString()
    });
    if (_stats.errors.length > 20) _stats.errors.shift();
    console.warn('[AI-CLIENT] Error ' + code + ':', message);
  }

  function _estimateTokens(messages) {
    return (messages || []).reduce(function (total, m) {
      return total + Math.ceil(String(m.content || '').length / 4);
    }, 0);
  }

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

    var c = parseInt(code, 10);
    if (map[c]) return map[c] + '\n\nDetail: ' + originalMsg;

    if (String(originalMsg || '').toLowerCase().indexOf('model') !== -1) {
      return '🤖 Model AI tidak ditemukan atau tidak tersedia. Hubungi admin.';
    }

    return '❌ Error dari AI: ' + originalMsg;
  }

  // ============================================================
  // PUBLIC: API KEY
  // ============================================================
  function setApiKey(key) {
    _persistApiKey(key);
    return _runtimeApiKey;
  }

  function getApiKey() {
    // prioritas: runtime -> sessionStorage -> localStorage session
    var k = _safeTrim(_runtimeApiKey);
    if (k) return k;

    k = _readApiKeyFromSessionStorage();
    if (k) {
      _runtimeApiKey = k;
      return k;
    }

    k = _readApiKeyFromLocalSession();
    if (k) {
      _persistApiKey(k); // sekalian sinkron ke sessionStorage
      return k;
    }

    return '';
  }

  function hasApiKey() {
    return getApiKey() !== '';
  }

  // ============================================================
  // PUBLIC: sendChat(messages, options)
  // options:
  //   - apiKey       : string (override key)
  //   - model        : string
  //   - maxTokens    : number
  //   - temperature  : number
  //   - referer      : string
  //   - title        : string
  // ============================================================
  function sendChat(messages, options) {
    options = options || {};

    var explicitKey = _safeTrim(options.apiKey);
    if (explicitKey) setApiKey(explicitKey);

    var apiKey = getApiKey();
    if (!apiKey) {
      return Promise.reject(new Error('API Key tidak tersedia. Hubungi admin untuk mengisi kolom API di akun kamu.'));
    }

    var model = options.model
      || (typeof AI_MODEL !== 'undefined' ? AI_MODEL : 'google/gemma-4-31b-it');

    var cleanMessages = (Array.isArray(messages) ? messages : []).map(function (m) {
      return {
        role: String((m && m.role) || 'user'),
        content: String((m && m.content) || '')
      };
    }).filter(function (m) {
      return m.content.trim() !== '';
    });

    if (!cleanMessages.length) {
      return Promise.reject(new Error('Messages tidak boleh kosong.'));
    }

    var maxTokens = (options.maxTokens ?? MAX_TOKENS);
    var temperature = (options.temperature ?? TEMPERATURE);
    var referer = options.referer || (window.location.origin || 'https://simontok.app');
    var title = options.title || 'SIMONTOK Assistant';

    var body = JSON.stringify({
      model: model,
      messages: cleanMessages,
      max_tokens: maxTokens,
      temperature: temperature,
      stream: false
    });

    var start = Date.now();

    return _fetchWithTimeout(
      OPENROUTER_ENDPOINT,
      {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + apiKey,
          'Content-Type': 'application/json',
          'HTTP-Referer': referer,
          'X-Title': title
        },
        body: body,
        redirect: 'follow'
      },
      REQUEST_TIMEOUT_MS
    )
      .then(function (res) {
        if (!res.ok) {
          return _parseErrorResponse(res).then(function (err) {
            _logError(err.code, err.message);
            throw new Error(_friendlyError(err.code, err.message));
          });
        }
        return res.json();
      })
      .then(function (data) {
        var latencyMs = Date.now() - start;

        if (!data || !data.choices || !data.choices.length) {
          _logError('EMPTY_RESPONSE', JSON.stringify(data || {}));
          throw new Error('Response kosong dari OpenRouter. Coba lagi.');
        }

        var choice = data.choices[0] || {};
        var text = choice.message && choice.message.content
          ? String(choice.message.content).trim()
          : '';

        if (!text) {
          _logError('EMPTY_CONTENT', 'finish_reason=' + (choice.finish_reason || '?'));
          throw new Error('AI tidak menghasilkan teks. Coba lagi.');
        }

        _stats.requestCount++;
        _stats.lastModel = model;
        _stats.lastLatencyMs = latencyMs;
        _stats.totalTokens += data.usage
          ? (data.usage.total_tokens || 0)
          : _estimateTokens(cleanMessages);

        return {
          ok: true,
          text: text,
          model: model,
          usage: data.usage || null,
          latencyMs: latencyMs
        };
      });
  }

  // ============================================================
  // PUBLIC: STATS
  // ============================================================
  function getStats() {
    return {
      requestCount : _stats.requestCount,
      totalTokens  : _stats.totalTokens,
      lastModel    : _stats.lastModel,
      lastLatencyMs: _stats.lastLatencyMs,
      errorCount   : _stats.errors.length,
      errors       : _stats.errors.slice()
    };
  }

  function resetStats() {
    _stats.requestCount  = 0;
    _stats.totalTokens   = 0;
    _stats.lastModel     = '';
    _stats.lastLatencyMs = 0;
    _stats.errors        = [];
  }

  return {
    sendChat: sendChat,
    setApiKey: setApiKey,
    getApiKey: getApiKey,
    hasApiKey: hasApiKey,
    getStats: getStats,
    resetStats: resetStats
  };
})();
