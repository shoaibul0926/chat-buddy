const test = require('node:test');
const assert = require('node:assert/strict');

const ai = require('../ai');

// These tests never call a real provider API — global fetch is monkeypatched
// for the duration of each test (same technique semanticQA.test.js uses for
// docQA.embedTexts), so no network access or real API key is required to
// verify the streaming/parsing logic itself.
function withMockFetch(mockFn, run) {
  const original = global.fetch;
  global.fetch = mockFn;
  return Promise.resolve(run()).finally(() => {
    global.fetch = original;
  });
}

function withEnvKey(name, run) {
  const original = process.env[name];
  process.env[name] = 'test-key-not-a-real-credential';
  return Promise.resolve(run()).finally(() => {
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
  });
}

function withoutEnvKey(name, run) {
  const original = process.env[name];
  delete process.env[name];
  return Promise.resolve(run()).finally(() => {
    if (original !== undefined) process.env[name] = original;
  });
}

// This machine may have real ANTHROPIC_API_KEY/OPENAI_API_KEY set in the
// ambient shell environment (outside this repo's own config) — tests must
// never assume either is unset, or they'd be flaky (or worse, make real
// network calls) depending on where they're run.
function withoutAnyProviderKeys(run) {
  return withoutEnvKey('ANTHROPIC_API_KEY', () => withoutEnvKey('OPENAI_API_KEY', run));
}

function sseResponse(rawChunks, { ok = true, status = 200 } = {}) {
  const encoder = new TextEncoder();
  let i = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (i < rawChunks.length) {
        controller.enqueue(encoder.encode(rawChunks[i++]));
      } else {
        controller.close();
      }
    }
  });
  return { ok, status, body, text: async () => (ok ? '' : 'error body') };
}

test('isProviderConfigured reflects the relevant env var only', async () => {
  await withoutAnyProviderKeys(async () => {
    await withEnvKey('ANTHROPIC_API_KEY', () => {
      assert.equal(ai.isProviderConfigured('anthropic'), true);
    });
    assert.equal(ai.isProviderConfigured('anthropic'), false);
    assert.equal(ai.isProviderConfigured('openai'), false);
    assert.equal(ai.isProviderConfigured('unknown'), false);
  });
});

test('isValidModel checks the model belongs to the given provider', () => {
  assert.equal(ai.isValidModel('anthropic', 'claude-sonnet-5'), true);
  assert.equal(ai.isValidModel('anthropic', 'gpt-5'), false);
  assert.equal(ai.isValidModel('openai', 'gpt-5'), true);
  assert.equal(ai.isValidModel('nope', 'claude-sonnet-5'), false);
});

test('PROVIDERS exposes a non-empty model list for both providers', () => {
  assert.ok(ai.PROVIDERS.anthropic.models.length > 0);
  assert.ok(ai.PROVIDERS.openai.models.length > 0);
});

test('streamChatCompletion (anthropic) parses content_block_delta events into onDelta calls', async () => {
  const chunks = [
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":", world"}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n'
  ];
  await withEnvKey('ANTHROPIC_API_KEY', () =>
    withMockFetch(
      async () => sseResponse(chunks),
      async () => {
        const deltas = [];
        await ai.streamChatCompletion(
          { provider: 'anthropic', model: 'claude-sonnet-5', systemPrompt: '', messages: [{ role: 'user', content: 'hi' }] },
          d => deltas.push(d)
        );
        assert.equal(deltas.join(''), 'Hello, world');
      }
    )
  );
});

test('streamChatCompletion (openai) parses choices[0].delta.content events into onDelta calls, stopping at [DONE]', async () => {
  const chunks = [
    'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":" there"}}]}\n\n',
    'data: [DONE]\n\n'
  ];
  await withEnvKey('OPENAI_API_KEY', () =>
    withMockFetch(
      async () => sseResponse(chunks),
      async () => {
        const deltas = [];
        await ai.streamChatCompletion(
          { provider: 'openai', model: 'gpt-5', systemPrompt: '', messages: [{ role: 'user', content: 'hi' }] },
          d => deltas.push(d)
        );
        assert.equal(deltas.join(''), 'Hi there');
      }
    )
  );
});

test('streamChatCompletion throws a normalized error on a non-OK provider response', async () => {
  await withEnvKey('ANTHROPIC_API_KEY', () =>
    withMockFetch(
      async () => sseResponse([], { ok: false, status: 401 }),
      async () => {
        await assert.rejects(
          ai.streamChatCompletion(
            { provider: 'anthropic', model: 'claude-sonnet-5', systemPrompt: '', messages: [] },
            () => {}
          ),
          /Anthropic request failed: 401/
        );
      }
    )
  );
});

test('streamChatCompletion throws when the provider key is not set', async () => {
  await withoutAnyProviderKeys(() =>
    assert.rejects(
      ai.streamChatCompletion(
        { provider: 'openai', model: 'gpt-5', systemPrompt: '', messages: [] },
        () => {}
      ),
      /OPENAI_API_KEY is not set/
    )
  );
});
