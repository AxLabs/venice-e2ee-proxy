import { HttpException, Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service';

/** Upstream API version path segment used by Venice's OpenAI-compatible API. */
const VENICE_API_PREFIX = '/api/v1';

/**
 * Thin HTTP client for Venice's upstream API. Centralizes base URL resolution,
 * authentication headers, and error normalization. Uses the global `fetch` so
 * response bodies remain web `ReadableStream`s — exactly what `@axlabs/venice-e2ee`'s
 * `decryptStream` consumes.
 */
@Injectable()
export class VeniceHttpService {
  private readonly logger = new Logger(VeniceHttpService.name);

  constructor(private readonly config: AppConfigService) {}

  private url(path: string): string {
    const base = this.config.baseUrl.replace(/\/+$/, '');
    const suffix = path.startsWith('/') ? path : `/${path}`;
    return `${base}${VENICE_API_PREFIX}${suffix}`;
  }

  private authHeaders(extra?: Record<string, string>): Record<string, string> {
    return {
      Authorization: `Bearer ${this.config.veniceApiKey}`,
      ...extra,
    };
  }

  /** POSTs a JSON body to Venice. Returns the raw `fetch` Response. */
  async postJson(
    path: string,
    body: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<Response> {
    const url = this.url(path);
    const payload = JSON.stringify(body);
    const payloadBytes = Buffer.byteLength(payload, 'utf8');
    this.logger.debug(
      `→ POST ${this.redact(url)} (body=${payloadBytes}B, extraHeaders=[${Object.keys(
        extraHeaders ?? {},
      ).join(', ')}])`,
    );
    const startedAt = Date.now();
    const response = await fetch(url, {
      method: 'POST',
      headers: this.authHeaders({ 'Content-Type': 'application/json', ...extraHeaders }),
      body: payload,
    });
    this.logger.debug(
      `← ${response.status} ${response.statusText} POST ${this.redact(url)} (${Date.now() - startedAt}ms)`,
    );
    return response;
  }

  /** GETs a path from Venice. Returns the raw `fetch` Response. */
  async get(path: string, extraHeaders?: Record<string, string>): Promise<Response> {
    const url = this.url(path);
    this.logger.debug(`→ GET ${this.redact(url)}`);
    const startedAt = Date.now();
    const response = await fetch(url, {
      method: 'GET',
      headers: this.authHeaders(extraHeaders),
    });
    this.logger.debug(
      `← ${response.status} ${response.statusText} GET ${this.redact(url)} (${Date.now() - startedAt}ms)`,
    );
    return response;
  }

  /** Redacts the `nonce` query parameter from a URL for cleaner logs. */
  private redact(url: string): string {
    return url.replace(/([?&]nonce=)[^&]*/i, '$1<redacted>');
  }

  /**
   * Reads an error response body and throws a matching `HttpException` so the
   * upstream status and message are surfaced to the client.
   */
  async throwUpstreamError(response: Response, context: string): Promise<never> {
    const text = await response.text().catch(() => '');
    let message = text;
    try {
      const parsed = JSON.parse(text);
      message = parsed?.error?.message ?? parsed?.message ?? text;
    } catch {
      // keep raw text
    }
    this.logger.error(`Venice upstream error during ${context} (${response.status}): ${message}`);
    throw new HttpException(
      message || `Upstream request failed with status ${response.status}`,
      response.status,
    );
  }
}
