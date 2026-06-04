import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';

interface OpenAIErrorBody {
  error: {
    message: string;
    type: string;
    param: string | null;
    code: string | null;
  };
}

/**
 * Translates any thrown error into the OpenAI error envelope so that
 * OpenAI-compatible clients (Cline, the OpenAI SDK, etc.) can parse failures.
 */
@Catch()
export class OpenAIExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(OpenAIExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const { status, body } = this.toOpenAIError(exception);

    this.logger.error(
      `${request.method} ${request.url} -> ${status}: ${body.error.message}`,
      exception instanceof Error ? exception.stack : undefined,
    );

    // If streaming already started, headers are sent; just end the stream.
    if (response.headersSent) {
      response.end();
      return;
    }

    response.status(status).json(body);
  }

  private toOpenAIError(exception: unknown): { status: number; body: OpenAIErrorBody } {
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const responseBody = exception.getResponse();
      const message = this.extractMessage(responseBody, exception.message);
      return {
        status,
        body: {
          error: {
            message,
            type: this.typeForStatus(status),
            param: null,
            code: null,
          },
        },
      };
    }

    const message = exception instanceof Error ? exception.message : 'Internal server error';
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: {
        error: {
          message,
          type: 'api_error',
          param: null,
          code: null,
        },
      },
    };
  }

  private extractMessage(responseBody: unknown, fallback: string): string {
    if (typeof responseBody === 'string') return responseBody;
    if (responseBody && typeof responseBody === 'object' && 'message' in responseBody) {
      const message = (responseBody as { message: unknown }).message;
      if (Array.isArray(message)) return message.join(', ');
      if (typeof message === 'string') return message;
    }
    return fallback;
  }

  private typeForStatus(status: number): string {
    if (status === HttpStatus.UNAUTHORIZED) return 'authentication_error';
    if (status === HttpStatus.TOO_MANY_REQUESTS) return 'rate_limit_error';
    if (status >= 400 && status < 500) return 'invalid_request_error';
    return 'api_error';
  }
}
