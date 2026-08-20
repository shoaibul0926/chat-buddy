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
const db = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const PORT = process.env.PORT || 3001;
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const ALLOWED_EXTENSIONS = ['.pdf', '.docx', '.txt'];

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

const STOPWORDS = new Set([
  'the', 'is', 'a', 'an', 'of', 'to', 'and', 'in', 'on', 'for', 'what', 'does',
  'do', 'say', 'about', 'tell', 'me', 'file', 'document', 'that', 'this', 'it',
  'was', 'were', 'are', 'be', 'with', 'as', 'at', 'from', 'my', 'your'
]);

function words(text) {
  return (text.toLowerCase().match(/[a-z0-9]+/g) || []).filter(w => !STOPWORDS.has(w));
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
    return res.status(400).json({ error: 'No file uploaded, or unsupported type (only PDF, DOCX, TXT allowed).' });
  }
  try {
    const ext = path.extname(req.file.originalname).toLowerCase();
    const text = (await extractText(req.file.path, ext)).slice(0, 200000);
    const fileRecord = {
      id: req._fileId,
      name: req.file.originalname,
      type: ext.slice(1),
      size: req.file.size,
      storedName: req.file.filename,
      text,
      uploadedAt: new Date().toISOString()
    };
    db.addFile(req.user.id, fileRecord);
    res.json({
      file: {
        id: fileRecord.id,
        name: fileRecord.name,
        type: fileRecord.type,
        size: fileRecord.size,
        uploadedAt: fileRecord.uploadedAt
      }
    });
  } catch (e) {
    console.error(e);
    fs.unlink(req.file.path, () => {});
    res.status(500).json({ error: 'Could not read that file. It may be corrupted or password-protected.' });
  }
});

app.get('/api/files', requireAuth, (req, res) => {
  const files = db.listFiles(req.user.id).map(f => ({
    id: f.id, name: f.name, type: f.type, size: f.size, uploadedAt: f.uploadedAt
  }));
  res.json({ files });
});

app.get('/api/files/:id', requireAuth, (req, res) => {
  const file = db.getFile(req.user.id, req.params.id);
  if (!file) return res.status(404).json({ error: 'Not found' });
  res.json({ id: file.id, name: file.name, type: file.type, text: file.text });
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
