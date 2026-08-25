const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// DATA_DIR must be set to a fresh temp directory before requiring
// vectorStore.js (it reads DATA_DIR at module load to compute INDEX_DIR),
// so these tests exercise a real on-disk vectra index without touching any
// other test file's or the real app's data.
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'chatbuddy-vectorstore-test-'));
process.env.DATA_DIR = TEST_DATA_DIR;

const vectorStore = require('../vectorStore');

test.after(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test('upsertChunks + queryTopK: ranks results by real cosine similarity', async () => {
  await vectorStore.upsertChunks('user1', 'file', 'doc1', 'doc1.pdf', [
    { text: 'the office is open 9 to 6', embedding: [1, 0, 0] },
    { text: 'completely unrelated sentence', embedding: [0, 1, 0] }
  ]);

  const results = await vectorStore.queryTopK('user1', [1, 0, 0], 5);
  assert.equal(results.length, 1, 'the orthogonal chunk should fall below the default threshold');
  assert.equal(results[0].text, 'the office is open 9 to 6');
  assert.equal(results[0].sourceLabel, 'doc1.pdf');
  assert.ok(results[0].score > 0.99);
});

test('queryTopK: per-user isolation — one user never sees another user\'s chunks', async () => {
  await vectorStore.upsertChunks('userA', 'file', 'a-doc', 'a.pdf', [
    { text: 'user A secret info', embedding: [1, 0] }
  ]);
  await vectorStore.upsertChunks('userB', 'file', 'b-doc', 'b.pdf', [
    { text: 'user B secret info', embedding: [1, 0] }
  ]);

  const resultsA = await vectorStore.queryTopK('userA', [1, 0], 10);
  assert.ok(resultsA.every(r => r.text !== 'user B secret info'), 'user A must never see user B\'s chunk');

  const resultsB = await vectorStore.queryTopK('userB', [1, 0], 10);
  assert.ok(resultsB.every(r => r.text !== 'user A secret info'), 'user B must never see user A\'s chunk');
});

test('queryTopK: sourceType filter scopes results to just files or just knowledge', async () => {
  const userId = 'user-scoped';
  await vectorStore.upsertChunks(userId, 'file', 'f1', 'f1.pdf', [{ text: 'file chunk', embedding: [1, 0] }]);
  await vectorStore.upsertChunks(userId, 'knowledge', 'k1', 'My note', [{ text: 'knowledge chunk', embedding: [1, 0] }]);

  const fileOnly = await vectorStore.queryTopK(userId, [1, 0], 10, { sourceType: 'file' });
  assert.deepEqual(fileOnly.map(r => r.text), ['file chunk']);

  const knowledgeOnly = await vectorStore.queryTopK(userId, [1, 0], 10, { sourceType: 'knowledge' });
  assert.deepEqual(knowledgeOnly.map(r => r.text), ['knowledge chunk']);
});

test('queryTopK: threshold excludes low-similarity matches', async () => {
  const userId = 'user-threshold';
  await vectorStore.upsertChunks(userId, 'file', 'low-sim', 'low.pdf', [{ text: 'barely related', embedding: [0.1, 1] }]);

  const strict = await vectorStore.queryTopK(userId, [1, 0], 5, { threshold: 0.9 });
  assert.equal(strict.length, 0);

  const lenient = await vectorStore.queryTopK(userId, [1, 0], 5, { threshold: 0 });
  assert.equal(lenient.length, 1);
});

test('findBestMatch: returns the single top result, or null when nothing matches', async () => {
  const userId = 'user-best';
  await vectorStore.upsertChunks(userId, 'file', 'doc', 'doc.pdf', [
    { text: 'weak match', embedding: [0.6, 0.8] },
    { text: 'strong match', embedding: [1, 0] }
  ]);

  const best = await vectorStore.findBestMatch(userId, [1, 0]);
  assert.equal(best.text, 'strong match');

  const none = await vectorStore.findBestMatch('user-with-nothing-embedded', [1, 0]);
  assert.equal(none, null);
});

test('hasAny: reports false for an unseeded user/sourceType, true once something is upserted', async () => {
  const userId = 'user-hasany';
  assert.equal(await vectorStore.hasAny(userId, 'file'), false);
  assert.equal(await vectorStore.hasAny(userId), false);

  await vectorStore.upsertChunks(userId, 'file', 'doc', 'doc.pdf', [{ text: 'x', embedding: [1, 0] }]);

  assert.equal(await vectorStore.hasAny(userId, 'file'), true);
  assert.equal(await vectorStore.hasAny(userId, 'knowledge'), false);
  assert.equal(await vectorStore.hasAny(userId), true);
});

test('deleteBySource: removes exactly that source\'s chunks and no others', async () => {
  const userId = 'user-delete';
  await vectorStore.upsertChunks(userId, 'knowledge', 'k-to-delete', 'Deleted note', [
    { text: 'chunk one', embedding: [1, 0] },
    { text: 'chunk two', embedding: [1, 0] }
  ]);
  await vectorStore.upsertChunks(userId, 'knowledge', 'k-to-keep', 'Kept note', [
    { text: 'kept chunk', embedding: [1, 0] }
  ]);

  await vectorStore.deleteBySource(userId, 'knowledge', 'k-to-delete');

  const remaining = await vectorStore.queryTopK(userId, [1, 0], 10, { sourceType: 'knowledge' });
  assert.deepEqual(remaining.map(r => r.text).sort(), ['kept chunk']);
});
