import { SuiGrpcClient } from "@mysten/sui/grpc";
import { Transaction } from "@mysten/sui/transactions";
import { fromBase64 } from "@mysten/sui/utils";
import type {
  PaymentRequirements,
  PaymentPayloadResult,
  SchemeNetworkClient,
} from "@x402/core/types";
import type { ClientSuiSigner } from "../../signer";
import type { ExactSuiPayload, SuiOutput } from "../../types";
import {
  TESTNET_RPC_URL,
  MAINNET_RPC_URL,
  DEVNET_RPC_URL,
  SUI_MAINNET_CAIP2,
  SUI_TESTNET_CAIP2,
  SUI_DEVNET_CAIP2,
} from "../../constants";
import { outputsOf } from "../../utils";

/**
 * Sui client implementation for the Exact payment scheme.
 *
 * Builds a GASLESS Address-Balance payment PTB — one `0x2::balance::send_funds`
 * per declared output, drawn from the payer's Address Balance (the SDK's
 * `tx.balance()` input resolves the coin source), built over gRPC so the gasless
 * params (`gasPrice = 0`, `gasPayment = []`) resolve, with `setGasBudget(0n)` to
 * force the resolver's gasless election deterministically. Signs but does NOT
 * execute — the facilitator broadcasts during settlement.
 *
 * Implements the `address-balance` asset transfer method. When the requirements
 * declare `extra.assetTransferMethod`, the payment MUST use that method — a
 * declared `coin` method is rejected here (this client does not build the
 * classic gas-paying path).
 */
export class ExactSuiScheme implements SchemeNetworkClient {
  readonly scheme = "exact";

  /**
   * Creates a new ExactSuiScheme client instance.
   *
   * @param signer - The client signer for signing transactions
   * @param config - Optional config object
   * @param config.rpcUrl - Optional custom gRPC RPC URL
   */
  constructor(
    private readonly signer: ClientSuiSigner,
    private readonly config?: { rpcUrl?: string },
  ) {}

  /**
   * Creates a payment payload by building (or fetching) and signing a gasless PTB.
   *
   * @param x402Version - The x402 protocol version
   * @param paymentRequirements - The payment requirements (amount, asset, payTo, network, extra)
   * @returns Promise resolving to a signed payment payload
   */
  async createPaymentPayload(
    x402Version: number,
    paymentRequirements: PaymentRequirements,
  ): Promise<PaymentPayloadResult> {
    const { asset, network } = paymentRequirements;
    if (!asset) {
      throw new Error("Asset is required");
    }

    // A declared method is binding (spec "Method selection rules"); this client
    // implements the gasless `address-balance` method only.
    const method = paymentRequirements.extra?.assetTransferMethod;
    if (method !== undefined && method !== "address-balance") {
      throw new Error(
        `unsupported assetTransferMethod: ${String(method)} (this client implements address-balance)`,
      );
    }

    const outputs = outputsOf(paymentRequirements);
    this.assertOutputsSumToAmount(outputs, paymentRequirements.amount);

    const client = this.grpcClient(network);
    const bytes = await this.buildGaslessOutputs(client, asset, outputs);

    const tx = Transaction.from(fromBase64(bytes));
    const { signature, bytes: signedBytes } = await this.signer.signTransaction(tx);

    const payload: ExactSuiPayload = {
      signature,
      transaction: signedBytes,
    };

    return {
      x402Version,
      payload,
    };
  }

  /**
   * Build the gasless Address-Balance payment PTB: one `0x2::balance::send_funds`
   * per declared output, `setGasBudget(0n)` to force the gasless election.
   *
   * @param client - A gRPC client (gasless eligibility resolves over gRPC)
   * @param asset - The coin type to transfer
   * @param outputs - The declared `{ to, amount }` outputs
   * @returns Base64-encoded unsigned transaction bytes
   */
  private async buildGaslessOutputs(
    client: SuiGrpcClient,
    asset: string,
    outputs: SuiOutput[],
  ): Promise<string> {
    const tx = new Transaction();
    tx.setSender(this.signer.address);
    for (const o of outputs) {
      tx.moveCall({
        target: "0x2::balance::send_funds",
        typeArguments: [asset],
        arguments: [tx.balance({ type: asset, balance: BigInt(o.amount) }), tx.pure.address(o.to)],
      });
    }
    // Force the gasless election (the resolver's `budget === 0n` branch) so
    // gaslessness does not depend on node-rebate behavior. Do NOT also set
    // gasPrice/gasPayment manually — the protocol rejects those.
    tx.setGasBudget(0n);
    const built = await tx.build({ client });
    return Buffer.from(built).toString("base64");
  }

  /**
   * Assert that declared outputs sum to the total `amount`.
   *
   * @param outputs - The declared `{ to, amount }` outputs
   * @param amount - The total atomic-unit amount
   */
  private assertOutputsSumToAmount(outputs: SuiOutput[], amount: string): void {
    const total = outputs.reduce((s, o) => s + BigInt(o.amount), 0n);
    if (total !== BigInt(amount)) {
      throw new Error(`declared outputs sum ${total} ≠ amount ${amount}`);
    }
  }

  /**
   * Create a gRPC client for the given network (the transport gasless build needs).
   *
   * @param network - CAIP-2 network identifier
   * @returns A SuiGrpcClient for the network
   */
  private grpcClient(network: string): SuiGrpcClient {
    if (this.config?.rpcUrl) {
      const ref = network.split(":")[1] as "testnet" | "mainnet" | "devnet";
      return new SuiGrpcClient({ network: ref, baseUrl: this.config.rpcUrl });
    }
    switch (network) {
      case SUI_MAINNET_CAIP2:
        return new SuiGrpcClient({ network: "mainnet", baseUrl: MAINNET_RPC_URL });
      case SUI_TESTNET_CAIP2:
        return new SuiGrpcClient({ network: "testnet", baseUrl: TESTNET_RPC_URL });
      case SUI_DEVNET_CAIP2:
        return new SuiGrpcClient({ network: "devnet", baseUrl: DEVNET_RPC_URL });
      default:
        throw new Error(`Unsupported Sui network: ${network}`);
    }
  }
}
