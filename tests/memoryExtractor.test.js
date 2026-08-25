const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// DATA_DIR must be set before requiring vectorStore.js/db.js (both read it
// at module load), so dedup tests exercise a real temp vectra index/data.json
// rather than mocking storage — same technique used throughout this session
// (vectorStore.test.js, semanticQA.test.js, server.test.js).
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'chatbuddy-memoryextractor-test-'));
process.env.DATA_DIR = TEST_DATA_DIR;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENAI_API_KEY;
delete process.env.VOYAGE_API_KEY;

const memoryExtractor = require('../memoryExtractor');
const docQA = require('../docQA');
const db = require('../db');

test.after(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

function withMockFetch(mockFn, run) {
  const original = global.fetch;
  global.fetch = mockFn;
  return Promise.resolve(run()).finally(() => { global.fetch = original; });
}

function withEnvKey(name, run) {
  const original = process.env[name];
  process.env[name] = 'test-key-not-a-real-credential';
  return Promise.resolve(run()).finally(() => {
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
  });
}

function withMockEmbedTexts(mockFn, run) {
  const original = docQA.embedTexts;
  docQA.embedTexts = mockFn;
  return Promise.resolve(run()).finally(() => { docQA.embedTexts = original; });
}

function sseChunk(text) {
  return `data: {"type":"content_block_delta","delta":{"type":"text_delta","text":${JSON.stringify(text)}}}\n\n`;
}

function sseResponse(rawChunks) {
  const encoder = new TextEncoder();
  let i = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (i < rawChunks.length) controller.enqueue(encoder.encode(rawChunks[i++]));
      else controller.close();
    }
  });
  return { ok: true, status: 200, body, text: async () => '' };
}

// db.createMemory (like the rest of db.js's CRUD) requires an existing user
// record — a bare string id with no registered user silently no-ops. Real
// users are cheap to create here since we don't care about auth in these
// tests, only that the user exists for the foreign-key-style lookup.
let uniqueCounter = 0;
function uniqueUserId() {
  uniqueCounter += 1;
  const user = db.createUser(`memtest-user-${uniqueCounter}`, 'fake-hash');
  return user.id;
}

// ---------- extractionModelFor ----------

test('extractionModelFor picks the cheapest (last) model in a provider\'s list', () => {
  assert.equal(memoryExtractor.extractionModelFor('anthropic'), 'claude-haiku-4-5');
  assert.equal(memoryExtractor.extractionModelFor('openai'), 'gpt-5-mini');
  assert.equal(memoryExtractor.extractionModelFor('not-a-provider'), null);
});

// ---------- parseCandidates ----------

test('parseCandidates accepts a clean JSON array and filters to allowed categories', () => {
  const text = '[{"category":"user","content":"Name is Alex"},{"category":"project","content":"Building a chatbot"}]';
  const result = memoryExtractor.parseCandidates(text, ['user']);
  assert.deepEqual(result, [{ category: 'user', content: 'Name is Alex' }]);
});

test('parseCandidates extracts JSON from prose the model wrapped it in', () => {
  const text = 'Sure, here is the JSON:\n[{"category":"preference","content":"Prefers concise replies"}]\nHope that helps!';
  const result = memoryExtractor.parseCandidates(text, ['preference']);
  assert.deepEqual(result, [{ category: 'preference', content: 'Prefers concise replies' }]);
});

test('parseCandidates returns [] for malformed or empty output, never throws', () => {
  assert.deepEqual(memoryExtractor.parseCandidates('not json at all', ['user']), []);
  assert.deepEqual(memoryExtractor.parseCandidates('[]', ['user']), []);
  assert.deepEqual(memoryExtractor.parseCandidates('', ['user']), []);
});

// ---------- extractMemories (mocked LLM call) ----------

test('extractMemories calls the LLM and parses its streamed response into candidates', async () => {
  await withEnvKey('ANTHROPIC_API_KEY', () =>
    withMockFetch(
      async () => sseResponse([sseChunk('[{"category":"user","content":"Name is Sam"}]')]),
      async () => {
        const candidates = await memoryExtractor.extractMemories({
          userId: 'u1', provider: 'anthropic',
          userMessage: 'My name is Sam', assistantReply: 'Nice to meet you, Sam!',
          allowedCategories: ['user', 'project', 'preference', 'conversation']
        });
        assert.deepEqual(candidates, [{ category: 'user', content: 'Name is Sam' }]);
      }
    )
  );
});

test('extractMemories returns [] and never throws when the LLM call fails', async () => {
  await withEnvKey('ANTHROPIC_API_KEY', () =>
    withMockFetch(
      async () => { throw new Error('simulated network failure'); },
      async () => {
        const candidates = await memoryExtractor.extractMemories({
          userId: 'u1', provider: 'anthropic',
          userMessage: 'hi', assistantReply: 'hello',
          allowedCategories: ['user']
        });
        assert.deepEqual(candidates, []);
      }
    )
  );
});

test('extractMemories returns [] immediately when no categories are allowed (no LLM call made)', async () => {
  await withMockFetch(
    async () => { throw new Error('should not be called'); },
    async () => {
      const candidates = await memoryExtractor.extractMemories({
        userId: 'u1', provider: 'anthropic', userMessage: 'hi', assistantReply: 'hello', allowedCategories: []
      });
      assert.deepEqual(candidates, []);
    }
  );
});

// ---------- saveExtractedMemories (real temp vectorStore for dedup) ----------

test('saveExtractedMemories saves a new candidate when nothing similar exists yet', async () => {
  const userId = uniqueUserId();
  await withEnvKey('VOYAGE_API_KEY', () =>
    withMockEmbedTexts(
      async () => [[1, 0]],
      async () => {
        await memoryExtractor.saveExtractedMemories({
          userId, conversationId: 'c1',
          candidates: [{ category: 'user', content: 'The user\'s name is Sam' }]
        });
        const memories = db.listMemories(userId);
        assert.equal(memories.length, 1);
        assert.equal(memories[0].content, 'The user\'s name is Sam');
        assert.equal(memories[0].category, 'user');
      }
    )
  );
});

test('saveExtractedMemories skips a near-duplicate of an existing memory in the same category', async () => {
  const userId = uniqueUserId();
  await withEnvKey('VOYAGE_API_KEY', () =>
    withMockEmbedTexts(
      async () => [[1, 0]], // identical embedding every call -> always a "duplicate"
      async () => {
        await memoryExtractor.saveExtractedMemories({
          userId, conversationId: 'c1', candidates: [{ category: 'user', content: 'Name is Sam' }]
        });
        await memoryExtractor.saveExtractedMemories({
          userId, conversationId: 'c2', candidates: [{ category: 'user', content: 'Name is Sam (again)' }]
        });
        assert.equal(db.listMemories(userId).length, 1, 'the second near-duplicate candidate must be skipped');
      }
    )
  );
});

test('saveExtractedMemories saves without dedup when VOYAGE_API_KEY is unset', async () => {
  const userId = uniqueUserId();
  await memoryExtractor.saveExtractedMemories({
    userId, conversationId: 'c1', candidates: [{ category: 'preference', content: 'Likes short answers' }]
  });
  const memories = db.listMemories(userId);
  assert.equal(memories.length, 1);
  assert.equal(memories[0].category, 'preference');
});
