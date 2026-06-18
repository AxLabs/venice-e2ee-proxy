import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { applyCliConfig, printCliHelp } from './config/cli-args';
import { AppConfigService } from './config/app-config.service';
import { configureApp } from './app.setup';

/**
 * True if a Venice API key is reachable from any supported source: a CLI flag
 * (already applied to `process.env`), an environment variable, or a `.env` file
 * in the working directory (the same file `@nestjs/config` loads). Used for a
 * pre-flight check so a missing key produces a clear message instead of a
 * NestJS startup stack trace.
 */
function veniceApiKeyConfigured(): boolean {
  const fromEnv = process.env.VENICE_API_KEY;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return true;
  try {
    const envPath = resolve(process.cwd(), '.env');
    if (!existsSync(envPath)) return false;
    return /^\s*VENICE_API_KEY\s*=\s*["']?\S/m.test(readFileSync(envPath, 'utf8'));
  } catch {
    return false;
  }
}

function exitWithApiKeyHelp(): never {
  process.stderr.write(
    '\nVENICE_API_KEY is required to start the proxy.\n\n' +
      'Provide it via a CLI flag, an environment variable, or a .env file. For example:\n' +
      '  npx @axlabs/venice-e2ee-proxy --venice-api-key <your-venice-api-key>\n' +
      '  VENICE_API_KEY=<your-venice-api-key> npx @axlabs/venice-e2ee-proxy\n\n' +
      'Get an API key at https://venice.ai. Run with --help to see all options.\n\n',
  );
  process.exit(1);
}

const cli = applyCliConfig();
if (cli.help) {
  printCliHelp();
  process.exit(0);
}

if (!veniceApiKeyConfigured()) {
  exitWithApiKeyHelp();
}

async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');
  // Buffer logs until the configured log level is applied, so startup messages
  // honor LOG_LEVEL instead of the default verbosity.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    // Throw on startup errors (e.g. config validation) so we can present a
    // clean message instead of Nest printing a stack trace and exiting.
    abortOnError: false,
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

bootstrap().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);

  // Configuration/validation problems (e.g. missing VENICE_API_KEY) get a
  // clean, actionable message instead of a stack trace.
  if (message.includes('Invalid environment configuration')) {
    process.stderr.write(
      `\n${message}\n\n` +
        'Provide configuration via a CLI flag, environment variable, or a .env file. For example:\n' +
        '  npx @axlabs/venice-e2ee-proxy --venice-api-key <your-venice-api-key>\n' +
        '  VENICE_API_KEY=<your-venice-api-key> npx @axlabs/venice-e2ee-proxy\n\n' +
        'Run with --help to see all options.\n\n',
    );
    process.exit(1);
  }

  process.stderr.write(`\nFailed to start venice-e2ee-proxy: ${message}\n\n`);
  process.exit(1);
});
