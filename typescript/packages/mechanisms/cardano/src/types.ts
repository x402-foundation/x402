/**
 * Who broadcasts the signed transaction. Declared by the server in
 * `PaymentRequirements.extra.submissionPolicy`; `either` lets the client pick.
 */
export type CardanoSubmissionPolicy = "server" | "client" | "either";

/**
 * The mode a paid payload actually selected. An absent `payload.submissionMode`
 * normalizes to `server`; `either` is a policy and never a payload mode.
 */
export type CardanoSubmissionMode = "server" | "client";

/**
 * Ledger a Masumi payment settles on. Carried by `payload.settlementLayer`.
 */
export type CardanoSettlementLayer = "l1" | "hydra";

/**
 * Minimum L1 evidence required before the resource is released.
 *
 * `-1` is authenticated mempool acceptance, `0` is inclusion in a canonical
 * block, and `1..20` requires that many newer canonical blocks. Greater
 * evidence satisfies a lower threshold.
 */
export interface CardanoConfirmationPolicy {
  l1Confirmations: number;
}

/**
 * Payload structure carried inside a Cardano `exact` PaymentPayload.
 *
 * The `transaction` field is a base64-encoded, fully signed Cardano CBOR
 * transaction. The `nonce` field is a UTXO reference (`txHashHex#index`) that
 * MUST also appear as one of the transaction inputs. The facilitator uses the
 * nonce to enforce uniqueness and replay protection (rule 5 in the spec).
 */
export type ExactCardanoPayload = {
  /**
   * Base64 encoded fully signed Cardano transaction (CBOR).
   */
  transaction: string;
  /**
   * UTXO reference (`txHash#index`) used as nonce, must be present as a tx input.
   */
  nonce: string;
  /**
   * Who broadcasts. Absent normalizes to `server`; the normalized value MUST be
   * allowed by the selected `extra.submissionPolicy`.
   */
  submissionMode?: CardanoSubmissionMode;
  /**
   * Masumi only: the ledger this payment settles on. `terms.settlementPolicy`
   * MUST allow the selected value.
   */
  settlementLayer?: CardanoSettlementLayer;
  /**
   * Masumi + Hydra only: the canonical lowercase 56-character hexadecimal Hydra
   * protocol head id from the on-chain Init transaction. MUST be absent for L1.
   */
  headId?: string;
};

/**
 * Fields every Cardano `extra` block may carry, whatever the transfer method.
 */
export interface CardanoExtraPolicies {
  /**
   * Who broadcasts the signed transaction. Defaults to `server` when absent.
   */
  submissionPolicy?: CardanoSubmissionPolicy;
  /**
   * Minimum L1 evidence. Defaults to `{ l1Confirmations: 1 }` when absent.
   */
  confirmationPolicy?: CardanoConfirmationPolicy;
  /**
   * Whether the facilitator pays the network fee. Always `false` on Cardano:
   * the client builds and signs the whole transaction, so the fee is balanced
   * against its own inputs. Copied from the facilitator's `/supported` entry.
   */
  areFeesSponsored?: boolean;
}

/**
 * Common (default) `extra` shape for Cardano payment requirements.
 *
 * The default assetTransferMethod is the address-to-address flow described in
 * the spec — `extra` may be empty or carry caller-defined metadata.
 */
export interface CardanoExtraDefault extends CardanoExtraPolicies {
  /**
   * Free-form metadata. Implementations MUST tolerate unknown keys.
   */
  [key: string]: unknown;
  /**
   * Optional explicit method marker. Defaults to "default" when missing.
   */
  assetTransferMethod?: "default";
}

/**
 * One part of the Masumi request commitment. `partBytes` is
 * `UTF-8(RFC8785-JCS(content))` for `jcs` and `base64url-decode(content)` for
 * `raw`; `digest` is their lowercase hex SHA-256.
 *
 * `content` is REQUIRED only for parts the issuer originates. It is OPTIONAL
 * for parts derived from the client's own request bytes, which the client
 * recomputes from what it sent — the manifest excludes `content` by
 * construction, so omitting it on the wire does not change `inputHash`.
 */
export interface MasumiCommitmentPart {
  /** Unique non-empty part name (conventionally `parameters`, `body`, `raw`). */
  name: string;
  /** How `content` is turned into bytes. */
  canonicalization: "jcs" | "raw";
  /** Optional media type, preserved byte-for-byte in the manifest. */
  mediaType?: string;
  /** RFC 8785-compatible JSON for `jcs`, unpadded base64url string for `raw`. */
  content?: unknown;
  /** Lowercase hex `SHA-256(partBytes)`, exactly 64 characters. */
  digest: string;
}

/**
 * The Masumi request commitment. Its `digest` is what the escrow's `input_hash`
 * binds the locked funds to, tying the payment to exactly the job requested.
 */
export interface MasumiInputCommitment {
  /** Literal `"1"`. */
  version: string;
  /** Literal `"sha256"`. */
  algorithm: string;
  /** Ordered parts with unique `name` values. */
  parts: MasumiCommitmentPart[];
  /** Lowercase hex digest over the content-free manifest; equals `terms.inputHash`. */
  digest: string;
}

/**
 * The seller-signed terms. Projected into `signedTerms` together with the
 * top-level `PaymentRequirements` fields and hashed into `termsDigest`, which
 * the seller authorizes with a CIP-8 `COSE_Sign1`.
 *
 * This is a **closed object**: an unknown field is invalid, and it MUST NOT
 * repeat a field that is projected from the top level.
 */
export interface MasumiTerms {
  /** Literal `"1"`. */
  version: string;
  /** Literal `"Web3CardanoV2"` — selects the contract generation. */
  paymentType: string;
  /** Key-credential seller address on the selected network; datum `seller`. */
  sellerAddress: string;
  /**
   * Optional key-credential payout address; datum `seller_return_address`.
   * **Omitted** when absent — JSON `null` is invalid.
   */
  sellerReturnAddress?: string;
  /** Exactly 32 fresh cryptographically random bytes as 64 lowercase hex characters. */
  sellerNonce: string;
  /** Empty string, or 7–13 bytes as 14–26 lowercase hex characters. */
  buyerNonce: string;
  /**
   * Registry asset identifier. Omitted, `null` or empty means the seller is
   * unregistered; these are distinct signed wire values and MUST be
   * reconstructed verbatim into `signedTerms`.
   */
  agentIdentifier?: string | null;
  /** Exactly equal to `inputCommitment.digest`. */
  inputHash: string;
  /** POSIX millisecond deadlines as positive canonical base-10 strings. */
  payByTime: string;
  submitResultTime: string;
  unlockTime: string;
  externalDisputeUnlockTime: string;
  /** Which ledger the payment may settle on. */
  settlementPolicy: "auto" | "l1" | "hydra";
}

/**
 * Validator parameters baked into the escrow script hash. Omit for the
 * canonical deployment; when present they replace **only** these three applied
 * parameters against the same canonical compiled validator.
 */
export interface MasumiDeployment {
  /** Positive canonical base-10 integer string, at most `adminVkeys.length`. */
  requiredAdmins: string;
  /**
   * Ordered non-empty 28-byte lowercase hex key hashes. Duplicates are
   * preserved and carry voting weight — a key appearing *n* times counts *n*
   * times toward the threshold.
   */
  adminVkeys: string[];
  /** Non-negative canonical base-10 POSIX-millisecond integer string. */
  cooldownPeriod: string;
}

/**
 * `extra` shape for the Masumi assetTransferMethod — everything a client needs
 * to build the `vested_pay` escrow lock and a facilitator needs to verify it.
 *
 * This is a **closed object**: an unknown field is invalid. `payTo` is not
 * repeated here; it is signed into `signedTerms` as `contractAddress` and the
 * verifier re-derives the escrow address from {@link MasumiDeployment} and
 * requires it to equal `payTo`. `collateral_return_lovelace` is deliberately
 * absent — the client computes it from the final transaction (see the spec's
 * "Escrow datum and client-computed collateral").
 */
export interface CardanoExtraMasumi extends CardanoExtraPolicies {
  /**
   * Method marker selecting Masumi semantics.
   */
  assetTransferMethod: "masumi";
  /**
   * The request commitment whose digest equals `terms.inputHash`.
   */
  inputCommitment: MasumiInputCommitment;
  /**
   * The seller-signed terms.
   */
  terms: MasumiTerms;
  /**
   * Complete CBOR `COSE_Key` as lowercase hex; datum `reference_key`.
   */
  referenceKey: string;
  /**
   * Complete CBOR `COSE_Sign1` as lowercase hex; datum `reference_signature`.
   */
  referenceSignature: string;
  /**
   * Lowercase hex of the LZString-compressed Masumi compatibility identifier.
   */
  blockchainIdentifier: string;
  /**
   * Optional non-canonical validator parameterization. Preview has no canonical
   * default and therefore requires this field.
   */
  deployment?: MasumiDeployment;
}

/**
 * Plutus script descriptor used in the script assetTransferMethod.
 */
export interface CardanoScriptDescriptor {
  /**
   * The script type: only Plutus script types are valid.
   */
  type: "plutusV1" | "plutusV2" | "plutusV3";
  /**
   * Hex-encoded script bytes.
   */
  code: string;
}

/**
 * One parameter applied to a Plutus script during transaction building.
 */
export interface CardanoScriptParameter {
  /**
   * The PlutusData primitive type.
   */
  type: "bytes" | "bigint" | "integer" | "string" | "constr" | "list" | "map" | "boolean";
  /**
   * The parameter value. Encoding is `type`-specific.
   */
  value: unknown;
}

/**
 * `extra` shape for the script assetTransferMethod.
 */
export interface CardanoExtraScript extends CardanoExtraPolicies {
  /**
   * Free-form additional metadata.
   */
  [key: string]: unknown;
  /**
   * Method marker selecting script semantics.
   */
  assetTransferMethod: "script";
  /**
   * Hash of the script as published on-chain (optional if `script` is inlined).
   */
  scriptHash?: string;
  /**
   * Inlined script body (optional if `scriptHash` is provided).
   */
  script?: CardanoScriptDescriptor;
  /**
   * Parameters that are applied to the script during transaction building.
   * Maps parameter name to its value descriptor.
   */
  parameters?: Record<string, CardanoScriptParameter>;
  /**
   * Optional Plutus datum (CBOR hex) to attach to the `payTo` output as an
   * INLINE datum. Supply this to lock funds into a contract that requires a
   * datum — the script method is fully general and not tied to any specific
   * contract, so the datum is whatever the target validator expects.
   *
   * The facilitator does NOT verify the datum's contents: it is arbitrary and
   * contract-specific, so only the server that defined the contract can judge
   * its correctness. A datum the target validator does not accept strands the
   * locked funds, so providing a correct datum is the server's responsibility.
   * Omit for scripts that spend without a datum (e.g. a PlutusV3 validator
   * written for the `None` case). Inline only — datum-hash outputs (required to
   * later spend a PlutusV1 script) are out of scope for this method.
   */
  datum?: string;
}

/**
 * Discriminated union of every supported `extra` shape for Cardano.
 */
export type CardanoExtra = CardanoExtraDefault | CardanoExtraMasumi | CardanoExtraScript;

/**
 * Lightweight description of a UTXO output kept in flight memory so that the
 * facilitator can perform input/asset checks without depending on a particular
 * Cardano SDK type.
 */
export interface CardanoUtxoOutput {
  /**
   * The bech32 payment address that owns this UTXO.
   */
  address: string;
  /**
   * Quantity of lovelace (ADA) attached to the UTXO.
   */
  coin: bigint;
  /**
   * Map of `policyId.assetNameHex` -> quantity for native tokens.
   */
  assets: Record<string, bigint>;
  /**
   * CBOR hex of the output's inline datum, when present. Used by the facilitator
   * to verify script/escrow payments (e.g. the Masumi lock datum).
   */
  datum?: string;
  /**
   * Byte length of the CBOR-serialized output. Used by the facilitator to check
   * the output satisfies the protocol min-UTXO. Present for decoded transactions.
   */
  serializedSize?: number;
  /**
   * True when the output carries a reference script (`script_ref`). The Masumi
   * escrow output must not — a set one is treated as a spoofing attempt.
   */
  hasReferenceScript?: boolean;
}

/**
 * Decoded view of the relevant fields from a Cardano transaction body.
 *
 * Used by the facilitator's verifier so the heavy CBOR decoding lives in one
 * place behind a stable shape.
 */
export interface DecodedCardanoTransaction {
  /**
   * Hex-encoded transaction hash (BLAKE2b-256 of the body).
   */
  txHash: string;
  /**
   * Network ID embedded in the transaction body (1 = mainnet, 0 = testnet),
   * or `undefined` if absent.
   */
  networkId?: number;
  /**
   * TTL slot number, or `undefined` if no TTL is set.
   */
  ttlSlot?: bigint;
  /**
   * `validityStart` slot number (lower bound), or `undefined` if absent.
   */
  validityStartSlot?: bigint;
  /**
   * Transaction inputs as ordered UTXO references (`txHashHex#index`).
   */
  inputs: string[];
  /** Transaction fee in lovelace. */
  fee: bigint;
  /**
   * Balance-changing operations outside a plain payment. The reference
   * facilitator rejects these before server submission because it cannot
   * prove value conservation from payment inputs and outputs alone.
   */
  unsupportedPhase1Operations: string[];
  /**
   * Decoded outputs in declaration order.
   */
  outputs: CardanoUtxoOutput[];
  /**
   * Number of vkey + bootstrap witnesses present in the transaction. Used by
   * the facilitator to refuse unsigned transactions in `verify()`.
   */
  vkeyWitnessCount: number;
  /**
   * Lowercase hex of every vkey witness public key, so the verifier can confirm
   * the buyer credential named by a Masumi datum actually witnessed the tx.
   */
  vkeyHashes: string[];
  /**
   * Number of script witnesses (native + plutus) present. A script-mode
   * payment must carry at least one redeemer; for default/Masumi payments
   * either vkey or bootstrap witnesses suffice.
   */
  scriptWitnessCount: number;
  /**
   * Number of Plutus redeemers. Only a transaction that runs a Plutus script
   * can be phase-2 invalid, so a payment with none can never land as a
   * failed-script transaction that creates no outputs.
   */
  redeemerCount: number;
  /**
   * True when every vkey witness carries a valid Ed25519 signature over the
   * transaction body hash. False signals a forged or stale signature that the
   * chain would reject at submission.
   */
  signaturesValid: boolean;
  /**
   * The transaction's ledger `is_valid` flag. When `false` the transaction is a
   * *failed script* transaction: the ledger consumes its collateral instead of
   * its inputs and creates **none** of its declared outputs — so the payment
   * output it advertises never exists, even though the transaction lands under
   * this exact transaction id.
   */
  isValid: boolean;
  /**
   * Index of the auxiliary data hash, if any (kept for parity with future
   * additions; unused today).
   */
  auxiliaryDataHash?: string;
}
