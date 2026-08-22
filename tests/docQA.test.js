const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { extractText, findAnswer } = require('../docQA');
const { buildTestPdf } = require('./pdf-helper');

function tmpPdf(lines) {
  const p = path.join(os.tmpdir(), `cb-test-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`);
  fs.writeFileSync(p, buildTestPdf(lines));
  return p;
}

test('(a) PDF text extracts correctly, including row-like table content', async () => {
  const lines = [
    'Refund Policy',
    'Refunds are issued within 14 days of purchase.',
    'Item        Price   Qty',
    'Widget      9.99    3',
    'Gadget      19.99   1',
    'Contact support at help@example.com for assistance.'
  ];
  const pdfPath = tmpPdf(lines);
  try {
    const text = await extractText(pdfPath, '.pdf');
    for (const line of lines) {
      assert.ok(text.includes(line.trim().replace(/\s+/g, ' ')) || text.includes(line),
        `extracted text should contain: "${line}"`);
    }
  } finally {
    fs.unlinkSync(pdfPath);
  }
});

test('(a) TXT text extracts verbatim', async () => {
  const p = path.join(os.tmpdir(), `cb-test-${Date.now()}.txt`);
  fs.writeFileSync(p, 'Hello world.\nSecond line.');
  try {
    const text = await extractText(p, '.txt');
    assert.equal(text, 'Hello world.\nSecond line.');
  } finally {
    fs.unlinkSync(p);
  }
});

function sampleFiles() {
  return [{
    name: 'policy.pdf',
    text: [
      'Welcome to Acme Corp. This document describes our return policy.',
      'Refunds are issued within 14 days of purchase for unused items.',
      'Shipping costs are non-refundable under any circumstances.',
      'For support, contact our helpdesk at help@example.com.',
      'Our offices are located in Springfield and are open on weekdays.'
    ].join('\n')
  }];
}

test('(b) an on-topic question returns the correct, relevant sentence', async () => {
  const files = sampleFiles();
  const match = await findAnswer(files, 'How many days do I have to get a refund?');
  assert.ok(match, 'expected a match for an on-topic refund question');
  assert.match(match.sentence, /14 days/);
  assert.equal(match.file, 'policy.pdf');
});

test('(b) a second on-topic question matches a different, correct sentence', async () => {
  const files = sampleFiles();
  const match = await findAnswer(files, 'Where are your offices located?');
  assert.ok(match, 'expected a match for an on-topic office-location question');
  assert.match(match.sentence, /Springfield/);
});

test('(c) an out-of-document question returns no answer instead of a weak/unrelated match', async () => {
  const files = sampleFiles();
  // Shares no more than one incidental stopword-filtered term with any
  // sentence in the document (e.g. "weather" doesn't appear at all) — before
  // the relevance threshold fix, a single shared word anywhere in the text
  // was enough for findAnswer to confidently return an unrelated sentence.
  const match = await findAnswer(files, "What's the weather like tomorrow?");
  assert.equal(match, null);
});

test('regression: a single incidental keyword match is rejected for multi-keyword questions', async () => {
  const files = [{
    name: 'doc.txt',
    text: [
      'The annual report covers company performance in detail.',
      'Our marketing budget increased by ten percent this year.'
    ].join('\n')
  }];
  // "performance" is the only shared meaningful word with "budget review" — a
  // single-word overlap out of two question keywords should not clear the
  // relevance threshold.
  const match = await findAnswer(files, 'What is the performance budget review?');
  // Either no match, or if one is returned it must be a strong (>=2 word) match.
  if (match) assert.ok(match.overlap >= 2, 'weak single-word matches must not be returned');
});

test('multi-keyword question with strong overlap still matches', async () => {
  const files = sampleFiles();
  const match = await findAnswer(files, 'Is shipping cost refundable?');
  assert.ok(match);
  assert.match(match.sentence, /non-refundable/);
});
