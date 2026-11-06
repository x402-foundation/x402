import { AddressEras, Data, InlineDatum, KeyHash, ScriptHash } from "@evolution-sdk/evolution";

/**
 * Codec for the Masumi `vested_pay` escrow lock datum (payment-v2 /
 * `Web3CardanoV2`). Builds the 19-field `Constr 0` datum for a fresh lock
 * (`state = FundsLocked`, empty `result_hash`, zero cooldowns) and parses it
 * back for facilitator verification. Encodings mirror the Masumi
 * `createInitialDatum` helper (`some`/`none`/`stateData`/`mPubKeyAddress`).
 */

/** A payment or stake credential extracted from an address or datum. */
export interface MasumiCredential {
  isScript: boolean;
  hash: string;
}

/** Address split into its payment + optional stake credentials. */
export interface MasumiAddressCredentials {
  payment: MasumiCredential;
  stake?: MasumiCredential;
  pointer?: MasumiPointer;
}

/** Legacy pointer stake reference carried by a Cardano pointer address. */
export interface MasumiPointer {
  slot: bigint;
  txIndex: bigint;
  certIndex: bigint;
}

/** Typed inputs required to build a fresh lock datum. */
export interface MasumiLockDatumInput {
  buyerAddress: string;
  sellerAddress: string;
  buyerReturnAddress?: string;
  sellerReturnAddress?: string;
  referenceKey: string;
  referenceSignature: string;
  sellerNonce: string;
  buyerNonce: string;
  agentIdentifier: string;
  collateralReturnLovelace: bigint;
  inputHash: string;
  payByTime: bigint;
  submitResultTime: bigint;
  unlockTime: bigint;
  externalDisputeUnlockTime: bigint;
}

/** Decoded view of a lock datum used by the facilitator. */
export interface MasumiDatumView {
  buyer: MasumiAddressCredentials;
  /** Optional payout address (`Some`) or `null` when the datum carries `None`. */
  buyerReturnAddress: MasumiAddressCredentials | null;
  seller: MasumiAddressCredentials;
  /** Optional payout address (`Some`) or `null` when the datum carries `None`. */
  sellerReturnAddress: MasumiAddressCredentials | null;
  referenceKey: string;
  referenceSignature: string;
  sellerNonce: string;
  buyerNonce: string;
  agentIdentifier: string;
  collateralReturnLovelace: bigint;
  inputHash: string;
  resultHash: string;
  payByTime: bigint;
  submitResultTime: bigint;
  unlockTime: bigint;
  externalDisputeUnlockTime: bigint;
  sellerCooldownTime: bigint;
  buyerCooldownTime: bigint;
  state: bigint;
}

/** The state constructor index for a fresh lock. */
export const MASUMI_STATE_FUNDS_LOCKED = 0n;

/**
 * Encodes a credential as Plutus data (`KeyHash` -> `Constr 0 [hash]`,
 * `ScriptHash` -> `Constr 1 [hash]`).
 *
 * @param cred - The credential to encode.
 * @returns The Plutus data credential.
 */
function credentialToData(cred: MasumiCredential): Data.Data {
  return Data.constr(cred.isScript ? 1n : 0n, [Data.bytearray(cred.hash)]);
}

/**
 * Encodes a bech32 address as a Plutus `Address` (`Constr 0 [payment, stakeOption]`).
 *
 * @param bech32 - The Cardano address.
 * @returns The Plutus data address.
 */
function addressToData(bech32: string): Data.Data {
  const creds = addressCredentials(bech32);
  const stakeOption = creds.stake
    ? Data.constr(0n, [Data.constr(0n, [credentialToData(creds.stake)])])
    : creds.pointer
      ? Data.constr(0n, [
          Data.constr(1n, [
            Data.int(creds.pointer.slot),
            Data.int(creds.pointer.txIndex),
            Data.int(creds.pointer.certIndex),
          ]),
        ])
      : Data.constr(1n, []);
  return Data.constr(0n, [credentialToData(creds.payment), stakeOption]);
}

/**
 * Encodes an optional address as `Some(address)` / `None`.
 *
 * @param bech32 - The optional Cardano address.
 * @returns `Constr 0 [address]` when present, else `Constr 1 []`.
 */
function optionAddressToData(bech32: string | undefined): Data.Data {
  return bech32 ? Data.constr(0n, [addressToData(bech32)]) : Data.constr(1n, []);
}

/**
 * Returns the lowercase hex of a payment/stake credential hash.
 *
 * @param cred - The `KeyHash` or `ScriptHash` credential.
 * @param cred._tag - The credential tag (`"KeyHash"` or `"ScriptHash"`).
 * @returns The credential hash as lowercase hex.
 */
function credentialHex(cred: { _tag: string }): string {
  const c = cred as unknown as KeyHash.KeyHash & ScriptHash.ScriptHash;
  return (cred._tag === "ScriptHash" ? ScriptHash.toHex(c) : KeyHash.toHex(c)).toLowerCase();
}

/**
 * Extracts the payment and (optional) stake credentials of a bech32 address.
 *
 * @param bech32 - The Cardano address.
 * @returns Its payment credential and, for base addresses, its stake credential.
 */
export function addressCredentials(bech32: string): MasumiAddressCredentials {
  const parsed = AddressEras.fromBech32(bech32);
  if (
    parsed._tag !== "BaseAddress" &&
    parsed._tag !== "EnterpriseAddress" &&
    parsed._tag !== "PointerAddress"
  ) {
    throw new Error("Masumi datum address must have a payment credential");
  }
  const payment = {
    isScript: parsed.paymentCredential._tag === "ScriptHash",
    hash: credentialHex(parsed.paymentCredential),
  };
  if (parsed._tag === "BaseAddress") {
    return {
      payment,
      stake: {
        isScript: parsed.stakeCredential._tag === "ScriptHash",
        hash: credentialHex(parsed.stakeCredential),
      },
    };
  }
  if (parsed._tag === "PointerAddress") {
    return {
      payment,
      pointer: {
        slot: BigInt(parsed.pointer.slot),
        txIndex: BigInt(parsed.pointer.txIndex),
        certIndex: BigInt(parsed.pointer.certIndex),
      },
    };
  }
  return { payment };
}

/**
 * Builds the Masumi lock datum (`Constr 0`, 19 fields) for a fresh lock.
 *
 * @param input - The datum field values.
 * @returns The Plutus data to attach as an inline datum on the escrow output.
 */
export function buildMasumiLockDatum(input: MasumiLockDatumInput): Data.Data {
  return Data.constr(0n, [
    addressToData(input.buyerAddress), // 0 buyer
    optionAddressToData(input.buyerReturnAddress), // 1 buyer_return_address
    addressToData(input.sellerAddress), // 2 seller
    optionAddressToData(input.sellerReturnAddress), // 3 seller_return_address
    Data.bytearray(input.referenceKey), // 4 reference_key
    Data.bytearray(input.referenceSignature), // 5 reference_signature
    Data.bytearray(input.sellerNonce), // 6 seller_nonce
    Data.bytearray(input.buyerNonce), // 7 buyer_nonce
    Data.bytearray(input.agentIdentifier), // 8 agent_identifier
    Data.int(input.collateralReturnLovelace), // 9 collateral_return_lovelace
    Data.bytearray(input.inputHash), // 10 input_hash
    Data.bytearray(""), // 11 result_hash (empty at lock)
    Data.int(input.payByTime), // 12 pay_by_time
    Data.int(input.submitResultTime), // 13 submit_result_time
    Data.int(input.unlockTime), // 14 unlock_time
    Data.int(input.externalDisputeUnlockTime), // 15 external_dispute_unlock_time
    Data.int(0n), // 16 seller_cooldown_time
    Data.int(0n), // 17 buyer_cooldown_time
    Data.constr(MASUMI_STATE_FUNDS_LOCKED, []), // 18 state = FundsLocked
  ]);
}

/**
 * Wraps Plutus data as an inline datum option for a transaction output.
 *
 * @param data - The datum to embed inline.
 * @returns The inline datum option.
 */
export function inlineDatum(data: Data.Data): InlineDatum.InlineDatum {
  return new InlineDatum.InlineDatum({ data });
}

/**
 * Reads a constructor node, or `null` when `d` is not a constructor.
 *
 * @param d - The Plutus data node.
 * @returns The `{ index, fields }` constructor, or `null`.
 */
function asConstr(d: Data.Data): { index: bigint; fields: Data.Data[] } | null {
  return Data.isConstr(d) ? (d as unknown as { index: bigint; fields: Data.Data[] }) : null;
}

/**
 * Reads an integer node, or `null` when `d` is not an integer.
 *
 * @param d - The Plutus data node.
 * @returns The bigint value, or `null`.
 */
function asInt(d: Data.Data): bigint | null {
  return Data.isInt(d) ? (d as unknown as bigint) : null;
}

/**
 * Reads a byte-string node as lowercase hex, or `null` when `d` is not bytes.
 *
 * @param d - The Plutus data node.
 * @returns The lowercase hex, or `null`.
 */
function asHex(d: Data.Data): string | null {
  return Data.isBytes(d)
    ? Buffer.from(d as unknown as Uint8Array)
        .toString("hex")
        .toLowerCase()
    : null;
}

/** Cardano payment/stake credential hashes are Blake2b-224: 28 bytes. */
const CREDENTIAL_HASH_HEX_LENGTH = 56;

/**
 * Decodes a Plutus credential (`Constr 0|1 [hash]`) into a typed credential.
 *
 * The hash length is enforced: `vested_pay` decodes the datum with a typed
 * `expect`, so a credential of any other size makes every later spend path fail
 * and permanently strands the escrow — after this facilitator has already
 * accepted the lock.
 *
 * @param d - The credential Plutus data.
 * @returns The credential, or `null` on a structural mismatch.
 */
function dataToCredential(d: Data.Data): MasumiCredential | null {
  const c = asConstr(d);
  if (!c || (c.index !== 0n && c.index !== 1n) || c.fields.length !== 1) return null;
  const hash = asHex(c.fields[0]);
  if (hash === null || hash.length !== CREDENTIAL_HASH_HEX_LENGTH) return null;
  return { isScript: c.index === 1n, hash };
}

/**
 * Decodes a Plutus `Address` into its payment and (optional) stake credentials.
 *
 * @param d - The address Plutus data.
 * @returns The address credentials, or `null` on a structural mismatch.
 */
function dataToAddress(d: Data.Data): MasumiAddressCredentials | null {
  const c = asConstr(d);
  if (!c || c.index !== 0n || c.fields.length !== 2) return null;
  const payment = dataToCredential(c.fields[0]);
  if (!payment) return null;
  const opt = asConstr(c.fields[1]);
  if (!opt) return null;
  if (opt.index === 1n) return opt.fields.length === 0 ? { payment } : null; // None
  if (opt.index !== 0n || opt.fields.length !== 1) return null;
  const stakeRef = asConstr(opt.fields[0]);
  if (!stakeRef) return null;
  if (stakeRef.index === 0n && stakeRef.fields.length === 1) {
    const stake = dataToCredential(stakeRef.fields[0]);
    return stake ? { payment, stake } : null;
  }
  if (stakeRef.index === 1n && stakeRef.fields.length === 3) {
    const slot = asInt(stakeRef.fields[0]);
    const txIndex = asInt(stakeRef.fields[1]);
    const certIndex = asInt(stakeRef.fields[2]);
    if (
      slot === null ||
      txIndex === null ||
      certIndex === null ||
      slot < 0n ||
      txIndex < 0n ||
      certIndex < 0n
    ) {
      return null;
    }
    return { payment, pointer: { slot, txIndex, certIndex } };
  }
  return null;
}

/**
 * Decodes an `Option<Address>` datum field (`Some(addr)` / `None`).
 *
 * @param d - The optional-address Plutus data.
 * @returns `{ value }` with the address credentials (`Some`) or `null` (`None`),
 *   or `null` on a structural mismatch.
 */
function dataToOptionAddress(d: Data.Data): { value: MasumiAddressCredentials | null } | null {
  const c = asConstr(d);
  if (!c) return null;
  if (c.index === 1n && c.fields.length === 0) return { value: null }; // None
  if (c.index !== 0n || c.fields.length !== 1) return null; // Some(addr)
  const addr = dataToAddress(c.fields[0]);
  return addr ? { value: addr } : null;
}

/**
 * Parses a Masumi lock datum (Plutus data or its CBOR hex) into a typed view.
 * Total: returns `null` when the structure does not match the 19-field datum.
 *
 * @param datum - The inline datum as Plutus data or CBOR hex.
 * @returns The decoded view, or `null` on a structural mismatch.
 */
export function parseMasumiLockDatum(datum: Data.Data | string): MasumiDatumView | null {
  let data: Data.Data;
  try {
    data = typeof datum === "string" ? Data.fromCBORHex(datum) : datum;
  } catch {
    return null;
  }
  const root = asConstr(data);
  if (!root || root.index !== 0n || root.fields.length !== 19) return null;
  const f = root.fields;

  const buyer = dataToAddress(f[0]);
  const buyerReturnAddress = dataToOptionAddress(f[1]);
  const seller = dataToAddress(f[2]);
  const sellerReturnAddress = dataToOptionAddress(f[3]);
  const referenceKey = asHex(f[4]);
  const referenceSignature = asHex(f[5]);
  const sellerNonce = asHex(f[6]);
  const buyerNonce = asHex(f[7]);
  const agentIdentifier = asHex(f[8]);
  const collateralReturnLovelace = asInt(f[9]);
  const inputHash = asHex(f[10]);
  const resultHash = asHex(f[11]);
  const payByTime = asInt(f[12]);
  const submitResultTime = asInt(f[13]);
  const unlockTime = asInt(f[14]);
  const externalDisputeUnlockTime = asInt(f[15]);
  const sellerCooldownTime = asInt(f[16]);
  const buyerCooldownTime = asInt(f[17]);
  // The state constructor carries no fields; `FundsLocked` is `Constr 0 []`.
  // Accepting `Constr 0 [junk]` would let through a datum the validator's typed
  // decode rejects on every later spend, stranding the escrow.
  const stateConstr = asConstr(f[18]);
  if (stateConstr !== null && stateConstr.fields.length !== 0) return null;

  if (
    !buyer ||
    !buyerReturnAddress ||
    !seller ||
    !sellerReturnAddress ||
    referenceKey === null ||
    referenceSignature === null ||
    sellerNonce === null ||
    buyerNonce === null ||
    agentIdentifier === null ||
    collateralReturnLovelace === null ||
    inputHash === null ||
    resultHash === null ||
    payByTime === null ||
    submitResultTime === null ||
    unlockTime === null ||
    externalDisputeUnlockTime === null ||
    sellerCooldownTime === null ||
    buyerCooldownTime === null ||
    !stateConstr
  ) {
    return null;
  }

  return {
    buyer,
    buyerReturnAddress: buyerReturnAddress.value,
    seller,
    sellerReturnAddress: sellerReturnAddress.value,
    referenceKey,
    referenceSignature,
    sellerNonce,
    buyerNonce,
    agentIdentifier,
    collateralReturnLovelace,
    inputHash,
    resultHash,
    payByTime,
    submitResultTime,
    unlockTime,
    externalDisputeUnlockTime,
    sellerCooldownTime,
    buyerCooldownTime,
    state: stateConstr.index,
  };
}
