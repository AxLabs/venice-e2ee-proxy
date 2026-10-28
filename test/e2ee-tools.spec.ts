import { describe, expect, it } from 'vitest';
import { InlineToolCallParser, prepareE2eeToolMessages } from '../src/common/utils/e2ee-tools';

const terminal = {
  type: 'function',
  function: {
    name: 'terminal',
    description: 'Run a shell command',
    parameters: { type: 'object', properties: { command: { type: 'string' } } },
  },
};

describe('prepareE2eeToolMessages', () => {
  it('encrypts tool schemas into a leading system message', () => {
    const prepared = prepareE2eeToolMessages(
      [{ role: 'user', content: 'run date' }],
      [terminal],
      'required',
    );
    expect(prepared.hidePlaintextTools).toBe(true);
    expect(prepared.messages[0]).toMatchObject({
      role: 'system',
      content: expect.stringContaining('terminal'),
    });
    expect(prepared.messages[0].content).toContain('You must call at least one tool.');
  });

  it('appends tool instructions to an existing system message', () => {
    const prepared = prepareE2eeToolMessages(
      [
        { role: 'system', content: 'You are Hermes.' },
        { role: 'user', content: 'run date' },
      ],
      [terminal],
      'auto',
    );
    expect(prepared.messages).toHaveLength(2);
    expect(prepared.messages[0].role).toBe('system');
    expect(prepared.messages[0].content).toContain('You are Hermes.');
    expect(prepared.messages[0].content).toContain('terminal');
  });

  it('omits the schema prompt when tool_choice is none', () => {
    const prepared = prepareE2eeToolMessages([{ role: 'user', content: 'hi' }], [terminal], 'none');
    expect(prepared.hidePlaintextTools).toBe(true);
    expect(prepared.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });
});

describe('InlineToolCallParser', () => {
  it('recovers a call-syntax tool call split across chunks', () => {
    const parser = new InlineToolCallParser();
    const first = parser.push('Quick test.<tool_ca');
    const second = parser.push('ll>terminal(command=\'date && echo "ok"\')');
    const done = parser.finish();
    expect(first).toEqual([{ kind: 'content', content: 'Quick test.' }]);
    expect(second).toEqual([]);
    expect(done).toEqual([
      {
        kind: 'tool_calls',
        toolCalls: [
          { name: 'terminal', arguments: JSON.stringify({ command: 'date && echo "ok"' }) },
        ],
      },
    ]);
  });

  it('recovers parallel calls that omit the closing tag', () => {
    const parser = new InlineToolCallParser();
    const events = parser.push(
      "<tool_call>list_dir(path='/tmp', depth=1)<tool_call>search_files(pattern='.md', file_pattern='')",
    );
    expect([...events, ...parser.finish()]).toEqual([
      {
        kind: 'tool_calls',
        toolCalls: [{ name: 'list_dir', arguments: JSON.stringify({ path: '/tmp', depth: 1 }) }],
      },
      {
        kind: 'tool_calls',
        toolCalls: [
          {
            name: 'search_files',
            arguments: JSON.stringify({ pattern: '.md', file_pattern: '' }),
          },
        ],
      },
    ]);
  });

  it('recovers a JSON tool call and leaves surrounding prose', () => {
    const parser = new InlineToolCallParser();
    const events = parser.finish();
    expect(events).toEqual([]);
    const streamed = parser.push(
      'Sure. <tool_call>{"name":"terminal","arguments":{"command":"date"}}</tool_call>',
    );
    expect(streamed).toEqual([
      { kind: 'content', content: 'Sure. ' },
      {
        kind: 'tool_calls',
        toolCalls: [{ name: 'terminal', arguments: '{"command":"date"}' }],
      },
    ]);
  });

  it('leaves unrecognized markup visible', () => {
    const parser = new InlineToolCallParser();
    expect(parser.push('<tool_call>not a call</tool_call>')).toEqual([
      { kind: 'content', content: '<tool_call>not a call</tool_call>' },
    ]);
  });
});
