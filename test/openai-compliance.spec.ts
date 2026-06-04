import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, readableFrom, yieldTexts, type TestHarness } from './helpers/test-app';

/**
 * OpenAI API compliance tests. These verify the proxy speaks the shapes that
 * tools like Cline and the OpenAI SDK expect, and that `e2ee-` models are
 * handled via the encryption path while regular models are proxied straight
 * through.
 */
describe('OpenAI-compatible proxy', () => {
  let harness: TestHarness;
  let app: INestApplication;

  beforeAll(async () => {
    harness = await createTestApp();
    app = harness.app;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    harness.venice.postJson.mockReset();
    harness.venice.get.mockReset();
    harness.e2ee.createSession.mockClear();
    harness.e2ee.encrypt.mockClear();
    harness.e2ee.decryptStream.mockReset();
  });

  describe('GET /v1/models', () => {
    it('returns an OpenAI-shaped model list', async () => {
      harness.venice.get.mockResolvedValue({
        ok: true,
        json: async () => ({
          object: 'list',
          data: [{ id: 'e2ee-qwen3-5-122b-a10b', object: 'model', created: 1, owned_by: 'venice' }],
        }),
      });

      const res = await request(app.getHttpServer()).get('/v1/models').expect(200);

      expect(res.body.object).toBe('list');
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data[0]).toMatchObject({ id: 'e2ee-qwen3-5-122b-a10b', object: 'model' });
    });
  });

  describe('POST /v1/chat/completions (non-e2ee)', () => {
    it('proxies a non-streaming completion and returns chat.completion shape', async () => {
      const upstream = {
        id: 'chatcmpl-upstream',
        object: 'chat.completion',
        created: 123,
        model: 'qwen3-5-122b',
        choices: [
          { index: 0, message: { role: 'assistant', content: 'hi there' }, finish_reason: 'stop' },
        ],
      };
      harness.venice.postJson.mockResolvedValue({ ok: true, json: async () => upstream });

      const res = await request(app.getHttpServer())
        .post('/v1/chat/completions')
        .send({ model: 'qwen3-5-122b', messages: [{ role: 'user', content: 'hi' }] })
        .expect(200);

      expect(res.body).toMatchObject({
        object: 'chat.completion',
        model: 'qwen3-5-122b',
        choices: [{ message: { role: 'assistant', content: 'hi there' } }],
      });
      // Regular models must NOT go through the E2EE encryption path.
      expect(harness.e2ee.createSession).not.toHaveBeenCalled();
      expect(harness.e2ee.encrypt).not.toHaveBeenCalled();
      // Forwarded body keeps stream disabled.
      expect(harness.venice.postJson).toHaveBeenCalledWith(
        '/chat/completions',
        expect.objectContaining({ model: 'qwen3-5-122b', stream: false }),
      );
    });

    it('pipes a streaming completion through as SSE', async () => {
      const sse = [
        'data: {"id":"x","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Hel"}}]}\n\n',
        'data: {"id":"x","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"lo"}}]}\n\n',
        'data: [DONE]\n\n',
      ];
      harness.venice.postJson.mockResolvedValue({ ok: true, body: readableFrom(sse) });

      const res = await request(app.getHttpServer())
        .post('/v1/chat/completions')
        .send({ model: 'qwen3-5-122b', messages: [{ role: 'user', content: 'hi' }], stream: true })
        .expect(200);

      expect(res.headers['content-type']).toContain('text/event-stream');
      expect(res.text).toContain('chat.completion.chunk');
      expect(res.text.trim().endsWith('data: [DONE]')).toBe(true);
      expect(harness.e2ee.createSession).not.toHaveBeenCalled();
    });
  });

  describe('POST /v1/chat/completions (e2ee)', () => {
    it('encrypts, streams, and decrypts SSE for e2ee models', async () => {
      harness.e2ee.decryptStream.mockReturnValue(yieldTexts(['Hello', ', ', 'world']));
      harness.venice.postJson.mockResolvedValue({ ok: true, body: {} });

      const res = await request(app.getHttpServer())
        .post('/v1/chat/completions')
        .send({
          model: 'e2ee-qwen3-5-122b-a10b',
          messages: [{ role: 'user', content: 'hi' }],
          stream: true,
        })
        .expect(200);

      expect(res.headers['content-type']).toContain('text/event-stream');

      // E2EE path must establish a session and encrypt the messages.
      expect(harness.e2ee.createSession).toHaveBeenCalledWith('e2ee-qwen3-5-122b-a10b');
      expect(harness.e2ee.encrypt).toHaveBeenCalled();

      // Upstream request must be forced to stream and carry venice_parameters.
      expect(harness.venice.postJson).toHaveBeenCalledWith(
        '/chat/completions',
        expect.objectContaining({
          stream: true,
          venice_parameters: expect.objectContaining({ enable_e2ee: true }),
        }),
        expect.objectContaining({ 'X-Venice-TEE-Client-Pub-Key': 'client-pub' }),
      );

      // Reassemble the streamed content deltas.
      const content = res.text
        .split('\n\n')
        .filter((line) => line.startsWith('data: ') && !line.includes('[DONE]'))
        .map((line) => JSON.parse(line.replace('data: ', '')))
        .map((chunk) => chunk.choices[0]?.delta?.content ?? '')
        .join('');
      expect(content).toBe('Hello, world');
      expect(res.text.trim().endsWith('data: [DONE]')).toBe(true);
    });

    it('buffers e2ee responses into a single completion when stream=false', async () => {
      harness.e2ee.decryptStream.mockReturnValue(yieldTexts(['Buffered ', 'answer']));
      harness.venice.postJson.mockResolvedValue({ ok: true, body: {} });

      const res = await request(app.getHttpServer())
        .post('/v1/chat/completions')
        .send({
          model: 'e2ee-qwen3-5-122b-a10b',
          messages: [{ role: 'user', content: 'hi' }],
          stream: false,
        })
        .expect(200);

      expect(res.headers['content-type']).toContain('application/json');
      expect(res.body).toMatchObject({
        object: 'chat.completion',
        model: 'e2ee-qwen3-5-122b-a10b',
        choices: [{ message: { role: 'assistant', content: 'Buffered answer' } }],
      });
      // Even for a non-streaming client request, upstream is forced to stream.
      expect(harness.venice.postJson).toHaveBeenCalledWith(
        '/chat/completions',
        expect.objectContaining({ stream: true }),
        expect.anything(),
      );
    });
  });

  describe('path compatibility', () => {
    it('serves the Venice-style /api/v1 prefix as well as /v1', async () => {
      harness.venice.get.mockResolvedValue({
        ok: true,
        json: async () => ({ object: 'list', data: [] }),
      });

      const res = await request(app.getHttpServer()).get('/api/v1/models').expect(200);
      expect(res.body.object).toBe('list');
    });
  });

  describe('validation', () => {
    it('rejects requests missing messages with an OpenAI error envelope', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/chat/completions')
        .send({ model: 'qwen3-5-122b' })
        .expect(400);

      expect(res.body.error).toBeDefined();
      expect(res.body.error.type).toBe('invalid_request_error');
    });
  });
});
