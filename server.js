const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const db = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const PORT = process.env.PORT || 3001;

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
