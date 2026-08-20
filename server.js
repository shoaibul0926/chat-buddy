const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const { PDFParse } = require('pdf-parse');
const mammoth = require('mammoth');
const Tesseract = require('tesseract.js');
const tf = require('@tensorflow/tfjs');
const cocoSsd = require('@tensorflow-models/coco-ssd');
const { Jimp } = require('jimp');
const db = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const PORT = process.env.PORT || 3001;
const UPLOAD_DIR = path.join(__dirname, 'uploads');
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

async function extractText(filePath, ext) {
  if (ext === '.txt') return fs.readFileSync(filePath, 'utf8');
  if (ext === '.pdf') {
    const parser = new PDFParse({ data: fs.readFileSync(filePath) });
    const result = await parser.getText();
    await parser.destroy();
    return result.text;
  }
  if (ext === '.docx') return (await mammoth.extractRawText({ path: filePath })).value;
  return '';
}

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

const STOPWORDS = new Set([
  'the', 'is', 'a', 'an', 'of', 'to', 'and', 'in', 'on', 'for', 'what', 'does',
  'do', 'say', 'about', 'tell', 'me', 'file', 'document', 'that', 'this', 'it',
  'was', 'were', 'are', 'be', 'with', 'as', 'at', 'from', 'my', 'your'
]);

function words(text) {
  return (text.toLowerCase().match(/[a-z]+|[0-9]+/g) || []).filter(w => !STOPWORDS.has(w));
}

function findAnswer(files, question) {
  const qWords = words(question);
  if (!qWords.length) return null;
  let best = null;
  for (const f of files) {
    const sentences = (f.text || '').split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);
    for (const s of sentences) {
      const sWords = words(s);
      const overlap = qWords.filter(w => sWords.includes(w)).length;
      if (overlap > 0 && (!best || overlap > best.overlap)) {
        best = { overlap, sentence: s, file: f.name };
      }
    }
  }
  return best;
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

app.post('/api/ask-files', requireAuth, (req, res) => {
  const { question } = req.body || {};
  if (!question) return res.status(400).json({ error: 'Missing question' });
  const files = db.listFiles(req.user.id);
  if (!files.length) return res.json({ answer: null });
  const match = findAnswer(files, question);
  res.json(match ? { answer: match.sentence, source: match.file } : { answer: null });
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

app.get('/api/data', requireAuth, (req, res) => {
  const user = db.findUserById(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(user.data);
});

app.put('/api/data', requireAuth, (req, res) => {
  const ok = db.saveUserData(req.user.id, req.body || {});
  if (!ok) return res.status(404).json({ error: 'User not found' });
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Chat Buddy server running at http://localhost:${PORT}`);
});

getCocoModel().then(() => console.log('Object detection model ready')).catch(e => console.error('Model preload failed', e));
getTesseractWorker().then(() => console.log('OCR worker ready')).catch(e => console.error('OCR worker preload failed', e));
