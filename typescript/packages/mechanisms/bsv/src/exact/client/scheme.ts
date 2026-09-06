import { PublicKey, Utils, Random } from "@bsv/sdk";
import type { WalletInterface } from "@bsv/sdk";
import type { PaymentPayload, PaymentRequirements, SchemeNetworkClient } from "@x402/core/types";
import type { ExactBsvPayloadV2 } from "../../types";
import {
  BRC29_PROTOCOL_ID,
  BSV_ASSET_IDENTIFIER,
  COMPRESSED_PUBKEY_REGEX,
  MAX_SATOSHIS,
  isBsvNetwork,
} from "../../constants";

export interface ClientBsvConfig {
  /**
   * Optional originator domain passed to every wallet call, identifying the
   * application requesting the payment (BRC-100 `originator` argument).
   */
  originator?: string;
}

/**
 * BSV client implementation for the `exact` payment scheme.
 *
 * Builds a BRC-29 payment (per BRC-121 "Simple 402 Payments"): a fresh
 * payment key is derived from the recipient's identity key (`payTo`) via
 * BRC-42, and the client's BRC-100 wallet creates a fully-signed,
 * fully-funded transaction paying that key. The client covers miner fees;
 * no facilitator fee sponsorship is involved.
 *
 * @example
 * ```typescript
 * import { ExactBsvScheme } from "@x402/bsv/exact/client";
 * import { WalletClient } from "@bsv/sdk";
 *
 * const scheme = new ExactBsvScheme(new WalletClient());
 * client.register("bsv:*", scheme);
 * ```
 */
export class ExactBsvScheme implements SchemeNetworkClient {
  readonly scheme = "exact";

  /**
   * Creates a new ExactBsvScheme client instance.
   *
   * @param wallet - BRC-100 wallet used to derive keys and create the payment
   * @param config - Optional client configuration
   */
  constructor(
    private readonly wallet: WalletInterface,
    private readonly config?: ClientBsvConfig,
  ) {}

  /**
   * Creates a payment payload for the `exact` scheme on BSV.
   *
   * Derives the recipient's payment key via BRC-42 (BRC-29 protocol ID,
   * counterparty = `payTo` identity key, key ID = `"<prefix> <suffix>"`
   * where the suffix encodes the current Unix-ms timestamp), then asks the
   * wallet to create a transaction with a P2PKH output of exactly
   * `requirements.amount` satoshis at output index 0.
   *
   * @param x402Version - The x402 protocol version in use
   * @param requirements - Payment requirements from the resource server
   * @returns The x402 version and scheme-specific payment payload
   */
  async createPaymentPayload(
    x402Version: number,
    requirements: PaymentRequirements,
  ): Promise<Pick<PaymentPayload, "x402Version" | "payload">> {
    this.validateRequirements(requirements);

    const originator = this.config?.originator;
    const satoshis = Number(requirements.amount);

    const derivationPrefix = Utils.toBase64(Random(8));
    const time = String(Date.now());
    const derivationSuffix = Utils.toBase64(Utils.toArray(time, "utf8"));

    // Derive the recipient's per-payment public key via BRC-42
    const { publicKey: derivedPubKey } = await this.wallet.getPublicKey(
      {
        protocolID: BRC29_PROTOCOL_ID,
        keyID: `${derivationPrefix} ${derivationSuffix}`,
        counterparty: requirements.payTo,
      },
      originator,
    );

    const pkh = PublicKey.fromString(derivedPubKey).toHash("hex") as string;

    const { publicKey: senderIdentityKey } = await this.wallet.getPublicKey(
      { identityKey: true },
      originator,
    );

    const actionResult = await this.wallet.createAction(
      {
        description: "x402 exact payment",
        outputs: [
          {
            satoshis,
            lockingScript: `76a914${pkh}88ac`,
            outputDescription: "x402 exact payment",
            customInstructions: JSON.stringify({
              derivationPrefix,
              derivationSuffix,
              payee: requirements.payTo,
            }),
            tags: ["x402"],
          },
        ],
        labels: ["x402"],
        options: { randomizeOutputs: false },
      },
      originator,
    );

    if (!actionResult.tx) {
      throw new Error("Wallet createAction did not return a signed transaction");
    }

    const bsvPayload: ExactBsvPayloadV2 = {
      transaction: Utils.toBase64(actionResult.tx as number[]),
      derivationPrefix,
      derivationSuffix,
      senderIdentityKey,
      outputIndex: 0,
    };

    return {
      x402Version,
      payload: bsvPayload as unknown as PaymentPayload["payload"],
    };
  }

  /**
   * Validates payment requirements before any wallet interaction.
   *
   * @param requirements - Payment requirements from the resource server
   */
  private validateRequirements(requirements: PaymentRequirements): void {
    if (requirements.scheme !== this.scheme) {
      throw new Error(`Unsupported scheme: ${requirements.scheme}`);
    }

    if (!isBsvNetwork(requirements.network)) {
      throw new Error(`Unsupported BSV network: ${requirements.network}`);
    }

    const asset = requirements.asset ?? BSV_ASSET_IDENTIFIER;
    if (asset !== "" && asset.toUpperCase() !== BSV_ASSET_IDENTIFIER) {
      throw new Error(
        `Unsupported asset "${requirements.asset}": only native ${BSV_ASSET_IDENTIFIER} (satoshis) is supported`,
      );
    }

    if (!requirements.amount || !/^\d+$/.test(requirements.amount)) {
      throw new Error("amount must be a non-empty decimal string of satoshis");
    }

    const satoshis = Number(requirements.amount);
    if (satoshis <= 0 || satoshis > MAX_SATOSHIS) {
      throw new Error(`amount must be between 1 and ${MAX_SATOSHIS} satoshis`);
    }

    if (!requirements.payTo || !COMPRESSED_PUBKEY_REGEX.test(requirements.payTo)) {
      throw new Error(
        "payTo must be the recipient's identity public key (33-byte compressed secp256k1 hex)",
      );
    }
  }
}
