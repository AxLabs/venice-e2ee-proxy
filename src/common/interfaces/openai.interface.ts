/**
 * Minimal, internal representations of the OpenAI Chat Completions API shapes
 * that this proxy needs to produce. These are intentionally narrow: we only
 * model the fields tooling like Cline relies on.
 */

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool' | 'function' | (string & {});

/** A single text part of OpenAI's "array" content form. */
export interface ChatContentPart {
  type: string;
  text?: string;
  [key: string]: unknown;
}

/** OpenAI message content can be a plain string, an array of typed parts, or null. */
export type ChatMessageContent = string | ChatContentPart[] | null;

/**
 * A streaming tool-call delta, or the call object stored on an assistant message.
 * Names, ids, and arguments stay plaintext; Venice's enclave reads them as JSON.
 */
export interface ToolCallDelta {
  index?: number;
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

/** Tool call assembled from streaming deltas for a non-streaming completion. */
export interface AssembledToolCall {
  id: string;
  type: string;
  function: {
    name: string;
    arguments: string;
  };
}

export interface ChatMessage {
  role: ChatRole;
  content?: ChatMessageContent;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCallDelta[];
  [key: string]: unknown;
}

export interface ChatCompletionChoice {
  index: number;
  message: {
    role: 'assistant';
    content: string | null;
    tool_calls?: AssembledToolCall[];
  };
  finish_reason: string | null;
  logprobs: null;
}

export interface ChatCompletionUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

/** Non-streaming response (`object: "chat.completion"`). */
export interface ChatCompletion {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage?: ChatCompletionUsage;
  system_fingerprint?: string;
}

export interface ChatCompletionChunkChoice {
  index: number;
  delta: {
    role?: 'assistant';
    content?: string;
    tool_calls?: ToolCallDelta[];
  };
  finish_reason: string | null;
  logprobs: null;
}

/** A single streamed SSE event (`object: "chat.completion.chunk"`). */
export interface ChatCompletionChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: ChatCompletionChunkChoice[];
  system_fingerprint?: string;
}

export interface ModelObject {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
  [key: string]: unknown;
}

export interface ModelList {
  object: 'list';
  data: ModelObject[];
}
