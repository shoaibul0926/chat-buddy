const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const Tesseract = require('tesseract.js');
const tf = require('@tensorflow/tfjs');
const cocoSsd = require('@tensorflow-models/coco-ssd');
const { Jimp } = require('jimp');
const db = require('./db');
const { extractText, findAnswer, embedChunksForFile, embedTexts, isEmbeddingConfigured } = require('./docQA');
const ai = require('./ai');
const vectorStore = require('./vectorStore');
const imageGen = require('./imageGen');
const memoryExtractor = require('./memoryExtractor');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const PORT = process.env.PORT || 3001;
const DATA_DIR = process.env.DATA_DIR || __dirname;
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const DOC_EXTENSIONS = ['.pdf', '.docx', '.txt'];
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.bmp', '.gif'];
const ALLOWED_EXTENSIONS = [...DOC_EXTENSIONS, ...IMAGE_EXTENSIONS];

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function makeToken(user) {
  return jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(UPLOAD_DIR, String(req.user.id));
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const id = crypto.randomUUID();
      req._fileId = id;
      cb(null, id + path.extname(file.originalname).toLowerCase());
    }
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, ALLOWED_EXTENSIONS.includes(ext));
  }
});

let cocoModelPromise = null;
function getCocoModel() {
  if (!cocoModelPromise) cocoModelPromise = cocoSsd.load();
  return cocoModelPromise;
}

let tesseractWorkerPromise = null;
function getTesseractWorker() {
  if (!tesseractWorkerPromise) tesseractWorkerPromise = Tesseract.createWorker('eng');
  return tesseractWorkerPromise;
}

const NAMED_COLORS = [
  { name: 'red', rgb: [220, 20, 20] }, { name: 'orange', rgb: [230, 130, 30] },
  { name: 'yellow', rgb: [220, 210, 30] }, { name: 'green', rgb: [40, 160, 60] },
  { name: 'cyan', rgb: [40, 190, 200] }, { name: 'blue', rgb: [40, 80, 210] },
  { name: 'purple', rgb: [130, 50, 180] }, { name: 'pink', rgb: [230, 130, 180] },
  { name: 'brown', rgb: [110, 70, 40] }, { name: 'white', rgb: [240, 240, 240] },
  { name: 'gray', rgb: [130, 130, 130] }, { name: 'black', rgb: [20, 20, 20] }
];

function closestColorName(r, g, b) {
  let best = null, bestDist = Infinity;
  for (const c of NAMED_COLORS) {
    const d = (r - c.rgb[0]) ** 2 + (g - c.rgb[1]) ** 2 + (b - c.rgb[2]) ** 2;
    if (d < bestDist) { bestDist = d; best = c.name; }
  }
  return best;
}

function generateCaption(objectCounts, ocrText, colorName, brightnessLabel) {
  const parts = [];
  const objectNames = Object.keys(objectCounts);
  if (objectNames.length) {
    const described = objectNames.map(name => {
      const count = objectCounts[name];
      return count > 1 ? `${count} ${name}s` : `a ${name}`;
    });
    parts.push(`This image appears to contain ${described.join(', ')}.`);
  } else {
    parts.push('No specific objects were confidently recognized in this image.');
  }
  parts.push(`It is predominantly ${colorName} and ${brightnessLabel}.`);
  if (ocrText && ocrText.trim()) {
    parts.push(`It also contains visible text.`);
  }
  return parts.join(' ');
}

async function analyzeImageFile(filePath) {
  const image = await Jimp.read(filePath);
  const { width, height, data } = image.bitmap;

  let r = 0, g = 0, b = 0, count = 0;
  for (let i = 0; i < data.length; i += 4) {
    r += data[i]; g += data[i + 1]; b += data[i + 2];
    count++;
  }
  r = Math.round(r / count); g = Math.round(g / count); b = Math.round(b / count);
  const brightness = (r * 299 + g * 587 + b * 114) / 1000;
  const brightnessLabel = brightness > 180 ? 'bright' : brightness > 90 ? 'medium brightness' : 'dark';
  const colorName = closestColorName(r, g, b);
  const hex = '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');

  const worker = await getTesseractWorker();
  const { data: ocrData } = await worker.recognize(filePath);
  const ocrText = (ocrData.text || '').trim();

  const pixels = new Int32Array(width * height * 3);
  let p = 0;
  for (let i = 0; i < data.length; i += 4) {
    pixels[p++] = data[i]; pixels[p++] = data[i + 1]; pixels[p++] = data[i + 2];
  }
  const tensor = tf.tensor3d(pixels, [height, width, 3], 'int32');
  const model = await getCocoModel();
  let predictions = [];
  try {
    predictions = await model.detect(tensor, 10, 0.5);
  } finally {
    tensor.dispose();
  }

  const objectCounts = {};
  for (const p of predictions) {
    objectCounts[p.class] = (objectCounts[p.class] || 0) + 1;
  }

  const caption = generateCaption(objectCounts, ocrText, colorName, brightnessLabel);

  const objectSummary = Object.entries(objectCounts)
    .map(([name, n]) => `${name}${n > 1 ? ` (x${n})` : ''}`)
    .join(', ');

  const searchableText = [
    caption,
    objectSummary ? `Detected objects: ${objectSummary}.` : '',
    ocrText ? `Text found in image: ${ocrText}` : ''
  ].filter(Boolean).join('\n');

  return {
    width, height, hex, colorName, brightnessLabel,
    ocrText, objects: predictions.map(p => ({ class: p.class, score: p.score })),
    caption, searchableText
  };
}

app.post('/api/files', requireAuth, upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded, or unsupported type (only PDF, DOCX, TXT, JPG, PNG, GIF, BMP allowed).' });
  }
  try {
    const ext = path.extname(req.file.originalname).toLowerCase();
    const isImage = IMAGE_EXTENSIONS.includes(ext);

    let fileRecord = {
      id: req._fileId,
      name: req.file.originalname,
      type: ext.slice(1),
      size: req.file.size,
      storedName: req.file.filename,
      uploadedAt: new Date().toISOString()
    };

    if (isImage) {
      const analysis = await analyzeImageFile(req.file.path);
      fileRecord.text = analysis.searchableText.slice(0, 200000);
      fileRecord.meta = {
        width: analysis.width, height: analysis.height,
        hex: analysis.hex, colorName: analysis.colorName, brightnessLabel: analysis.brightnessLabel,
        caption: analysis.caption, objects: analysis.objects, ocrText: analysis.ocrText
      };
    } else {
      fileRecord.text = (await extractText(req.file.path, ext)).slice(0, 200000);
      if (isEmbeddingConfigured()) {
        try {
          const chunks = await embedChunksForFile(fileRecord.text);
          await vectorStore.upsertChunks(req.user.id, 'file', fileRecord.id, fileRecord.name, chunks);
        } catch (e) {
          // Q&A still works via keyword search on fileRecord.text — an
          // embeddings outage shouldn't block the upload itself.
          console.error('Embedding upload failed, falling back to keyword search for this file:', e.message);
        }
      }
    }

    db.addFile(req.user.id, fileRecord);
    res.json({
      file: {
        id: fileRecord.id,
        name: fileRecord.name,
        type: fileRecord.type,
        size: fileRecord.size,
        uploadedAt: fileRecord.uploadedAt,
        meta: fileRecord.meta
      }
    });
  } catch (e) {
    console.error(e);
    fs.unlink(req.file.path, () => {});
    res.status(500).json({ error: 'Could not read that file. It may be corrupted or in an unsupported format.' });
  }
});

app.get('/api/files', requireAuth, (req, res) => {
  const files = db.listFiles(req.user.id).map(f => ({
    id: f.id, name: f.name, type: f.type, size: f.size, uploadedAt: f.uploadedAt, meta: f.meta
  }));
  res.json({ files });
});

app.get('/api/files/:id', requireAuth, (req, res) => {
  const file = db.getFile(req.user.id, req.params.id);
  if (!file) return res.status(404).json({ error: 'Not found' });
  res.json({ id: file.id, name: file.name, type: file.type, text: file.text, meta: file.meta });
});

app.get('/api/files/:id/download', requireAuth, (req, res) => {
  const file = db.getFile(req.user.id, req.params.id);
  if (!file) return res.status(404).end();
  const filePath = path.join(UPLOAD_DIR, String(req.user.id), file.storedName);
  if (!fs.existsSync(filePath)) return res.status(404).end();
  res.setHeader('Content-Disposition', 'inline; filename="' + file.name.replace(/"/g, '') + '"');
  res.sendFile(filePath);
});

app.post('/api/ask-files', requireAuth, async (req, res) => {
  const { question } = req.body || {};
  if (!question) return res.status(400).json({ error: 'Missing question' });
  const files = db.listFiles(req.user.id);
  if (!files.length) return res.json({ answer: null });
  const match = await findAnswer(req.user.id, files, question);
  res.json(match ? { answer: match.sentence, source: match.file } : { answer: null });
});

const MIME_TYPES_BY_EXT = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', bmp: 'image/bmp' };

function readImageFileBytes(userId, file) {
  const filePath = path.join(UPLOAD_DIR, String(userId), file.storedName);
  return { buffer: fs.readFileSync(filePath), mimeType: MIME_TYPES_BY_EXT[file.type] || 'application/octet-stream' };
}

// Persists an OpenAI-returned image buffer into the user's existing file
// library — the same one POST /api/files populates — so preview, download,
// and (if VOYAGE_API_KEY is set) embedding/RAG all work on generated images
// for free, with no new storage system.
function saveGeneratedImage(userId, buffer, { name, meta }) {
  const id = crypto.randomUUID();
  const storedName = id + '.png';
  const dir = path.join(UPLOAD_DIR, String(userId));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, storedName), buffer);
  const fileRecord = {
    id,
    name: name || `generated-${Date.now()}.png`,
    type: 'png',
    size: buffer.length,
    storedName,
    uploadedAt: new Date().toISOString(),
    text: meta.prompt || '',
    meta
  };
  db.addFile(userId, fileRecord);
  return fileRecord;
}

function toFileResponse(fileRecord) {
  return {
    id: fileRecord.id, name: fileRecord.name, type: fileRecord.type, size: fileRecord.size,
    uploadedAt: fileRecord.uploadedAt, meta: fileRecord.meta
  };
}

app.post('/api/images/generate', requireAuth, async (req, res) => {
  const { prompt, size, background } = req.body || {};
  if (!prompt || !prompt.trim()) return res.status(400).json({ error: 'Prompt is required.' });
  if (!imageGen.isConfigured()) return res.status(400).json({ error: 'Image generation is not configured on the server.' });
  try {
    const { buffer } = await imageGen.generateImage({
      prompt: prompt.trim().slice(0, 4000),
      size: size || 'auto',
      background: background || 'auto'
    });
    const fileRecord = saveGeneratedImage(req.user.id, buffer, {
      name: `generated-${Date.now()}.png`,
      meta: { generated: true, operation: 'generate', prompt: prompt.trim().slice(0, 4000) }
    });
    res.json({ file: toFileResponse(fileRecord) });
  } catch (e) {
    console.error('Image generation failed:', e.message);
    res.status(502).json({ error: 'Image generation failed. Please try again.' });
  }
});

function requireSourceImage(req, res) {
  const file = db.getFile(req.user.id, req.params.fileId);
  if (!file) { res.status(404).json({ error: 'Not found' }); return null; }
  if (!IMAGE_EXTENSIONS.includes('.' + file.type)) {
    res.status(400).json({ error: 'That file is not an image.' });
    return null;
  }
  return file;
}

app.post('/api/images/:fileId/edit', requireAuth, async (req, res) => {
  const { prompt } = req.body || {};
  if (!prompt || !prompt.trim()) return res.status(400).json({ error: 'Prompt is required.' });
  if (!imageGen.isConfigured()) return res.status(400).json({ error: 'Image editing is not configured on the server.' });
  const file = requireSourceImage(req, res);
  if (!file) return;
  try {
    const { buffer: srcBuffer, mimeType } = readImageFileBytes(req.user.id, file);
    const trimmedPrompt = prompt.trim().slice(0, 4000);
    const { buffer } = await imageGen.editImage({ imageBuffer: srcBuffer, mimeType, prompt: trimmedPrompt });
    const fileRecord = saveGeneratedImage(req.user.id, buffer, {
      name: `edited-${file.name}.png`,
      meta: { generated: true, operation: 'edit', prompt: trimmedPrompt, sourceFileId: file.id }
    });
    res.json({ file: toFileResponse(fileRecord) });
  } catch (e) {
    console.error('Image edit failed:', e.message);
    res.status(502).json({ error: 'Image edit failed. Please try again.' });
  }
});

app.post('/api/images/:fileId/remove-background', requireAuth, async (req, res) => {
  if (!imageGen.isConfigured()) return res.status(400).json({ error: 'Image editing is not configured on the server.' });
  const file = requireSourceImage(req, res);
  if (!file) return;
  try {
    const { buffer: srcBuffer, mimeType } = readImageFileBytes(req.user.id, file);
    const { buffer } = await imageGen.removeBackground({ imageBuffer: srcBuffer, mimeType });
    const fileRecord = saveGeneratedImage(req.user.id, buffer, {
      name: `no-bg-${file.name}.png`,
      meta: { generated: true, operation: 'removeBackground', sourceFileId: file.id }
    });
    res.json({ file: toFileResponse(fileRecord) });
  } catch (e) {
    console.error('Background removal failed:', e.message);
    res.status(502).json({ error: 'Background removal failed. Please try again.' });
  }
});

app.post('/api/images/:fileId/style-transfer', requireAuth, async (req, res) => {
  const { stylePrompt } = req.body || {};
  if (!stylePrompt || !stylePrompt.trim()) return res.status(400).json({ error: 'A style description is required.' });
  if (!imageGen.isConfigured()) return res.status(400).json({ error: 'Image editing is not configured on the server.' });
  const file = requireSourceImage(req, res);
  if (!file) return;
  try {
    const { buffer: srcBuffer, mimeType } = readImageFileBytes(req.user.id, file);
    const trimmedStyle = stylePrompt.trim().slice(0, 1000);
    const { buffer } = await imageGen.styleTransferImage({ imageBuffer: srcBuffer, mimeType, stylePrompt: trimmedStyle });
    const fileRecord = saveGeneratedImage(req.user.id, buffer, {
      name: `styled-${file.name}.png`,
      meta: { generated: true, operation: 'styleTransfer', prompt: trimmedStyle, sourceFileId: file.id }
    });
    res.json({ file: toFileResponse(fileRecord) });
  } catch (e) {
    console.error('Style transfer failed:', e.message);
    res.status(502).json({ error: 'Style transfer failed. Please try again.' });
  }
});

app.post('/api/images/:fileId/enhance', requireAuth, async (req, res) => {
  if (!imageGen.isConfigured()) return res.status(400).json({ error: 'Image editing is not configured on the server.' });
  const file = requireSourceImage(req, res);
  if (!file) return;
  try {
    const { buffer: srcBuffer, mimeType } = readImageFileBytes(req.user.id, file);
    const { buffer } = await imageGen.enhanceImage({ imageBuffer: srcBuffer, mimeType });
    const fileRecord = saveGeneratedImage(req.user.id, buffer, {
      name: `enhanced-${file.name}.png`,
      meta: { generated: true, operation: 'enhance', sourceFileId: file.id }
    });
    res.json({ file: toFileResponse(fileRecord) });
  } catch (e) {
    console.error('Image enhancement failed:', e.message);
    res.status(502).json({ error: 'Image enhancement failed. Please try again.' });
  }
});

app.get('/api/ai/config', requireAuth, (req, res) => {
  const providers = Object.values(ai.PROVIDERS).map(p => ({ id: p.id, label: p.label, models: p.models }));
  const configured = {
    anthropic: ai.isProviderConfigured('anthropic'),
    openai: ai.isProviderConfigured('openai')
  };
  res.json({ providers, configured });
});

// Builds { role, content } messages from stored conversation history for LLM
// context. HTML-type entries (agent-trace bubbles) are excluded — they're
// UI presentation, not real conversational content.
function buildMessagesFromHistory(history, limit) {
  const textEntries = (history || []).filter(e => e.type !== 'html' && typeof e.text === 'string');
  const recent = textEntries.slice(-limit);
  return recent.map(e => ({ role: e.sender === 'user' ? 'user' : 'assistant', content: e.text }));
}

app.post('/api/chat', requireAuth, async (req, res) => {
  const { conversationId, message, provider, model, systemPrompt } = req.body || {};
  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'Missing message' });
  }
  if (!provider || !model || !ai.isValidModel(provider, model)) {
    return res.status(400).json({ error: 'Invalid provider/model' });
  }
  if (!ai.isProviderConfigured(provider)) {
    return res.status(400).json({ error: `${provider} is not configured on the server.` });
  }

  const conversation = conversationId ? db.getConversation(req.user.id, conversationId) : null;
  const historyMessages = buildMessagesFromHistory(conversation ? conversation.history : [], 20);
  const profile = db.getProfile(req.user.id) || {};

  let effectiveSystemPrompt = typeof systemPrompt === 'string' ? systemPrompt : '';

  // Memory, part 1: user/preference facts are always included in full — no
  // similarity search — since they're meant to be stable identity/preference
  // context that should be present regardless of what the current message is
  // about (a name or a tone preference isn't "relevant" to any one message,
  // it's relevant to all of them).
  const alwaysOnMemories = db.listMemories(req.user.id)
    .filter(m => m.enabled && (m.category === 'user' || m.category === 'preference'))
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
    .slice(0, memoryExtractor.MAX_MEMORIES_IN_PROMPT);
  if (alwaysOnMemories.length) {
    const memoryBlock = alwaysOnMemories.map(m => `- (${m.category}) ${m.content}`).join('\n');
    effectiveSystemPrompt = (effectiveSystemPrompt ? effectiveSystemPrompt + '\n\n' : '') +
      `What you know about the user:\n${memoryBlock}`;
  }

  // RAG: ground the answer in the user's knowledge base, uploaded files, and
  // project/conversation memories when embeddings are available. No-ops
  // gracefully otherwise (no VOYAGE_API_KEY, nothing embedded yet, or the
  // embedding call fails) — the LLM just answers from conversation history
  // (+ the always-on memory block above) alone, same degradation philosophy
  // as the rest of this codebase's Voyage integration. memory:user/
  // memory:preference are excluded here since they're already included in
  // full above — an unscoped search would otherwise risk surfacing the same
  // fact twice.
  let messageEmbedding = null;
  if (isEmbeddingConfigured()) {
    try {
      if (await vectorStore.hasAny(req.user.id)) {
        [messageEmbedding] = await embedTexts([message], 'query');
        const results = await vectorStore.queryTopK(req.user.id, messageEmbedding, 5, {
          excludeSourceTypes: ['memory:user', 'memory:preference']
        });
        if (results.length) {
          const context = results.map(r => `[${r.sourceLabel}]\n${r.text}`).join('\n\n');
          effectiveSystemPrompt = (effectiveSystemPrompt ? effectiveSystemPrompt + '\n\n' : '') +
            `Relevant information from the user's knowledge base, files, and memory:\n\n${context}`;
        }
      }
    } catch (e) {
      console.error('RAG retrieval failed, continuing without context:', e.message);
    }
  }

  // NDJSON over a plain chunked response, not real SSE/EventSource:
  // EventSource can't send the Authorization: Bearer header this app's auth
  // relies on and doesn't support POST bodies, so the frontend reads this via
  // fetch()'s streaming body instead — no need for the text/event-stream
  // protocol at all.
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache' });
  let fullReplyText = '';
  try {
    await ai.streamChatCompletion(
      { provider, model, systemPrompt: effectiveSystemPrompt, messages: [...historyMessages, { role: 'user', content: message }] },
      delta => { fullReplyText += delta; res.write(JSON.stringify({ delta }) + '\n'); }
    );
    res.write(JSON.stringify({ done: true }) + '\n');
  } catch (e) {
    console.error('Chat completion failed:', e.message);
    res.write(JSON.stringify({ error: 'The AI provider request failed. Please try again.' }) + '\n');
  }
  res.end();

  // Memory, part 2: fire-and-forget extraction — runs after the response has
  // already been fully sent, so a slow or failed extraction call can never
  // delay or affect the chat reply the user is actually waiting on.
  if (fullReplyText && profile.memoryEnabled !== false) {
    const categories = profile.memoryCategories || {};
    const allowedCategories = memoryExtractor.CATEGORIES.filter(c => categories[c] !== false);
    if (allowedCategories.length) {
      memoryExtractor
        .extractMemories({ userId: req.user.id, provider, userMessage: message, assistantReply: fullReplyText, allowedCategories })
        .then(candidates => candidates.length && memoryExtractor.saveExtractedMemories({ userId: req.user.id, conversationId, candidates }))
        .catch(e => console.error('Memory extraction/save failed:', e.message));
    }
  }
});

app.get('/api/prompt-templates', requireAuth, (req, res) => {
  res.json({ templates: db.listPromptTemplates(req.user.id) });
});

app.post('/api/prompt-templates', requireAuth, (req, res) => {
  const { name, systemPrompt } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Template name is required.' });
  if (!systemPrompt || !systemPrompt.trim()) return res.status(400).json({ error: 'System prompt is required.' });
  const template = db.createPromptTemplate(req.user.id, {
    name: name.trim().slice(0, 60),
    systemPrompt: systemPrompt.trim().slice(0, 4000)
  });
  res.json({ template });
});

app.patch('/api/prompt-templates/:id', requireAuth, (req, res) => {
  const { name, systemPrompt } = req.body || {};
  const patch = {};
  if (typeof name === 'string' && name.trim()) patch.name = name.trim().slice(0, 60);
  if (typeof systemPrompt === 'string' && systemPrompt.trim()) patch.systemPrompt = systemPrompt.trim().slice(0, 4000);
  const ok = db.updatePromptTemplate(req.user.id, req.params.id, patch);
  if (!ok) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

app.delete('/api/prompt-templates/:id', requireAuth, (req, res) => {
  const ok = db.deletePromptTemplate(req.user.id, req.params.id);
  if (!ok) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

function toKnowledgeResponse(record) {
  return { id: record.id, title: record.title, content: record.content, createdAt: record.createdAt, updatedAt: record.updatedAt };
}

app.get('/api/knowledge', requireAuth, (req, res) => {
  res.json({ knowledge: db.listKnowledge(req.user.id).map(toKnowledgeResponse) });
});

app.post('/api/knowledge', requireAuth, async (req, res) => {
  const { title, content } = req.body || {};
  if (!title || !title.trim()) return res.status(400).json({ error: 'Title is required.' });
  if (!content || !content.trim()) return res.status(400).json({ error: 'Content is required.' });
  const entry = { title: title.trim().slice(0, 120), content: content.trim().slice(0, 50000) };
  const record = db.createKnowledgeEntry(req.user.id, entry);
  if (!record) return res.status(404).json({ error: 'User not found' });
  if (isEmbeddingConfigured()) {
    try {
      const chunks = await embedChunksForFile(record.content);
      await vectorStore.upsertChunks(req.user.id, 'knowledge', record.id, record.title, chunks);
    } catch (e) {
      console.error('Embedding knowledge entry failed, falling back to no embeddings for this entry:', e.message);
    }
  }
  res.json({ knowledge: toKnowledgeResponse(record) });
});

app.put('/api/knowledge/:id', requireAuth, async (req, res) => {
  const { title, content } = req.body || {};
  if (!title || !title.trim()) return res.status(400).json({ error: 'Title is required.' });
  if (!content || !content.trim()) return res.status(400).json({ error: 'Content is required.' });
  const patch = { title: title.trim().slice(0, 120), content: content.trim().slice(0, 50000) };
  const record = db.updateKnowledgeEntry(req.user.id, req.params.id, patch);
  if (!record) return res.status(404).json({ error: 'Not found' });
  if (isEmbeddingConfigured()) {
    try {
      // Compute the new chunks before touching the index — if embedding
      // fails, the old vectors must stay intact rather than being deleted
      // and never replaced.
      const chunks = await embedChunksForFile(record.content);
      await vectorStore.deleteBySource(req.user.id, 'knowledge', record.id);
      await vectorStore.upsertChunks(req.user.id, 'knowledge', record.id, record.title, chunks);
    } catch (e) {
      console.error('Embedding knowledge entry failed, keeping previous embeddings for this entry:', e.message);
    }
  }
  res.json({ knowledge: toKnowledgeResponse(record) });
});

app.delete('/api/knowledge/:id', requireAuth, async (req, res) => {
  const ok = db.deleteKnowledgeEntry(req.user.id, req.params.id);
  if (!ok) return res.status(404).json({ error: 'Not found' });
  // Only touch the vector index when embeddings are actually in use — same
  // gate every other embedding-related code path uses, so an app that never
  // configures VOYAGE_API_KEY never creates a vector-index/ folder at all.
  if (isEmbeddingConfigured()) {
    try {
      await vectorStore.deleteBySource(req.user.id, 'knowledge', req.params.id);
    } catch (e) {
      // The JSON record is already gone either way — a stale vector left
      // behind is a minor cleanup failure, not a reason to error the request.
      console.error('Failed to clean up vector index for a deleted knowledge entry:', e.message);
    }
  }
  res.json({ ok: true });
});

app.get('/api/memories', requireAuth, (req, res) => {
  const { category, q } = req.query || {};
  let memories = db.listMemories(req.user.id);
  if (category && memoryExtractor.CATEGORIES.includes(category)) {
    memories = memories.filter(m => m.category === category);
  }
  if (q && q.trim()) {
    const needle = q.trim().toLowerCase();
    memories = memories.filter(m => m.content.toLowerCase().includes(needle));
  }
  memories = memories.slice().sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  res.json({ memories });
});

app.patch('/api/memories/:id', requireAuth, (req, res) => {
  const { content, enabled } = req.body || {};
  const patch = {};
  if (typeof content === 'string' && content.trim()) patch.content = content.trim().slice(0, 500);
  if (typeof enabled === 'boolean') patch.enabled = enabled;
  const memory = db.updateMemory(req.user.id, req.params.id, patch);
  if (!memory) return res.status(404).json({ error: 'Not found' });
  res.json({ memory });
});

app.delete('/api/memories/:id', requireAuth, async (req, res) => {
  const memory = db.deleteMemory(req.user.id, req.params.id);
  if (!memory) return res.status(404).json({ error: 'Not found' });
  if (isEmbeddingConfigured()) {
    try {
      await vectorStore.deleteBySource(req.user.id, 'memory:' + memory.category, memory.id);
    } catch (e) {
      console.error('Failed to clean up vector index for a deleted memory:', e.message);
    }
  }
  res.json({ ok: true });
});

app.post('/api/register', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password || username.length < 3 || password.length < 6) {
    return res.status(400).json({ error: 'Username must be 3+ chars, password 6+ chars.' });
  }
  if (db.findUserByUsername(username)) {
    return res.status(409).json({ error: 'That username is already taken.' });
  }
  const passwordHash = bcrypt.hashSync(password, 10);
  const user = db.createUser(username, passwordHash);
  res.json({ token: makeToken(user), username: user.username });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = db.findUserByUsername(username || '');
  if (!user || !bcrypt.compareSync(password || '', user.passwordHash)) {
    return res.status(401).json({ error: 'Invalid username or password.' });
  }
  res.json({ token: makeToken(user), username: user.username });
});

app.get('/api/profile', requireAuth, (req, res) => {
  const profile = db.getProfile(req.user.id);
  if (!profile) return res.status(404).json({ error: 'User not found' });
  const user = db.findUserById(req.user.id);
  res.json({ ...profile, username: user.username, createdAt: user.createdAt });
});

app.put('/api/profile', requireAuth, (req, res) => {
  const {
    displayName, avatar, theme, defaultProvider, defaultModel, defaultSystemPrompt,
    memoryEnabled, memoryCategories
  } = req.body || {};
  const patch = {};
  if (typeof displayName === 'string' && displayName.trim()) patch.displayName = displayName.trim().slice(0, 40);
  if (typeof avatar === 'string') patch.avatar = avatar.slice(0, 8);
  if (theme === 'light' || theme === 'dark') patch.theme = theme;
  if (defaultProvider === null || typeof defaultProvider === 'string') patch.defaultProvider = defaultProvider;
  if (defaultModel === null || typeof defaultModel === 'string') patch.defaultModel = defaultModel;
  if (defaultSystemPrompt === null) patch.defaultSystemPrompt = null;
  else if (typeof defaultSystemPrompt === 'string') patch.defaultSystemPrompt = defaultSystemPrompt.slice(0, 4000);
  if (typeof memoryEnabled === 'boolean') patch.memoryEnabled = memoryEnabled;
  if (memoryCategories && typeof memoryCategories === 'object') {
    // updateProfile spreads `patch` over the existing profile shallowly, so a
    // partial memoryCategories object here would silently drop any category
    // key not included in this request — merge over the current value first.
    const current = db.getProfile(req.user.id);
    const merged = { ...(current && current.memoryCategories) };
    for (const cat of memoryExtractor.CATEGORIES) {
      if (typeof memoryCategories[cat] === 'boolean') merged[cat] = memoryCategories[cat];
    }
    patch.memoryCategories = merged;
  }
  const profile = db.updateProfile(req.user.id, patch);
  if (!profile) return res.status(404).json({ error: 'User not found' });
  res.json(profile);
});

app.put('/api/password', requireAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  const user = db.findUserById(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (!bcrypt.compareSync(currentPassword || '', user.passwordHash)) {
    return res.status(401).json({ error: 'Current password is incorrect.' });
  }
  if (!newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: 'New password must be 6+ characters.' });
  }
  db.updatePassword(user.id, bcrypt.hashSync(newPassword, 10));
  res.json({ ok: true });
});

app.get('/api/folders', requireAuth, (req, res) => {
  res.json({ folders: db.listFolders(req.user.id) });
});

app.post('/api/folders', requireAuth, (req, res) => {
  const { name } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Folder name is required.' });
  const folder = db.createFolder(req.user.id, name.trim().slice(0, 40));
  res.json({ folder });
});

app.patch('/api/folders/:id', requireAuth, (req, res) => {
  const { name } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Folder name is required.' });
  const ok = db.renameFolder(req.user.id, req.params.id, name.trim().slice(0, 40));
  if (!ok) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

app.delete('/api/folders/:id', requireAuth, (req, res) => {
  db.deleteFolder(req.user.id, req.params.id);
  res.json({ ok: true });
});

app.get('/api/conversations', requireAuth, (req, res) => {
  const conversations = db.listConversations(req.user.id).map(c => {
    const lastEntry = c.history[c.history.length - 1];
    return {
      id: c.id,
      title: c.title,
      folderId: c.folderId,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      preview: lastEntry ? (lastEntry.text || '').slice(0, 60) : ''
    };
  }).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  res.json({ conversations });
});

app.post('/api/conversations', requireAuth, (req, res) => {
  const { title } = req.body || {};
  const conversation = db.createConversation(req.user.id, title);
  if (!conversation) return res.status(404).json({ error: 'User not found' });
  res.json({ conversation });
});

app.get('/api/conversations/:id', requireAuth, (req, res) => {
  const conversation = db.getConversation(req.user.id, req.params.id);
  if (!conversation) return res.status(404).json({ error: 'Not found' });
  res.json({ conversation });
});

app.put('/api/conversations/:id', requireAuth, (req, res) => {
  const { history, userName, notes, provider, model, systemPrompt } = req.body || {};
  // Only include keys the caller actually sent — this endpoint now has two
  // callers (full-history saves and AI-settings-only saves), and Object.assign
  // in db.saveConversation would clobber an omitted field to undefined if it
  // were always included here regardless of presence.
  const patch = {};
  if (Array.isArray(history)) patch.history = history;
  if (userName === null || typeof userName === 'string') patch.userName = userName;
  if (Array.isArray(notes)) patch.notes = notes;
  if (provider === null || typeof provider === 'string') patch.provider = provider;
  if (model === null || typeof model === 'string') patch.model = model;
  if (systemPrompt === null) patch.systemPrompt = null;
  else if (typeof systemPrompt === 'string') patch.systemPrompt = systemPrompt.slice(0, 4000);
  const ok = db.saveConversation(req.user.id, req.params.id, patch);
  if (!ok) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

app.patch('/api/conversations/:id', requireAuth, (req, res) => {
  const { title, folderId } = req.body || {};
  const patch = {};
  if (typeof title === 'string' && title.trim()) patch.title = title.trim().slice(0, 60);
  if (folderId === null || typeof folderId === 'string') patch.folderId = folderId;
  const ok = db.saveConversation(req.user.id, req.params.id, patch);
  if (!ok) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

app.delete('/api/conversations/:id', requireAuth, (req, res) => {
  const ok = db.deleteConversation(req.user.id, req.params.id);
  if (!ok) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

function stripHtml(html) {
  return (html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

app.get('/api/search', requireAuth, (req, res) => {
  const q = (req.query.q || '').toString().trim().toLowerCase();
  if (!q) return res.json({ results: [] });
  const results = [];
  for (const c of db.listConversations(req.user.id)) {
    for (const entry of c.history) {
      const plain = entry.type === 'html' ? stripHtml(entry.html) : (entry.text || '');
      const idx = plain.toLowerCase().indexOf(q);
      if (idx !== -1) {
        const start = Math.max(0, idx - 30);
        const snippet = (start > 0 ? '…' : '') + plain.slice(start, idx + q.length + 30) + (idx + q.length + 30 < plain.length ? '…' : '');
        results.push({ conversationId: c.id, conversationTitle: c.title, sender: entry.sender, time: entry.time, snippet });
      }
    }
  }
  res.json({ results: results.slice(0, 50) });
});

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'That file is too large — 10MB max.' });
    }
    return res.status(400).json({ error: 'Upload failed: ' + err.message });
  }
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server.' });
});

// Guarded so `require('./server')` (route tests) gets `app` without also
// binding a port or kicking off slow model downloads — only `node server.js`
// / `npm start` (require.main === module) does that.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Chat Buddy server running at http://localhost:${PORT}`);
  });

  getCocoModel().then(() => console.log('Object detection model ready')).catch(e => console.error('Model preload failed', e));
  getTesseractWorker().then(() => console.log('OCR worker ready')).catch(e => console.error('OCR worker preload failed', e));
}

module.exports = app;
