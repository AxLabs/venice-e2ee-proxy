import { Body, Controller, HttpCode, Logger, Post, Res } from '@nestjs/common';
import { ApiBody, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { ChatService } from './chat.service';
import { ChatCompletionRequestDto } from './dto/chat-completion-request.dto';
import { ChatCompletionResponseDto } from './dto/chat-completion-response.dto';
import type { ChatCompletionChunk } from '../common/interfaces/openai.interface';
import { SSE_DONE, sseEvent } from '../common/utils/openai.util';

@ApiTags('Chat')
@Controller({ path: 'chat/completions', version: '1' })
export class ChatController {
  private readonly logger = new Logger(ChatController.name);

  constructor(private readonly chatService: ChatService) {}

  @Post()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Create chat completion',
    description:
      'OpenAI-compatible chat completions. Supports streaming (SSE) and non-streaming responses. ' +
      'Models prefixed with `e2ee-` are end-to-end encrypted via Venice TEE: messages are encrypted, ' +
      'streamed upstream, and decrypted on the fly. Non-streaming requests to `e2ee-` models are ' +
      'transparently buffered and returned as a single completion.',
  })
  @ApiBody({ type: ChatCompletionRequestDto })
  @ApiOkResponse({
    description:
      'A chat completion object, or — when `stream: true` — a `text/event-stream` of `chat.completion.chunk` events terminated by `data: [DONE]`.',
    type: ChatCompletionResponseDto,
  })
  async createCompletion(
    @Body() dto: ChatCompletionRequestDto,
    @Res({ passthrough: false }) res: Response,
  ): Promise<void> {
    const wantsStream = dto.stream === true;
    const e2ee = this.chatService.isE2EE(dto.model);

    this.logger.log(
      `chat.completions model=${dto.model} e2ee=${e2ee} stream=${wantsStream} messages=${dto.messages.length}`,
    );
    const { messages: _messages, ...params } = dto;
    this.logger.debug(`Request params (messages omitted): ${JSON.stringify(params)}`);

    if (e2ee && wantsStream) {
      await this.writeSyntheticStream(res, this.chatService.streamE2EE(dto));
      return;
    }

    if (e2ee && !wantsStream) {
      const completion = await this.chatService.completeE2EE(dto);
      res.status(200).json(completion);
      return;
    }

    if (!e2ee && wantsStream) {
      const upstream = await this.chatService.proxyStream(dto);
      await this.pipeUpstream(res, upstream);
      return;
    }

    const completion = await this.chatService.proxyCompletion(dto);
    res.status(200).json(completion);
  }

  /** Writes SSE headers once, lazily, so pre-stream errors hit the exception filter. */
  private setSseHeaders(res: Response): void {
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
  }

  /** Streams synthesized OpenAI chunks (used by the E2EE flow). */
  private async writeSyntheticStream(
    res: Response,
    chunks: AsyncGenerator<ChatCompletionChunk>,
  ): Promise<void> {
    let started = false;
    let emitted = 0;
    const startedAt = Date.now();
    for await (const chunk of chunks) {
      if (!started) {
        this.setSseHeaders(res);
        started = true;
        this.logger.debug('SSE stream started; sending synthesized OpenAI chunks');
      }
      res.write(sseEvent(chunk));
      emitted += 1;
    }
    if (!started) {
      this.setSseHeaders(res);
    }
    res.write(SSE_DONE);
    res.end();
    this.logger.debug(`SSE stream complete: ${emitted} chunk(s) in ${Date.now() - startedAt}ms`);
  }

  /** Pipes an upstream SSE byte stream straight through (non-E2EE passthrough). */
  private async pipeUpstream(res: Response, upstream: globalThis.Response): Promise<void> {
    this.setSseHeaders(res);
    this.logger.debug('Piping upstream SSE bytes through (non-E2EE passthrough)');
    const reader = upstream.body!.getReader();
    let bytes = 0;
    const startedAt = Date.now();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          res.write(Buffer.from(value));
          bytes += value.byteLength;
        }
      }
    } finally {
      reader.releaseLock();
      res.end();
      this.logger.debug(`Upstream passthrough complete: ${bytes}B in ${Date.now() - startedAt}ms`);
    }
  }
}
