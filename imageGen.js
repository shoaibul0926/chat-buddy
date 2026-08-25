// --- OpenAI Images API client (generation + edit-based creation features) ---
//
// Same convention as ai.js/docQA.js: raw fetch, no SDK. Node 20+'s global
// FormData/Blob build the multipart /edits request with zero new
// dependencies — fetch sets the multipart boundary itself from a FormData
// body, so never set Content-Type manually on that request.
//
// Only /v1/images/generations and /v1/images/edits are real OpenAI
// endpoints. Background removal, style transfer, and enhancement aren't
// separate API features — each is a thin wrapper around editImage() with a
// fixed/templated prompt and a couple of tuned parameters. This is the
// standard documented way to get these effects from this API, not an
// improvised workaround.

const ai = require('./ai');

const IMAGES_GENERATE_URL = 'https://api.openai.com/v1/images/generations';
const IMAGES_EDIT_URL = 'https://api.openai.com/v1/images/edits';

// The edit endpoint's own documented default. gpt-image-2's transparent-
// background support is still "in preview" per OpenAI's API reference, so
// 1.5 is the safer default specifically because removeBackground() depends
// on transparent backgrounds working reliably.
const MODEL = 'gpt-image-1.5';

function isConfigured() {
  return ai.isProviderConfigured('openai');
}

function apiKey() {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY is not set');
  return key;
}

async function parseImagesResponse(res, label) {
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${label} request failed: ${res.status} ${body}`);
  }
  const data = await res.json();
  const first = data.data && data.data[0];
  if (!first || !first.b64_json) throw new Error(`${label} response had no image data`);
  return { buffer: Buffer.from(first.b64_json, 'base64'), revisedPrompt: first.revised_prompt };
}

// n is hardcoded to 1 everywhere in this module — every call here is a real
// billed OpenAI request, and there's no reason a single click should ever
// multiply that cost.
async function generateImage({ prompt, size = 'auto', background = 'auto' }) {
  const res = await fetch(IMAGES_GENERATE_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ model: MODEL, prompt, size, background, output_format: 'png', n: 1 })
  });
  return parseImagesResponse(res, 'Image generation');
}

async function editImage({ imageBuffer, mimeType, prompt, background = 'auto', inputFidelity, quality }) {
  const form = new FormData();
  form.append('model', MODEL);
  form.append('prompt', prompt);
  form.append('image', new Blob([imageBuffer], { type: mimeType }), 'image');
  form.append('background', background);
  form.append('output_format', 'png');
  form.append('size', 'auto');
  form.append('n', '1');
  if (inputFidelity) form.append('input_fidelity', inputFidelity);
  if (quality) form.append('quality', quality);

  const res = await fetch(IMAGES_EDIT_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey()}` },
    body: form
  });
  return parseImagesResponse(res, 'Image edit');
}

function removeBackground({ imageBuffer, mimeType }) {
  return editImage({
    imageBuffer,
    mimeType,
    prompt: 'Remove the background from this image completely, keep the main subject exactly as-is, transparent background.',
    background: 'transparent'
  });
}

function styleTransferImage({ imageBuffer, mimeType, stylePrompt }) {
  return editImage({
    imageBuffer,
    mimeType,
    prompt: `Redraw this image in the following style: ${stylePrompt}. Keep the same subject and composition.`,
    inputFidelity: 'low'
  });
}

// This re-renders the image through a generative model — it is not a
// deterministic, pixel-preserving upscaler. Callers must present the result
// as an AI-enhanced re-render, not a lossless enhancement.
function enhanceImage({ imageBuffer, mimeType }) {
  return editImage({
    imageBuffer,
    mimeType,
    prompt: 'Enhance this image: increase sharpness, clarity, and fine detail while preserving the exact subject, composition, colors, and framing. Do not add, remove, or change any elements.',
    inputFidelity: 'high',
    quality: 'high'
  });
}

module.exports = {
  isConfigured, generateImage, editImage, removeBackground, styleTransferImage, enhanceImage, MODEL
};
