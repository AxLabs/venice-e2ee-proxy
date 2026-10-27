import { randomBytes } from 'node:crypto';
import { Injectable, Logger, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import type {
  createVeniceE2EE,
  E2EESession,
  E2EEMessage,
  EncryptedPayload,
  DecryptedStreamEvent,
  AttestationResult,
  AttestationResponse,
  DcapVerifier,
} from '@axlabs/venice-e2ee';
import { AppConfigService } from '../config/app-config.service';
import { VeniceHttpService } from '../common/venice/venice-http.service';

type VeniceE2EE = ReturnType<typeof createVeniceE2EE>;
type VeniceE2EEModule = typeof import('@axlabs/venice-e2ee');

/** Shape of the `@axlabs/venice-e2ee/dcap` subpath export (typed manually to avoid
 * subpath module resolution requirements under classic Node resolution). */
interface VeniceDcapModule {
  createDcapVerifier: (pccsUrl?: string) => DcapVerifier;
}

/**
 * `import()` that survives TypeScript's CommonJS down-leveling. `@axlabs/venice-e2ee`
 * is an ESM-only package; a normal `import`/`require` would be rewritten to
 * `require()` and fail at runtime. Wrapping it in `new Function` keeps a true
 * dynamic `import()` in the emitted output.
 */
const importEsm = new Function('specifier', 'return import(specifier);') as <T>(
  specifier: string,
) => Promise<T>;

export type { E2EESession, DecryptedStreamEvent, AttestationResult };

/**
 * Wrapper around the `@axlabs/venice-e2ee` library. Owns the single E2EE instance,
 * lazily loads the ESM module, and exposes a typed, NestJS-friendly surface
 * for session creation, encryption, and stream decryption.
 */
@Injectable()
export class E2eeService implements OnModuleInit {
  private readonly logger = new Logger(E2eeService.name);
  private client?: VeniceE2EE;

  /** Per-model expiry (ms epoch) of a passing GPU attestation check. */
  private readonly gpuAttestationCache = new Map<string, number>();

  /** Last observed client ephemeral public key per model (to detect session reuse). */
  private readonly sessionPubKeyByModel = new Map<string, string>();

  constructor(
    private readonly config: AppConfigService,
    private readonly venice: VeniceHttpService,
  ) {}

  async onModuleInit(): Promise<void> {
    const mod = await importEsm<VeniceE2EEModule>('@axlabs/venice-e2ee');
    const dcapVerifier = await this.loadDcapVerifier();

    this.client = mod.createVeniceE2EE({
      apiKey: this.config.veniceApiKey,
      baseUrl: this.config.baseUrl,
      sessionTTL: this.config.sessionTtlMs,
      verifyAttestation: this.config.verifyAttestation,
      dcapVerifier,
    });

    this.logger.log(
      `@axlabs/venice-e2ee initialized (baseUrl=${this.config.baseUrl}, ` +
        `verifyAttestation=${this.config.verifyAttestation}, ` +
        `fullDcapVerification=${dcapVerifier ? 'on' : 'off'}, ` +
        `verifyGpuAttestation=${this.config.verifyGpuAttestation}, ` +
        `sessionTTL=${this.config.sessionTtlMs}ms)`,
    );

    if (this.config.verifyDcap && !this.config.verifyAttestation) {
      this.logger.warn(
        'VERIFY_DCAP is enabled but VERIFY_ATTESTATION is disabled; DCAP verification ' +
          'only runs as part of attestation, so it will have no effect until attestation is enabled.',
      );
    }
  }

  /**
   * Loads the full TDX DCAP verifier from `@axlabs/venice-e2ee/dcap` (backed by
   * `@phala/dcap-qvl`). Enabled by default; controlled via `VERIFY_DCAP`.
   * A load failure is surfaced as a clear startup error rather than silently
   * downgrading the security posture.
   */
  private async loadDcapVerifier(): Promise<DcapVerifier | undefined> {
    if (!this.config.verifyDcap) {
      this.logger.warn('Full DCAP verification is disabled (VERIFY_DCAP=false).');
      return undefined;
    }

    try {
      const dcap = await importEsm<VeniceDcapModule>('@axlabs/venice-e2ee/dcap');
      const verifier = dcap.createDcapVerifier(this.config.dcapPccsUrl);
      this.logger.log(
        `Full DCAP verification enabled (PCCS: ${this.config.dcapPccsUrl ?? 'Phala default'}).`,
      );
      return verifier;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to initialize full DCAP verification: ${message}. ` +
          'Ensure "@phala/dcap-qvl" is installed, or set VERIFY_DCAP=false to disable it.',
      );
    }
  }

  private get instance(): VeniceE2EE {
    if (!this.client) {
      throw new ServiceUnavailableException('E2EE client is not initialized yet.');
    }
    return this.client;
  }

  /**
   * Creates (or reuses a cached) E2EE session for a model. Performs the TEE
   * attestation handshake and key exchange. Attestation/handshake failures are
   * surfaced as clear HTTP 503 errors.
   */
  async createSession(modelId: string): Promise<E2EESession> {
    await this.enforceGpuAttestation(modelId);
    this.logger.debug(
      `Creating/reusing E2EE session for "${modelId}" (TTL ${this.config.sessionTtlMs}ms)`,
    );
    try {
      const startedAt = Date.now();
      const session = await this.instance.createSession(modelId);

      // The client ephemeral keypair is generated per session and cached per
      // model for SESSION_TTL_MS — so a stable key here across requests means
      // the session was reused, not regenerated.
      const reused = this.sessionPubKeyByModel.get(modelId) === session.pubKeyHex;
      this.sessionPubKeyByModel.set(modelId, session.pubKeyHex);

      this.logger.debug(`Session ready for "${modelId}" in ${Date.now() - startedAt}ms`);
      this.logger.debug(
        `Client ephemeral public key for "${modelId}" ` +
          `(${reused ? 'reused cached session' : 'new session'}): ${session.pubKeyHex}`,
      );
      this.logger.debug(`TEE model public key for "${modelId}": ${session.modelPubKeyHex}`);

      this.logAttestation(modelId, session.attestation);
      return session;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to establish E2EE session for "${modelId}": ${message}`);
      throw new ServiceUnavailableException(
        `Could not establish a verified E2EE session for "${modelId}": ${message}`,
      );
    }
  }

  /**
   * Enforces NVIDIA GPU attestation **before** a session is established.
   * Enabled by default (`VERIFY_GPU_ATTESTATION`).
   *
   * IMPORTANT — what this does and does not do:
   *  - It fetches `/tee/attestation` directly, checks `verified === true`,
   *    confirms our fresh nonce (replay protection), and — when the model
   *    returns GPU evidence (`nvidia_payload`) — requires that Venice's
   *    server-side NVIDIA verification passed. If a GPU-backed model fails
   *    this, session creation fails closed (HTTP 503).
   *  - It does NOT perform *independent* client-side verification of the
   *    NVIDIA quote against NVIDIA's root of trust. No audited JS verifier
   *    exists today, and the library does not expose the raw GPU evidence to
   *    the session path. This gate therefore enforces Venice's GPU verdict; it
   *    is the natural insertion point for a future NRAS-based independent check.
   *
   * Results are cached per model for `SESSION_TTL_MS` to avoid re-fetching on
   * every request.
   */
  private async enforceGpuAttestation(modelId: string): Promise<void> {
    if (!this.config.verifyGpuAttestation) return;

    const now = Date.now();
    const cachedUntil = this.gpuAttestationCache.get(modelId);
    if (cachedUntil && cachedUntil > now) {
      this.logger.debug(
        `GPU attestation cache hit for "${modelId}" (valid ${cachedUntil - now}ms more)`,
      );
      return;
    }

    this.logger.debug(`GPU attestation: fetching fresh attestation for "${modelId}"`);
    const nonce = randomBytes(32).toString('hex'); // 32 bytes = 64 hex chars (required by Venice)
    const path = `/tee/attestation?model=${encodeURIComponent(modelId)}&nonce=${nonce}`;

    let attestation: AttestationResponse;
    try {
      const response = await this.venice.get(path);
      if (!response.ok) {
        await this.venice.throwUpstreamError(response, 'GPU attestation fetch');
      }
      attestation = (await response.json()) as AttestationResponse;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ServiceUnavailableException(
        `Could not fetch attestation to verify GPU for "${modelId}": ${message}`,
      );
    }

    if (attestation.verified !== true) {
      throw new ServiceUnavailableException(
        `Attestation for "${modelId}" did not pass Venice verification (verified=${String(
          attestation.verified,
        )}).`,
      );
    }
    if (attestation.nonce !== nonce) {
      throw new ServiceUnavailableException(
        `Attestation nonce mismatch for "${modelId}" (possible replay attack).`,
      );
    }

    const hasGpuEvidence =
      typeof attestation.nvidia_payload === 'string' && attestation.nvidia_payload.length > 0;
    const serverNvidia = attestation.server_verification?.nvidia;

    if (!hasGpuEvidence) {
      this.logger.warn(
        `No GPU attestation (nvidia_payload) present for "${modelId}"; cannot enforce GPU ` +
          'attestation (model may be CPU-only). Set VERIFY_GPU_ATTESTATION=false to silence this.',
      );
    } else if (serverNvidia && serverNvidia.valid !== true) {
      throw new ServiceUnavailableException(
        `GPU (NVIDIA) attestation for "${modelId}" is invalid: ${serverNvidia.error ?? 'unknown error'}.`,
      );
    } else {
      const basis = serverNvidia ? 'server nvidia.valid=true' : 'overall verified=true';
      this.logger.log(`GPU attestation enforced for "${modelId}" (Venice-verified: ${basis}).`);
    }

    this.gpuAttestationCache.set(modelId, now + this.config.sessionTtlMs);
  }

  /** Encrypts messages for an established session. Tool metadata is left in the clear. */
  async encrypt(messages: E2EEMessage[], session: E2EESession): Promise<EncryptedPayload> {
    this.logger.debug(`Encrypting ${messages.length} message(s) for "${session.modelId}"`);
    return this.instance.encrypt(messages, session);
  }

  /**
   * Decrypts a Venice SSE stream into content, tool-call, and finish events.
   * Tool-call deltas are not ciphertext.
   */
  decryptStream(
    body: ReadableStream<Uint8Array>,
    session: E2EESession,
  ): AsyncGenerator<DecryptedStreamEvent> {
    return this.instance.decryptStream(body, session);
  }

  /** Zeroizes the private key and clears the cached session. */
  clearSession(): void {
    this.client?.clearSession();
    this.gpuAttestationCache.clear();
    this.sessionPubKeyByModel.clear();
  }

  private logAttestation(modelId: string, attestation?: AttestationResult): void {
    if (!attestation) {
      this.logger.warn(`No attestation result returned for "${modelId}" (verification disabled?).`);
      return;
    }
    if (attestation.errors?.length) {
      this.logger.warn(
        `Attestation for "${modelId}" reported issues: ${attestation.errors.join('; ')}`,
      );
    } else {
      this.logger.log(`Attestation verified for "${modelId}".`);
    }

    if (attestation.dcap) {
      const advisories = attestation.dcap.advisoryIds?.length
        ? ` (advisories: ${attestation.dcap.advisoryIds.join(', ')})`
        : '';
      this.logger.log(
        `Full DCAP verification for "${modelId}": ${attestation.dcap.status}${advisories}.`,
      );
    }
  }
}
