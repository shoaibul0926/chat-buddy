const test = require('node:test');
const assert = require('node:assert/strict');

const imageGen = require('../imageGen');

// These tests never call the real OpenAI API — global fetch is monkeypatched
// for the duration of each test (same technique ai.test.js uses), so no
// network access or real API key is required to verify request-building and
// response-parsing logic.
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

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) };
}

const FAKE_B64 = Buffer.from('fake-png-bytes').toString('base64');

test('isConfigured reflects OPENAI_API_KEY only', async () => {
  await withoutEnvKey('OPENAI_API_KEY', () => {
    assert.equal(imageGen.isConfigured(), false);
  });
  await withEnvKey('OPENAI_API_KEY', () => {
    assert.equal(imageGen.isConfigured(), true);
  });
});

test('generateImage sends a JSON request with model/prompt/size/background and decodes b64_json', async () => {
  let capturedUrl, capturedOptions;
  await withEnvKey('OPENAI_API_KEY', () =>
    withMockFetch(
      async (url, options) => {
        capturedUrl = url;
        capturedOptions = options;
        return jsonResponse({ data: [{ b64_json: FAKE_B64, revised_prompt: 'a cat, revised' }] });
      },
      async () => {
        const result = await imageGen.generateImage({ prompt: 'a cat', size: '1024x1024', background: 'transparent' });
        assert.equal(capturedUrl, 'https://api.openai.com/v1/images/generations');
        assert.equal(capturedOptions.method, 'POST');
        assert.equal(capturedOptions.headers['Content-Type'], 'application/json');
        assert.match(capturedOptions.headers.Authorization, /^Bearer /);
        const body = JSON.parse(capturedOptions.body);
        assert.equal(body.model, imageGen.MODEL);
        assert.equal(body.prompt, 'a cat');
        assert.equal(body.size, '1024x1024');
        assert.equal(body.background, 'transparent');
        assert.equal(body.output_format, 'png');
        assert.equal(body.n, 1);
        assert.equal(result.buffer.toString('base64'), FAKE_B64);
        assert.equal(result.revisedPrompt, 'a cat, revised');
      }
    )
  );
});

test('editImage sends a multipart request with the image as a Blob and no manual Content-Type', async () => {
  let capturedUrl, capturedOptions;
  await withEnvKey('OPENAI_API_KEY', () =>
    withMockFetch(
      async (url, options) => {
        capturedUrl = url;
        capturedOptions = options;
        return jsonResponse({ data: [{ b64_json: FAKE_B64 }] });
      },
      async () => {
        const result = await imageGen.editImage({
          imageBuffer: Buffer.from('original-image-bytes'),
          mimeType: 'image/png',
          prompt: 'add a hat'
        });
        assert.equal(capturedUrl, 'https://api.openai.com/v1/images/edits');
        assert.equal(capturedOptions.method, 'POST');
        assert.ok(capturedOptions.body instanceof FormData);
        assert.equal(capturedOptions.headers['Content-Type'], undefined, 'must not manually set Content-Type on a FormData body');
        assert.equal(capturedOptions.body.get('model'), imageGen.MODEL);
        assert.equal(capturedOptions.body.get('prompt'), 'add a hat');
        assert.equal(capturedOptions.body.get('background'), 'auto');
        assert.equal(capturedOptions.body.get('size'), 'auto');
        assert.equal(capturedOptions.body.get('n'), '1');
        assert.equal(result.buffer.toString('base64'), FAKE_B64);
      }
    )
  );
});

test('removeBackground requests a transparent background with a fixed prompt', async () => {
  let capturedForm;
  await withEnvKey('OPENAI_API_KEY', () =>
    withMockFetch(
      async (url, options) => { capturedForm = options.body; return jsonResponse({ data: [{ b64_json: FAKE_B64 }] }); },
      async () => {
        await imageGen.removeBackground({ imageBuffer: Buffer.from('x'), mimeType: 'image/png' });
        assert.equal(capturedForm.get('background'), 'transparent');
        assert.match(capturedForm.get('prompt'), /remove the background/i);
      }
    )
  );
});

test('styleTransferImage embeds the style prompt and requests low input_fidelity', async () => {
  let capturedForm;
  await withEnvKey('OPENAI_API_KEY', () =>
    withMockFetch(
      async (url, options) => { capturedForm = options.body; return jsonResponse({ data: [{ b64_json: FAKE_B64 }] }); },
      async () => {
        await imageGen.styleTransferImage({ imageBuffer: Buffer.from('x'), mimeType: 'image/png', stylePrompt: 'watercolor painting' });
        assert.match(capturedForm.get('prompt'), /watercolor painting/);
        assert.equal(capturedForm.get('input_fidelity'), 'low');
      }
    )
  );
});

test('enhanceImage requests high input_fidelity and high quality', async () => {
  let capturedForm;
  await withEnvKey('OPENAI_API_KEY', () =>
    withMockFetch(
      async (url, options) => { capturedForm = options.body; return jsonResponse({ data: [{ b64_json: FAKE_B64 }] }); },
      async () => {
        await imageGen.enhanceImage({ imageBuffer: Buffer.from('x'), mimeType: 'image/png' });
        assert.equal(capturedForm.get('input_fidelity'), 'high');
        assert.equal(capturedForm.get('quality'), 'high');
        assert.match(capturedForm.get('prompt'), /enhance/i);
      }
    )
  );
});

test('generateImage throws a normalized error on a non-OK response', async () => {
  await withEnvKey('OPENAI_API_KEY', () =>
    withMockFetch(
      async () => jsonResponse({ error: { message: 'bad request' } }, { ok: false, status: 400 }),
      async () => {
        await assert.rejects(
          imageGen.generateImage({ prompt: 'x' }),
          /Image generation request failed: 400/
        );
      }
    )
  );
});

test('generateImage throws when OPENAI_API_KEY is not set', async () => {
  await withoutEnvKey('OPENAI_API_KEY', () =>
    assert.rejects(imageGen.generateImage({ prompt: 'x' }), /OPENAI_API_KEY is not set/)
  );
});
