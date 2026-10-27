import { describe, expect, it } from 'vitest';
import {
  appendToolCallDeltas,
  buildChatCompletion,
  buildContentChunk,
  buildFinalChunk,
  buildRoleChunk,
  buildToolCallsChunk,
  compactToolCalls,
  countIncomingMessageChars,
  countOutgoingE2eeMessageChars,
  flattenContent,
  generateCompletionId,
  isE2EEModel,
  sseEvent,
  toPlainMessages,
  SSE_DONE,
} from '../src/common/utils/openai.util';
import type { AssembledToolCall } from '../src/common/interfaces/openai.interface';

describe('isE2EEModel', () => {
  it('detects e2ee- prefixed models', () => {
    expect(isE2EEModel('e2ee-qwen3-5-122b-a10b')).toBe(true);
  });

  it('treats regular models as non-e2ee', () => {
    expect(isE2EEModel('qwen3-5-122b')).toBe(false);
    expect(isE2EEModel('gpt-4o')).toBe(false);
  });
});

describe('flattenContent', () => {
  it('passes through plain strings', () => {
    expect(flattenContent('hello')).toBe('hello');
  });

  it('joins text parts of array content', () => {
    expect(
      flattenContent([
        { type: 'text', text: 'foo ' },
        { type: 'text', text: 'bar' },
      ]),
    ).toBe('foo bar');
  });

  it('handles null/empty content', () => {
    expect(flattenContent(null)).toBe('');
  });
});

describe('toPlainMessages', () => {
  it('normalizes role and content to strings', () => {
    const result = toPlainMessages([
      { role: 'system', content: 'be helpful' },
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    ]);
    expect(result).toEqual([
      { role: 'system', content: 'be helpful' },
      { role: 'user', content: 'hi' },
    ]);
  });

  it('keeps null content and tool fields for a follow-up turn', () => {
    const toolCalls = [
      {
        id: 'call_weather',
        type: 'function',
        function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
      },
    ];
    const result = toPlainMessages([
      { role: 'assistant', content: null, tool_calls: toolCalls },
      {
        role: 'tool',
        content: '22C and sunny',
        tool_call_id: 'call_weather',
        name: 'get_weather',
      },
    ]);
    expect(result).toEqual([
      { role: 'assistant', content: null, tool_calls: toolCalls },
      {
        role: 'tool',
        content: '22C and sunny',
        tool_call_id: 'call_weather',
        name: 'get_weather',
      },
    ]);
  });
});

describe('message char stats', () => {
  it('counts incoming plaintext by role', () => {
    const stats = countIncomingMessageChars([
      { role: 'system', content: 'abc' },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world' },
      { role: 'tool', content: 'x' },
    ]);
    expect(stats).toEqual({
      messageCount: 4,
      totalChars: 14,
      encryptableChars: 8,
      assistantChars: 5,
      otherChars: 1,
    });
  });

  it('counts outgoing E2EE content as encrypted vs plaintext', () => {
    const stats = countOutgoingE2eeMessageChars([
      { role: 'user', content: 'a'.repeat(186) },
      { role: 'assistant', content: null },
      { role: 'tool', content: 'cipher' },
    ]);
    expect(stats).toEqual({
      messageCount: 3,
      totalChars: 186 + 6,
      encryptedChars: 186,
      plaintextChars: 6,
    });
  });
});

describe('OpenAI builders', () => {
  it('builds a chat.completion object', () => {
    const completion = buildChatCompletion({
      id: 'chatcmpl-1',
      model: 'e2ee-x',
      content: 'hello',
    });
    expect(completion.object).toBe('chat.completion');
    expect(completion.choices[0].message).toEqual({ role: 'assistant', content: 'hello' });
    expect(completion.choices[0].finish_reason).toBe('stop');
  });

  it('builds role, content, and final stream chunks', () => {
    const created = 1700000000;
    const role = buildRoleChunk({ id: 'c1', model: 'm', created });
    expect(role.object).toBe('chat.completion.chunk');
    expect(role.choices[0].delta.role).toBe('assistant');

    const content = buildContentChunk({ id: 'c1', model: 'm', created, content: 'tok' });
    expect(content.choices[0].delta.content).toBe('tok');
    expect(content.choices[0].finish_reason).toBeNull();

    const final = buildFinalChunk({ id: 'c1', model: 'm', created, finishReason: 'tool_calls' });
    expect(final.choices[0].finish_reason).toBe('tool_calls');
    expect(final.choices[0].delta).toEqual({});

    const call = {
      index: 0,
      id: 'call_1',
      type: 'function',
      function: { name: 'lookup', arguments: '{}' },
    };
    const toolChunk = buildToolCallsChunk({ id: 'c1', model: 'm', created, toolCalls: [call] });
    expect(toolChunk.choices[0].delta.tool_calls).toEqual([call]);
    expect(toolChunk.choices[0].finish_reason).toBeNull();
  });

  it('assembles tool-call deltas by index', () => {
    const accumulated: AssembledToolCall[] = [];
    appendToolCallDeltas(accumulated, [
      {
        index: 0,
        id: 'call_a',
        type: 'function',
        function: { name: 'get_weather', arguments: '' },
      },
      { index: 1, id: 'call_b', type: 'function', function: { name: 'get_time', arguments: '' } },
    ]);
    appendToolCallDeltas(accumulated, [
      { index: 0, function: { arguments: '{"city":' } },
      { index: 1, function: { arguments: '{"tz":"UTC"}' } },
    ]);
    appendToolCallDeltas(accumulated, [{ index: 0, function: { arguments: '"Paris"}' } }]);

    expect(compactToolCalls(accumulated)).toEqual([
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
    ]);
  });
});

describe('SSE serialization', () => {
  it('wraps payloads as data: events', () => {
    expect(sseEvent({ a: 1 })).toBe('data: {"a":1}\n\n');
  });

  it('exposes the [DONE] sentinel', () => {
    expect(SSE_DONE).toBe('data: [DONE]\n\n');
  });
});

describe('generateCompletionId', () => {
  it('produces unique chatcmpl- ids', () => {
    const a = generateCompletionId();
    const b = generateCompletionId();
    expect(a).toMatch(/^chatcmpl-[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });
});
