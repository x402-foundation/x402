import {
  createCip30ClientCardanoSigner,
  type Cip30PaymentClock,
  type Cip30ProtocolParameters,
  type Cip30SignedPayment,
  type Cip30WalletApi,
} from "@x402/cardano";
import { ExactCardanoScheme } from "@x402/cardano/exact/client";
import { x402Client } from "@x402/core/client";
import { encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { deepEqual } from "@x402/core/utils";

import type { SignedPayment } from "./payment";

/**
 * An `x402Client` requirement selector that only ever returns the requirement
 * the server displayed, so a route that also offers masumi/script entries can
 * never make the page sign one of those.
 *
 * @param selected - The requirement injected by the server.
 * @returns Selector for `new x402Client(selector)`.
 */
export function pinnedRequirementSelector(
  selected: PaymentRequirements,
): (x402Version: number, accepts: PaymentRequirements[]) => PaymentRequirements {
  // The same structural comparison core's server uses to match a payment to its requirements.
  return (_version, accepts) => {
    const match = accepts.find(candidate => deepEqual(candidate, selected));
    if (!match) {
      throw new Error(
        "The payment option shown on this page is no longer offered; reload the page",
      );
    }
    return match;
  };
}

/** Inputs for {@link createSignPayment}. */
export interface SignPaymentOptions {
  api: Cip30WalletApi;
  network: string;
  protocolParameters: Cip30ProtocolParameters;
  clock: Cip30PaymentClock;
  paymentRequired: PaymentRequired;
  selectedRequirement: PaymentRequirements;
}

/**
 * Returns the `sign` function the payment controller calls: it builds a fresh
 * x402 client pinned to the displayed requirement and a CIP-30 signer that
 * spends `pinnedNonce` when one is given.
 *
 * @param options - Wallet, network, parameters, clock and requirements.
 * @returns Signing function.
 */
export function createSignPayment(
  options: SignPaymentOptions,
): (pinnedNonce: string | undefined) => Promise<SignedPayment> {
  return async pinnedNonce => {
    let signed: Cip30SignedPayment | undefined;
    const signer = await createCip30ClientCardanoSigner(options.api, {
      network: options.network,
      protocolParameters: options.protocolParameters,
      clock: options.clock,
      pinnedNonce: () => pinnedNonce,
      onSigned: payment => {
        signed = payment;
      },
    });
    const client = new x402Client(pinnedRequirementSelector(options.selectedRequirement));
    // The page itself shows and confirms the amount; pinning plus the signer's
    // guards bound what can be signed.
    client.setSpendControls(false);
    const scheme = new ExactCardanoScheme(signer);
    client.register("cardano:*", scheme);
    client.register("cip34:*", scheme);
    const payload = await client.createPaymentPayload(options.paymentRequired);
    if (!signed) throw new Error("The wallet did not produce a signed payment");
    return {
      header: encodePaymentSignatureHeader(payload),
      nonce: signed.nonce,
      txId: signed.txId,
      ttlMs: signed.ttlMs,
    };
  };
}
