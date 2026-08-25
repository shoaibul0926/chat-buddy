// --- LLM chat providers (Anthropic + OpenAI) ---
//
// Same convention as docQA.js's Voyage integration: raw fetch, no SDK, one
// env var per provider read at the point of use, plus an isProviderConfigured
// check so callers can branch on availability without knowing the env var
// name. Streaming is parsed from each provider's server-sent-events response
// and re-emitted to the caller as plain delta strings via a callback — the
// HTTP-layer streaming protocol back to the browser (server.js's /api/chat)
// is a separate, simpler concern (NDJSON, not SSE) handled by the caller.

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';
const ANTHROPIC_VERSION = '2023-06-01';
const MAX_TOKENS = 4096;

const PROVIDERS = {
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic',
    models: [
      { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
      { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' }
    ]
  },
  openai: {
    id: 'openai',
    label: 'OpenAI',
    models: [
      { id: 'gpt-5', label: 'GPT-5' },
      { id: 'gpt-5-mini', label: 'GPT-5 mini' }
    ]
  }
};

function isProviderConfigured(provider) {
  if (provider === 'anthropic') return Boolean(process.env.ANTHROPIC_API_KEY);
  if (provider === 'openai') return Boolean(process.env.OPENAI_API_KEY);
  return false;
}

function isValidModel(provider, model) {
  const p = PROVIDERS[provider];
  return Boolean(p && p.models.some(m => m.id === model));
}

// Both providers frame streaming responses as `data: {...}\n\n` (SSE), with
// a bare `data: [DONE]` sentinel from OpenAI at the end (Anthropic ends the
// stream naturally instead). This reads the response body as it arrives and
// calls onEvent(parsedJson) per event, tolerating a JSON object split across
// two chunks by buffering the trailing partial line.
async function parseSSEStream(body, onEvent) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        onEvent(JSON.parse(payload));
      } catch (e) {
        // Ignore malformed/partial lines rather than aborting the stream.
      }
    }
  }
}

async function streamAnthropic({ model, systemPrompt, messages }, onDelta) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
  const res = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      system: systemPrompt || undefined,
      messages,
      max_tokens: MAX_TOKENS,
      stream: true
    })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Anthropic request failed: ${res.status} ${body}`);
  }
  await parseSSEStream(res.body, event => {
    if (event.type === 'content_block_delta' && event.delta && event.delta.type === 'text_delta') {
      onDelta(event.delta.text);
    }
  });
}

async function streamOpenAI({ model, systemPrompt, messages }, onDelta) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set');
  const fullMessages = systemPrompt ? [{ role: 'system', content: systemPrompt }, ...messages] : messages;
  const res = await fetch(OPENAI_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ model, messages: fullMessages, stream: true })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`OpenAI request failed: ${res.status} ${body}`);
  }
  await parseSSEStream(res.body, event => {
    const delta = event.choices && event.choices[0] && event.choices[0].delta;
    if (delta && delta.content) onDelta(delta.content);
  });
}

// Unified entrypoint: streams a chat completion, calling onDelta(text) for
// each token/chunk as it arrives. Throws (does not call onDelta again) if
// the provider request fails outright; a failure after some deltas have
// already been emitted is the caller's responsibility to surface partially.
async function streamChatCompletion({ provider, model, systemPrompt, messages }, onDelta) {
  if (provider === 'anthropic') return streamAnthropic({ model, systemPrompt, messages }, onDelta);
  if (provider === 'openai') return streamOpenAI({ model, systemPrompt, messages }, onDelta);
  throw new Error(`Unknown provider: ${provider}`);
}

module.exports = {
  PROVIDERS, isProviderConfigured, isValidModel, streamChatCompletion
};
