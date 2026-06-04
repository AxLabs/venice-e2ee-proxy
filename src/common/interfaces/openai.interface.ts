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

/** OpenAI message content can be a plain string or an array of typed parts. */
export type ChatMessageContent = string | ChatContentPart[] | null;

export interface ChatMessage {
  role: ChatRole;
  content: ChatMessageContent;
  name?: string;
  [key: string]: unknown;
}

export interface ChatCompletionChoice {
  index: number;
  message: {
    role: 'assistant';
    content: string;
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
