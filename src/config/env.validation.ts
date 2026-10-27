import { plainToInstance, Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
  validateSync,
} from 'class-validator';

/** Accepted values for `LOG_LEVEL`, from least to most verbose. */
export const LOG_LEVELS = ['error', 'warn', 'info', 'debug', 'verbose'] as const;
export type LogLevelName = (typeof LOG_LEVELS)[number];

/**
 * Coerces common truthy/falsy string representations into a boolean.
 * Accepts: true/false, 1/0, yes/no, on/off (case-insensitive).
 */
function toBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

/**
 * Strongly-typed, validated representation of the process environment.
 * Validation runs once at bootstrap so misconfiguration fails fast.
 */
export class EnvironmentVariables {
  @IsString()
  @IsNotEmpty({ message: 'VENICE_API_KEY is required.' })
  VENICE_API_KEY!: string;

  @Transform(({ value }) => (value === undefined || value === '' ? 4337 : Number(value)))
  @IsInt()
  @Min(1)
  @Max(65535)
  PORT: number = 4337;

  @Transform(({ value }) => (value === undefined || value === '' ? '0.0.0.0' : String(value)))
  @IsString()
  @IsNotEmpty()
  HOST: string = '0.0.0.0';

  @Transform(({ value }) => (value === undefined || value === '' ? 1_800_000 : Number(value)))
  @IsInt()
  @Min(0)
  SESSION_TTL_MS: number = 1_800_000;

  @Transform(({ value }) => toBoolean(value, true))
  @IsBoolean()
  VERIFY_ATTESTATION: boolean = true;

  @Transform(({ value }) => toBoolean(value, true))
  @IsBoolean()
  VERIFY_DCAP: boolean = true;

  @Transform(({ value }) => toBoolean(value, true))
  @IsBoolean()
  VERIFY_GPU_ATTESTATION: boolean = true;

  @Transform(({ value }) => (value === undefined || value === '' ? undefined : String(value)))
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  DCAP_PCCS_URL?: string;

  @Transform(({ value }) =>
    value === undefined || value === '' ? 'https://api.venice.ai' : String(value),
  )
  @IsString()
  @IsNotEmpty()
  BASE_URL: string = 'https://api.venice.ai';

  // Max request body size accepted by the proxy. Chat payloads can be large
  // (long histories, base64 image data URLs), so the default is well above
  // Express's 100kb. Accepts any `bytes`-compatible string (e.g. "25mb").
  @Transform(({ value }) => (value === undefined || value === '' ? '25mb' : String(value).trim()))
  @IsString()
  @IsNotEmpty()
  MAX_BODY_SIZE: string = '25mb';

  @Transform(({ value }) =>
    value === undefined || value === '' ? 'info' : String(value).trim().toLowerCase(),
  )
  @IsIn(LOG_LEVELS)
  LOG_LEVEL: LogLevelName = 'info';
}

/**
 * Validation function wired into `@nestjs/config`. Throws a descriptive error
 * (and prevents startup) when required variables are missing or malformed.
 */
export function validateEnv(config: Record<string, unknown>): EnvironmentVariables {
  const validated = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: false,
  });

  const errors = validateSync(validated, {
    skipMissingProperties: false,
    whitelist: false,
  });

  if (errors.length > 0) {
    const messages = errors
      .map((error) => Object.values(error.constraints ?? {}).join(', '))
      .filter(Boolean)
      .join('\n  - ');
    throw new Error(`Invalid environment configuration:\n  - ${messages}`);
  }

  return validated;
}
