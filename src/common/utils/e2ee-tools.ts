import { randomBytes } from 'node:crypto';
import type { ToolCallDelta } from '../interfaces/openai.interface';
import type { PlainMessage } from './openai.util';

const OPEN = '<tool_call>';
const CLOSE = '</tool_call>';

export interface RecoveredToolCall {
  name: string;
  arguments: string;
}

export type ToolRecoveryEvent =
  | { kind: 'content'; content: string }
  | { kind: 'tool_calls'; toolCalls: RecoveredToolCall[] };

/**
 * Venice's E2EE gateway drops the plaintext `tools` array, so the model never
 * sees OpenAI function definitions and often writes `<tool_call>` markup into
 * the decrypted text instead. Schemas are copied into a system message (which
 * is encrypted) and this parser turns the markup back into tool calls.
 */
export function prepareE2eeToolMessages(
  messages: PlainMessage[],
  tools: readonly unknown[],
  toolChoice: unknown,
): { messages: PlainMessage[]; hidePlaintextTools: boolean } {
  if (tools.length === 0) return { messages, hidePlaintextTools: false };
  if (toolChoice === 'none') return { messages, hidePlaintextTools: true };
  const instructions = renderE2eeToolInstructions(tools, toolChoice);
  const systemIndex = messages.findIndex((message) => message.role === 'system');
  // A second system message is concatenated by Venice before the hex check, which
  // rejects the joined field. Fold the instructions into the existing one.
  if (systemIndex === -1) {
    return {
      messages: [{ role: 'system', content: instructions }, ...messages],
      hidePlaintextTools: true,
    };
  }
  const current = messages[systemIndex];
  const content =
    typeof current.content === 'string' && current.content.length > 0
      ? `${current.content}\n\n${instructions}`
      : instructions;
  const next = messages.slice();
  next[systemIndex] = { ...current, content };
  return { messages: next, hidePlaintextTools: true };
}

export function renderE2eeToolInstructions(tools: readonly unknown[], toolChoice: unknown): string {
  const rendered = tools
    .map(renderTool)
    .filter((line) => line.length > 0)
    .join('\n\n');
  return [
    'You can call tools. Reply with normal text when you are not calling one.',
    'To call a tool, emit one or more <tool_call> blocks. Each block is a JSON object:',
    '<tool_call>{"name":"<tool name>","arguments":{...}}</tool_call>',
    directiveFor(toolChoice),
    rendered,
  ]
    .filter((line) => line.length > 0)
    .join('\n');
}

/** Assigns ids and indexes for tool calls recovered from decrypted text. */
export function toToolCallDeltas(
  calls: readonly RecoveredToolCall[],
  startIndex: number,
): ToolCallDelta[] {
  return calls.map((call, offset) => ({
    index: startIndex + offset,
    id: `call_${randomBytes(8).toString('hex')}`,
    type: 'function',
    function: { name: call.name, arguments: call.arguments },
  }));
}

/**
 * Splits a decrypted stream into prose and `<tool_call>` blocks. A partial
 * opening tag is held back until the next chunk so it is not shown as text.
 */
export class InlineToolCallParser {
  private buffer = '';

  push(chunk: string): ToolRecoveryEvent[] {
    if (chunk.length === 0) return [];
    this.buffer += chunk;
    return this.drain(false);
  }

  finish(): ToolRecoveryEvent[] {
    return this.drain(true);
  }

  private drain(eof: boolean): ToolRecoveryEvent[] {
    const events: ToolRecoveryEvent[] = [];
    while (this.buffer.length > 0) {
      const openAt = findMarker(this.buffer, OPEN);
      if (openAt === -1) {
        const hold = eof ? 0 : heldTail(this.buffer, OPEN);
        const prose = this.buffer.slice(0, this.buffer.length - hold);
        this.buffer = this.buffer.slice(this.buffer.length - hold);
        if (prose.length > 0) events.push({ kind: 'content', content: prose });
        break;
      }
      if (openAt > 0) {
        events.push({ kind: 'content', content: this.buffer.slice(0, openAt) });
        this.buffer = this.buffer.slice(openAt);
      }

      const afterOpen = this.buffer.slice(OPEN.length);
      const closeAt = findMarker(afterOpen, CLOSE);
      const nextAt = findMarker(afterOpen, OPEN);
      const closed = closeAt !== -1 && (nextAt === -1 || closeAt <= nextAt);
      const bounded = nextAt !== -1 && !closed;
      if (!closed && !bounded && !eof) break;

      const bodyEnd = closed ? closeAt : bounded ? nextAt : afterOpen.length;
      const consumeThrough = closed
        ? OPEN.length + closeAt + CLOSE.length
        : bounded
          ? OPEN.length + nextAt
          : this.buffer.length;
      const calls = parseToolCallBody(afterOpen.slice(0, bodyEnd));
      if (calls.length > 0) {
        events.push({ kind: 'tool_calls', toolCalls: calls });
      } else {
        events.push({ kind: 'content', content: this.buffer.slice(0, consumeThrough) });
      }
      this.buffer = this.buffer.slice(consumeThrough);
    }
    return events;
  }
}

function directiveFor(toolChoice: unknown): string {
  if (toolChoice === 'required') return 'You must call at least one tool.';
  const named = namedToolChoice(toolChoice);
  if (named) return `You must call the ${named} tool.`;
  return 'Call a tool only when it is needed.';
}

function namedToolChoice(toolChoice: unknown): string | undefined {
  if (!toolChoice || typeof toolChoice !== 'object') return undefined;
  const record = toolChoice as Record<string, unknown>;
  const fn = record.function;
  if (!fn || typeof fn !== 'object') return undefined;
  const name = (fn as Record<string, unknown>).name;
  return typeof name === 'string' && name.length > 0 ? name : undefined;
}

function renderTool(tool: unknown): string {
  const parsed = readTool(tool);
  if (!parsed) return '';
  const description = parsed.description ? ` — ${parsed.description}` : '';
  const parameters = parsed.parameters ? `\nparameters: ${JSON.stringify(parsed.parameters)}` : '';
  return `${parsed.name}${description}${parameters}`;
}

function readTool(
  tool: unknown,
): { name: string; description?: string; parameters?: unknown } | undefined {
  if (!tool || typeof tool !== 'object') return undefined;
  const record = tool as Record<string, unknown>;
  const source =
    record.function && typeof record.function === 'object'
      ? (record.function as Record<string, unknown>)
      : record;
  if (typeof source.name !== 'string' || source.name.length === 0) return undefined;
  return {
    name: source.name,
    description: typeof source.description === 'string' ? source.description : undefined,
    parameters: source.parameters ?? source.input_schema,
  };
}

function parseToolCallBody(body: string): RecoveredToolCall[] {
  const trimmed = body.trim();
  if (trimmed.length === 0) return [];
  const fromJson = parseJsonCalls(trimmed);
  if (fromJson.length > 0) return fromJson;
  const fromCall = parseCallSyntax(trimmed);
  if (fromCall) return [fromCall];
  const fromTags = parseArgTags(trimmed);
  if (fromTags) return [fromTags];
  return [];
}

function parseJsonCalls(body: string): RecoveredToolCall[] {
  const start = body.search(/[[{]/);
  if (start === -1) return [];
  try {
    return callsFromJson(JSON.parse(body.slice(start)));
  } catch {
    return [];
  }
}

function callsFromJson(value: unknown): RecoveredToolCall[] {
  if (Array.isArray(value)) return value.flatMap(callsFromJson);
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.tool_calls)) return record.tool_calls.flatMap(callsFromJson);
  const fn = record.function;
  if (fn && typeof fn === 'object') {
    const nested = callsFromJson(fn);
    if (nested.length > 0) return nested;
  }
  const name = typeof record.name === 'string' ? record.name : undefined;
  if (!name) return [];
  const args = record.arguments ?? record.parameters ?? record.args ?? {};
  return [{ name, arguments: argumentsJson(args) }];
}

function argumentsJson(value: unknown): string {
  if (typeof value === 'string') {
    try {
      JSON.parse(value);
      return value;
    } catch {
      return JSON.stringify(value);
    }
  }
  return JSON.stringify(value ?? {});
}

function parseCallSyntax(body: string): RecoveredToolCall | undefined {
  const match = /^([A-Za-z_][\w.-]*)\s*\(/.exec(body);
  if (!match) return undefined;
  const scanned = scanCallArguments(body, match[0].length - 1);
  if (!scanned) return undefined;
  return { name: match[1], arguments: JSON.stringify(scanned) };
}

function scanCallArguments(body: string, openAt: number): Record<string, unknown> | undefined {
  const args: Record<string, unknown> = {};
  let index = openAt + 1;
  while (index < body.length) {
    index = skipSeparators(body, index);
    if (index >= body.length) return undefined;
    if (body[index] === ')') return args;
    const key = readKey(body, index);
    if (!key) return undefined;
    index = skipSpaces(body, key.end);
    if (body[index] !== '=' && body[index] !== ':') return undefined;
    index = skipSpaces(body, index + 1);
    const value = readValue(body, index);
    if (!value) return undefined;
    args[key.text] = value.value;
    index = value.end;
  }
  return undefined;
}

function parseArgTags(body: string): RecoveredToolCall | undefined {
  const name = /^([A-Za-z_][\w.-]*)/.exec(body);
  if (!name) return undefined;
  const args: Record<string, string> = {};
  const pattern = /<arg_key>\s*([^<]+?)\s*<\/arg_key>\s*<arg_value>([\s\S]*?)<\/arg_value>/gi;
  for (const match of body.matchAll(pattern)) {
    args[match[1].trim()] = match[2];
  }
  if (Object.keys(args).length === 0) return undefined;
  return { name: name[1], arguments: JSON.stringify(args) };
}

function skipSeparators(body: string, index: number): number {
  let cursor = index;
  while (cursor < body.length && /[\s,]/.test(body[cursor])) cursor += 1;
  return cursor;
}

function skipSpaces(body: string, index: number): number {
  let cursor = index;
  while (cursor < body.length && /\s/.test(body[cursor])) cursor += 1;
  return cursor;
}

function readKey(body: string, index: number): { text: string; end: number } | undefined {
  const quoted = readQuoted(body, index);
  if (quoted) return { text: quoted.value, end: quoted.end };
  const match = /^[A-Za-z_][\w.-]*/.exec(body.slice(index));
  if (!match) return undefined;
  return { text: match[0], end: index + match[0].length };
}

function readValue(body: string, index: number): { value: unknown; end: number } | undefined {
  if (index >= body.length) return undefined;
  const quoted = readQuoted(body, index);
  if (quoted) return quoted;
  const slice = body.slice(index);
  if (slice.startsWith('true') && isBoundary(slice[4])) return { value: true, end: index + 4 };
  if (slice.startsWith('false') && isBoundary(slice[5])) return { value: false, end: index + 5 };
  if (slice.startsWith('null') && isBoundary(slice[4])) return { value: null, end: index + 4 };
  const number = /^-?\d+(?:\.\d+)?/.exec(slice);
  if (number && isBoundary(slice[number[0].length])) {
    return { value: Number(number[0]), end: index + number[0].length };
  }
  const bare = /^[^,)]+/.exec(slice);
  if (!bare) return undefined;
  return { value: bare[0].trim(), end: index + bare[0].length };
}

function isBoundary(char: string | undefined): boolean {
  return char === undefined || /[\s,)]/.test(char);
}

function readQuoted(body: string, index: number): { value: string; end: number } | undefined {
  const quote = body[index];
  if (quote !== '"' && quote !== "'") return undefined;
  let value = '';
  for (let cursor = index + 1; cursor < body.length; cursor += 1) {
    const char = body[cursor];
    if (char === '\\' && cursor + 1 < body.length) {
      value += body[cursor + 1];
      cursor += 1;
      continue;
    }
    if (char === quote) return { value, end: cursor + 1 };
    value += char;
  }
  return undefined;
}

function findMarker(haystack: string, marker: string): number {
  return haystack.toLowerCase().indexOf(marker);
}

function heldTail(buffer: string, marker: string): number {
  const lower = buffer.toLowerCase();
  const max = Math.min(lower.length, marker.length - 1);
  for (let size = max; size > 0; size -= 1) {
    if (marker.startsWith(lower.slice(-size))) return size;
  }
  return 0;
}
