import { randomBytes } from 'node:crypto';
import type {
  AssembledToolCall,
  ChatCompletion,
  ChatCompletionChunk,
  ChatMessage,
  ChatMessageContent,
  ToolCallDelta,
} from '../interfaces/openai.interface';

const E2EE_PREFIX = 'e2ee-';

/** Returns true when a model id targets Venice's E2EE (TEE) inference. */
export function isE2EEModel(modelId: string): boolean {
  return typeof modelId === 'string' && modelId.startsWith(E2EE_PREFIX);
}

/** Generates an OpenAI-style identifier, e.g. `chatcmpl-ab12cd34...`. */
export function generateCompletionId(): string {
  return `chatcmpl-${randomBytes(16).toString('hex')}`;
}

/** Unix timestamp in seconds, matching the `created` field OpenAI emits. */
export function unixSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Flattens OpenAI message content (string or array-of-parts) into a single
 * string. `null` and missing content stay empty here; callers that encrypt
 * decide whether that becomes `null` or ciphertext.
 */
export function flattenContent(content: ChatMessageContent | undefined): string {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return content;
  return content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('');
}

/** Message passed to `@axlabs/venice-e2ee` `encrypt`, including tool-call structure. */
export interface PlainMessage {
  role: string;
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCallDelta[];
}

/** Fields read from a chat message before encryption. */
interface PlainMessageSource {
  role: string;
  content?: ChatMessageContent;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCallDelta[];
}

/**
 * Normalizes messages for encryption. Tool-call metadata is preserved in the
 * clear. `content: null` stays `null` so a tool-only assistant turn is not
 * flattened into an empty string (which the library would otherwise have to
 * treat as text).
 */
export function toPlainMessages(messages: ReadonlyArray<PlainMessageSource>): PlainMessage[] {
  return messages.map((message) => {
    const plain: PlainMessage = {
      role: String(message.role),
      content:
        message.content === null || message.content === undefined
          ? null
          : flattenContent(message.content),
    };
    if (typeof message.name === 'string') plain.name = message.name;
    if (typeof message.tool_call_id === 'string') plain.tool_call_id = message.tool_call_id;
    if (Array.isArray(message.tool_calls)) plain.tool_calls = message.tool_calls;
    return plain;
  });
}

/** Character counts for an incoming chat payload (plaintext, before E2EE). */
export interface IncomingMessageCharStats {
  messageCount: number;
  totalChars: number;
  /** user + system content — the text that will be encrypted for E2EE. */
  encryptableChars: number;
  assistantChars: number;
  otherChars: number;
}

/** Character counts for the message content fields sent upstream after E2EE. */
export interface OutgoingE2eeMessageCharStats {
  messageCount: number;
  totalChars: number;
  /** Hex ciphertext length for user/system `content`. */
  encryptedChars: number;
  /** `content` length for every other role (ciphertext for non-empty tool results). */
  plaintextChars: number;
}

/** Totals plaintext character counts in a chat request received by the proxy. */
export function countIncomingMessageChars(
  messages: ReadonlyArray<Pick<ChatMessage, 'role' | 'content'>>,
): IncomingMessageCharStats {
  let totalChars = 0;
  let encryptableChars = 0;
  let assistantChars = 0;
  let otherChars = 0;

  for (const message of messages) {
    const chars = flattenContent(message.content).length;
    totalChars += chars;
    const role = String(message.role);
    if (role === 'user' || role === 'system') {
      encryptableChars += chars;
    } else if (role === 'assistant') {
      assistantChars += chars;
    } else {
      otherChars += chars;
    }
  }

  return {
    messageCount: messages.length,
    totalChars,
    encryptableChars,
    assistantChars,
    otherChars,
  };
}

/** Totals character counts in message `content` fields after E2EE encryption. */
export function countOutgoingE2eeMessageChars(
  messages: ReadonlyArray<{ role: string; content: string | null }>,
): OutgoingE2eeMessageCharStats {
  let encryptedChars = 0;
  let plaintextChars = 0;

  for (const message of messages) {
    const chars = message.content?.length ?? 0;
    if (message.role === 'user' || message.role === 'system') {
      encryptedChars += chars;
    } else {
      plaintextChars += chars;
    }
  }

  return {
    messageCount: messages.length,
    totalChars: encryptedChars + plaintextChars,
    encryptedChars,
    plaintextChars,
  };
}

/**
 * Merges streaming `delta.tool_calls` into completed calls, keyed by `index`.
 * `function.name` and `function.arguments` are concatenated in arrival order.
 */
export function appendToolCallDeltas(
  accumulated: AssembledToolCall[],
  deltas: readonly ToolCallDelta[],
): void {
  for (const delta of deltas) {
    const index = typeof delta.index === 'number' ? delta.index : 0;
    const current = accumulated[index] ?? {
      id: '',
      type: 'function',
      function: { name: '', arguments: '' },
    };
    if (typeof delta.id === 'string' && delta.id.length > 0) current.id = delta.id;
    if (typeof delta.type === 'string' && delta.type.length > 0) current.type = delta.type;
    if (typeof delta.function?.name === 'string') current.function.name += delta.function.name;
    if (typeof delta.function?.arguments === 'string') {
      current.function.arguments += delta.function.arguments;
    }
    accumulated[index] = current;
  }
}

/** Drops holes left by a sparse tool-call index. */
export function compactToolCalls(accumulated: AssembledToolCall[]): AssembledToolCall[] {
  return accumulated.filter((call) => call != null);
}

/** Builds a full non-streaming chat completion from assembled text and tool calls. */
export function buildChatCompletion(params: {
  id: string;
  model: string;
  content: string;
  finishReason?: string;
  toolCalls?: AssembledToolCall[];
}): ChatCompletion {
  const toolCalls = params.toolCalls ?? [];
  const message: ChatCompletion['choices'][number]['message'] = {
    role: 'assistant',
    content: toolCalls.length > 0 && params.content.length === 0 ? null : params.content,
  };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;

  return {
    id: params.id,
    object: 'chat.completion',
    created: unixSeconds(),
    model: params.model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: params.finishReason ?? 'stop',
        logprobs: null,
      },
    ],
  };
}

/** Builds a single streaming chunk carrying a content delta. */
export function buildContentChunk(params: {
  id: string;
  model: string;
  content: string;
  created: number;
}): ChatCompletionChunk {
  return {
    id: params.id,
    object: 'chat.completion.chunk',
    created: params.created,
    model: params.model,
    choices: [
      {
        index: 0,
        delta: { content: params.content },
        finish_reason: null,
        logprobs: null,
      },
    ],
  };
}

/** Builds the opening chunk that announces the assistant role. */
export function buildRoleChunk(params: {
  id: string;
  model: string;
  created: number;
}): ChatCompletionChunk {
  return {
    id: params.id,
    object: 'chat.completion.chunk',
    created: params.created,
    model: params.model,
    choices: [
      {
        index: 0,
        delta: { role: 'assistant', content: '' },
        finish_reason: null,
        logprobs: null,
      },
    ],
  };
}

/** Builds a streaming chunk carrying `delta.tool_calls`, in the order received. */
export function buildToolCallsChunk(params: {
  id: string;
  model: string;
  created: number;
  toolCalls: ToolCallDelta[];
}): ChatCompletionChunk {
  return {
    id: params.id,
    object: 'chat.completion.chunk',
    created: params.created,
    model: params.model,
    choices: [
      {
        index: 0,
        delta: { tool_calls: params.toolCalls },
        finish_reason: null,
        logprobs: null,
      },
    ],
  };
}

/** Builds the terminating chunk carrying the finish reason. */
export function buildFinalChunk(params: {
  id: string;
  model: string;
  created: number;
  finishReason?: string;
}): ChatCompletionChunk {
  return {
    id: params.id,
    object: 'chat.completion.chunk',
    created: params.created,
    model: params.model,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: params.finishReason ?? 'stop',
        logprobs: null,
      },
    ],
  };
}

/** Serializes a payload as a single SSE `data:` event. */
export function sseEvent(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** The terminating SSE sentinel OpenAI clients expect. */
export const SSE_DONE = 'data: [DONE]\n\n';
