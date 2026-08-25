// --- Real local vector index (vectra), replacing the hand-rolled brute-force
// cosine-similarity scan over embeddings that used to be stored inline on
// file/knowledge records in data.json ---
//
// One shared index on disk, filtered by `userId` (per-account isolation),
// `sourceType` (`file` vs `knowledge`, so a query can target one or both),
// and `sourceId` (so deleteBySource can target exactly one file/knowledge
// entry's chunks). Only fields listed in metadata_config.indexed are
// filterable at all, hence indexing exactly these three.

const path = require('path');
const { LocalIndex } = require('vectra');

const DATA_DIR = process.env.DATA_DIR || __dirname;
const INDEX_DIR = path.join(DATA_DIR, 'vector-index');

const index = new LocalIndex(INDEX_DIR);

let readyPromise = null;
function ensureIndex() {
  if (!readyPromise) {
    readyPromise = (async () => {
      if (!(await index.isIndexCreated())) {
        await index.createIndex({ version: 1, metadata_config: { indexed: ['userId', 'sourceType', 'sourceId'] } });
      }
    })();
  }
  return readyPromise;
}

// Upserts one vectra item per chunk. `sourceId` scopes the generated item
// ids so a later deleteBySource can remove exactly this source's chunks
// without touching any other file/knowledge entry's vectors.
async function upsertChunks(userId, sourceType, sourceId, sourceLabel, chunks) {
  await ensureIndex();
  for (let i = 0; i < chunks.length; i++) {
    await index.upsertItem({
      id: `${sourceType}:${sourceId}:${i}`,
      vector: chunks[i].embedding,
      metadata: { userId, sourceType, sourceId, sourceLabel, text: chunks[i].text }
    });
  }
}

// Removes every chunk previously upserted for this source — needed when a
// knowledge entry is re-embedded (stale chunks from the old content must go)
// or deleted (its vectors don't live inside the JSON record anymore, so
// nothing else removes them automatically).
async function deleteBySource(userId, sourceType, sourceId) {
  await ensureIndex();
  const items = await index.listItemsByMetadata({
    $and: [{ userId: { $eq: userId } }, { sourceType: { $eq: sourceType } }, { sourceId: { $eq: sourceId } }]
  });
  await index.deleteItems(items.map(i => i.id));
}

const DEFAULT_THRESHOLD = 0.5;

// Top-K semantic search across one user's chunks, optionally scoped to a
// single sourceType or excluding a list of them (e.g. memory categories that
// are injected into the system prompt unconditionally elsewhere and would
// otherwise risk being surfaced twice by an unscoped relevance search).
// Returns the same {sourceLabel, text, score} shape the old brute-force
// semanticSearchChunks used, so callers didn't need to change their
// result-handling code when this replaced it.
async function queryTopK(userId, queryVector, topK, opts = {}) {
  await ensureIndex();
  const { sourceType, excludeSourceTypes, threshold = DEFAULT_THRESHOLD } = opts;
  const clauses = [{ userId: { $eq: userId } }];
  if (sourceType) clauses.push({ sourceType: { $eq: sourceType } });
  if (excludeSourceTypes && excludeSourceTypes.length) clauses.push({ sourceType: { $nin: excludeSourceTypes } });
  const filter = clauses.length > 1 ? { $and: clauses } : clauses[0];
  const results = await index.queryItems(queryVector, '', topK, filter);
  return results
    .filter(r => r.score >= threshold)
    .map(r => ({ sourceLabel: r.item.metadata.sourceLabel, text: r.item.metadata.text, score: r.score }));
}

// Single best match — thin wrapper over queryTopK, used by the extractive
// Q&A path (/api/ask-files), which only ever wants one answer, not a list.
async function findBestMatch(userId, queryVector, opts = {}) {
  const [best] = await queryTopK(userId, queryVector, 1, opts);
  return best || null;
}

// Cheap existence check so callers can skip an embedding API call entirely
// when there's nothing to search yet (e.g. no files/knowledge embedded for
// this user) instead of always embedding the query just to get an empty
// result back.
async function hasAny(userId, sourceType) {
  await ensureIndex();
  const filter = sourceType
    ? { $and: [{ userId: { $eq: userId } }, { sourceType: { $eq: sourceType } }] }
    : { userId: { $eq: userId } };
  const items = await index.listItemsByMetadata(filter);
  return items.length > 0;
}

module.exports = { upsertChunks, deleteBySource, queryTopK, findBestMatch, hasAny, DEFAULT_THRESHOLD };
