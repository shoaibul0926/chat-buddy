const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Must be set before requiring db.js/server.js (both read DATA_DIR at module
// load) so tests never touch the real local data.json, and before requiring
// ai.js's consumers so /api/ai/config and /api/chat validation are
// deterministic regardless of any real keys present in the host environment
// (this machine's ambient shell may have a real OPENAI_API_KEY set — see
// project memory — so tests must never assume either key is absent on their
// own; explicitly unsetting here is what makes that safe).
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'chatbuddy-test-'));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.JWT_SECRET = 'test-secret-not-for-production';
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENAI_API_KEY;
delete process.env.VOYAGE_API_KEY;

const app = require('../server');

let server;
let baseUrl;

test.before(() => new Promise(resolve => {
  server = app.listen(0, () => {
    baseUrl = `http://localhost:${server.address().port}`;
    resolve();
  });
}));

test.after(() => {
  server.close();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

let uniqueCounter = 0;
function uniqueUsername(prefix) {
  uniqueCounter += 1;
  return `${prefix}_${Date.now()}_${uniqueCounter}`;
}

async function registerUser(username, password = 'testpass123') {
  const res = await fetch(`${baseUrl}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  const data = await res.json();
  return { res, data };
}

function authHeaders(token, json) {
  const h = { Authorization: 'Bearer ' + token };
  if (json) h['Content-Type'] = 'application/json';
  return h;
}

// ---------- Auth ----------

test('register: succeeds with a token, rejects a duplicate username', async () => {
  const username = uniqueUsername('alice');
  const { res, data } = await registerUser(username);
  assert.equal(res.status, 200);
  assert.ok(data.token);
  assert.equal(data.username, username);

  const dupe = await registerUser(username);
  assert.equal(dupe.res.status, 409);
});

test('login: correct password succeeds, wrong password is rejected', async () => {
  const username = uniqueUsername('bob');
  await registerUser(username, 'correcthorse123');

  const bad = await fetch(`${baseUrl}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: 'wrongpassword' })
  });
  assert.equal(bad.status, 401);

  const good = await fetch(`${baseUrl}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: 'correcthorse123' })
  });
  assert.equal(good.status, 200);
  const data = await good.json();
  assert.ok(data.token);
});

test('protected routes reject missing or invalid tokens', async () => {
  const noToken = await fetch(`${baseUrl}/api/profile`);
  assert.equal(noToken.status, 401);

  const badToken = await fetch(`${baseUrl}/api/profile`, { headers: { Authorization: 'Bearer not-a-real-token' } });
  assert.equal(badToken.status, 401);
});

// ---------- Profile & password ----------

test('profile: GET returns defaults, PUT updates and persists', async () => {
  const { data: { token } } = await registerUser(uniqueUsername('carol'));

  const before = await (await fetch(`${baseUrl}/api/profile`, { headers: authHeaders(token) })).json();
  assert.equal(before.theme, 'light');

  const putRes = await fetch(`${baseUrl}/api/profile`, {
    method: 'PUT', headers: authHeaders(token, true),
    body: JSON.stringify({ displayName: 'Carol D', theme: 'dark' })
  });
  assert.equal(putRes.status, 200);

  const after = await (await fetch(`${baseUrl}/api/profile`, { headers: authHeaders(token) })).json();
  assert.equal(after.displayName, 'Carol D');
  assert.equal(after.theme, 'dark');
});

test('password: rejects wrong current password, accepts correct and new one logs in', async () => {
  const username = uniqueUsername('dave');
  const { data: { token } } = await registerUser(username, 'originalpass1');

  const wrong = await fetch(`${baseUrl}/api/password`, {
    method: 'PUT', headers: authHeaders(token, true),
    body: JSON.stringify({ currentPassword: 'nope', newPassword: 'newpass123' })
  });
  assert.equal(wrong.status, 401);

  const ok = await fetch(`${baseUrl}/api/password`, {
    method: 'PUT', headers: authHeaders(token, true),
    body: JSON.stringify({ currentPassword: 'originalpass1', newPassword: 'newpass123' })
  });
  assert.equal(ok.status, 200);

  const login = await fetch(`${baseUrl}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: 'newpass123' })
  });
  assert.equal(login.status, 200);
});

// ---------- Folders ----------

test('folders: create, list, rename, delete un-parents its conversations', async () => {
  const { data: { token } } = await registerUser(uniqueUsername('erin'));

  const created = await (await fetch(`${baseUrl}/api/folders`, {
    method: 'POST', headers: authHeaders(token, true), body: JSON.stringify({ name: 'Work' })
  })).json();
  assert.ok(created.folder.id);

  const list1 = await (await fetch(`${baseUrl}/api/folders`, { headers: authHeaders(token) })).json();
  assert.equal(list1.folders.length, 1);

  await fetch(`${baseUrl}/api/folders/${created.folder.id}`, {
    method: 'PATCH', headers: authHeaders(token, true), body: JSON.stringify({ name: 'Renamed' })
  });
  const list2 = await (await fetch(`${baseUrl}/api/folders`, { headers: authHeaders(token) })).json();
  assert.equal(list2.folders[0].name, 'Renamed');

  const conv = await (await fetch(`${baseUrl}/api/conversations`, {
    method: 'POST', headers: authHeaders(token, true), body: JSON.stringify({ title: 'In folder' })
  })).json();
  await fetch(`${baseUrl}/api/conversations/${conv.conversation.id}`, {
    method: 'PATCH', headers: authHeaders(token, true), body: JSON.stringify({ folderId: created.folder.id })
  });

  await fetch(`${baseUrl}/api/folders/${created.folder.id}`, { method: 'DELETE', headers: authHeaders(token) });
  const list3 = await (await fetch(`${baseUrl}/api/folders`, { headers: authHeaders(token) })).json();
  assert.equal(list3.folders.length, 0);

  const convAfter = await (await fetch(`${baseUrl}/api/conversations/${conv.conversation.id}`, { headers: authHeaders(token) })).json();
  assert.equal(convAfter.conversation.folderId, null);
});

// ---------- Conversations ----------

test('conversations: create, list, get, rename, delete', async () => {
  const { data: { token } } = await registerUser(uniqueUsername('frank'));

  const created = await (await fetch(`${baseUrl}/api/conversations`, {
    method: 'POST', headers: authHeaders(token, true), body: JSON.stringify({ title: 'Trip planning' })
  })).json();
  const id = created.conversation.id;
  assert.equal(created.conversation.title, 'Trip planning');

  const list = await (await fetch(`${baseUrl}/api/conversations`, { headers: authHeaders(token) })).json();
  assert.ok(list.conversations.some(c => c.id === id));

  await fetch(`${baseUrl}/api/conversations/${id}`, {
    method: 'PATCH', headers: authHeaders(token, true), body: JSON.stringify({ title: 'Renamed trip' })
  });
  const got = await (await fetch(`${baseUrl}/api/conversations/${id}`, { headers: authHeaders(token) })).json();
  assert.equal(got.conversation.title, 'Renamed trip');

  const del = await fetch(`${baseUrl}/api/conversations/${id}`, { method: 'DELETE', headers: authHeaders(token) });
  assert.equal(del.status, 200);
  const afterDelete = await fetch(`${baseUrl}/api/conversations/${id}`, { headers: authHeaders(token) });
  assert.equal(afterDelete.status, 404);
});

test('conversations: PUT saves history/userName/notes and round-trips', async () => {
  const { data: { token } } = await registerUser(uniqueUsername('grace'));
  const created = await (await fetch(`${baseUrl}/api/conversations`, {
    method: 'POST', headers: authHeaders(token, true), body: JSON.stringify({ title: 'Notes test' })
  })).json();
  const id = created.conversation.id;

  const history = [{ type: 'text', sender: 'user', text: 'hello there', time: '10:00 AM' }];
  await fetch(`${baseUrl}/api/conversations/${id}`, {
    method: 'PUT', headers: authHeaders(token, true),
    body: JSON.stringify({ history, userName: 'Grace', notes: ['likes tea'] })
  });

  const got = await (await fetch(`${baseUrl}/api/conversations/${id}`, { headers: authHeaders(token) })).json();
  assert.deepEqual(got.conversation.history, history);
  assert.equal(got.conversation.userName, 'Grace');
  assert.deepEqual(got.conversation.notes, ['likes tea']);
});

// Regression test for a bug caught and fixed during Phase 4 implementation:
// PUT /api/conversations/:id gained a second caller (AI-settings-only saves)
// that sends no history/userName/notes at all — the route must not clobber
// those fields to undefined via Object.assign when they're simply absent
// from the request body.
test('conversations: PUT with only provider/model/systemPrompt does not clobber history/userName/notes', async () => {
  const { data: { token } } = await registerUser(uniqueUsername('henry'));
  const created = await (await fetch(`${baseUrl}/api/conversations`, {
    method: 'POST', headers: authHeaders(token, true), body: JSON.stringify({ title: 'AI settings test' })
  })).json();
  const id = created.conversation.id;

  const history = [{ type: 'text', sender: 'user', text: 'do not lose me', time: '11:00 AM' }];
  await fetch(`${baseUrl}/api/conversations/${id}`, {
    method: 'PUT', headers: authHeaders(token, true),
    body: JSON.stringify({ history, userName: 'Henry', notes: ['keep this'] })
  });

  const aiOnlyRes = await fetch(`${baseUrl}/api/conversations/${id}`, {
    method: 'PUT', headers: authHeaders(token, true),
    body: JSON.stringify({ provider: 'anthropic', model: 'claude-sonnet-5', systemPrompt: 'Be terse.' })
  });
  assert.equal(aiOnlyRes.status, 200);

  const got = await (await fetch(`${baseUrl}/api/conversations/${id}`, { headers: authHeaders(token) })).json();
  assert.deepEqual(got.conversation.history, history, 'history must survive an AI-settings-only PUT');
  assert.equal(got.conversation.userName, 'Henry');
  assert.deepEqual(got.conversation.notes, ['keep this']);
  assert.equal(got.conversation.provider, 'anthropic');
  assert.equal(got.conversation.model, 'claude-sonnet-5');
  assert.equal(got.conversation.systemPrompt, 'Be terse.');
});

// ---------- Search ----------

test('search: finds a matching message across conversations with a snippet', async () => {
  const { data: { token } } = await registerUser(uniqueUsername('ivy'));
  const created = await (await fetch(`${baseUrl}/api/conversations`, {
    method: 'POST', headers: authHeaders(token, true), body: JSON.stringify({ title: 'Searchable' })
  })).json();
  await fetch(`${baseUrl}/api/conversations/${created.conversation.id}`, {
    method: 'PUT', headers: authHeaders(token, true),
    body: JSON.stringify({
      history: [{ type: 'text', sender: 'user', text: 'the quokka is the happiest animal', time: '9:00 AM' }],
      userName: null, notes: []
    })
  });

  const res = await fetch(`${baseUrl}/api/search?q=quokka`, { headers: authHeaders(token) });
  const data = await res.json();
  assert.equal(data.results.length, 1);
  assert.match(data.results[0].snippet, /quokka/);
});

// ---------- Files & ask-files ----------

test('files: upload a .txt, list it, fetch its text, and ask-files finds an answer via keyword fallback', async () => {
  const { data: { token } } = await registerUser(uniqueUsername('jack'));

  const form = new FormData();
  form.append('file', new Blob(['Our office is open from 9am to 6pm on weekdays.'], { type: 'text/plain' }), 'hours.txt');
  const upload = await fetch(`${baseUrl}/api/files`, { method: 'POST', headers: authHeaders(token), body: form });
  assert.equal(upload.status, 200);
  const uploaded = await upload.json();
  assert.equal(uploaded.file.name, 'hours.txt');

  const list = await (await fetch(`${baseUrl}/api/files`, { headers: authHeaders(token) })).json();
  assert.equal(list.files.length, 1);

  const got = await (await fetch(`${baseUrl}/api/files/${uploaded.file.id}`, { headers: authHeaders(token) })).json();
  assert.match(got.text, /9am to 6pm/);

  const ask = await fetch(`${baseUrl}/api/ask-files`, {
    method: 'POST', headers: authHeaders(token, true),
    body: JSON.stringify({ question: 'What time does the office open?' })
  });
  const answer = await ask.json();
  assert.ok(answer.answer, 'expected a keyword-fallback match since VOYAGE_API_KEY is unset in tests');
  assert.match(answer.answer, /9am to 6pm/);
});

// ---------- AI config, prompt templates, knowledge, /api/chat validation ----------

test('ai config: lists providers, reports both unconfigured (keys unset in test env)', async () => {
  const { data: { token } } = await registerUser(uniqueUsername('kate'));
  const res = await fetch(`${baseUrl}/api/ai/config`, { headers: authHeaders(token) });
  const data = await res.json();
  assert.equal(data.configured.anthropic, false);
  assert.equal(data.configured.openai, false);
  assert.ok(data.providers.some(p => p.id === 'anthropic'));
  assert.ok(data.providers.some(p => p.id === 'openai'));
});

test('prompt templates: create, list, rename, delete', async () => {
  const { data: { token } } = await registerUser(uniqueUsername('liam'));

  const created = await (await fetch(`${baseUrl}/api/prompt-templates`, {
    method: 'POST', headers: authHeaders(token, true),
    body: JSON.stringify({ name: 'Terse', systemPrompt: 'Answer in one sentence.' })
  })).json();
  assert.ok(created.template.id);

  const list = await (await fetch(`${baseUrl}/api/prompt-templates`, { headers: authHeaders(token) })).json();
  assert.equal(list.templates.length, 1);

  await fetch(`${baseUrl}/api/prompt-templates/${created.template.id}`, {
    method: 'PATCH', headers: authHeaders(token, true), body: JSON.stringify({ name: 'Very terse' })
  });
  const list2 = await (await fetch(`${baseUrl}/api/prompt-templates`, { headers: authHeaders(token) })).json();
  assert.equal(list2.templates[0].name, 'Very terse');

  await fetch(`${baseUrl}/api/prompt-templates/${created.template.id}`, { method: 'DELETE', headers: authHeaders(token) });
  const list3 = await (await fetch(`${baseUrl}/api/prompt-templates`, { headers: authHeaders(token) })).json();
  assert.equal(list3.templates.length, 0);
});

test('knowledge: create (no embeddings, VOYAGE_API_KEY unset), list, update, delete', async () => {
  const { data: { token } } = await registerUser(uniqueUsername('mia'));

  const created = await (await fetch(`${baseUrl}/api/knowledge`, {
    method: 'POST', headers: authHeaders(token, true),
    body: JSON.stringify({ title: 'Office hours', content: 'Open 9 to 6 on weekdays.' })
  })).json();
  assert.ok(created.knowledge.id);

  const list = await (await fetch(`${baseUrl}/api/knowledge`, { headers: authHeaders(token) })).json();
  assert.equal(list.knowledge.length, 1);

  const updated = await (await fetch(`${baseUrl}/api/knowledge/${created.knowledge.id}`, {
    method: 'PUT', headers: authHeaders(token, true),
    body: JSON.stringify({ title: 'Office hours', content: 'Open 8 to 5 on weekdays now.' })
  })).json();
  assert.match(updated.knowledge.content, /8 to 5/);

  await fetch(`${baseUrl}/api/knowledge/${created.knowledge.id}`, { method: 'DELETE', headers: authHeaders(token) });
  const list2 = await (await fetch(`${baseUrl}/api/knowledge`, { headers: authHeaders(token) })).json();
  assert.equal(list2.knowledge.length, 0);
});

test('chat: rejects a missing message, an invalid model, and an unconfigured provider', async () => {
  const { data: { token } } = await registerUser(uniqueUsername('noah'));

  const noMessage = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST', headers: authHeaders(token, true),
    body: JSON.stringify({ provider: 'anthropic', model: 'claude-sonnet-5' })
  });
  assert.equal(noMessage.status, 400);

  const badModel = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST', headers: authHeaders(token, true),
    body: JSON.stringify({ message: 'hi', provider: 'anthropic', model: 'not-a-real-model' })
  });
  assert.equal(badModel.status, 400);

  const unconfigured = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST', headers: authHeaders(token, true),
    body: JSON.stringify({ message: 'hi', provider: 'anthropic', model: 'claude-sonnet-5' })
  });
  assert.equal(unconfigured.status, 400);
  const data = await unconfigured.json();
  assert.match(data.error, /not configured/);
});
