// --- Automatic memory extraction ---
//
// Runs after an AI chat exchange completes: asks a cheap/fast model to pull
// out durable facts worth remembering (name, preferences, project context),
// then saves them — deduped against what's already known via vectorStore's
// per-user vector index, when embeddings are configured. This module is a
// background enhancement: every failure inside it is caught and logged, and
// nothing here is ever allowed to affect the user's actual chat reply, which
// has already been sent by the time any of this runs.

const ai = require('./ai');
const docQA = require('./docQA');
const db = require('./db');
const vectorStore = require('./vectorStore');

const MAX_MEMORIES_IN_PROMPT = 30;
const DEDUP_SIMILARITY_THRESHOLD = 0.88;
const CATEGORIES = ['user', 'project', 'preference', 'conversation'];

// Extraction runs on every single AI exchange — it must not silently double
// the cost of whatever (possibly expensive) model the user picked for the
// actual reply, so it always uses the cheapest model in that provider's own
// list (the last entry, by this file's convention in ai.js's PROVIDERS).
function extractionModelFor(provider) {
  const models = ai.PROVIDERS[provider] && ai.PROVIDERS[provider].models;
  if (!models || !models.length) return null;
  return models[models.length - 1].id;
}

function buildExtractionPrompt(allowedCategories) {
  return `You extract durable, worth-remembering facts from a single chat exchange for a personal assistant's long-term memory.

Only extract facts that would still be useful weeks from now — the user's name, stated preferences (tone, format, likes/dislikes), ongoing project context, or important decisions. Do NOT extract small talk, one-off questions, or anything already obvious from context.

Allowed categories: ${allowedCategories.join(', ')}.
- user: stable facts about who the user is (name, role, background)
- project: what the user is working on, its goals, constraints, decisions
- preference: how the user wants things done (tone, format, tools)
- conversation: important context/decisions from this specific exchange worth recalling later

Respond with ONLY a JSON array, no prose, no markdown fences. Each item: {"category": "...", "content": "..."}. If nothing is worth remembering, respond with [].`;
}

function parseCandidates(text, allowedCategories) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return [];
    try {
      parsed = JSON.parse(match[0]);
    } catch (e2) {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter(item => item && typeof item.category === 'string' && typeof item.content === 'string')
    .filter(item => allowedCategories.includes(item.category) && item.content.trim())
    .map(item => ({ category: item.category, content: item.content.trim().slice(0, 500) }))
    .slice(0, 10);
}

async function extractMemories({ userId, provider, userMessage, assistantReply, allowedCategories }) {
  if (!allowedCategories.length) return [];
  const model = extractionModelFor(provider);
  if (!model) return [];
  try {
    let text = '';
    await ai.streamChatCompletion(
      {
        provider,
        model,
        systemPrompt: buildExtractionPrompt(allowedCategories),
        messages: [{ role: 'user', content: `User: ${userMessage}\n\nAssistant: ${assistantReply}` }]
      },
      delta => { text += delta; }
    );
    return parseCandidates(text, allowedCategories);
  } catch (e) {
    console.error('Memory extraction failed:', e.message);
    return [];
  }
}

// Saves each candidate unless a near-duplicate memory already exists in the
// same category (checked via cosine similarity when embeddings are
// configured). Without VOYAGE_API_KEY, dedup is skipped entirely and every
// candidate is saved — same graceful-degradation shape as the rest of this
// codebase's optional-embeddings features.
async function saveExtractedMemories({ userId, conversationId, candidates }) {
  for (const candidate of candidates) {
    try {
      if (docQA.isEmbeddingConfigured()) {
        const [embedding] = await docQA.embedTexts([candidate.content], 'document');
        const existing = await vectorStore.findBestMatch(userId, embedding, {
          sourceType: 'memory:' + candidate.category,
          threshold: DEDUP_SIMILARITY_THRESHOLD
        });
        if (existing) continue;
        const record = db.createMemory(userId, { ...candidate, sourceConversationId: conversationId });
        if (record) {
          await vectorStore.upsertChunks(userId, 'memory:' + candidate.category, record.id, record.category, [
            { text: record.content, embedding }
          ]);
        }
      } else {
        db.createMemory(userId, { ...candidate, sourceConversationId: conversationId });
      }
    } catch (e) {
      console.error('Saving an extracted memory failed:', e.message);
    }
  }
}

module.exports = {
  MAX_MEMORIES_IN_PROMPT, DEDUP_SIMILARITY_THRESHOLD, CATEGORIES,
  extractionModelFor, parseCandidates, extractMemories, saveExtractedMemories
};
