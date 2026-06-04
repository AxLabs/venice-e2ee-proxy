import { describe, expect, it } from 'vitest';
import {
  buildChatCompletion,
  buildContentChunk,
  buildFinalChunk,
  buildRoleChunk,
  flattenContent,
  generateCompletionId,
  isE2EEModel,
  sseEvent,
  toPlainMessages,
  SSE_DONE,
} from '../src/common/utils/openai.util';

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

    const final = buildFinalChunk({ id: 'c1', model: 'm', created });
    expect(final.choices[0].finish_reason).toBe('stop');
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
