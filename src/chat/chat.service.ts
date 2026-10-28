import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { E2eeService } from '../e2ee/e2ee.service';
import { VeniceHttpService } from '../common/venice/venice-http.service';
import type {
  AssembledToolCall,
  ChatCompletion,
  ChatCompletionChunk,
} from '../common/interfaces/openai.interface';
import {
  InlineToolCallParser,
  prepareE2eeToolMessages,
  toToolCallDeltas,
  type ToolRecoveryEvent,
} from '../common/utils/e2ee-tools';
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
  generateCompletionId,
  isE2EEModel,
  toPlainMessages,
  unixSeconds,
} from '../common/utils/openai.util';
import type { ChatCompletionRequestDto } from './dto/chat-completion-request.dto';

const CHAT_COMPLETIONS_PATH = '/chat/completions';

/**
 * Orchestrates chat completions. Requests for `e2ee-` models are encrypted via
 * `@axlabs/venice-e2ee`, forwarded to Venice with `stream: true`, and the response is
 * decrypted on the fly. All other models are proxied transparently.
 */
@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  constructor(
    private readonly e2ee: E2eeService,
    private readonly venice: VeniceHttpService,
  ) {}

  isE2EE(model: string): boolean {
    return isE2EEModel(model);
  }

  /**
   * E2EE streaming: synthesize OpenAI SSE chunks from decrypted text deltas
   * and plaintext tool-call deltas. E2EE models always stream upstream.
   */
  async *streamE2EE(dto: ChatCompletionRequestDto): AsyncGenerator<ChatCompletionChunk> {
    this.logger.debug(`E2EE stream: establishing session for "${dto.model}"`);

    const received = countIncomingMessageChars(dto.messages);
    this.logger.debug(
      `E2EE payload received: ${received.messageCount} message(s), ${received.totalChars} char(s) ` +
        `(user/system=${received.encryptableChars}, assistant=${received.assistantChars}` +
        `${received.otherChars > 0 ? `, other=${received.otherChars}` : ''})`,
    );

    const session = await this.e2ee.createSession(dto.model);

    const tools = Array.isArray(dto.tools) ? dto.tools : [];
    const prepared = prepareE2eeToolMessages(toPlainMessages(dto.messages), tools, dto.tool_choice);
    const plainMessages = prepared.messages;
    const { encryptedMessages, headers, veniceParameters } = await this.e2ee.encrypt(
      plainMessages,
      session,
    );

    const sent = countOutgoingE2eeMessageChars(encryptedMessages);
    const body = this.toUpstreamBody(dto, {
      messages: encryptedMessages,
      stream: true,
      venice_parameters: { ...(dto.venice_parameters ?? {}), ...veniceParameters },
    });
    if (prepared.hidePlaintextTools) {
      delete body.tools;
      delete body.tool_choice;
      this.logger.debug(
        `E2EE tools: ${tools.length} schema(s) encrypted into the prompt; plaintext tools omitted`,
      );
    }
    const bodyJson = JSON.stringify(body);
    const bodyBytes = Buffer.byteLength(bodyJson, 'utf8');

    this.logger.debug(
      `E2EE payload upstream: ${sent.messageCount} message(s), ${sent.totalChars} char(s) in content ` +
        `(encrypted hex=${sent.encryptedChars}, plaintext=${sent.plaintextChars}), ` +
        `JSON body=${bodyBytes} byte(s)` +
        (received.encryptableChars > 0
          ? ` (~${Math.round(sent.encryptedChars / received.encryptableChars)}× encryptable content)`
          : ''),
    );
    this.logger.debug(
      `E2EE stream: encrypted ${encryptedMessages.length} message(s); ` +
        `TEE headers=[${Object.keys(headers).join(', ')}]`,
    );

    const response = await this.venice.postJson(CHAT_COMPLETIONS_PATH, body, headers);
    if (!response.ok) {
      await this.venice.throwUpstreamError(response, 'e2ee chat completion');
    }
    if (!response.body) {
      throw new InternalServerErrorException('Venice returned an empty E2EE response body.');
    }

    const id = generateCompletionId();
    const created = unixSeconds();
    this.logger.debug(`E2EE stream: decrypting upstream stream (completion id=${id})`);

    let decryptedChunks = 0;
    let decryptedChars = 0;
    let toolCallDeltas = 0;
    let recoveredToolCalls = 0;
    let nextToolIndex = 0;
    let finishReason = 'stop';
    const parser = new InlineToolCallParser();
    yield buildRoleChunk({ id, model: dto.model, created });
    for await (const event of this.e2ee.decryptStream(response.body, session)) {
      switch (event.kind) {
        case 'content':
          if (event.content.length > 0) {
            decryptedChunks += 1;
            decryptedChars += event.content.length;
            for (const recovered of parser.push(event.content)) {
              const emitted = this.emitRecovered(recovered, {
                id,
                model: dto.model,
                created,
                nextToolIndex,
              });
              nextToolIndex = emitted.nextToolIndex;
              toolCallDeltas += emitted.toolCallDeltas;
              recoveredToolCalls += emitted.toolCallDeltas;
              yield emitted.chunk;
            }
          }
          break;
        case 'tool_calls':
          for (const delta of event.tool_calls) {
            if (typeof delta.index === 'number' && delta.index >= nextToolIndex) {
              nextToolIndex = delta.index + 1;
            }
          }
          toolCallDeltas += event.tool_calls.length;
          yield buildToolCallsChunk({
            id,
            model: dto.model,
            created,
            toolCalls: event.tool_calls,
          });
          break;
        case 'finish':
          finishReason = event.finish_reason;
          break;
        default: {
          const unexpected: never = event;
          throw new Error(`Unhandled E2EE stream event: ${JSON.stringify(unexpected)}`);
        }
      }
    }
    for (const recovered of parser.finish()) {
      const emitted = this.emitRecovered(recovered, {
        id,
        model: dto.model,
        created,
        nextToolIndex,
      });
      nextToolIndex = emitted.nextToolIndex;
      toolCallDeltas += emitted.toolCallDeltas;
      recoveredToolCalls += emitted.toolCallDeltas;
      yield emitted.chunk;
    }
    if (recoveredToolCalls > 0 && finishReason === 'stop') finishReason = 'tool_calls';
    yield buildFinalChunk({ id, model: dto.model, created, finishReason });
    this.logger.debug(
      `E2EE stream: decrypted ${decryptedChunks} chunk(s), ${decryptedChars} char(s), ` +
        `${toolCallDeltas} tool-call delta(s)` +
        (recoveredToolCalls > 0 ? ` (${recoveredToolCalls} recovered from content)` : '') +
        `, finish_reason=${finishReason} (id=${id})`,
    );
  }

  /**
   * E2EE non-streaming: Venice requires streaming for E2EE, so we stream + decrypt
   * upstream, buffer text and tool-call deltas, and return one completion object.
   */
  async completeE2EE(dto: ChatCompletionRequestDto): Promise<ChatCompletion> {
    this.logger.debug(`E2EE non-streaming: buffering decrypted stream for "${dto.model}"`);
    let content = '';
    let id = '';
    let finishReason = 'stop';
    const toolCalls: AssembledToolCall[] = [];

    for await (const chunk of this.streamE2EE(dto)) {
      id = chunk.id;
      const choice = chunk.choices[0];
      if (choice?.delta?.content) content += choice.delta.content;
      if (choice?.delta?.tool_calls) appendToolCallDeltas(toolCalls, choice.delta.tool_calls);
      if (choice?.finish_reason) finishReason = choice.finish_reason;
    }

    const assembled = compactToolCalls(toolCalls);
    this.logger.debug(
      `E2EE non-streaming: assembled ${content.length} char(s), ${assembled.length} tool call(s) (id=${id})`,
    );
    return buildChatCompletion({
      id: id || generateCompletionId(),
      model: dto.model,
      content,
      finishReason,
      toolCalls: assembled,
    });
  }

  /** Non-E2EE non-streaming proxy: forward the request and return the JSON body. */
  async proxyCompletion(dto: ChatCompletionRequestDto): Promise<unknown> {
    this.logger.debug(`Proxying non-streaming completion for "${dto.model}"`);
    const body = this.toUpstreamBody(dto, { stream: false });
    const response = await this.venice.postJson(CHAT_COMPLETIONS_PATH, body);
    if (!response.ok) {
      await this.venice.throwUpstreamError(response, 'chat completion');
    }
    return response.json();
  }

  /**
   * Non-E2EE streaming proxy: returns the upstream `fetch` Response so the
   * controller can pipe the SSE bytes through unchanged.
   */
  async proxyStream(dto: ChatCompletionRequestDto): Promise<Response> {
    this.logger.debug(`Proxying streaming completion for "${dto.model}"`);
    const body = this.toUpstreamBody(dto, { stream: true });
    const response = await this.venice.postJson(CHAT_COMPLETIONS_PATH, body);
    if (!response.ok) {
      await this.venice.throwUpstreamError(response, 'chat completion stream');
    }
    if (!response.body) {
      throw new InternalServerErrorException('Venice returned an empty response body.');
    }
    return response;
  }

  /** Maps one recovered stream piece onto an OpenAI chunk. */
  private emitRecovered(
    event: ToolRecoveryEvent,
    params: { id: string; model: string; created: number; nextToolIndex: number },
  ): { chunk: ChatCompletionChunk; nextToolIndex: number; toolCallDeltas: number } {
    switch (event.kind) {
      case 'content':
        return {
          chunk: buildContentChunk({
            id: params.id,
            model: params.model,
            created: params.created,
            content: event.content,
          }),
          nextToolIndex: params.nextToolIndex,
          toolCallDeltas: 0,
        };
      case 'tool_calls': {
        const toolCalls = toToolCallDeltas(event.toolCalls, params.nextToolIndex);
        return {
          chunk: buildToolCallsChunk({
            id: params.id,
            model: params.model,
            created: params.created,
            toolCalls,
          }),
          nextToolIndex: params.nextToolIndex + toolCalls.length,
          toolCallDeltas: toolCalls.length,
        };
      }
      default: {
        const unexpected: never = event;
        throw new Error(`Unhandled recovered stream event: ${JSON.stringify(unexpected)}`);
      }
    }
  }

  /**
   * Merges the incoming request with proxy-specific overrides, forwarding any
   * additional provider parameters untouched.
   */
  private toUpstreamBody(
    dto: ChatCompletionRequestDto,
    overrides: Record<string, unknown>,
  ): Record<string, unknown> {
    return { ...dto, ...overrides };
  }
}
