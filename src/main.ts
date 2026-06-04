import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { AppConfigService } from './config/app-config.service';
import { configureApp } from './app.setup';

async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');
  // Buffer logs until the configured log level is applied, so startup messages
  // honor LOG_LEVEL instead of the default verbosity.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
  });

  const config = app.get(AppConfigService);
  app.useLogger(config.logLevels);
  app.flushLogs();
  logger.log(`Log level: ${config.logLevel} (enabled: ${config.logLevels.join(', ')})`);

  configureApp(app);

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Venice E2EE Proxy')
    .setDescription(
      'An OpenAI-compatible proxy that adds end-to-end encryption (E2EE) for Venice.ai ' +
        'TEE-backed models. Point any OpenAI-compatible client (e.g. Cline) at this server. ' +
        'Models prefixed with `e2ee-` are encrypted client-side and only decrypted inside the TEE.',
    )
    .setVersion('1.0.0')
    .addBearerAuth()
    .addServer('/', 'Local proxy')
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('docs', app, document, {
    customSiteTitle: 'Venice E2EE Proxy — API Docs',
    jsonDocumentUrl: 'docs-json',
  });

  await app.listen(config.port, config.host);

  const baseUrl = `http://${config.host}:${config.port}`;
  logger.log(`Venice E2EE Proxy listening on ${baseUrl}`);
  logger.log(`OpenAI-compatible base URL: ${baseUrl}/v1 (also accepts ${baseUrl}/api/v1)`);
  logger.log(`Swagger UI: ${baseUrl}/docs`);
  logger.debug(
    `Effective config: host=${config.host} port=${config.port} baseUrl=${config.baseUrl} ` +
      `sessionTTL=${config.sessionTtlMs}ms verifyAttestation=${config.verifyAttestation} ` +
      `verifyDcap=${config.verifyDcap} verifyGpuAttestation=${config.verifyGpuAttestation} ` +
      `dcapPccsUrl=${config.dcapPccsUrl ?? 'default'}`,
  );
}

void bootstrap();
