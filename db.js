const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, 'data.json');

function load() {
  if (!fs.existsSync(DB_FILE)) {
    return { users: [], nextUserId: 1 };
  }
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}

function save(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function findUserByUsername(username) {
  const db = load();
  return db.users.find(u => u.username.toLowerCase() === username.toLowerCase()) || null;
}

function findUserById(id) {
  const db = load();
  return db.users.find(u => u.id === id) || null;
}

function createUser(username, passwordHash) {
  const db = load();
  const user = {
    id: db.nextUserId++,
    username,
    passwordHash,
    data: { history: [], userName: null, notes: [] }
  };
  db.users.push(user);
  save(db);
  return user;
}

function saveUserData(id, data) {
  const db = load();
  const user = db.users.find(u => u.id === id);
  if (!user) return false;
  user.data = data;
  save(db);
  return true;
}

module.exports = { findUserByUsername, findUserById, createUser, saveUserData };
