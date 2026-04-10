// ================================================================
// BEKARYE - AI Client
// File  : js/ai-client.js
// Versi : 1.2 (UX improved: retry + fallback + safer payload)
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
  // KONFIG DEFAULT
  // ============================================================
  var CONFIG = {
    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    timeoutMs: 30000,
    maxTokens: 2048,
    temperature: 0.7,

    // Retry policy (untuk error sementara)
    retryMax: 2,              // total retry tambahan
    retryBaseDelayMs: 700,    // backoff awal
    retryMaxDelayMs: 4000,

    // Fallback model jika model utama unavailable
    enableModelFallback: true,
    fallbackModels: [
      'google/gemma-4-27b-it',
      'meta-llama/llama-3.1-70b-instruct'
    ],

    // Payload guard
    maxMessages: 30,
    maxCharsPerMessage: 8000,
    maxTotalChars: 50000
  };

  // ============================================================
  // STATE INTERNAL
  // ============================================================
  var _runtimeApiKey = '';
  var _activeControllers = [];
  var _stats = {
    requestCount: 0,
    totalTokens: 0,
    lastModel: '',
    lastLatencyMs: 0,
    errors: []
  };

  // ============================================================
  // PRIVATE HELPERS
  // ============================================================
  function _safeTrim(v) {
    var s = String(v || '').trim();
    if (!s || s === 'undefined' || s === 'null') return '';
    return s;
  }

  function _clamp(n, min, max) {
    n = Number(n);
    if (isNaN(n)) return min;
    return Math.max(min, Math.min(max, n));
  }

  function _sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  function _jitter(ms) {
    var j = Math.floor(Math.random() * 180); // 0..179
    return ms + j;
  }

  function _readApiKeyFromSessionStorage() {
    try {
      return _safeTrim(sessionStorage.getItem('bekarye-apikey')); // ✅ BEKARYE session
    } catch (e) {
      return '';
    }
  }

  function _readApiKeyFromLocalSession() {
    try {
      var raw = localStorage.getItem('bekarye-session'); // ✅ BEKARYE session
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
    try { sessionStorage.setItem('bekarye-apikey', k); } catch (e) {}
  }

  function _registerController(c) {
    _activeControllers.push(c);
  }

  function _removeController(c) {
    var idx = _activeControllers.indexOf(c);
    if (idx >= 0) _activeControllers.splice(idx, 1);
  }

  function _fetchWithTimeout(url, options, timeoutMs) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, timeoutMs);

    options = options || {};
    options.signal = controller.signal;

    _registerController(controller);

    return fetch(url, options)
      .then(function (res) {
        clearTimeout(timer);
        _removeController(controller);
        return res;
      })
      .catch(function (err) {
        clearTimeout(timer);
        _removeController(controller);

        if (err && err.name === 'AbortError') {
          var e = new Error('⏳ Request timeout — server tidak merespons dalam ' + (timeoutMs / 1000) + ' detik.');
          e.isTimeout = true;
          throw e;
        }

        var e2 = new Error('🌐 Gangguan jaringan. Cek koneksi internet lalu coba lagi.');
        e2.isNetwork = true;
        throw e2;
      });
  }

  function _parseRetryAfterMs(res) {
    try {
      var h = res.headers.get('retry-after');
      if (!h) return 0;
      var sec = parseInt(h, 10);
      if (!isNaN(sec) && sec > 0) return sec * 1000;
      return 0;
    } catch (e) {
      return 0;
    }
  }

  function _parseErrorResponse(res) {
    return res.text()
      .then(function (raw) {
        var parsed;
        try { parsed = JSON.parse(raw || '{}'); } catch (e) { parsed = null; }

        var msg = parsed && parsed.error && parsed.error.message
          ? parsed.error.message
          : (raw || ('HTTP ' + res.status + ' ' + res.statusText));

        var code = parsed && parsed.error && parsed.error.code
          ? parsed.error.code
          : res.status;

        return {
          status: res.status,
          code: code,
          message: String(msg || ''),
          retryAfterMs: _parseRetryAfterMs(res)
        };
      })
      .catch(function () {
        return {
          status: res.status,
          code: res.status,
          message: 'HTTP ' + res.status + ' ' + res.statusText,
          retryAfterMs: _parseRetryAfterMs(res)
        };
      });
  }

  function _logError(code, message) {
    _stats.errors.push({
      code: code,
      message: message,
      timestamp: new Date().toISOString()
    });
    if (_stats.errors.length > 25) _stats.errors.shift();
    console.warn('[AI-CLIENT] Error ' + code + ':', message);
  }

  function _estimateTokens(messages) {
    return (messages || []).reduce(function (total, m) {
      return total + Math.ceil(String((m && m.content) || '').length / 4);
    }, 0);
  }

  function _friendlyError(code, originalMsg) {
    var map = {
      400: '❌ Request tidak valid. Periksa format/isi pesan.',
      401: '🔑 API Key tidak valid atau kedaluwarsa. Hubungi admin.',
      402: '💳 Saldo OpenRouter habis. Hubungi admin untuk top-up.',
      403: '🚫 Akses ditolak oleh OpenRouter.',
      404: '🤖 Model tidak ditemukan.',
      408: '⏳ Request timeout. Coba lagi.',
      409: '⚠️ Terjadi konflik request. Coba lagi.',
      413: '📦 Payload terlalu besar. Riwayat chat akan dipersingkat.',
      429: '⏳ Terlalu banyak request. Tunggu sebentar lalu coba lagi.',
      500: '🔧 Server OpenRouter sedang bermasalah.',
      502: '🔧 Gateway error dari OpenRouter.',
      503: '🔧 OpenRouter sedang maintenance.',
      504: '⏳ Gateway timeout dari OpenRouter.'
    };

    var c = parseInt(code, 10);
    if (map[c]) return map[c] + '\n\nDetail: ' + originalMsg;

    var low = String(originalMsg || '').toLowerCase();
    if (low.indexOf('model') !== -1 && (low.indexOf('not found') !== -1 || low.indexOf('unavailable') !== -1)) {
      return '🤖 Model AI tidak tersedia saat ini. Coba lagi sebentar atau gunakan model lain.';
    }

    return '❌ Error dari AI: ' + originalMsg;
  }

  function _isRetryable(errObj, err) {
    if (err && (err.isTimeout || err.isNetwork)) return true;
    if (!errObj) return false;

    var s = parseInt(errObj.status || errObj.code, 10);
    return s === 429 || s === 500 || s === 502 || s === 503 || s === 504;
  }

  function _isModelUnavailable(errObj) {
    if (!errObj) return false;
    var s = parseInt(errObj.status || errObj.code, 10);
    var msg = String(errObj.message || '').toLowerCase();

    if (s === 404) return true;
    if (msg.indexOf('model') === -1) return false;

    return (
      msg.indexOf('not found') !== -1 ||
      msg.indexOf('unavailable') !== -1 ||
      msg.indexOf('no endpoints') !== -1 ||
      msg.indexOf('not supported') !== -1
    );
  }

  function _compactMessages(messages) {
    var arr = Array.isArray(messages) ? messages : [];

    // 1) normalize + buang kosong + trim panjang per message
    var cleaned = arr.map(function (m) {
      var role = String((m && m.role) || 'user');
      var content = String((m && m.content) || '').trim();
      if (content.length > CONFIG.maxCharsPerMessage) {
        content = content.slice(0, CONFIG.maxCharsPerMessage) + '\n\n[...dipotong otomatis]';
      }
      return { role: role, content: content };
    }).filter(function (m) {
      return m.content !== '';
    });

    // 2) merge consecutive same role (hemat token)
    var merged = [];
    cleaned.forEach(function (m) {
      var last = merged.length ? merged[merged.length - 1] : null;
      if (last && last.role === m.role) {
        last.content += '\n' + m.content;
      } else {
        merged.push({ role: m.role, content: m.content });
      }
    });

    // 3) batasi jumlah message
    if (merged.length > CONFIG.maxMessages) {
      merged = merged.slice(merged.length - CONFIG.maxMessages);
    }

    // 4) batasi total karakter dari belakang
    var total = 0;
    var kept = [];
    for (var i = merged.length - 1; i >= 0; i--) {
      var c = merged[i].content.length;
      if ((total + c) > CONFIG.maxTotalChars) break;
      kept.unshift(merged[i]);
      total += c;
    }

    return kept;
  }

  // ============================================================
  // PUBLIC: API KEY
  // ============================================================
  function setApiKey(key) {
    _persistApiKey(key);
    return _runtimeApiKey;
  }

  function getApiKey() {
    var k = _safeTrim(_runtimeApiKey);
    if (k) return k;

    k = _readApiKeyFromSessionStorage();
    if (k) {
      _runtimeApiKey = k;
      return k;
    }

    k = _readApiKeyFromLocalSession();
    if (k) {
      _persistApiKey(k);
      return k;
    }

    // ⬇️ MIGRATION: fallback ke simontok-session jika bekarye-session kosong
    try {
      if (!k) {
        var oldSession = localStorage.getItem('simontok-session');
        if (oldSession) {
          var obj = JSON.parse(oldSession);
          k = _safeTrim(obj && obj.apiKey);
          if (k) {
            _persistApiKey(k);
            console.log('✅ API Key berhasil dimigrasi dari SIMONTOK ke BEKARYE');
          }
        }
      }
    } catch(e) {
      console.error('Error migrasi API Key:', e);
    }

    return k;
  }

  function hasApiKey() {
    return getApiKey() !== '';
  }

  // ============================================================
  // PRIVATE: eksekusi 1 request model (dengan retry)
  // ============================================================
  function _sendOneModel(cleanMessages, options, model, attemptBase) {
    var apiKey = options.apiKey;
    var referer = options.referer || (window.location.origin || 'https://bekarye.app'); // ⬇️ BEKARYE domain
    var title = options.title || 'BEKARYE Assistant';
    var maxTokens = _clamp(
      (typeof options.maxTokens === 'number' ? options.maxTokens : CONFIG.maxTokens),
      64,
      4096
    );
    var temperature = _clamp(
      (typeof options.temperature === 'number' ? options.temperature : CONFIG.temperature),
      0,
      1.5
    );

    var payload = {
      model: model,
      messages: cleanMessages,
      max_tokens: maxTokens,
      temperature: temperature,
      stream: false
    };

    var start = Date.now();

    function runAttempt(retryIndex, lastErrObj) {
      return _fetchWithTimeout(
        CONFIG.endpoint,
        {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + apiKey,
            'Content-Type': 'application/json',
            'HTTP-Referer': referer,
            'X-Title': title
          },
          body: JSON.stringify(payload),
          redirect: 'follow'
        },
        CONFIG.timeoutMs
      )
        .then(function (res) {
          if (!res.ok) {
            return _parseErrorResponse(res).then(function (errObj) {
              var retryable = _isRetryable(errObj, null);
              if (retryable && retryIndex < CONFIG.retryMax) {
                var waitMs = errObj.retryAfterMs || Math.min(
                  CONFIG.retryMaxDelayMs,
                  CONFIG.retryBaseDelayMs * Math.pow(2, retryIndex)
                );
                waitMs = _jitter(waitMs);
                return _sleep(waitMs).then(function () {
                  return runAttempt(retryIndex + 1, errObj);
                });
              }

              throw {
                isApiError: true,
                errObj: errObj
              };
            });
          }

          return res.json().then(function (data) {
            var latencyMs = Date.now() - start;
            if (!data || !data.choices || !data.choices.length) {
              throw new Error('Response kosong dari OpenRouter. Coba lagi.');
            }

            var choice = data.choices[0] || {};
            var text = choice.message && choice.message.content
              ? String(choice.message.content).trim()
              : '';

            if (!text) {
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
              latencyMs: latencyMs,
              attempts: retryIndex + 1 + attemptBase
            };
          });
        })
        .catch(function (err) {
          // Network/timeout path
          if (err && (err.isTimeout || err.isNetwork)) {
            if (retryIndex < CONFIG.retryMax) {
              var waitMs2 = Math.min(
                CONFIG.retryMaxDelayMs,
                CONFIG.retryBaseDelayMs * Math.pow(2, retryIndex)
              );
              waitMs2 = _jitter(waitMs2);
              return _sleep(waitMs2).then(function () {
                return runAttempt(retryIndex + 1, lastErrObj || null);
              });
            }

            _logError('NETWORK_OR_TIMEOUT', err.message || 'Network/timeout');
            throw new Error(err.message || 'Gangguan jaringan.');
          }

          // API error object wrapper
          if (err && err.isApiError && err.errObj) {
            _logError(err.errObj.code, err.errObj.message);
            throw err;
          }

          // Unknown
          _logError('UNKNOWN', err && err.message ? err.message : 'Unknown error');
          throw new Error((err && err.message) ? err.message : 'Terjadi kesalahan tak terduga.');
        });
    }

    return runAttempt(0, null);
  }

  // ============================================================
  // PUBLIC: sendChat(messages, options)
  // options:
  //   - apiKey, model, maxTokens, temperature, referer, title
  //   - fallbackModels: array
  // ============================================================
  function sendChat(messages, options) {
    options = options || {};

    var explicitKey = _safeTrim(options.apiKey);
    if (explicitKey) setApiKey(explicitKey);

    var apiKey = getApiKey();
    if (!apiKey) {
      return Promise.reject(new Error('API Key tidak tersedia. Hubungi admin untuk mengisi API Key akun BEKARYE Anda.'));
    }

    var chosenModel = options.model || (typeof AI_MODEL !== 'undefined' ? AI_MODEL : 'google/gemma-4-31b-it');

    var cleanMessages = _compactMessages(messages);
    if (!cleanMessages.length) {
      return Promise.reject(new Error('Pesan kosong. Silakan tulis pertanyaan dulu.'));
    }

    var modelsToTry = [chosenModel];
    if (CONFIG.enableModelFallback) {
      var fromOpt = Array.isArray(options.fallbackModels) ? options.fallbackModels : CONFIG.fallbackModels;
      (fromOpt || []).forEach(function (m) {
        m = _safeTrim(m);
        if (m && modelsToTry.indexOf(m) === -1) modelsToTry.push(m);
      });
    }

    function tryModelAt(idx, cumulativeAttempts) {
      var model = modelsToTry[idx];
      var requestOpts = {
        apiKey: apiKey,
        model: model,
        maxTokens: options.maxTokens,
        temperature: options.temperature,
        referer: options.referer,
        title: options.title
      };

      return _sendOneModel(cleanMessages, requestOpts, model, cumulativeAttempts)
        .catch(function (err) {
          // Jika model unavailable, lanjut fallback model berikutnya
          if (err && err.isApiError && _isModelUnavailable(err.errObj) && (idx < modelsToTry.length - 1)) {
            console.warn('[AI-CLIENT] Model "' + model + '" unavailable. Fallback ke "' + modelsToTry[idx + 1] + '".');
            return tryModelAt(idx + 1, cumulativeAttempts + (CONFIG.retryMax + 1));
          }

          if (err && err.isApiError && err.errObj) {
            throw new Error(_friendlyError(err.errObj.code, err.errObj.message));
          }

          throw err;
        });
    }

    return tryModelAt(0, 0);
  }

  // ============================================================
  // PUBLIC: CONFIG & CONTROL
  // ============================================================
  function setConfig(partial) {
    partial = partial || {};
    Object.keys(partial).forEach(function (k) {
      if (CONFIG.hasOwnProperty(k)) CONFIG[k] = partial[k];
    });

    // normalize minimum
    CONFIG.timeoutMs = _clamp(CONFIG.timeoutMs, 5000, 120000);
    CONFIG.maxTokens = _clamp(CONFIG.maxTokens, 64, 4096);
    CONFIG.temperature = _clamp(CONFIG.temperature, 0, 1.5);
    CONFIG.retryMax = _clamp(CONFIG.retryMax, 0, 5);
    CONFIG.retryBaseDelayMs = _clamp(CONFIG.retryBaseDelayMs, 100, 10000);
    CONFIG.retryMaxDelayMs = _clamp(CONFIG.retryMaxDelayMs, 300, 15000);
    CONFIG.maxMessages = _clamp(CONFIG.maxMessages, 5, 80);
    CONFIG.maxCharsPerMessage = _clamp(CONFIG.maxCharsPerMessage, 300, 50000);
    CONFIG.maxTotalChars = _clamp(CONFIG.maxTotalChars, 2000, 200000);

    return getConfig();
  }

  function getConfig() {
    return JSON.parse(JSON.stringify(CONFIG));
  }

  function abortAll() {
    _activeControllers.slice().forEach(function (c) {
      try { c.abort(); } catch (e) {}
    });
    _activeControllers = [];
  }

  // ============================================================
  // PUBLIC: STATS
  // ============================================================
  function getStats() {
    return {
      requestCount: _stats.requestCount,
      totalTokens: _stats.totalTokens,
      lastModel: _stats.lastModel,
      lastLatencyMs: _stats.lastLatencyMs,
      errorCount: _stats.errors.length,
      errors: _stats.errors.slice()
    };
  }

  function resetStats() {
    _stats.requestCount =0;
    _stats.totalTokens =0;
    _stats.lastModel = '';
    _stats.lastLatencyMs =0;
    _stats.errors = [];
  }

  return {
    // core
    sendChat: sendChat,

    // key
    setApiKey: setApiKey,
    getApiKey: getApiKey,
    hasApiKey: hasApiKey,

    // control/config
    setConfig: setConfig,
    getConfig: getConfig,
    abortAll: abortAll,

    // stats
    getStats: getStats,
    resetStats: resetStats
  };
})();
