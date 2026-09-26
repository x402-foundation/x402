/**
 * Injected ledger-access interfaces. The mechanism package carries the
 * PROTOCOL logic (payload codec, verify-before-sign, structural verify, settle
 * shape); all access to a Canton participant / Scan / registry is supplied by
 * the integrator through these interfaces. This keeps `@x402/canton` free of any
 * specific ledger client and free of operational concerns (rate-limits,
 * attribution, workers) that belong to a facilitator deployment, not the scheme.
 *
 * Mirrors the SVM mechanism's `ClientSvmSigner` / `FacilitatorSvmSigner` split.
 */

/** A live TransferPreapproval for a merchant (Amulet/Canton-Coin path). */
export interface PreapprovalView {
  receiver: string;
  /** Instrument admin the preapproval is scoped to (the DSO for Amulet). */
  dso: string;
  expiresAt: string;
  /** On-ledger app provider recorded on the preapproval, if any. */
  provider?: string;
  /** Not-yet-active before this instant, if present. */
  validFrom?: string;
}

/** Result of relaying the payer-signed transaction (ExecuteSubmission). */
export interface ExecuteResult {
  /** Canton updateId of the committed transaction. */
  updateId: string;
  /** Whether funds actually moved to the merchant (committed-zero-funds → false). */
  transferred: boolean;
  /** True when the funds-moved read could not be confirmed either way. */
  confirmInconclusive?: boolean;
}

/**
 * Client-side signer: the payer's self-custody key plus participant access to
 * resolve the transfer factory and interactive-prepare the transaction. The
 * client scheme verifies the returned bytes (verify-before-sign), then hands
 * THOSE EXACT bytes to `signPrepared`, which recomputes the hash from them and
 * signs it — so the payer never signs a hash it did not derive from a validated
 * transaction. This closes the "lying relay" hash-substitution attack: a relay
 * that returns honest bytes alongside the hash of a different, draining
 * transaction cannot get the payer's signature over that other hash.
 */
export interface ClientCantonSigner {
  /** The payer party this signer acts as. */
  readonly party: string;
  /**
   * Resolve the transfer factory and interactive-prepare a
   * `TransferFactory_Transfer` (sender = this party, receiver = payTo). Returns
   * the prepared transaction (base64). The hash is NOT returned here — it is
   * derived from these bytes inside `signPrepared`, so the value the payer signs
   * is bound to the bytes the client validated.
   */
  prepareTransfer(input: {
    receiver: string;
    /** Ledger Decimal amount string, e.g. "0.2500000000". */
    amount: string;
    instrumentId: { admin: string; id: string };
    executeBeforeSeconds: number;
    /** Optional `x402.memo` meta to stamp into the transfer. */
    memo?: string;
  }): Promise<{ preparedTransaction: string }>;
  /**
   * Recompute the Canton hash FROM these exact prepared-transaction bytes and
   * Ed25519-sign it with the payer's key. The hash MUST be derived from the
   * bytes passed in (never a relay-supplied value) — this is the hash binding
   * that protects the payer from a lying relay.
   *
   * @param preparedTransaction - The base64 prepared transaction the client validated.
   * @returns The hex hash actually signed, the base64 signature, and the hashing scheme.
   */
  signPrepared(preparedTransaction: string): Promise<{
    preparedTxHashHex: string;
    signatureB64: string;
    hashingSchemeVersion?: "HASHING_SCHEME_VERSION_V1" | "HASHING_SCHEME_VERSION_V2";
  }>;
}

/**
 * Facilitator-side signer + ledger capabilities. `verify` uses the read
 * capabilities; `settle` additionally relays via `executeSubmission`.
 */
export interface FacilitatorCantonSigner {
  /** Facilitator parties this deployment relays as (the `feePayer`). */
  getAddresses(): readonly string[];
  /**
   * Recompute the Canton hash from the prepared bytes, check it equals the
   * claimed hash, and verify the Ed25519 signature against the payer over it.
   */
  verifySignature(args: {
    preparedTransactionBytes: Buffer;
    claimedPreparedTxHash: string;
    signatureB64: string;
    payer: string;
    hashingSchemeVersion: string;
  }): Promise<{
    verified: boolean;
    preparedTxHashHex?: string;
    publishedProtocolKeys?: number;
  }>;
  /** Live Amulet TransferPreapproval for the merchant, or null. */
  fetchPreapproval(party: string): Promise<PreapprovalView | null>;
  /**
   * Authoritative current view of the payer's holdings (cid → ledger Decimal),
   * or undefined when this facilitator does not host the payer with read access.
   */
  fetchOwnedHoldingAmounts?(party: string): Promise<Map<string, string> | undefined>;
  /** Relay the payer-signed transaction (ExecuteSubmission). Settle only. */
  executeSubmission(args: {
    preparedTransactionBytes: Buffer;
    signatureB64: string;
    payer: string;
    hashingSchemeVersion: string;
    /** The transfer's instrument admin. Selects the funds-moved signal: an
     *  Amulet admin uses the archived-Amulet check, a registry admin (present in
     *  the deployment's tokenRegistries) uses the CIP-56 result-tag signal. */
    instrumentAdmin?: string;
  }): Promise<ExecuteResult>;
}

/** Trust anchors + registry config, supplied out-of-band (never relay-derived). */
export interface CantonSchemeConfig {
  /** Ceiling (seconds) on how far ahead the transfer's executeBefore may sit. */
  maxExecuteBeforeSeconds?: number;
  /** Which merchants this facilitator will burn its own traffic for. */
  merchantPolicy?: "open" | "provider" | "allowlist" | "provider-or-allowlist";
  merchantAllowlist?: readonly string[];
  /** Non-Amulet CIP-56 registries (instrument admin → DA Registry Utility base URL). */
  tokenRegistries?: Record<string, string>;
  /** Out-of-band-trusted registry infra parties (instrument admin → party[]). */
  registryTrustedParties?: Record<string, string[]>;
}
