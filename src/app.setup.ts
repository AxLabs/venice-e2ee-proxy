import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { OpenAIExceptionFilter } from './common/filters/openai-exception.filter';

/**
 * Applies the global pipes, filters, versioning, and CORS that make the server
 * OpenAI-compatible. Shared between the runtime bootstrap and the test harness
 * so both behave identically.
 */
export function configureApp(app: INestApplication): void {
  app.enableCors({ origin: true });

  // Accept both `/v1/*` and Venice-style `/api/v1/*` base URLs. Clients often
  // mirror Venice's real API path (`https://api.venice.ai/api/v1`), so we
  // transparently strip the leading `/api` before routing.
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (req.url === '/api/v1' || req.url.startsWith('/api/v1/')) {
      req.url = req.url.slice('/api'.length);
    }
    next();
  });

  // URI versioning => endpoints live under /v1/* (e.g. /v1/chat/completions).
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });

  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      // Keep unknown fields: provider-specific params are forwarded upstream.
      whitelist: false,
      forbidNonWhitelisted: false,
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  app.useGlobalFilters(new OpenAIExceptionFilter());
}
