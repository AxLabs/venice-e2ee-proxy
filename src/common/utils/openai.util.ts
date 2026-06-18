import { randomBytes } from 'node:crypto';
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatMessage,
  ChatMessageContent,
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
 * string. `@axlabs/venice-e2ee` encrypts `{ role, content: string }` pairs, so any
 * structured content is collapsed to its text parts.
 */
export function flattenContent(content: ChatMessageContent): string {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return content;
  return content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('');
}

/** Normalizes messages into the `{ role, content }` form @axlabs/venice-e2ee expects. */
export function toPlainMessages(
  messages: ReadonlyArray<Pick<ChatMessage, 'role' | 'content'>>,
): Array<{ role: string; content: string }> {
  return messages.map((message) => ({
    role: String(message.role),
    content: flattenContent(message.content),
  }));
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
  /** Hex ciphertext length for encrypted user/system messages. */
  encryptedChars: number;
  /** Plaintext length for assistant and other roles left unchanged. */
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
  messages: ReadonlyArray<{ role: string; content: string }>,
): OutgoingE2eeMessageCharStats {
  let encryptedChars = 0;
  let plaintextChars = 0;

  for (const message of messages) {
    const chars = message.content.length;
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

/** Builds a full non-streaming chat completion from assembled text. */
export function buildChatCompletion(params: {
  id: string;
  model: string;
  content: string;
  finishReason?: string;
}): ChatCompletion {
  return {
    id: params.id,
    object: 'chat.completion',
    created: unixSeconds(),
    model: params.model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: params.content },
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
