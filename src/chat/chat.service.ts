import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { E2eeService } from '../e2ee/e2ee.service';
import { VeniceHttpService } from '../common/venice/venice-http.service';
import type { ChatCompletion, ChatCompletionChunk } from '../common/interfaces/openai.interface';
import {
  buildChatCompletion,
  buildContentChunk,
  buildFinalChunk,
  buildRoleChunk,
  generateCompletionId,
  isE2EEModel,
  toPlainMessages,
  unixSeconds,
} from '../common/utils/openai.util';
import type { ChatCompletionRequestDto } from './dto/chat-completion-request.dto';

const CHAT_COMPLETIONS_PATH = '/chat/completions';

/**
 * Orchestrates chat completions. Requests for `e2ee-` models are encrypted via
 * `venice-e2ee`, forwarded to Venice with `stream: true`, and the response is
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
   * E2EE streaming: synthesize OpenAI SSE chunks from decrypted text deltas.
   * E2EE models always stream upstream (a Venice requirement).
   */
  async *streamE2EE(dto: ChatCompletionRequestDto): AsyncGenerator<ChatCompletionChunk> {
    this.logger.debug(`E2EE stream: establishing session for "${dto.model}"`);
    const session = await this.e2ee.createSession(dto.model);

    const plainMessages = toPlainMessages(dto.messages);
    const { encryptedMessages, headers, veniceParameters } = await this.e2ee.encrypt(
      plainMessages,
      session,
    );
    this.logger.debug(
      `E2EE stream: encrypted ${encryptedMessages.length} message(s); ` +
        `TEE headers=[${Object.keys(headers).join(', ')}]`,
    );

    const body = this.toUpstreamBody(dto, {
      messages: encryptedMessages,
      stream: true,
      venice_parameters: { ...(dto.venice_parameters ?? {}), ...veniceParameters },
    });

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
    yield buildRoleChunk({ id, model: dto.model, created });
    for await (const text of this.e2ee.decryptStream(response.body, session)) {
      if (text.length > 0) {
        decryptedChunks += 1;
        decryptedChars += text.length;
        yield buildContentChunk({ id, model: dto.model, content: text, created });
      }
    }
    yield buildFinalChunk({ id, model: dto.model, created });
    this.logger.debug(
      `E2EE stream: decrypted ${decryptedChunks} chunk(s), ${decryptedChars} char(s) (id=${id})`,
    );
  }

  /**
   * E2EE non-streaming: Venice requires streaming for E2EE, so we stream + decrypt
   * upstream, buffer the deltas, and return a single OpenAI completion object.
   */
  async completeE2EE(dto: ChatCompletionRequestDto): Promise<ChatCompletion> {
    this.logger.debug(`E2EE non-streaming: buffering decrypted stream for "${dto.model}"`);
    let content = '';
    let id = '';
    let finishReason = 'stop';

    for await (const chunk of this.streamE2EE(dto)) {
      id = chunk.id;
      const choice = chunk.choices[0];
      if (choice?.delta?.content) content += choice.delta.content;
      if (choice?.finish_reason) finishReason = choice.finish_reason;
    }

    this.logger.debug(`E2EE non-streaming: assembled ${content.length} char(s) (id=${id})`);
    return buildChatCompletion({
      id: id || generateCompletionId(),
      model: dto.model,
      content,
      finishReason,
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
