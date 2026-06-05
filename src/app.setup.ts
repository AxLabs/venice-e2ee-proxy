import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { json, urlencoded, type NextFunction, type Request, type Response } from 'express';
import { AppConfigService } from './config/app-config.service';
import { OpenAIExceptionFilter } from './common/filters/openai-exception.filter';

/**
 * Applies the global pipes, filters, versioning, and CORS that make the server
 * OpenAI-compatible. Shared between the runtime bootstrap and the test harness
 * so both behave identically.
 */
export function configureApp(app: INestApplication): void {
  app.enableCors({ origin: true });

  // Raise the body-size limit above Express's 100kb default. Registering our
  // own parsers before `app.init()` means they run first and mark the body as
  // parsed, so Nest's default 100kb parser becomes a no-op. Chat payloads can
  // be large (long histories, base64 image data URLs).
  const bodyLimit = app.get(AppConfigService).maxBodySize;
  app.use(json({ limit: bodyLimit }));
  app.use(urlencoded({ extended: true, limit: bodyLimit }));

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
