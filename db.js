const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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

const AVATARS = ['🤖', '🦊', '🐼', '🐸', '🐙', '🦉', '🐳', '🦄', '🐝', '🦁'];

function createUser(username, passwordHash) {
  const db = load();
  const now = new Date().toISOString();
  const conversationId = crypto.randomUUID();
  const user = {
    id: db.nextUserId++,
    username,
    passwordHash,
    createdAt: now,
    profile: {
      displayName: username,
      avatar: AVATARS[Math.floor(Math.random() * AVATARS.length)],
      theme: 'light'
    },
    folders: [],
    conversations: [
      {
        id: conversationId,
        title: 'New Chat',
        folderId: null,
        history: [],
        userName: null,
        notes: [],
        createdAt: now,
        updatedAt: now
      }
    ],
    files: []
  };
  db.users.push(user);
  save(db);
  return user;
}

function updatePassword(id, passwordHash) {
  const db = load();
  const user = db.users.find(u => u.id === id);
  if (!user) return false;
  user.passwordHash = passwordHash;
  save(db);
  return true;
}

function getProfile(id) {
  const db = load();
  const user = db.users.find(u => u.id === id);
  return user ? user.profile : null;
}

function updateProfile(id, patch) {
  const db = load();
  const user = db.users.find(u => u.id === id);
  if (!user) return null;
  user.profile = { ...user.profile, ...patch };
  save(db);
  return user.profile;
}

function listFolders(userId) {
  const db = load();
  const user = db.users.find(u => u.id === userId);
  return user && Array.isArray(user.folders) ? user.folders : [];
}

function createFolder(userId, name) {
  const db = load();
  const user = db.users.find(u => u.id === userId);
  if (!user) return null;
  if (!Array.isArray(user.folders)) user.folders = [];
  const folder = { id: crypto.randomUUID(), name };
  user.folders.push(folder);
  save(db);
  return folder;
}

function renameFolder(userId, folderId, name) {
  const db = load();
  const user = db.users.find(u => u.id === userId);
  const folder = user && user.folders.find(f => f.id === folderId);
  if (!folder) return false;
  folder.name = name;
  save(db);
  return true;
}

function deleteFolder(userId, folderId) {
  const db = load();
  const user = db.users.find(u => u.id === userId);
  if (!user) return false;
  user.folders = (user.folders || []).filter(f => f.id !== folderId);
  user.conversations.forEach(c => { if (c.folderId === folderId) c.folderId = null; });
  save(db);
  return true;
}

function listConversations(userId) {
  const db = load();
  const user = db.users.find(u => u.id === userId);
  return user && Array.isArray(user.conversations) ? user.conversations : [];
}

function getConversation(userId, conversationId) {
  return listConversations(userId).find(c => c.id === conversationId) || null;
}

function createConversation(userId, title) {
  const db = load();
  const user = db.users.find(u => u.id === userId);
  if (!user) return null;
  const now = new Date().toISOString();
  const conversation = {
    id: crypto.randomUUID(),
    title: title || 'New Chat',
    folderId: null,
    history: [],
    userName: null,
    notes: [],
    createdAt: now,
    updatedAt: now
  };
  user.conversations.push(conversation);
  save(db);
  return conversation;
}

function saveConversation(userId, conversationId, patch) {
  const db = load();
  const user = db.users.find(u => u.id === userId);
  const conversation = user && user.conversations.find(c => c.id === conversationId);
  if (!conversation) return false;
  Object.assign(conversation, patch, { updatedAt: new Date().toISOString() });
  save(db);
  return true;
}

function deleteConversation(userId, conversationId) {
  const db = load();
  const user = db.users.find(u => u.id === userId);
  if (!user) return false;
  const before = user.conversations.length;
  user.conversations = user.conversations.filter(c => c.id !== conversationId);
  save(db);
  return user.conversations.length < before;
}

function addFile(userId, fileRecord) {
  const db = load();
  const user = db.users.find(u => u.id === userId);
  if (!user) return false;
  if (!Array.isArray(user.files)) user.files = [];
  user.files.push(fileRecord);
  save(db);
  return true;
}

function listFiles(userId) {
  const db = load();
  const user = db.users.find(u => u.id === userId);
  return user && Array.isArray(user.files) ? user.files : [];
}

function getFile(userId, fileId) {
  return listFiles(userId).find(f => f.id === fileId) || null;
}

module.exports = {
  findUserByUsername, findUserById, createUser, updatePassword,
  getProfile, updateProfile,
  listFolders, createFolder, renameFolder, deleteFolder,
  listConversations, getConversation, createConversation, saveConversation, deleteConversation,
  addFile, listFiles, getFile
};
