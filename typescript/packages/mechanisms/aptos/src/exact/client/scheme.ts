import { AccountAddress, Aptos, AptosConfig, SimpleTransaction } from "@aptos-labs/ts-sdk";
import type { PaymentPayload, PaymentRequirements, SchemeNetworkClient } from "@x402/core/types";
import { APTOS_ADDRESS_REGEX, getAptosNetwork, getAptosRpcUrl } from "../../constants";
import type { ClientAptosSigner, ClientAptosConfig } from "../../signer";
import type { ExactAptosPayload } from "../../types";
import { encodeAptosPayload } from "../../utils";

/**
 * Aptos client implementation for the Exact payment scheme.
 */
export class ExactAptosScheme implements SchemeNetworkClient {
  readonly scheme = "exact";

  /**
   * Creates a new ExactAptosScheme instance.
   *
   * @param signer - The Aptos account for signing transactions
   * @param config - Optional configuration with custom RPC URL
   */
  constructor(
    private readonly signer: ClientAptosSigner,
    private readonly config?: ClientAptosConfig,
  ) {}

  /**
   * Creates a payment payload for the Exact scheme.
   *
   * @param x402Version - The x402 protocol version
   * @param paymentRequirements - The payment requirements
   * @returns Promise resolving to a payment payload
   */
  async createPaymentPayload(
    x402Version: number,
    paymentRequirements: PaymentRequirements,
  ): Promise<Pick<PaymentPayload, "x402Version" | "payload">> {
    if (!this.signer.accountAddress) {
      throw new Error("Aptos account address is required");
    }
    if (!paymentRequirements.asset) {
      throw new Error("Asset is required");
    }
    if (!paymentRequirements.asset.match(APTOS_ADDRESS_REGEX)) {
      throw new Error("Invalid asset address");
    }
    if (!paymentRequirements.payTo) {
      throw new Error("Pay-to address is required");
    }
    if (!paymentRequirements.payTo.match(APTOS_ADDRESS_REGEX)) {
      throw new Error("Invalid pay-to address");
    }
    if (!paymentRequirements.amount) {
      throw new Error("Amount is required");
    }
    if (!paymentRequirements.amount.match(/^[0-9]+$/)) {
      throw new Error("Amount must be a number");
    }

    const aptosNetwork = getAptosNetwork(paymentRequirements.network);
    const rpcUrl = this.config?.rpcUrl || getAptosRpcUrl(aptosNetwork);
    const aptosConfig = new AptosConfig({
      network: aptosNetwork,
      fullnode: rpcUrl,
    });
    const aptos = new Aptos(aptosConfig);

    const feePayer = paymentRequirements.extra?.feePayer;
    const isSponsored = typeof feePayer === "string";

    const builtTransaction = await aptos.transaction.build.simple({
      sender: this.signer.accountAddress,
      data: {
        function: "0x1::primary_fungible_store::transfer",
        typeArguments: ["0x1::fungible_asset::Metadata"],
        functionArguments: [
          paymentRequirements.asset,
          paymentRequirements.payTo,
          paymentRequirements.amount,
        ],
      },
      withFeePayer: isSponsored,
    });

    // For sponsored transactions, set the actual fee payer address (SDK uses 0x0 placeholder)
    const transaction = isSponsored
      ? new SimpleTransaction(builtTransaction.rawTransaction, AccountAddress.from(feePayer))
      : builtTransaction;

    const senderAuthenticator = this.signer.signTransactionWithAuthenticator(transaction);
    const transactionBytes = transaction.bcsToBytes();
    const authenticatorBytes = senderAuthenticator.bcsToBytes();
    const base64Transaction = encodeAptosPayload(transactionBytes, authenticatorBytes);

    const payload: ExactAptosPayload = {
      transaction: base64Transaction,
    };

    return {
      x402Version,
      payload,
    };
  }
}
