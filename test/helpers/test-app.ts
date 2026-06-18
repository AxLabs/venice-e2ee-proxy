import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { vi } from 'vitest';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.setup';
import { E2eeService } from '../../src/e2ee/e2ee.service';
import { VeniceHttpService } from '../../src/common/venice/venice-http.service';

export interface MockedVenice {
  postJson: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  throwUpstreamError: ReturnType<typeof vi.fn>;
}

export interface MockedE2ee {
  createSession: ReturnType<typeof vi.fn>;
  encrypt: ReturnType<typeof vi.fn>;
  decryptStream: ReturnType<typeof vi.fn>;
  clearSession: ReturnType<typeof vi.fn>;
}

export interface TestHarness {
  app: INestApplication;
  venice: MockedVenice;
  e2ee: MockedE2ee;
}

/** Builds a web ReadableStream that emits the given string parts then closes. */
export function readableFrom(parts: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  });
}

/** Async generator helper mirroring `@axlabs/venice-e2ee`'s decryptStream output. */
export async function* yieldTexts(texts: string[]): AsyncGenerator<string> {
  for (const text of texts) yield text;
}

/**
 * Boots the full Nest application with the `@axlabs/venice-e2ee` library and upstream
 * HTTP client replaced by mocks. This lets the compliance tests exercise the
 * real controllers, pipes, filters, and routing without any network or crypto.
 */
export async function createTestApp(): Promise<TestHarness> {
  process.env.VENICE_API_KEY = process.env.VENICE_API_KEY ?? 'test-key';

  const venice: MockedVenice = {
    postJson: vi.fn(),
    get: vi.fn(),
    throwUpstreamError: vi.fn(async () => {
      throw new Error('upstream error');
    }),
  };

  const e2ee: MockedE2ee = {
    createSession: vi.fn(async (modelId: string) => ({ modelId })),
    encrypt: vi.fn(async (messages: Array<{ role: string; content: string }>) => ({
      encryptedMessages: messages.map((m) => ({ role: m.role, content: `ENC(${m.content})` })),
      headers: { 'X-Venice-TEE-Client-Pub-Key': 'client-pub' },
      veniceParameters: { enable_e2ee: true },
    })),
    decryptStream: vi.fn(() => yieldTexts([])),
    clearSession: vi.fn(),
  };

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideProvider(E2eeService)
    .useValue(e2ee)
    .overrideProvider(VeniceHttpService)
    .useValue(venice)
    .compile();

  const app = moduleRef.createNestApplication();
  configureApp(app);
  await app.init();

  return { app, venice, e2ee };
}
