import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyCliConfig, printCliHelp } from '../src/config/cli-args';

describe('applyCliConfig', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns help when --help is passed', () => {
    const result = applyCliConfig(['--help']);
    expect(result.help).toBe(true);
  });

  it('returns help for -h', () => {
    const result = applyCliConfig(['-h']);
    expect(result.help).toBe(true);
  });

  it('writes CLI values into process.env', () => {
    process.env.PORT = '3000';
    process.env.LOG_LEVEL = 'info';

    const result = applyCliConfig([
      '--venice-api-key',
      'cli-key',
      '--port',
      '8080',
      '--log-level',
      'debug',
    ]);

    expect(result.help).toBe(false);
    expect(process.env.VENICE_API_KEY).toBe('cli-key');
    expect(process.env.PORT).toBe('8080');
    expect(process.env.LOG_LEVEL).toBe('debug');
  });

  it('supports short -p for port', () => {
    applyCliConfig(['-p', '9000']);
    expect(process.env.PORT).toBe('9000');
  });

  it('applies --no-* negation flags after explicit boolean flags', () => {
    applyCliConfig(['--verify-attestation', 'true', '--no-verify-attestation']);
    expect(process.env.VERIFY_ATTESTATION).toBe('false');
  });

  it('throws on unknown flags', () => {
    expect(() => applyCliConfig(['--unknown-flag'])).toThrow(/Invalid CLI arguments/);
  });

  it('printCliHelp writes usage to stdout', () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    printCliHelp();
    expect(write).toHaveBeenCalledWith(expect.stringContaining('venice-e2ee-proxy'));
    write.mockRestore();
  });
});
