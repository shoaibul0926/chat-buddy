const fs = require('fs');
const { PDFParse } = require('pdf-parse');
const mammoth = require('mammoth');

async function extractText(filePath, ext) {
  if (ext === '.txt') return fs.readFileSync(filePath, 'utf8');
  if (ext === '.pdf') {
    const parser = new PDFParse({ data: fs.readFileSync(filePath) });
    const result = await parser.getText();
    await parser.destroy();
    // pdf-parse emits runs of extra spaces/tabs for multi-column text and
    // table-like layouts (each visual column gap becomes literal whitespace).
    // Collapsing horizontal whitespace per line — without touching newlines,
    // which are the only paragraph/row boundary we have — keeps that content
    // intact while giving the sentence splitter clean input to chunk on.
    return result.text
      .split('\n')
      .map(line => line.replace(/[ \t]+/g, ' ').trim())
      .join('\n');
  }
  if (ext === '.docx') return (await mammoth.extractRawText({ path: filePath })).value;
  return '';
}

// Split on sentence punctuation AND newlines — plain prose (PDFs/DOCX with
// real sentences) splits fine on punctuation alone, but slide decks, bullet
// lists, and code snippets often have little to no punctuation, so without
// the newline split a "chunk" ends up being the entire block of text.
function chunkText(text) {
  return (text || '').split(/(?<=[.!?])\s+|\r?\n+/).map(s => s.trim()).filter(Boolean);
}

const STOPWORDS = new Set([
  'the', 'is', 'a', 'an', 'of', 'to', 'and', 'in', 'on', 'for', 'what', 'does',
  'do', 'did', 'say', 'about', 'tell', 'me', 'file', 'document', 'that', 'this',
  'it', 'was', 'were', 'are', 'be', 'been', 'being', 'with', 'as', 'at', 'from',
  'my', 'your', 'our', 'their', 'his', 'her', 'its', 'i', 'you', 'we', 'they',
  'he', 'she', 'him', 'them', 'us',
  // Question/filler words: carry no topical meaning on their own, but unlike
  // "what"/"does" above they show up in almost every natural-phrased question
  // ("How many days do I have to..."), inflating the question's word count
  // and pushing the relevance threshold higher than the real topic words
  // ("days", "refund") can clear.
  'how', 'many', 'much', 'have', 'has', 'had', 'get', 'got', 'can', 'could',
  'would', 'should', 'will', 'shall', 'may', 'might', 'must', 'who', 'whom',
  'which', 'when', 'why', 'where', 'if', 'than', 'then', 'so', 'but', 'or',
  'not', 'no', 'yes', 'please', 'there', 'here', 'also', 'just', 'by'
]);

// Naive plural stripping so "refund"/"refunds", "day"/"days" etc. count as
// the same word for overlap purposes. Applied identically to question and
// document text, so it only needs to be self-consistent, not produce real
// dictionary stems.
function normalize(w) {
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

function words(text) {
  return (text.toLowerCase().match(/[a-z]+|[0-9]+/g) || [])
    .filter(w => !STOPWORDS.has(w))
    .filter(w => w.length > 1 || /^[0-9]$/.test(w))
    .map(normalize);
}

const MAX_ANSWER_LENGTH = 400;

// A question must clear this fraction of its meaningful (non-stopword) words
// actually appearing in a chunk before that chunk counts as a match. Without
// it, a single incidental shared word anywhere in the document (e.g. both
// the question and some unrelated sentence contain "system") was enough to
// be returned as a confident answer — the source of "inaccurate or
// unrelated" answers. Single-keyword questions still need the one word.
function minOverlapRequired(qWordCount) {
  if (qWordCount <= 1) return 1;
  return Math.max(2, Math.ceil(qWordCount / 2));
}

// Literal keyword-overlap matching. Fast, needs no network/API key, but only
// finds answers phrased close to the document's own wording — kept as the
// baseline and as a fallback for files with no precomputed embeddings (no
// VOYAGE_API_KEY configured, or the embedding call failed at upload time).
function findAnswerKeyword(files, question) {
  const qWords = words(question);
  if (!qWords.length) return null;
  const minRequired = minOverlapRequired(qWords.length);
  let best = null;
  for (const f of files) {
    for (const s of chunkText(f.text)) {
      const sWords = words(s);
      if (!sWords.length) continue;
      const overlap = qWords.filter(w => sWords.includes(w)).length;
      if (overlap < minRequired) continue;
      // Among equally-matching chunks, prefer the one where the matched
      // words make up more of the sentence (a focused sentence) over a long
      // sentence that happens to contain the same number of matching words.
      const ratio = overlap / sWords.length;
      if (!best || overlap > best.overlap || (overlap === best.overlap && ratio > best.ratio)) {
        best = { overlap, ratio, sentence: s, file: f.name };
      }
    }
  }
  if (best && best.sentence.length > MAX_ANSWER_LENGTH) {
    best.sentence = best.sentence.slice(0, MAX_ANSWER_LENGTH) + '…';
  }
  return best;
}

// --- Semantic matching (Voyage AI embeddings) ---
//
// Anthropic has no first-party embeddings endpoint; Voyage AI (acquired by
// Anthropic, and their recommended embeddings provider for RAG alongside
// Claude) fills that role. Chunk embeddings are computed once per file at
// upload time and stored on the file record; answering a question only needs
// one embedding call (for the question itself) plus local cosine-similarity
// math against the precomputed vectors.
const VOYAGE_API_URL = 'https://api.voyageai.com/v1/embeddings';
const EMBEDDING_MODEL = 'voyage-3.5-lite';
const EMBEDDING_DIMENSION = 512;
const SEMANTIC_SIMILARITY_THRESHOLD = 0.5;
const EMBEDDING_BATCH_LIMIT = 1000; // Voyage's per-request cap on input texts

function isEmbeddingConfigured() {
  return Boolean(process.env.VOYAGE_API_KEY);
}

async function embedTexts(texts, inputType) {
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey) throw new Error('VOYAGE_API_KEY is not set');
  const res = await fetch(VOYAGE_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: texts,
      input_type: inputType,
      output_dimension: EMBEDDING_DIMENSION
    })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Voyage embeddings request failed: ${res.status} ${body}`);
  }
  const data = await res.json();
  return data.data.sort((a, b) => a.index - b.index).map(d => d.embedding);
}

function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Computes {text, embedding} pairs for a file's chunks — call once at upload
// time and store the result on the file record so answering questions later
// never needs to re-embed the whole document.
async function embedChunksForFile(text) {
  const chunks = chunkText(text).filter(c => words(c).length > 0).slice(0, EMBEDDING_BATCH_LIMIT);
  if (!chunks.length) return [];
  const embeddings = await module.exports.embedTexts(chunks, 'document');
  return chunks.map((chunkText, i) => ({ text: chunkText, embedding: embeddings[i] }));
}

async function findAnswerSemantic(files, question) {
  const [qEmbedding] = await module.exports.embedTexts([question], 'query');
  let best = null;
  for (const f of files) {
    for (const chunk of f.chunks || []) {
      const score = cosineSimilarity(qEmbedding, chunk.embedding);
      if (score < SEMANTIC_SIMILARITY_THRESHOLD) continue;
      if (!best || score > best.score) {
        best = { score, sentence: chunk.text, file: f.name };
      }
    }
  }
  if (best && best.sentence.length > MAX_ANSWER_LENGTH) {
    best.sentence = best.sentence.slice(0, MAX_ANSWER_LENGTH) + '…';
  }
  return best;
}

// Retrieves the top-K most relevant chunks across a merged pool of sources
// (uploaded files + knowledge base entries) for a single query — used for
// RAG context injection in /api/chat. Unlike findAnswerSemantic (single best
// chunk overall, for extractive Q&A), this returns multiple ranked results
// across possibly-multiple sources, and is purely additive: it doesn't touch
// findAnswerSemantic or any other existing export/behavior.
async function semanticSearchChunks(pool, query, opts = {}) {
  const { topK = 5, threshold = SEMANTIC_SIMILARITY_THRESHOLD } = opts;
  const [qEmbedding] = await module.exports.embedTexts([query], 'query');
  const scored = [];
  for (const source of pool) {
    for (const chunk of source.chunks || []) {
      const score = cosineSimilarity(qEmbedding, chunk.embedding);
      if (score < threshold) continue;
      scored.push({ score, text: chunk.text, sourceLabel: source.sourceLabel });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

// Public entry point: prefer semantic matching for files that have
// precomputed embeddings, falling back to keyword matching — for files with
// no embeddings, when no question clears the semantic similarity threshold,
// or when the embeddings call itself fails (network/API error), so a Voyage
// outage degrades matching quality instead of breaking Q&A entirely.
async function findAnswer(files, question) {
  const embeddedFiles = files.filter(f => Array.isArray(f.chunks) && f.chunks.length);
  if (embeddedFiles.length && isEmbeddingConfigured()) {
    try {
      const semanticMatch = await module.exports.findAnswerSemantic(embeddedFiles, question);
      if (semanticMatch) return semanticMatch;
    } catch (e) {
      console.error('Semantic match failed, falling back to keyword search:', e.message);
    }
  }
  return findAnswerKeyword(files, question);
}

module.exports = {
  extractText, words, findAnswer, findAnswerKeyword, findAnswerSemantic, semanticSearchChunks,
  chunkText, embedTexts, embedChunksForFile, cosineSimilarity, isEmbeddingConfigured,
  STOPWORDS, MAX_ANSWER_LENGTH, minOverlapRequired,
  EMBEDDING_MODEL, EMBEDDING_DIMENSION, SEMANTIC_SIMILARITY_THRESHOLD
};
