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

function findAnswer(files, question) {
  const qWords = words(question);
  if (!qWords.length) return null;
  const minRequired = minOverlapRequired(qWords.length);
  let best = null;
  for (const f of files) {
    // Split on sentence punctuation AND newlines — plain prose (PDFs/DOCX
    // with real sentences) splits fine on punctuation alone, but slide decks,
    // bullet lists, and code snippets often have little to no punctuation,
    // so without the newline split the "sentence" ends up being the entire
    // block of text, returning a huge unhelpful wall of text as the answer.
    const chunks = (f.text || '').split(/(?<=[.!?])\s+|\r?\n+/).map(s => s.trim()).filter(Boolean);
    for (const s of chunks) {
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

module.exports = { extractText, words, findAnswer, STOPWORDS, MAX_ANSWER_LENGTH, minOverlapRequired };
