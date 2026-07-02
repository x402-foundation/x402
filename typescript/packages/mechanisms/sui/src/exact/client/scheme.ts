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
  GASLESS_ALLOWED_TARGETS,
  GASLESS_ALLOWED_NON_MOVECALL,
  TESTNET_RPC_URL,
  MAINNET_RPC_URL,
  DEVNET_RPC_URL,
  SUI_MAINNET_CAIP2,
  SUI_TESTNET_CAIP2,
  SUI_DEVNET_CAIP2,
  normalizeMoveTarget,
} from "../../constants";
import { createSuiClient, matchBalanceChanges, outputsOf } from "../../utils";

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
 * When the requirements advertise `extra.buildUrl`, the client MAY instead fetch
 * the facilitator's prebuilt unsigned bytes — but it independently verifies them
 * (sender, gasless gas fields, allowlisted commands) BEFORE signing.
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

    const outputs = outputsOf(paymentRequirements);
    this.assertOutputsSumToAmount(outputs, paymentRequirements.amount);

    const client = this.grpcClient(network);

    // PATH B: a prebuilt-transaction URL was advertised — fetch, VERIFY, then sign.
    const buildUrl = paymentRequirements.extra?.buildUrl;
    const bytes =
      typeof buildUrl === "string"
        ? await this.fetchAndVerifyBuildUrl(buildUrl, paymentRequirements, outputs)
        : await this.buildGaslessOutputs(client, asset, outputs);

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
   * Fetch unsigned bytes from a facilitator `buildUrl` and INDEPENDENTLY verify
   * them before signing: decode, assert the sender is this client, assert the
   * gasless gas fields, assert every command is allowlisted, and assert the
   * declared recipients/amounts match. The client MUST NOT sign bytes that fail.
   *
   * @param buildUrl - The facilitator's prebuilt-transaction endpoint
   * @param requirements - The agreed payment requirements
   * @param outputs - The declared `{ to, amount }` outputs
   * @returns Base64-encoded, verified unsigned transaction bytes
   */
  private async fetchAndVerifyBuildUrl(
    buildUrl: string,
    requirements: PaymentRequirements,
    outputs: SuiOutput[],
  ): Promise<string> {
    if (!/^https:\/\//.test(buildUrl)) {
      throw new Error(`buildUrl must be an absolute https URL: ${buildUrl}`);
    }

    const res = await fetch(buildUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sender: this.signer.address, requirements }),
    });
    if (!res.ok) {
      throw new Error(`buildUrl returned ${res.status}`);
    }
    const body = (await res.json()) as { transaction?: string; bytes?: string };
    const bytes = body.transaction ?? body.bytes;
    if (typeof bytes !== "string") {
      throw new Error("buildUrl response missing transaction bytes");
    }

    await this.assertBytesSafe(bytes, requirements.network, requirements.asset, outputs);
    return bytes;
  }

  /**
   * Decode prebuilt (facilitator-built) bytes and assert they are safe to sign — the
   * ENTIRE threat model of `buildUrl` is a malicious or buggy facilitator, so this is
   * the one guard that matters. It asserts, in order: (1) the sender is this client,
   * (2) the gasless gas fields (`gasPrice == 0` ∧ `gasPayment == []`), (3) every
   * command is an allowlisted gasless op or tolerated coin plumbing, and (4) — the
   * load-bearing check the old code SKIPPED — a DRY-RUN proves the exact-fee split:
   * each declared recipient is credited exactly, this client is debited exactly the
   * total, and NO undeclared address receives the asset. Without (4) a facilitator
   * could slip a hidden recipient into bytes the client then blindly signs.
   *
   * Uses the same exact-fee balance-change matcher as the facilitator's verify,
   * with `expectedPayer = sender`.
   *
   * @param bytes - Base64-encoded unsigned transaction bytes
   * @param network - CAIP-2 network identifier (for the dry-run client)
   * @param asset - The required coin type
   * @param outputs - The declared `{ to, amount }` outputs
   */
  private async assertBytesSafe(
    bytes: string,
    network: string,
    asset: string,
    outputs: SuiOutput[],
  ): Promise<void> {
    const data = Transaction.from(fromBase64(bytes)).getData();

    const sender = (data.sender ?? "").toLowerCase();
    if (sender !== this.signer.address.toLowerCase()) {
      throw new Error(`buildUrl sender mismatch: ${data.sender} ≠ ${this.signer.address}`);
    }

    const price = data.gasData?.price;
    const payment = data.gasData?.payment;
    const gasless =
      (price === "0" || price === null || price === undefined) &&
      (payment === null ||
        payment === undefined ||
        (Array.isArray(payment) && payment.length === 0));
    if (!gasless) {
      throw new Error(`buildUrl bytes are not gasless: ${JSON.stringify(data.gasData ?? {})}`);
    }

    for (const cmd of data.commands) {
      if (cmd.$kind === "MoveCall" && cmd.MoveCall) {
        const target = normalizeMoveTarget(
          cmd.MoveCall.package,
          cmd.MoveCall.module,
          cmd.MoveCall.function,
        );
        if (!GASLESS_ALLOWED_TARGETS.has(target)) {
          throw new Error(`buildUrl bytes contain a disallowed target: ${target}`);
        }
      } else if (!GASLESS_ALLOWED_NON_MOVECALL.has(cmd.$kind)) {
        throw new Error(`buildUrl bytes contain a disallowed command: ${cmd.$kind}`);
      }
    }

    // (4) The exact-fee match — dry-run the UNSIGNED bytes and verify the recipients
    // and amounts BEFORE signing. `expectedPayer` is the sender we just matched.
    const sim = await createSuiClient(network as never).dryRunTransactionBlock({
      transactionBlock: bytes,
    });
    if (sim.effects?.status?.status !== "success") {
      throw new Error(`buildUrl bytes fail dry-run: ${sim.effects?.status?.error ?? "unknown"}`);
    }
    const problems = matchBalanceChanges(
      sim.balanceChanges ?? [],
      asset,
      outputs,
      this.signer.address,
    );
    if (problems.length > 0) {
      throw new Error(`buildUrl bytes do not pay the declared split: ${problems.join("; ")}`);
    }
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
