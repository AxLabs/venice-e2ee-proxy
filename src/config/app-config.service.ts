import { Injectable, type LogLevel } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EnvironmentVariables, LogLevelName } from './env.validation';

/**
 * Thin, strongly-typed wrapper around `ConfigService`. Every consumer in the
 * app reads configuration through this service so we get a single, typed
 * surface instead of stringly-typed `get('SOME_KEY')` calls scattered around.
 */
@Injectable()
export class AppConfigService {
  constructor(private readonly configService: ConfigService<EnvironmentVariables, true>) {}

  get veniceApiKey(): string {
    return this.configService.get('VENICE_API_KEY', { infer: true });
  }

  get port(): number {
    return this.configService.get('PORT', { infer: true });
  }

  get host(): string {
    return this.configService.get('HOST', { infer: true });
  }

  get sessionTtlMs(): number {
    return this.configService.get('SESSION_TTL_MS', { infer: true });
  }

  get verifyAttestation(): boolean {
    return this.configService.get('VERIFY_ATTESTATION', { infer: true });
  }

  get verifyDcap(): boolean {
    return this.configService.get('VERIFY_DCAP', { infer: true });
  }

  get verifyGpuAttestation(): boolean {
    return this.configService.get('VERIFY_GPU_ATTESTATION', { infer: true });
  }

  get dcapPccsUrl(): string | undefined {
    return this.configService.get('DCAP_PCCS_URL', { infer: true });
  }

  get baseUrl(): string {
    return this.configService.get('BASE_URL', { infer: true });
  }

  get logLevel(): LogLevelName {
    return this.configService.get('LOG_LEVEL', { infer: true });
  }

  /**
   * Maps the configured `LOG_LEVEL` to the cumulative set of NestJS log levels
   * to enable (each level includes all less-verbose levels). `info` maps to
   * Nest's `log` level.
   */
  get logLevels(): LogLevel[] {
    const order: LogLevel[] = ['error', 'warn', 'log', 'debug', 'verbose'];
    const normalized: LogLevel = this.logLevel === 'info' ? 'log' : (this.logLevel as LogLevel);
    const index = order.indexOf(normalized);
    return order.slice(0, index < 0 ? 3 : index + 1);
  }
}
