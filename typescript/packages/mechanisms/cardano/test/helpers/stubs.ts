/**
 * Shared deterministic test stubs for the Cardano integration and e2e suites.
 *
 * These drive the real client→facilitator scheme logic with REAL signed CBOR
 * transactions (via {@link buildSignedTx}) but an in-memory chain layer, so the
 * full flow runs without funds or network access.
 */
import {
  Address,
  Client,
  EnterpriseAddress,
  PlutusV3,
  preprod,
  PrivateKey,
  ScriptHash,
} from "@evolution-sdk/evolution";
import type { Network, PaymentRequirements } from "@x402/core/types";

import {
  ASSET_TRANSFER_METHOD_MASUMI,
  ASSET_TRANSFER_METHOD_SCRIPT,
  CARDANO_PREPROD_CAIP2,
  LOVELACE_ASSET,
} from "../../src/constants";
import { buildMasumiLock } from "../../src/exact/masumi/lock";
import { validateMasumiExtra } from "../../src/exact/masumi/schema";
import { buildScriptDatumInline } from "../../src/exact/script/datum";
import type { ClientCardanoSigner, FacilitatorCardanoSigner } from "../../src/signer";
import type { CardanoExtraScript } from "../../src/types";
import { decodeCardanoTransaction } from "../../src/utils";
import { buildSignedTx, getFixtureInputSnapshot } from "./buildSignedTx";

/** `coinsPerUtxoByte` used by the offline fixtures (current mainnet value). */
export const STUB_COINS_PER_UTXO_BYTE = 4310n;

/** One buyer wallet per process, so every stub Masumi lock names the same buyer. */
const STUB_BUYER_MNEMONIC = PrivateKey.generateMnemonic();

/**
 * The bech32 address of the wallet {@link stubClientSigner} uses for Masumi
 * locks. The datum names it as `buyer`, so the facilitator's `getUtxo` stub must
 * report it as the nonce UTXO's owner.
 *
 * @returns The buyer bech32 address.
 */
export async function stubBuyerAddress(): Promise<string> {
  return Address.toBech32(
    await Client.make(preprod).withSeed({ mnemonic: STUB_BUYER_MNEMONIC }).address(),
  );
}

/** Network used across the deterministic suites. */
export const NETWORK: Network = CARDANO_PREPROD_CAIP2;

/**
 * Current slot reported by the stub chain layer. Derived from the real clock so
 * fixtures stay consistent with wall-clock-based logic (TTL retention windows,
 * Masumi deadlines) instead of drifting into the past as time passes.
 */
export const STUB_CURRENT_SLOT =
  preprod.slotConfig.zeroSlot +
  BigInt(
    Math.floor((Date.now() - Number(preprod.slotConfig.zeroTime)) / preprod.slotConfig.slotLength),
  );

/**
 * TTL slot ahead of {@link STUB_CURRENT_SLOT} but still inside the fixtures'
 * 600-second `maxTimeoutSeconds`, so it satisfies rule 7's upper bound. Preprod
 * slots are one second long.
 */
export const TTL_SLOT = STUB_CURRENT_SLOT + 300n;

/** Fixed nonce UTXO reference forced into every fixture transaction. */
export const NONCE_REF = `${"a".repeat(64)}#0`;

/** Address the stub chain layer reports as the nonce UTXO owner (the payer). */
export const PAYER_ADDRESS = "addr_test1vpfacilitatorpayerplaceholder";

/**
 * Mints a fresh, valid bech32 preprod address offline (no provider, no funds).
 *
 * @returns A bech32 `addr_test1...` address.
 */
export async function freshPreprodAddress(): Promise<string> {
  const client = Client.make(preprod).withSeed({ mnemonic: PrivateKey.generateMnemonic() });
  return Address.toBech32(await client.address());
}

/**
 * In-memory facilitator chain layer. Reports the nonce UTXO as unspent, a
 * current slot below the fixture TTL, and confirmed submission. Intentionally
 * omits `evaluateTransaction` so verify() does not attempt a node dry-run.
 *
 * @param overrides - Per-test overrides (e.g. spent nonce, advanced slot).
 * @returns A facilitator signer stub.
 */
export function stubFacilitatorSigner(
  overrides: Partial<FacilitatorCardanoSigner> = {},
): FacilitatorCardanoSigner {
  // A transaction only becomes evidence once it has been submitted, exactly as
  // on a real chain. A stub that reported every transaction as already included
  // would silently disable the checks that only apply before acceptance.
  const submitted = new Set<string>();
  return {
    getAddresses: () => [PAYER_ADDRESS],
    getUtxo: async ref => getFixtureInputSnapshot(ref) ?? { exists: true, address: PAYER_ADDRESS },
    // Fixtures are built by the real transaction builder. Model the complete
    // ledger preflight that production server-submission signers must provide.
    validatePhase1Transaction: async () => undefined,
    getCurrentSlot: async () => STUB_CURRENT_SLOT,
    submitTransaction: async transaction => {
      const { txHash } = decodeCardanoTransaction(transaction);
      submitted.add(txHash);
      return { txHash, status: "confirmed" };
    },
    // One newer canonical block: satisfies the default confirmationPolicy.
    getTransactionEvidence: async txHash =>
      submitted.has(txHash)
        ? { status: "confirmed", confirmations: 1 }
        : { status: "unknown", confirmations: -2 },
    ...overrides,
  };
}

/**
 * Builds a real signed Masumi escrow lock offline, exactly as the reference
 * client signer would: the buyer controls the nonce input, the datum comes from
 * the seller-signed terms, and the escrow output carries precisely
 * `requestedLovelace + collateral`.
 *
 * Exposed so a test can build a *second, different* lock for the same 402 (by
 * varying the nonce) and exercise the Masumi logical-replay guard.
 *
 * @param extra - The masumi `extra` block from the requirements.
 * @param network - The x402 Cardano network identifier.
 * @param payTo - The escrow address.
 * @param asset - The requested asset unit.
 * @param amount - The requested amount.
 * @param nonceUtxoRef - The UTXO reference to consume as nonce.
 * @returns The base64 transaction and its nonce.
 */
export async function buildStubMasumiLockTx(
  extra: Record<string, unknown>,
  network: string,
  payTo: string,
  asset: string,
  amount: bigint,
  nonceUtxoRef: string,
): Promise<{ transaction: string; nonce: string }> {
  const schema = validateMasumiExtra(extra, network);
  if (!schema.ok) throw new Error(`invalid masumi extra: ${schema.detail}`);
  const buyer = await stubBuyerAddress();
  const lock = buildMasumiLock(schema.extra, buyer, asset, amount, STUB_COINS_PER_UTXO_BYTE);
  const built = await buildSignedTx({
    payTo,
    asset,
    amount,
    nonceUtxoRef,
    ttlSlot: TTL_SLOT,
    network,
    datum: lock.datum,
    outputLovelace: lock.lockedLovelace,
    mnemonic: STUB_BUYER_MNEMONIC,
    fundingLovelace: lock.lockedLovelace + 10_000_000n,
  });
  return { transaction: built.transaction, nonce: built.nonce };
}

/**
 * Client signer stub that produces a real signed CBOR transaction offline via
 * {@link buildSignedTx}, so the full client→server→facilitator flow runs
 * without funds or network.
 *
 * @returns A client signer stub.
 */
export function stubClientSigner(): ClientCardanoSigner {
  return {
    getAddress: () => PAYER_ADDRESS,
    buildAndSignPaymentTransaction: async input => {
      // Honor the script and masumi methods like the real signer does, so
      // full-flow tests exercise datum attachment through the stack.
      const extra = input.extra as { assetTransferMethod?: string } | undefined;
      const scriptDatum =
        extra?.assetTransferMethod === ASSET_TRANSFER_METHOD_SCRIPT
          ? buildScriptDatumInline(extra as CardanoExtraScript)
          : undefined;

      if (extra?.assetTransferMethod === ASSET_TRANSFER_METHOD_MASUMI) {
        const built = await buildStubMasumiLockTx(
          extra,
          input.network,
          input.payTo,
          input.asset,
          BigInt(input.amount),
          NONCE_REF,
        );
        return { ...built, submissionMode: input.submissionMode, settlementLayer: "l1" };
      }

      const built = await buildSignedTx({
        payTo: input.payTo,
        asset: input.asset,
        amount: BigInt(input.amount),
        nonceUtxoRef: NONCE_REF,
        ttlSlot: TTL_SLOT,
        network: input.network,
        ...(scriptDatum ? { datum: scriptDatum } : {}),
      });
      return {
        transaction: built.transaction,
        nonce: built.nonce,
        submissionMode: input.submissionMode,
      };
    },
  };
}

/**
 * Builds Cardano payment requirements for the deterministic suites.
 *
 * @param payTo - The recipient bech32 address.
 * @param amount - The amount in the asset's smallest unit.
 * @param asset - The asset unit (defaults to lovelace).
 * @param extra - The requirements `extra` block (defaults to empty).
 * @returns The payment requirements.
 */
export function buildRequirements(
  payTo: string,
  amount: string,
  asset: string = LOVELACE_ASSET,
  extra: Record<string, unknown> = {},
): PaymentRequirements {
  return {
    scheme: "exact",
    network: NETWORK,
    asset,
    amount,
    payTo,
    maxTimeoutSeconds: 600,
    extra,
  };
}

/** Minimal always-succeeds Plutus V3 script (raw flat-encoded bytes). */
export const MINIMAL_PLUTUS_V3 = "4d01000033222220051200120011";

/**
 * Derives the enterprise script address + hash for a raw Plutus script, so
 * tests can target a real script address without a network call.
 *
 * @param code - Raw flat-encoded Plutus script hex.
 * @param networkId - 0 for testnets (default), 1 for mainnet.
 * @returns The bech32 script address and its lowercase script hash hex.
 */
export function scriptAddressFor(
  code: string,
  networkId = 0,
): { address: string; scriptHash: string } {
  const script = new PlutusV3.PlutusV3({ bytes: Uint8Array.from(Buffer.from(code, "hex")) });
  const hash = ScriptHash.fromScript(script);
  const enterprise = new EnterpriseAddress.EnterpriseAddress({
    networkId,
    paymentCredential: hash,
  });
  return {
    address: Address.toBech32(enterprise),
    scriptHash: ScriptHash.toHex(hash).toLowerCase(),
  };
}
