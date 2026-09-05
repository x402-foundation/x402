/**
 * Canton client implementation of the `exact` scheme.
 *
 * The payer's participant resolves the transfer factory and interactive-prepares
 * the `TransferFactory_Transfer` (injected `ClientCantonSigner`). Before signing,
 * the client re-derives the transfer from the SIGNED bytes and pins it to caller
 * intent (verify-before-sign) — a malicious relay cannot get an unintended
 * transfer signed. The signed transaction then travels INLINE in the payload.
 */
import type { PaymentPayload, PaymentRequirements, SchemeNetworkClient } from "@x402/core/types";
import { assertPreparedTransferMatches } from "../../prepared-transfer.js";
import { encodeInlinePaymentPayload } from "../../inline-payload.js";
import { wireAmountToLedgerDecimal } from "../../amount.js";
import { findDefaultAsset } from "../../defaultAssets.js";
import type { ClientCantonSigner, CantonSchemeConfig } from "../../signer.js";

/** Client-side `exact` scheme for Canton networks. */
export class ExactCantonScheme implements SchemeNetworkClient {
  readonly scheme = "exact";
  findDefaultAsset = findDefaultAsset;

  /**
   * Construct the client-side Canton exact scheme.
   *
   * @param signer - The payer's key + participant access (resolve/prepare/sign).
   * @param config - Trust anchors / registry config (CIP-56 trusted parties).
   */
  constructor(
    private readonly signer: ClientCantonSigner,
    private readonly config: CantonSchemeConfig = {},
  ) {}

  /**
   * Build the inline payment payload for a Canton `exact` 402.
   *
   * @param x402Version - The x402 protocol version.
   * @param paymentRequirements - The merchant's payment requirements.
   * @returns The x402 payment payload carrying the payer-signed transfer inline.
   */
  async createPaymentPayload(
    x402Version: number,
    paymentRequirements: PaymentRequirements,
  ): Promise<Pick<PaymentPayload, "x402Version" | "payload">> {
    const extra = (paymentRequirements.extra ?? {}) as {
      instrumentId?: { admin?: string; id?: string };
      feePayer?: string;
      synchronizerId?: string;
      memo?: string;
      executeBeforeSeconds?: number;
    };

    const admin = extra.instrumentId?.admin;
    const id = extra.instrumentId?.id;
    if (!admin || !id) {
      throw new Error(
        "paymentRequirements.extra.instrumentId {admin,id} is required for the Canton exact scheme",
      );
    }

    // Wire amount is atomic integer units; the ledger transfer carries a Decimal.
    const amount = wireAmountToLedgerDecimal(
      paymentRequirements.scheme,
      paymentRequirements.amount,
    );

    const executeBeforeSeconds =
      typeof extra.executeBeforeSeconds === "number" && extra.executeBeforeSeconds > 0
        ? extra.executeBeforeSeconds
        : 60;

    // 1. Relay-build + interactive-prepare (participant access is injected).
    const prepared = await this.signer.prepareTransfer({
      receiver: paymentRequirements.payTo,
      amount,
      instrumentId: { admin, id },
      executeBeforeSeconds,
      ...(typeof extra.memo === "string" && extra.memo.length > 0 ? { memo: extra.memo } : {}),
    });

    // 2. VERIFY-BEFORE-SIGN — pin the relay-built transfer to caller intent.
    assertPreparedTransferMatches(prepared.preparedTransaction, {
      sender: this.signer.party,
      receiver: paymentRequirements.payTo,
      amount,
      instrumentId: id,
      instrumentAdmin: admin,
      requireInputHoldings: true,
      ...(this.config.registryTrustedParties?.[admin]
        ? { trustedRegistryParties: new Set(this.config.registryTrustedParties[admin]) }
        : {}),
      ...(extra.synchronizerId !== undefined ? { synchronizerId: extra.synchronizerId } : {}),
      ...(typeof extra.memo === "string" && extra.memo.length > 0 ? { memo: extra.memo } : {}),
    });

    // 3. Sign — the signer recomputes the hash FROM the exact bytes validated
    //    above and signs it, so the payer never signs a relay-supplied hash it
    //    did not derive from the transaction it just checked (hash binding).
    const signed = await this.signer.signPrepared(prepared.preparedTransaction);

    // 4. Emit the inline payload — the signed transaction itself.
    const payload = encodeInlinePaymentPayload({
      preparedTransactionBytes: Buffer.from(prepared.preparedTransaction, "base64"),
      preparedTxHash: signed.preparedTxHashHex,
      signatureB64: signed.signatureB64,
      hashingSchemeVersion: signed.hashingSchemeVersion ?? "HASHING_SCHEME_VERSION_V2",
    });

    // Spread into a plain record: the wire type is a fixed-key interface, and the
    // base `payload` field is `Record<string, unknown>`.
    return { x402Version, payload: { ...payload } };
  }
}
