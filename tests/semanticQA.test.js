const test = require('node:test');
const assert = require('node:assert/strict');

const docQA = require('../docQA');
const { cosineSimilarity, findAnswerSemantic, embedChunksForFile, findAnswer } = docQA;

// These tests never call the real Voyage AI API — embedTexts is monkeypatched
// on the module's exports object (which findAnswer/findAnswerSemantic/
// embedChunksForFile call through internally as `exports.embedTexts`), so no
// network access or VOYAGE_API_KEY is required to verify the semantic-match
// logic itself.
function withMockEmbedTexts(mockFn, run) {
  const original = docQA.embedTexts;
  docQA.embedTexts = mockFn;
  return Promise.resolve(run()).finally(() => {
    docQA.embedTexts = original;
  });
}

function withVoyageKey(run) {
  const original = process.env.VOYAGE_API_KEY;
  process.env.VOYAGE_API_KEY = 'test-key-not-a-real-credential';
  return Promise.resolve(run()).finally(() => {
    if (original === undefined) delete process.env.VOYAGE_API_KEY;
    else process.env.VOYAGE_API_KEY = original;
  });
}

test('cosineSimilarity: identical direction is 1, orthogonal is 0', () => {
  assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
  assert.equal(cosineSimilarity([0, 0], [1, 0]), 0);
});

test('findAnswerSemantic picks the highest-similarity chunk above the threshold', async () => {
  const files = [{
    name: 'doc.pdf',
    chunks: [
      { text: 'The office closes at 6pm on weekdays.', embedding: [1, 0] },
      { text: 'Our founder started the company in a garage.', embedding: [0, 1] }
    ]
  }];
  await withMockEmbedTexts(
    async () => [[1, 0]], // question vector matches chunk 1 exactly, orthogonal to chunk 2
    async () => {
      const match = await findAnswerSemantic(files, 'When does the office close?');
      assert.ok(match);
      assert.match(match.sentence, /6pm/);
    }
  );
});

test('findAnswerSemantic returns null when nothing clears the similarity threshold', async () => {
  const files = [{
    name: 'doc.pdf',
    chunks: [{ text: 'Unrelated sentence about something else entirely.', embedding: [1, 0] }]
  }];
  await withMockEmbedTexts(
    async () => [[0, 1]], // orthogonal to the only chunk -> similarity 0
    async () => {
      const match = await findAnswerSemantic(files, 'Some question');
      assert.equal(match, null);
    }
  );
});

test('embedChunksForFile pairs each chunk with its embedding in order', async () => {
  await withMockEmbedTexts(
    async (texts) => texts.map((_, i) => [i, i + 1]),
    async () => {
      const result = await embedChunksForFile('First line.\nSecond line.\nThird line.');
      assert.equal(result.length, 3);
      result.forEach((chunk, i) => {
        assert.deepEqual(chunk.embedding, [i, i + 1]);
        assert.ok(chunk.text.length > 0);
      });
    }
  );
});

test('findAnswer prefers a semantic match over the keyword matcher when embeddings are available', async () => {
  const files = [{
    name: 'doc.pdf',
    // Deliberately worded so the keyword matcher (no literal overlap with a
    // paraphrased question) would find nothing here, but the mocked semantic
    // embedding still "recognizes" it as the answer.
    text: 'Reimbursements are processed within two weeks of the original purchase.',
    chunks: [{ text: 'Reimbursements are processed within two weeks of the original purchase.', embedding: [1, 0] }]
  }];
  await withVoyageKey(() =>
    withMockEmbedTexts(
      async () => [[1, 0]],
      async () => {
        const match = await findAnswer(files, 'How long until I get my money back?');
        assert.ok(match);
        assert.match(match.sentence, /Reimbursements/);
      }
    )
  );
});

test('findAnswer falls back to keyword search when the embeddings call fails', async () => {
  const files = [{
    name: 'doc.pdf',
    text: 'Refunds are issued within 14 days of purchase for unused items.',
    chunks: [{ text: 'Refunds are issued within 14 days of purchase for unused items.', embedding: [1, 0] }]
  }];
  await withVoyageKey(() =>
    withMockEmbedTexts(
      async () => { throw new Error('simulated Voyage API outage'); },
      async () => {
        const match = await findAnswer(files, 'How many days until a refund?');
        assert.ok(match, 'keyword fallback should still find the answer');
        assert.match(match.sentence, /14 days/);
      }
    )
  );
});
