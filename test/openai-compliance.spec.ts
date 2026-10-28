import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestApp,
  readableFrom,
  yieldEvents,
  yieldTexts,
  type TestHarness,
} from './helpers/test-app';

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
        choices: [
          {
            message: { role: 'assistant', content: 'Buffered answer' },
            finish_reason: 'stop',
          },
        ],
      });
      // Even for a non-streaming client request, upstream is forced to stream.
      expect(harness.venice.postJson).toHaveBeenCalledWith(
        '/chat/completions',
        expect.objectContaining({ stream: true }),
        expect.anything(),
      );
    });

    it('streams tool-call deltas in order and finishes with tool_calls', async () => {
      const first = {
        index: 0,
        id: 'call_weather',
        type: 'function',
        function: { name: 'get_weather', arguments: '' },
      };
      const second = { index: 0, function: { arguments: '{"city":"Paris"}' } };
      harness.e2ee.decryptStream.mockReturnValue(
        yieldEvents([
          { kind: 'content', content: 'Checking ' },
          { kind: 'content', content: 'weather' },
          { kind: 'tool_calls', tool_calls: [first] },
          { kind: 'tool_calls', tool_calls: [second] },
          { kind: 'finish', finish_reason: 'tool_calls' },
        ]),
      );
      harness.venice.postJson.mockResolvedValue({ ok: true, body: {} });

      const res = await request(app.getHttpServer())
        .post('/v1/chat/completions')
        .send({
          model: 'e2ee-qwen3-5-122b-a10b',
          messages: [{ role: 'user', content: 'Weather?' }],
          stream: true,
        })
        .expect(200);

      const chunks = parseSse(res.text);
      const deltas = chunks.map((chunk) => chunk.choices[0].delta);
      expect(deltas[0]).toMatchObject({ role: 'assistant' });
      expect(
        deltas.filter((delta) => typeof delta.content === 'string' && delta.content.length > 0),
      ).toEqual([{ content: 'Checking ' }, { content: 'weather' }]);
      expect(
        deltas.filter((delta) => Array.isArray(delta.tool_calls)).map((delta) => delta.tool_calls),
      ).toEqual([[first], [second]]);
      expect(chunks[chunks.length - 1].choices[0]).toMatchObject({
        delta: {},
        finish_reason: 'tool_calls',
      });
      expect(chunks.some((chunk) => chunk.choices[0].finish_reason === 'stop')).toBe(false);
    });

    it('encrypts tool schemas and recovers inline tool-call markup', async () => {
      harness.e2ee.decryptStream.mockReturnValue(
        yieldTexts(['Quick test. ', "<tool_call>terminal(command='date')"]),
      );
      harness.venice.postJson.mockResolvedValue({ ok: true, body: {} });

      const res = await request(app.getHttpServer())
        .post('/v1/chat/completions')
        .send({
          model: 'e2ee-glm-5-3-flash',
          messages: [{ role: 'user', content: 'run date' }],
          tools: [
            {
              type: 'function',
              function: { name: 'terminal', parameters: { type: 'object' } },
            },
          ],
          tool_choice: 'required',
          stream: true,
        })
        .expect(200);

      const encrypted = harness.e2ee.encrypt.mock.calls[0][0] as Array<{
        role: string;
        content: string;
      }>;
      expect(encrypted[0]).toMatchObject({
        role: 'system',
        content: expect.stringContaining('terminal'),
      });
      const upstream = harness.venice.postJson.mock.calls[0][1] as Record<string, unknown>;
      expect(upstream.tools).toBeUndefined();
      expect(upstream.tool_choice).toBeUndefined();

      const chunks = parseSse(res.text);
      const toolDeltas = chunks
        .map((chunk) => chunk.choices[0].delta.tool_calls)
        .filter((calls) => Array.isArray(calls));
      expect(toolDeltas).toEqual([
        [
          expect.objectContaining({
            type: 'function',
            function: { name: 'terminal', arguments: '{"command":"date"}' },
          }),
        ],
      ]);
      expect(chunks[chunks.length - 1].choices[0].finish_reason).toBe('tool_calls');
      expect(res.text).toContain('Quick test. ');
      expect(res.text).not.toContain('<tool_call>');
    });

    it('assembles tool calls by index for clients that do not stream', async () => {
      harness.e2ee.decryptStream.mockReturnValue(
        yieldEvents([
          { kind: 'content', content: 'Sure' },
          {
            kind: 'tool_calls',
            tool_calls: [
              {
                index: 0,
                id: 'call_a',
                type: 'function',
                function: { name: 'get_weather', arguments: '' },
              },
              {
                index: 1,
                id: 'call_b',
                type: 'function',
                function: { name: 'get_time', arguments: '' },
              },
            ],
          },
          {
            kind: 'tool_calls',
            tool_calls: [
              { index: 0, function: { arguments: '{"city":' } },
              { index: 1, function: { arguments: '{"tz":"UTC"}' } },
            ],
          },
          { kind: 'tool_calls', tool_calls: [{ index: 0, function: { arguments: '"Paris"}' } }] },
          { kind: 'finish', finish_reason: 'tool_calls' },
        ]),
      );
      harness.venice.postJson.mockResolvedValue({ ok: true, body: {} });

      const res = await request(app.getHttpServer())
        .post('/v1/chat/completions')
        .send({
          model: 'e2ee-qwen3-5-122b-a10b',
          messages: [{ role: 'user', content: 'Weather and time?' }],
        })
        .expect(200);

      expect(res.body.choices[0]).toMatchObject({
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: 'Sure',
          tool_calls: [
            {
              id: 'call_a',
              type: 'function',
              function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
            },
            {
              id: 'call_b',
              type: 'function',
              function: { name: 'get_time', arguments: '{"tz":"UTC"}' },
            },
          ],
        },
      });
    });

    it('returns null content when the assistant turn is only a tool call', async () => {
      harness.e2ee.decryptStream.mockReturnValue(
        yieldEvents([
          {
            kind: 'tool_calls',
            tool_calls: [
              {
                index: 0,
                id: 'call_only',
                type: 'function',
                function: { name: 'lookup', arguments: '{}' },
              },
            ],
          },
          { kind: 'finish', finish_reason: 'length' },
        ]),
      );
      harness.venice.postJson.mockResolvedValue({ ok: true, body: {} });

      const res = await request(app.getHttpServer())
        .post('/v1/chat/completions')
        .send({
          model: 'e2ee-qwen3-5-122b-a10b',
          messages: [{ role: 'user', content: 'Look it up' }],
        })
        .expect(200);

      expect(res.body.choices[0].finish_reason).toBe('length');
      expect(res.body.choices[0].message).toEqual({
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_only', type: 'function', function: { name: 'lookup', arguments: '{}' } },
        ],
      });
    });

    it('accepts a follow-up whose assistant message has null content and tool fields', async () => {
      harness.e2ee.decryptStream.mockReturnValue(
        yieldEvents([
          { kind: 'content', content: 'It is sunny.' },
          { kind: 'finish', finish_reason: 'stop' },
        ]),
      );
      harness.venice.postJson.mockResolvedValue({ ok: true, body: {} });

      const toolCalls = [
        {
          id: 'call_weather',
          type: 'function',
          function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
        },
      ];

      const res = await request(app.getHttpServer())
        .post('/v1/chat/completions')
        .send({
          model: 'e2ee-qwen3-5-122b-a10b',
          messages: [
            { role: 'user', content: 'Weather in Paris?' },
            { role: 'assistant', content: null, tool_calls: toolCalls },
            {
              role: 'tool',
              tool_call_id: 'call_weather',
              name: 'get_weather',
              content: '22C and sunny',
            },
          ],
        })
        .expect(200);

      expect(res.body.choices[0].message.content).toBe('It is sunny.');
      expect(harness.e2ee.encrypt).toHaveBeenCalledWith(
        [
          { role: 'user', content: 'Weather in Paris?' },
          { role: 'assistant', content: null, tool_calls: toolCalls },
          {
            role: 'tool',
            content: '22C and sunny',
            name: 'get_weather',
            tool_call_id: 'call_weather',
          },
        ],
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

function parseSse(body: string): Array<{
  choices: Array<{ delta: Record<string, unknown>; finish_reason: string | null }>;
}> {
  return body
    .split('\n\n')
    .filter((block) => block.startsWith('data: ') && !block.includes('[DONE]'))
    .map(
      (block) =>
        JSON.parse(block.slice('data: '.length)) as {
          choices: Array<{ delta: Record<string, unknown>; finish_reason: string | null }>;
        },
    );
}
