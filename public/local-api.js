// Chat Buddy local API.
//
// The app used to talk to a Node/Express backend (accounts, per-user database,
// PDF/DOCX parsing, OCR, object detection). This file replaces that backend
// with an in-browser implementation so the whole app can be hosted as static
// files on GitHub Pages: it intercepts every fetch('/api/...') call the UI makes
// and answers it from IndexedDB on this device. There are no accounts and no
// server — everything a visitor saves stays in their own browser.
//
// The route shapes mirror server.js/db.js/docQA.js one-to-one, so the UI code
// didn't have to change. Features that need a paid API key and a server
// (LLM chat, image generation/editing) report "not available" instead.
(function () {
  'use strict';

  var DB_NAME = 'chatBuddyLocal';
  var STATE_KEY = 'main';
  var MAX_FILE_BYTES = 10 * 1024 * 1024;
  var MAX_TEXT_CHARS = 200000;
  var DOC_EXTENSIONS = ['pdf', 'docx', 'txt'];
  var IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'bmp', 'gif'];
  var MIME_TYPES = {
    pdf: 'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    txt: 'text/plain',
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', bmp: 'image/bmp'
  };
  var AVATARS = ['🤖', '🦊', '🐼', '🐸', '🐙', '🦉', '🐳', '🦄', '🐝', '🦁'];
  var PROVIDERS = [
    { id: 'anthropic', label: 'Anthropic', models: [{ id: 'claude-sonnet-5', label: 'Claude Sonnet 5' }, { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' }] },
    { id: 'openai', label: 'OpenAI', models: [{ id: 'gpt-5', label: 'GPT-5' }, { id: 'gpt-5-mini', label: 'GPT-5 mini' }] }
  ];
  var NO_BACKEND = 'This needs an API key and a server, which the GitHub-hosted version of Chat Buddy doesn\'t have.';

  // ---------- helpers ----------

  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }
  function nowIso() { return new Date().toISOString(); }
  function extOf(name) { return (name.split('.').pop() || '').toLowerCase(); }

  // ---------- storage (IndexedDB, with an in-memory fallback) ----------

  var db = null;          // IDBDatabase, or null when IndexedDB is unavailable
  var memoryBlobs = {};   // fallback blob store
  var state = null;

  function openDb() {
    return new Promise(function (resolve) {
      try {
        var req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = function () {
          req.result.createObjectStore('kv');
          req.result.createObjectStore('blobs');
        };
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { resolve(null); };
        req.onblocked = function () { resolve(null); };
      } catch (e) { resolve(null); }
    });
  }
  function idb(store, mode, fn) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(store, mode);
      var result = fn(tx.objectStore(store));
      tx.oncomplete = function () { resolve(result && result.result); };
      tx.onerror = tx.onabort = function () { reject(tx.error); };
    });
  }

  function freshState() {
    var now = nowIso();
    return {
      createdAt: now,
      profile: {
        displayName: 'You',
        avatar: AVATARS[Math.floor(Math.random() * AVATARS.length)],
        theme: 'light',
        defaultProvider: null,
        defaultModel: null,
        defaultSystemPrompt: null
      },
      folders: [],
      conversations: [],
      files: [],
      promptTemplates: [],
      knowledge: []
    };
  }

  var saveTimer = null;
  var saving = Promise.resolve();
  function saveNow() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    if (!db) return saving;
    saving = saving.then(function () {
      return idb('kv', 'readwrite', function (s) { return s.put(state, STATE_KEY); });
    }).catch(function (e) { console.warn('Chat Buddy: could not save to this device.', e); });
    return saving;
  }
  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 150);
  }
  window.addEventListener('pagehide', saveNow);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') saveNow();
  });

  function putBlob(id, blob) {
    if (!db) { memoryBlobs[id] = blob; return Promise.resolve(); }
    return idb('blobs', 'readwrite', function (s) { return s.put(blob, id); });
  }
  function getBlob(id) {
    if (!db) return Promise.resolve(memoryBlobs[id] || null);
    return idb('blobs', 'readonly', function (s) { return s.get(id); }).then(function (b) { return b || null; });
  }

  var ready = (async function init() {
    db = await openDb();
    if (db) {
      try { state = await idb('kv', 'readonly', function (s) { return s.get(STATE_KEY); }); } catch (e) { state = null; }
    }
    if (!state) { state = freshState(); await saveNow(); }
    // Ask the browser not to evict this data under storage pressure.
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) { /* best effort */ }
  })();

  // ---------- keyword Q&A (port of docQA.js) ----------

  var STOPWORDS = new Set([
    'the', 'is', 'a', 'an', 'of', 'to', 'and', 'in', 'on', 'for', 'what', 'does',
    'do', 'did', 'say', 'about', 'tell', 'me', 'file', 'document', 'that', 'this',
    'it', 'was', 'were', 'are', 'be', 'been', 'being', 'with', 'as', 'at', 'from',
    'my', 'your', 'our', 'their', 'his', 'her', 'its', 'i', 'you', 'we', 'they',
    'he', 'she', 'him', 'them', 'us',
    'how', 'many', 'much', 'have', 'has', 'had', 'get', 'got', 'can', 'could',
    'would', 'should', 'will', 'shall', 'may', 'might', 'must', 'who', 'whom',
    'which', 'when', 'why', 'where', 'if', 'than', 'then', 'so', 'but', 'or',
    'not', 'no', 'yes', 'please', 'there', 'here', 'also', 'just', 'by'
  ]);
  var MAX_ANSWER_LENGTH = 400;

  function chunkText(text) {
    return (text || '').split(/(?<=[.!?])\s+|\r?\n+/).map(function (s) { return s.trim(); }).filter(Boolean);
  }
  function normalizeWord(w) {
    if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
    return w;
  }
  function words(text) {
    return (text.toLowerCase().match(/[a-z]+|[0-9]+/g) || [])
      .filter(function (w) { return !STOPWORDS.has(w); })
      .filter(function (w) { return w.length > 1 || /^[0-9]$/.test(w); })
      .map(normalizeWord);
  }
  function minOverlapRequired(n) {
    if (n <= 1) return 1;
    return Math.max(2, Math.ceil(n / 2));
  }
  function findAnswerKeyword(files, question) {
    var qWords = words(question);
    if (!qWords.length) return null;
    var minRequired = minOverlapRequired(qWords.length);
    var best = null;
    files.forEach(function (f) {
      chunkText(f.text).forEach(function (s) {
        var sWords = words(s);
        if (!sWords.length) return;
        var overlap = qWords.filter(function (w) { return sWords.indexOf(w) !== -1; }).length;
        if (overlap < minRequired) return;
        var ratio = overlap / sWords.length;
        if (!best || overlap > best.overlap || (overlap === best.overlap && ratio > best.ratio)) {
          best = { overlap: overlap, ratio: ratio, sentence: s, file: f.name };
        }
      });
    });
    if (best && best.sentence.length > MAX_ANSWER_LENGTH) best.sentence = best.sentence.slice(0, MAX_ANSWER_LENGTH) + '…';
    return best;
  }

  // ---------- lazy-loaded browser libraries (PDF / DOCX / OCR / object detection) ----------

  var scriptCache = {};
  function loadScript(src) {
    if (!scriptCache[src]) {
      scriptCache[src] = new Promise(function (resolve, reject) {
        var s = document.createElement('script');
        s.src = src;
        s.onload = resolve;
        s.onerror = function () { delete scriptCache[src]; reject(new Error('Could not load ' + src)); };
        document.head.appendChild(s);
      });
    }
    return scriptCache[src];
  }

  var PDFJS_BASE = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/';
  async function extractPdfText(file) {
    await loadScript(PDFJS_BASE + 'pdf.min.js');
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_BASE + 'pdf.worker.min.js';
    var pdf = await window.pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    var out = [];
    for (var p = 1; p <= pdf.numPages; p++) {
      var content = await (await pdf.getPage(p)).getTextContent();
      var line = '';
      content.items.forEach(function (item) {
        line += item.str;
        if (item.hasEOL) { out.push(line); line = ''; }
      });
      if (line) out.push(line);
    }
    // Same cleanup the server did: collapse runs of spaces from column gaps
    // while keeping line breaks as the paragraph boundary.
    return out.map(function (l) { return l.replace(/[ \t]+/g, ' ').trim(); }).join('\n');
  }

  async function extractDocxText(file) {
    await loadScript('https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js');
    return (await window.mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() })).value;
  }

  var ocrWorkerPromise = null;
  function getOcrWorker() {
    if (!ocrWorkerPromise) {
      ocrWorkerPromise = loadScript('https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js')
        .then(function () { return window.Tesseract.createWorker('eng'); })
        .catch(function (e) { ocrWorkerPromise = null; throw e; });
    }
    return ocrWorkerPromise;
  }

  var cocoPromise = null;
  function getCocoModel() {
    if (!cocoPromise) {
      cocoPromise = loadScript('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js')
        .then(function () { return loadScript('https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd@2.2.3/dist/coco-ssd.min.js'); })
        .then(function () { return window.cocoSsd.load(); })
        .catch(function (e) { cocoPromise = null; throw e; });
    }
    return cocoPromise;
  }

  // ---------- image analysis (port of analyzeImageFile in server.js) ----------

  var NAMED_COLORS = [
    ['red', 220, 20, 20], ['orange', 230, 130, 30], ['yellow', 220, 210, 30], ['green', 40, 160, 60],
    ['cyan', 40, 190, 200], ['blue', 40, 80, 210], ['purple', 130, 50, 180], ['pink', 230, 130, 180],
    ['brown', 110, 70, 40], ['white', 240, 240, 240], ['gray', 130, 130, 130], ['black', 20, 20, 20]
  ];
  function closestColorName(r, g, b) {
    var best = null, bestDist = Infinity;
    NAMED_COLORS.forEach(function (c) {
      var d = Math.pow(r - c[1], 2) + Math.pow(g - c[2], 2) + Math.pow(b - c[3], 2);
      if (d < bestDist) { bestDist = d; best = c[0]; }
    });
    return best;
  }
  function generateCaption(objectCounts, objectsKnown, ocrText, colorName, brightnessLabel) {
    var parts = [];
    var names = Object.keys(objectCounts);
    if (names.length) {
      var described = names.map(function (name) {
        var n = objectCounts[name];
        return n > 1 ? n + ' ' + name + 's' : 'a ' + name;
      });
      parts.push('This image appears to contain ' + described.join(', ') + '.');
    } else if (objectsKnown) {
      parts.push('No specific objects were confidently recognized in this image.');
    }
    parts.push('It is predominantly ' + colorName + ' and ' + brightnessLabel + '.');
    if (ocrText && ocrText.trim()) parts.push('It also contains visible text.');
    return parts.join(' ');
  }
  function loadImage(blob) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(blob);
      var img = new Image();
      img.onload = function () { resolve({ img: img, url: url }); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('unreadable image')); };
      img.src = url;
    });
  }

  async function analyzeImage(file) {
    var loaded = await loadImage(file);
    try {
      var img = loaded.img;
      var width = img.naturalWidth, height = img.naturalHeight;

      // Average colour on a downscaled copy — same result, far cheaper.
      var scale = Math.min(1, 200 / Math.max(width, height));
      var canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      var ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      var data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      var r = 0, g = 0, b = 0, count = 0;
      for (var i = 0; i < data.length; i += 4) { r += data[i]; g += data[i + 1]; b += data[i + 2]; count++; }
      r = Math.round(r / count); g = Math.round(g / count); b = Math.round(b / count);
      var brightness = (r * 299 + g * 587 + b * 114) / 1000;
      var brightnessLabel = brightness > 180 ? 'bright' : brightness > 90 ? 'medium brightness' : 'dark';
      var colorName = closestColorName(r, g, b);
      var hex = '#' + [r, g, b].map(function (v) { return v.toString(16).padStart(2, '0'); }).join('');

      // OCR and object detection download a few MB of model data on first use.
      // If either can't load (offline, blocked), the upload still succeeds with
      // whatever did work rather than failing outright.
      var ocrText = '';
      try {
        var worker = await getOcrWorker();
        ocrText = (((await worker.recognize(file)).data || {}).text || '').trim();
      } catch (e) { console.warn('Chat Buddy: OCR unavailable.', e); }

      var predictions = [];
      var objectsKnown = false;
      try {
        var model = await getCocoModel();
        predictions = await model.detect(img, 10, 0.5);
        objectsKnown = true;
      } catch (e) { console.warn('Chat Buddy: object detection unavailable.', e); }

      var objectCounts = {};
      predictions.forEach(function (p) { objectCounts[p.class] = (objectCounts[p.class] || 0) + 1; });
      var caption = generateCaption(objectCounts, objectsKnown, ocrText, colorName, brightnessLabel);
      var objectSummary = Object.keys(objectCounts).map(function (n) {
        return n + (objectCounts[n] > 1 ? ' (x' + objectCounts[n] + ')' : '');
      }).join(', ');
      var searchableText = [
        caption,
        objectSummary ? 'Detected objects: ' + objectSummary + '.' : '',
        ocrText ? 'Text found in image: ' + ocrText : ''
      ].filter(Boolean).join('\n');

      return {
        width: width, height: height, hex: hex, colorName: colorName, brightnessLabel: brightnessLabel,
        ocrText: ocrText,
        objects: predictions.map(function (p) { return { class: p.class, score: p.score }; }),
        caption: caption, searchableText: searchableText
      };
    } finally {
      URL.revokeObjectURL(loaded.url);
    }
  }

  // ---------- routes ----------

  function json(status, body) { return { status: status, body: body }; }
  function findConv(id) { return state.conversations.find(function (c) { return c.id === id; }); }
  function stripHtml(html) { return (html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); }
  function toFileResponse(f) {
    return { id: f.id, name: f.name, type: f.type, size: f.size, uploadedAt: f.uploadedAt, meta: f.meta };
  }
  function toKnowledgeResponse(k) {
    return { id: k.id, title: k.title, content: k.content, createdAt: k.createdAt, updatedAt: k.updatedAt };
  }

  var routes = [];
  function route(method, pattern, handler) {
    routes.push({ method: method, regex: new RegExp('^' + pattern.replace(/:[a-zA-Z]+/g, '([^/]+)') + '$'), handler: handler });
  }

  // profile
  route('GET', '/api/profile', function () {
    return json(200, Object.assign({}, state.profile, { username: state.profile.displayName, createdAt: state.createdAt }));
  });
  route('PUT', '/api/profile', function (ctx) {
    var b = ctx.body || {}, patch = {};
    if (typeof b.displayName === 'string' && b.displayName.trim()) patch.displayName = b.displayName.trim().slice(0, 40);
    if (typeof b.avatar === 'string') patch.avatar = b.avatar.slice(0, 8);
    if (b.theme === 'light' || b.theme === 'dark') patch.theme = b.theme;
    if (b.defaultProvider === null || typeof b.defaultProvider === 'string') patch.defaultProvider = b.defaultProvider;
    if (b.defaultModel === null || typeof b.defaultModel === 'string') patch.defaultModel = b.defaultModel;
    if (b.defaultSystemPrompt === null) patch.defaultSystemPrompt = null;
    else if (typeof b.defaultSystemPrompt === 'string') patch.defaultSystemPrompt = b.defaultSystemPrompt.slice(0, 4000);
    state.profile = Object.assign({}, state.profile, patch);
    scheduleSave();
    return json(200, state.profile);
  });

  // folders
  route('GET', '/api/folders', function () { return json(200, { folders: state.folders }); });
  route('POST', '/api/folders', function (ctx) {
    var name = ((ctx.body || {}).name || '').trim();
    if (!name) return json(400, { error: 'Folder name is required.' });
    var folder = { id: uuid(), name: name.slice(0, 40) };
    state.folders.push(folder);
    scheduleSave();
    return json(200, { folder: folder });
  });
  route('PATCH', '/api/folders/:id', function (ctx) {
    var name = ((ctx.body || {}).name || '').trim();
    if (!name) return json(400, { error: 'Folder name is required.' });
    var folder = state.folders.find(function (f) { return f.id === ctx.params[0]; });
    if (!folder) return json(404, { error: 'Not found' });
    folder.name = name.slice(0, 40);
    scheduleSave();
    return json(200, { ok: true });
  });
  route('DELETE', '/api/folders/:id', function (ctx) {
    state.folders = state.folders.filter(function (f) { return f.id !== ctx.params[0]; });
    state.conversations.forEach(function (c) { if (c.folderId === ctx.params[0]) c.folderId = null; });
    scheduleSave();
    return json(200, { ok: true });
  });

  // conversations
  route('GET', '/api/conversations', function () {
    var list = state.conversations.map(function (c) {
      var last = c.history[c.history.length - 1];
      return {
        id: c.id, title: c.title, folderId: c.folderId, createdAt: c.createdAt, updatedAt: c.updatedAt,
        preview: last ? (last.text || '').slice(0, 60) : ''
      };
    }).sort(function (a, b) { return new Date(b.updatedAt) - new Date(a.updatedAt); });
    return json(200, { conversations: list });
  });
  route('POST', '/api/conversations', function (ctx) {
    var now = nowIso();
    var conversation = {
      id: uuid(), title: (ctx.body || {}).title || 'New Chat', folderId: null, history: [], userName: null,
      notes: [], provider: null, model: null, systemPrompt: null, createdAt: now, updatedAt: now
    };
    state.conversations.push(conversation);
    scheduleSave();
    return json(200, { conversation: conversation });
  });
  route('GET', '/api/conversations/:id', function (ctx) {
    var c = findConv(ctx.params[0]);
    return c ? json(200, { conversation: c }) : json(404, { error: 'Not found' });
  });
  route('PUT', '/api/conversations/:id', function (ctx) {
    var c = findConv(ctx.params[0]);
    if (!c) return json(404, { error: 'Not found' });
    var b = ctx.body || {}, patch = {};
    if (Array.isArray(b.history)) patch.history = b.history;
    if (b.userName === null || typeof b.userName === 'string') patch.userName = b.userName;
    if (Array.isArray(b.notes)) patch.notes = b.notes;
    if (b.provider === null || typeof b.provider === 'string') patch.provider = b.provider;
    if (b.model === null || typeof b.model === 'string') patch.model = b.model;
    if (b.systemPrompt === null) patch.systemPrompt = null;
    else if (typeof b.systemPrompt === 'string') patch.systemPrompt = b.systemPrompt.slice(0, 4000);
    Object.assign(c, patch, { updatedAt: nowIso() });
    scheduleSave();
    return json(200, { ok: true });
  });
  route('PATCH', '/api/conversations/:id', function (ctx) {
    var c = findConv(ctx.params[0]);
    if (!c) return json(404, { error: 'Not found' });
    var b = ctx.body || {}, patch = {};
    if (typeof b.title === 'string' && b.title.trim()) patch.title = b.title.trim().slice(0, 60);
    if (b.folderId === null || typeof b.folderId === 'string') patch.folderId = b.folderId;
    Object.assign(c, patch, { updatedAt: nowIso() });
    scheduleSave();
    return json(200, { ok: true });
  });
  route('DELETE', '/api/conversations/:id', function (ctx) {
    var before = state.conversations.length;
    state.conversations = state.conversations.filter(function (c) { return c.id !== ctx.params[0]; });
    if (state.conversations.length === before) return json(404, { error: 'Not found' });
    scheduleSave();
    return json(200, { ok: true });
  });

  route('GET', '/api/search', function (ctx) {
    var q = (ctx.query.get('q') || '').trim().toLowerCase();
    if (!q) return json(200, { results: [] });
    var results = [];
    state.conversations.forEach(function (c) {
      c.history.forEach(function (entry) {
        var plain = entry.type === 'html' ? stripHtml(entry.html) : (entry.text || '');
        var idx = plain.toLowerCase().indexOf(q);
        if (idx === -1) return;
        var start = Math.max(0, idx - 30);
        var snippet = (start > 0 ? '…' : '') + plain.slice(start, idx + q.length + 30) +
          (idx + q.length + 30 < plain.length ? '…' : '');
        results.push({ conversationId: c.id, conversationTitle: c.title, sender: entry.sender, time: entry.time, snippet: snippet });
      });
    });
    return json(200, { results: results.slice(0, 50) });
  });

  // prompt templates
  route('GET', '/api/prompt-templates', function () { return json(200, { templates: state.promptTemplates }); });
  route('POST', '/api/prompt-templates', function (ctx) {
    var b = ctx.body || {};
    if (!b.name || !b.name.trim()) return json(400, { error: 'Template name is required.' });
    if (!b.systemPrompt || !b.systemPrompt.trim()) return json(400, { error: 'System prompt is required.' });
    var template = { id: uuid(), name: b.name.trim().slice(0, 60), systemPrompt: b.systemPrompt.trim().slice(0, 4000), createdAt: nowIso() };
    state.promptTemplates.push(template);
    scheduleSave();
    return json(200, { template: template });
  });
  route('PATCH', '/api/prompt-templates/:id', function (ctx) {
    var t = state.promptTemplates.find(function (x) { return x.id === ctx.params[0]; });
    if (!t) return json(404, { error: 'Not found' });
    var b = ctx.body || {};
    if (typeof b.name === 'string' && b.name.trim()) t.name = b.name.trim().slice(0, 60);
    if (typeof b.systemPrompt === 'string' && b.systemPrompt.trim()) t.systemPrompt = b.systemPrompt.trim().slice(0, 4000);
    scheduleSave();
    return json(200, { ok: true });
  });
  route('DELETE', '/api/prompt-templates/:id', function (ctx) {
    var before = state.promptTemplates.length;
    state.promptTemplates = state.promptTemplates.filter(function (t) { return t.id !== ctx.params[0]; });
    if (state.promptTemplates.length === before) return json(404, { error: 'Not found' });
    scheduleSave();
    return json(200, { ok: true });
  });

  // knowledge base
  route('GET', '/api/knowledge', function () { return json(200, { knowledge: state.knowledge.map(toKnowledgeResponse) }); });
  route('POST', '/api/knowledge', function (ctx) {
    var b = ctx.body || {};
    if (!b.title || !b.title.trim()) return json(400, { error: 'Title is required.' });
    if (!b.content || !b.content.trim()) return json(400, { error: 'Content is required.' });
    var now = nowIso();
    var record = { id: uuid(), title: b.title.trim().slice(0, 120), content: b.content.trim().slice(0, 50000), createdAt: now, updatedAt: now };
    state.knowledge.push(record);
    scheduleSave();
    return json(200, { knowledge: toKnowledgeResponse(record) });
  });
  route('PUT', '/api/knowledge/:id', function (ctx) {
    var b = ctx.body || {};
    if (!b.title || !b.title.trim()) return json(400, { error: 'Title is required.' });
    if (!b.content || !b.content.trim()) return json(400, { error: 'Content is required.' });
    var record = state.knowledge.find(function (k) { return k.id === ctx.params[0]; });
    if (!record) return json(404, { error: 'Not found' });
    record.title = b.title.trim().slice(0, 120);
    record.content = b.content.trim().slice(0, 50000);
    record.updatedAt = nowIso();
    scheduleSave();
    return json(200, { knowledge: toKnowledgeResponse(record) });
  });
  route('DELETE', '/api/knowledge/:id', function (ctx) {
    var before = state.knowledge.length;
    state.knowledge = state.knowledge.filter(function (k) { return k.id !== ctx.params[0]; });
    if (state.knowledge.length === before) return json(404, { error: 'Not found' });
    scheduleSave();
    return json(200, { ok: true });
  });

  // files
  route('POST', '/api/files', async function (ctx) {
    var file = ctx.form && ctx.form.get('file');
    var ext = file && file.name ? extOf(file.name) : '';
    if (!file || DOC_EXTENSIONS.concat(IMAGE_EXTENSIONS).indexOf(ext) === -1) {
      return json(400, { error: 'No file uploaded, or unsupported type (only PDF, DOCX, TXT, JPG, PNG, GIF, BMP allowed).' });
    }
    if (file.size > MAX_FILE_BYTES) return json(400, { error: 'That file is too large — 10MB max.' });
    try {
      var record = { id: uuid(), name: file.name, type: ext, size: file.size, uploadedAt: nowIso() };
      if (IMAGE_EXTENSIONS.indexOf(ext) !== -1) {
        var a = await analyzeImage(file);
        record.text = a.searchableText.slice(0, MAX_TEXT_CHARS);
        record.meta = {
          width: a.width, height: a.height, hex: a.hex, colorName: a.colorName, brightnessLabel: a.brightnessLabel,
          caption: a.caption, objects: a.objects, ocrText: a.ocrText
        };
      } else if (ext === 'txt') {
        record.text = (await file.text()).slice(0, MAX_TEXT_CHARS);
      } else if (ext === 'pdf') {
        record.text = (await extractPdfText(file)).slice(0, MAX_TEXT_CHARS);
      } else {
        record.text = (await extractDocxText(file)).slice(0, MAX_TEXT_CHARS);
      }
      await putBlob(record.id, new Blob([file], { type: MIME_TYPES[ext] || file.type }));
      state.files.push(record);
      scheduleSave();
      return json(200, { file: toFileResponse(record) });
    } catch (e) {
      console.error(e);
      return json(500, { error: 'Could not read that file. It may be corrupted, in an unsupported format, or the reader could not be loaded (check your connection).' });
    }
  });
  route('GET', '/api/files', function () { return json(200, { files: state.files.map(toFileResponse) }); });
  route('GET', '/api/files/:id/download', async function (ctx) {
    var record = state.files.find(function (f) { return f.id === ctx.params[0]; });
    var blob = record && await getBlob(record.id);
    if (!blob) return { status: 404, empty: true };
    return { status: 200, blob: blob };
  });
  route('GET', '/api/files/:id', function (ctx) {
    var f = state.files.find(function (x) { return x.id === ctx.params[0]; });
    return f ? json(200, { id: f.id, name: f.name, type: f.type, text: f.text, meta: f.meta }) : json(404, { error: 'Not found' });
  });
  route('POST', '/api/ask-files', function (ctx) {
    var question = (ctx.body || {}).question;
    if (!question) return json(400, { error: 'Missing question' });
    if (!state.files.length) return json(200, { answer: null });
    var match = findAnswerKeyword(state.files, question);
    return json(200, match ? { answer: match.sentence, source: match.file } : { answer: null });
  });

  // AI features that need API keys + a server: reported as unavailable so the
  // UI falls back to the built-in rule-based bot.
  route('GET', '/api/ai/config', function () {
    return json(200, { providers: PROVIDERS, configured: { anthropic: false, openai: false } });
  });
  route('POST', '/api/chat', function () { return json(501, { error: NO_BACKEND }); });
  route('POST', '/api/images/generate', function () { return json(501, { error: NO_BACKEND }); });
  route('POST', '/api/images/:id/:action', function () { return json(501, { error: NO_BACKEND }); });

  // wipe everything stored on this device
  route('DELETE', '/api/local-data', async function () {
    state = freshState();
    memoryBlobs = {};
    if (db) {
      await idb('blobs', 'readwrite', function (s) { return s.clear(); });
    }
    await saveNow();
    return json(200, { ok: true });
  });

  // ---------- fetch interception ----------

  var realFetch = window.fetch.bind(window);

  window.fetch = function (input, init) {
    var url;
    try { url = new URL(typeof input === 'string' ? input : input.url, location.href); } catch (e) { return realFetch(input, init); }
    if (url.origin !== location.origin || url.pathname.indexOf('/api/') !== 0) return realFetch(input, init);

    var method = ((init && init.method) || (typeof input !== 'string' && input.method) || 'GET').toUpperCase();
    var rawBody = init && init.body;

    return ready.then(async function () {
      var match = null, params = null;
      for (var i = 0; i < routes.length && !match; i++) {
        var r = routes[i];
        if (r.method !== method) continue;
        var m = r.regex.exec(url.pathname);
        if (m) { match = r; params = m.slice(1); }
      }
      if (!match) return respond(json(404, { error: 'Not found' }));

      var ctx = { params: params, query: url.searchParams, body: null, form: null };
      if (typeof FormData !== 'undefined' && rawBody instanceof FormData) ctx.form = rawBody;
      else if (typeof rawBody === 'string') { try { ctx.body = JSON.parse(rawBody); } catch (e) { ctx.body = null; } }

      try {
        return respond(await match.handler(ctx));
      } catch (e) {
        console.error('Chat Buddy local API error:', e);
        return respond(json(500, { error: 'Something went wrong.' }));
      }
    });
  };

  function respond(result) {
    if (result.blob) return new Response(result.blob, { status: result.status });
    if (result.empty) return new Response(null, { status: result.status });
    return new Response(JSON.stringify(result.body), { status: result.status, headers: { 'Content-Type': 'application/json' } });
  }
})();
