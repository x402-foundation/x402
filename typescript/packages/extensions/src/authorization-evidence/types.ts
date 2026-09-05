/**
 * Authorization Evidence Extension Types
 *
 * Constants and interfaces for the authorization-evidence resource-server
 * extension: pre-payment verification of an operator-signed spend mandate
 * through an External Verifier Contract v1 (EVC) verifier.
 */

/** Extension key. */
export const AUTHORIZATION_EVIDENCE = "authorization-evidence";

/** Profile identifier advertised in the extension info. */
export const AUTHORIZATION_EVIDENCE_PROFILE = "authorization-evidence/0";

/** Default wall-clock timeout for one verifier run, in milliseconds. */
export const DEFAULT_VERIFIER_TIMEOUT_MS = 10_000;

/** Default bound on verifier stdout, in bytes. */
export const DEFAULT_VERIFIER_MAX_STDOUT_BYTES = 1_048_576;

/** Default lifetime of a minted challenge, in seconds. */
export const DEFAULT_CHALLENGE_TTL_SECONDS = 300;

/** The EVC section 9 denial-code registry, closed within wire version 1. */
export const EVC_DENIAL_CODES = new Set([
  "malformed_input",
  "unsupported_version",
  "invalid_bundle",
  "invalid_proof",
  "untrusted_root",
  "delegation_invalid",
  "invalid_signature",
  "request_mismatch",
  "model_mismatch",
  "unknown_capability",
  "scope_exceeded",
  "expired",
  "nonce_missing",
  "nonce_replayed",
  "internal_error",
]);

/** Verifier self-description classes (EVC section 3.5). */
export const EVC_VERIFIER_KINDS = new Set(["classical", "zk", "external"]);

/** Host fail-closed classification (EVC section 16.3). */
export type EvcFailureClass =
  | "nonzero_exit"
  | "timeout"
  | "signal_death"
  | "unparseable_stdout"
  | "multiple_objects"
  | "oversize_stdout"
  | "schema_invalid"
  | "replay"
  | "spawn_error";

/**
 * The host's closed decision for one verifier run: relay a schema-valid
 * verifier deny unchanged, or fail closed with the detected failure class.
 */
export type EvcDecision =
  | { decision: "allow" }
  | { decision: "deny"; code: string }
  | { decision: "deny"; failureClass: EvcFailureClass };

/** One nonce-reservation entry from an allow verdict (EVC section 3.2). */
export interface EvcNonceEntry {
  issuer_key: string;
  nonce: string;
  retain_until: number;
}

/**
 * Reserve-before-act nonce storage (EVC section 7.3). `reserve` must
 * atomically record every nonce and return false when ANY was already
 * present. The bundled in-memory store is per-process only; production
 * deployments should inject a shared durable implementation.
 */
export interface EvidenceNonceStore {
  reserve(nonces: string[], retainUntilUnix: number): boolean | Promise<boolean>;
}

/** Configuration for the bundled command-spawning EVC verifier adapter. */
export interface CommandVerifierOptions {
  /** argv of the verifier process; argv[0] is the executable. */
  command: string[];
  /** Wall-clock timeout the host enforces. Default {@link DEFAULT_VERIFIER_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** stdout bound the host enforces. Default {@link DEFAULT_VERIFIER_MAX_STDOUT_BYTES}. */
  maxStdoutBytes?: number;
}

/**
 * A pluggable evidence verifier. The bundled implementation spawns an EVC
 * verifier subprocess; alternatives (HTTP verifiers, in-process policy) can
 * implement the same closed-decision surface.
 */
export interface AuthorizationEvidenceVerifier {
  verify(request: unknown): Promise<EvcDecision>;
}

/** Route-declaration options for {@link declareAuthorizationEvidenceExtension}. */
export interface DeclareAuthorizationEvidenceOptions {
  /** Challenge lifetime in seconds. Default {@link DEFAULT_CHALLENGE_TTL_SECONDS}. */
  challengeTtlSeconds?: number;
}

/** The advertised extension info fields. */
export interface AuthorizationEvidenceInfo {
  /** Profile identifier, {@link AUTHORIZATION_EVIDENCE_PROFILE}. */
  profile: string;
  /** Fresh single-use signed challenge nonce, minted per response. */
  nonce?: string;
  /** Unix seconds after which the challenge is stale, minted per response. */
  expiresAt?: number;
  /** Client-added field: the opaque evidence presentation for this attempt. */
  evidence?: string;
}

/** The `{ info, schema }` payload attached under `extensions[AUTHORIZATION_EVIDENCE]`. */
export interface AuthorizationEvidenceExtension {
  info: AuthorizationEvidenceInfo;
  schema: object;
}

/** Route declaration produced by the declare helper. */
export interface AuthorizationEvidenceDeclaration extends AuthorizationEvidenceExtension {
  _options: DeclareAuthorizationEvidenceOptions;
}

/** Factory options for the resource-server extension. */
export interface AuthorizationEvidenceServerOptions {
  /**
   * The audience/payee identity this server authorizes for. The verifier
   * compares the mandate's signed audience against this value; the extension
   * additionally checks that it covers each requirement's `payTo`.
   */
  audience: string;
  /** The evidence verifier. Use `createCommandVerifier` for an EVC subprocess. */
  verifier: AuthorizationEvidenceVerifier;
  /** Binding program discriminator carried in the verifier request. Default "x402". */
  program?: string;
  /** Optional model pin carried in the verifier request. Default "*". */
  model?: string;
  /**
   * Map one payment requirement to the capability tokens the mandate must
   * cover. The default assumes a 1:1 USD stablecoin with 6 decimals and maps
   * to cumulative financial tiers: under $100 "mpp:financial:small", under
   * $10,000 "mpp:financial:medium", otherwise "mpp:financial:unlimited".
   */
  capabilitiesFor?: (requirement: PaymentRequirementLike) => string[];
  /**
   * Decide whether the configured audience covers a requirement's payee.
   * Default: byte-literal equality.
   */
  payeeMatches?: (audience: string, payTo: string) => boolean;
  /** Reserve-before-act nonce store. Default: bundled per-process store. */
  nonceStore?: EvidenceNonceStore;
  /**
   * Secret signing the stateless challenge nonces. Default: random per
   * process. Multi-instance deployments MUST share one secret so any
   * instance can validate any instance's challenge.
   */
  challengeSecret?: string;
  /** Clock override in unix seconds, for tests. */
  now?: () => number;
}

/** The subset of an x402 payment requirement the extension reads. */
export interface PaymentRequirementLike {
  network: string;
  asset: string;
  amount: string;
  payTo: string;
}
