import { parseArgs, type ParseArgsConfig } from 'node:util';

/** Maps a CLI flag (kebab-case) to its environment variable name. */
const CLI_ENV_MAP = {
  'venice-api-key': 'VENICE_API_KEY',
  port: 'PORT',
  host: 'HOST',
  'session-ttl-ms': 'SESSION_TTL_MS',
  'verify-attestation': 'VERIFY_ATTESTATION',
  'verify-dcap': 'VERIFY_DCAP',
  'verify-gpu-attestation': 'VERIFY_GPU_ATTESTATION',
  'dcap-pccs-url': 'DCAP_PCCS_URL',
  'base-url': 'BASE_URL',
  'max-body-size': 'MAX_BODY_SIZE',
  'log-level': 'LOG_LEVEL',
} as const;

type CliOption = keyof typeof CLI_ENV_MAP;

const PARSE_CONFIG = {
  options: {
    'venice-api-key': { type: 'string' },
    port: { type: 'string', short: 'p' },
    host: { type: 'string' },
    'session-ttl-ms': { type: 'string' },
    'verify-attestation': { type: 'string' },
    'verify-dcap': { type: 'string' },
    'verify-gpu-attestation': { type: 'string' },
    'dcap-pccs-url': { type: 'string' },
    'base-url': { type: 'string' },
    'max-body-size': { type: 'string' },
    'log-level': { type: 'string' },
    'no-verify-attestation': { type: 'boolean' },
    'no-verify-dcap': { type: 'boolean' },
    'no-verify-gpu-attestation': { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
  allowPositionals: false,
  strict: true,
} satisfies ParseArgsConfig;

const HELP_TEXT = `Venice E2EE Proxy — OpenAI-compatible proxy with end-to-end encryption for Venice.ai

Usage:
  venice-e2ee-proxy [options]
  npx @axlabs/venice-e2ee-proxy [options]

Options (CLI flags override environment variables and .env):
  --venice-api-key <key>       Venice API key (env: VENICE_API_KEY)
  -p, --port <port>            Port to listen on (default: 3000)
  --host <host>                Interface to bind (default: 0.0.0.0)
  --session-ttl-ms <ms>        E2EE session cache TTL in ms (default: 1800000)
  --verify-attestation <bool>  Verify TEE attestation (default: true)
  --no-verify-attestation      Disable TEE attestation verification
  --verify-dcap <bool>         Run full TDX DCAP verification (default: true)
  --no-verify-dcap             Disable DCAP verification
  --verify-gpu-attestation <bool>
                               Enforce GPU attestation (default: true)
  --no-verify-gpu-attestation  Disable GPU attestation enforcement
  --dcap-pccs-url <url>        PCCS server URL for DCAP collateral
  --base-url <url>             Venice API base URL (default: https://api.venice.ai)
  --max-body-size <size>       Max request body size (default: 25mb)
  --log-level <level>          error | warn | info | debug | verbose (default: info)
  -h, --help                   Show this help message

Examples:
  npx @axlabs/venice-e2ee-proxy --venice-api-key sk-... --port 8080
  npx @axlabs/venice-e2ee-proxy --venice-api-key sk-... --log-level debug --no-verify-dcap
`;

export interface CliParseResult {
  help: boolean;
}

/**
 * Parses CLI flags and writes them into `process.env`, overriding any existing
 * values. Call this before NestJS bootstraps so ConfigModule sees the merged
 * configuration. Unspecified flags are left unchanged (env / .env / defaults).
 */
export function applyCliConfig(argv: readonly string[] = process.argv.slice(2)): CliParseResult {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({ ...PARSE_CONFIG, args: argv });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid CLI arguments: ${message}\n\nRun with --help for usage.`);
  }

  const { values } = parsed;

  if (values.help) {
    return { help: true };
  }

  for (const [cliKey, envKey] of Object.entries(CLI_ENV_MAP)) {
    const value = values[cliKey as CliOption];
    if (value !== undefined) {
      process.env[envKey] = String(value);
    }
  }

  if (values['no-verify-attestation']) {
    process.env.VERIFY_ATTESTATION = 'false';
  }
  if (values['no-verify-dcap']) {
    process.env.VERIFY_DCAP = 'false';
  }
  if (values['no-verify-gpu-attestation']) {
    process.env.VERIFY_GPU_ATTESTATION = 'false';
  }

  return { help: false };
}

/** Prints CLI usage to stdout and exits with code 0. */
export function printCliHelp(): void {
  process.stdout.write(`${HELP_TEXT}\n`);
}
