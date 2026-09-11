import { num, stark, type Signature } from "starknet";
import type {
  PaymentPayloadResult,
  PaymentRequirements,
  SchemeNetworkClient,
} from "@x402/core/types";
import { ANY_CALLER, getStarknetChainId, TRANSFER_SELECTOR } from "../../constants";
import { findDefaultAsset } from "../../defaultAssets";
import type { ClientStarknetSigner } from "../../signer";
import type { ExactStarknetPayload } from "../../types";
import {
  buildCanonicalOutsideExecutionTypedData,
  buildTransferCall,
  type OutsideExecutionMessage,
} from "../../typed-data";
import { feltEquals, isValidStarknetAddress } from "../../utils";

/**
 * SNIP-9 `Execute After` bound. The spec requires it be well in the past so the
 * authorization is already active when settled; `1` is the canonical minimum
 * (the felt zero would also work) and clears the facilitator freshness check
 * (`Execute After < now - skewMargin`) for any realistic wall clock.
 */
const EXECUTE_AFTER = 1;

/**
 * Starknet client implementation for the Exact payment scheme.
 *
 * The client alone builds the SNIP-9 v2 `OutsideExecution` from the
 * `PaymentRequirements` and signs its SNIP-12 typed data. There is no paymaster
 * call and no facilitator interaction on this path: the signature authorizes
 * exactly one `transfer` call, bound to the sponsor via `Caller = extra.feePayer`.
 */
export class ExactStarknetScheme implements SchemeNetworkClient {
  readonly scheme = "exact";
  findDefaultAsset = findDefaultAsset;

  /**
   * Creates a new ExactStarknetScheme instance.
   *
   * @param signer - The payer's Starknet account, exposing its address and a
   *   SNIP-12 typed-data signer
   */
  constructor(private readonly signer: ClientStarknetSigner) {}

  /**
   * Creates a payment payload for the Exact scheme by signing a SNIP-9 v2
   * OutsideExecution that authorizes exactly the required token transfer.
   *
   * @param x402Version - The x402 protocol version, echoed into the payload
   * @param paymentRequirements - The selected Starknet `exact` requirements,
   *   whose `extra.feePayer` becomes the SNIP-9 `Caller`
   * @returns Promise resolving to the payment payload result carrying the payer
   *   address, signed typed data, and felt-array signature
   */
  async createPaymentPayload(
    x402Version: number,
    paymentRequirements: PaymentRequirements,
  ): Promise<PaymentPayloadResult> {
    const { network, asset, payTo, amount, maxTimeoutSeconds, extra } = paymentRequirements;
    const from = this.signer.address;

    // --- Validate the requirements before spending a signature on them. ---
    if (!from) {
      throw new Error("Starknet account address is required");
    }
    if (!asset) {
      throw new Error("Asset is required");
    }
    if (!isValidStarknetAddress(asset)) {
      throw new Error("Invalid asset address");
    }
    if (!payTo) {
      throw new Error("Pay-to address is required");
    }
    if (!isValidStarknetAddress(payTo)) {
      throw new Error("Invalid pay-to address");
    }
    if (!amount) {
      throw new Error("Amount is required");
    }
    if (!/^[0-9]+$/.test(amount)) {
      throw new Error("Amount must be a base-10 integer string");
    }
    if (BigInt(amount) <= 0n) {
      throw new Error("Amount must be a positive integer");
    }
    // Rejected rather than floored: `Execute Before` is a felt, so a fractional
    // value throws from inside signing, and silently rounding it here would sign
    // a deadline the facilitator - reading the raw requirements - never agrees with.
    if (!Number.isInteger(maxTimeoutSeconds) || maxTimeoutSeconds <= 0) {
      throw new Error("maxTimeoutSeconds must be a positive integer");
    }

    // Resolve and validate the network; getStarknetChainId throws when unsupported.
    const chainId = getStarknetChainId(network);

    // --- extra.feePayer: REQUIRED and MUST be a concrete SNIP-9 Caller. ---
    const feePayer = extra?.feePayer;
    if (typeof feePayer !== "string" || feePayer.length === 0) {
      throw new Error("extra.feePayer is required");
    }
    if (feltEquals(feePayer, "0x0")) {
      throw new Error("feePayer must not be the zero address");
    }
    if (!isValidStarknetAddress(feePayer)) {
      throw new Error("Invalid feePayer address");
    }
    if (feltEquals(feePayer, from)) {
      throw new Error("feePayer must not equal the payer address");
    }
    if (feltEquals(feePayer, ANY_CALLER)) {
      throw new Error("feePayer must not be the ANY_CALLER sentinel");
    }

    // --- Build the single exact transfer Call: recipient = payTo, exact amount. ---
    const transferCall = buildTransferCall(asset, payTo, amount);

    // Time bounds per the Timeout Mapping: Execute Before = now + maxTimeoutSeconds.
    const nowSec = Math.floor(Date.now() / 1000);

    // Fresh, single-use SNIP-9 nonce, independent of the account transaction nonce.
    const nonce = stark.randomAddress();

    const message: OutsideExecutionMessage = {
      Caller: feePayer,
      Nonce: nonce,
      "Execute After": EXECUTE_AFTER,
      "Execute Before": nowSec + maxTimeoutSeconds,
      Calls: [
        {
          To: transferCall.contractAddress,
          Selector: TRANSFER_SELECTOR,
          Calldata: transferCall.calldata,
        },
      ],
    };

    // Reconstruct the canonical SNIP-9 v2 typed data and sign that exact form:
    // the facilitator hashes its own reconstruction of the same shape.
    const typedData = buildCanonicalOutsideExecutionTypedData(chainId, message);
    const signature = await this.signer.signMessage(typedData);
    const signatureFelts = normalizeSignature(signature);

    const payload = {
      from,
      outsideExecution: {
        typedData,
        signature: signatureFelts,
      },
    } satisfies ExactStarknetPayload;

    return {
      x402Version,
      payload,
    };
  }
}

/**
 * Normalizes a starknet.js signature to an array of hex-encoded felts, the shape
 * the account's `is_valid_signature` consumes. Accepts both the felt-array form
 * and the `{ r, s }` Weierstrass form.
 *
 * @param signature - The signature returned by the client signer
 * @returns The signature as an array of hex felt strings
 */
function normalizeSignature(signature: Signature): string[] {
  return Array.isArray(signature)
    ? signature.map(felt => num.toHex(felt))
    : [num.toHex(signature.r), num.toHex(signature.s)];
}
