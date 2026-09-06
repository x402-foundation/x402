import * as KeetaNet from "@keetanetwork/keetanet-client";
import { Logger } from "@keetanetwork/keetanet-client/lib/log";
import type {
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkFacilitator,
  SettleResponse,
  VerifyResponse,
  Network,
} from "@x402/core/types";
import type { FacilitatorKeetaSigner } from "../../signer";
import type { ExactKeetaPayload } from "../../types";
import { DuplicateBlockError, SettlementQueue } from "./queue";

/**
 * Keeta facilitator implementation for the Exact payment scheme.
 */
export class ExactKeetaScheme implements SchemeNetworkFacilitator {
  readonly scheme = "exact";
  readonly caipFamily = "keeta:*";

  /**
   * Creates a new ExactKeetaScheme instance.
   *
   * @param signer - The Keeta client for facilitator operations
   * @param logger - Optional logger to use. If unset, logging is disabled.
   * @param queue - Optional queue to use for settlement requests. If unset, defaults to an in-memory implementation.
   */
  constructor(
    private readonly signer: FacilitatorKeetaSigner,
    private readonly logger?: Logger,
    private readonly queue: SettlementQueue = new SettlementQueue(signer, logger),
  ) {}

  /**
   * Get mechanism-specific extra data for the supported kinds endpoint.
   *
   * @param _ - The network identifier (unused)
   * @returns undefined (no facilitator-specific extra data needed)
   */
  getExtra(_: string): Record<string, unknown> | undefined {
    return undefined;
  }

  /**
   * Get signer addresses used by this facilitator.
   *
   * @param _ - The network identifier (unused for Keeta since signers work on all networks)
   * @returns Array of fee payer addresses
   */
  getSigners(_: string): string[] {
    return [...this.signer.getAddresses()];
  }

  /**
   * Verifies a payment payload.
   *
   * @param payload - The payment payload to verify
   * @param requirements - The payment requirements
   * @returns Promise resolving to verification response
   */
  async verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    const exactKeetaPayload = payload.payload as ExactKeetaPayload;

    // 1. Verify x402Version is 2
    if (payload.x402Version !== 2) {
      return {
        isValid: false,
        invalidReason: "invalid_exact_keeta_payload_unsupported_version",
        payer: "",
      };
    }

    // 2. Verify the scheme matches
    if (payload.accepted.scheme !== "exact" || requirements.scheme !== "exact") {
      return { isValid: false, invalidReason: "unsupported_scheme", payer: "" };
    }

    // Parse network to use networkName and networkId later on.
    const caip = requirements.network.split(":");
    if (caip.length !== 2) {
      return {
        isValid: false,
        invalidReason: "invalid_exact_keeta_requirements_network_malformed",
      };
    }

    let networkName = caip[0];
    let networkId: bigint | undefined;
    try {
      networkId = BigInt(caip[1]);
    } catch (error) {
      this.logger?.error("Error decoding requirements.network CAIP:", error);

      return {
        isValid: false,
        invalidReason: "invalid_exact_keeta_requirements_network_id",
      };
    }

    // 3. Verify the network matches
    if (payload.accepted.network !== requirements.network) {
      return { isValid: false, invalidReason: "network_mismatch", payer: "" };
    }

    // 4. Decode payload block and
    // 4.1 Verify signature, done by the SDK when decoding the block
    let block;
    try {
      block = new KeetaNet.lib.Block(exactKeetaPayload.block);
    } catch (error) {
      this.logger?.error("Error decoding block:", error);

      return {
        isValid: false,
        invalidReason: "invalid_exact_keeta_payload_block_could_not_be_decoded",
        payer: "",
      };
    }

    // 4.2 Verify the network id matches
    if (networkName !== "keeta" || block.network !== networkId) {
      return { isValid: false, invalidReason: "network_mismatch", payer: "" };
    }

    // 4.3 Verify the block contains exactly one operation
    if (block.operations.length !== 1) {
      return {
        isValid: false,
        invalidReason: "invalid_exact_keeta_payload_operations_length",
        payer: "",
      };
    }

    // 4.4 Verify the payment operation
    const [payOperation] = block.operations;
    const payOperationVerificationResult = this.verifyPaymentOperation(payOperation, requirements);
    if (payOperationVerificationResult !== null) {
      return payOperationVerificationResult;
    }

    // Ensure that the sponsor can't be tricked into moving its own funds
    const facilitatorAddresses = this.signer.getAddresses();
    if (facilitatorAddresses.includes(block.account.publicKeyString.toString())) {
      return {
        isValid: false,
        invalidReason: "invalid_exact_keeta_payload_payer_is_facilitator",
        payer: "",
      };
    }

    // 4.5 Simulate transaction
    const simulateTransactionVerificationResult = await this.simulateTransaction(
      block,
      requirements,
    );
    if (simulateTransactionVerificationResult !== null) {
      return simulateTransactionVerificationResult;
    }

    return {
      isValid: true,
      invalidReason: undefined,
      payer: block.account.publicKeyString.toString(),
    };
  }

  /**
   * Settles a payment by submitting the transaction to the network.
   * Inserts the payload into a queue and waits for the item to be processed.
   *
   * @param payload - The payment payload to settle
   * @param requirements - The payment requirements
   * @returns Promise resolving to settlement response
   */
  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    const exactKeetaPayload = payload.payload as ExactKeetaPayload;

    const valid = await this.verify(payload, requirements);
    if (!valid.isValid) {
      return {
        success: false,
        network: payload.accepted.network,
        transaction: "",
        errorReason: valid.invalidReason ?? "verification_failed",
        payer: valid.payer || "",
      };
    }

    try {
      const feePayer = this.getRandomFeePayer();

      const blockHash = await this.queue.enqueue(
        feePayer,
        exactKeetaPayload.block,
        requirements.network,
      );

      return {
        success: true,
        transaction: blockHash,
        network: payload.accepted.network,
        payer: valid.payer,
      };
    } catch (error) {
      this.logger?.error("Failed to settle transaction:", error);

      const errorReason =
        error instanceof DuplicateBlockError ? "duplicate_block" : "transaction_failed";

      return {
        success: false,
        errorReason,
        transaction: "",
        network: payload.accepted.network,
        payer: valid.payer || "",
      };
    }
  }

  /**
   * Chooses a random fee payer address from the available addresses of the facilitator's signer.
   * This can be used to distribute load across multiple signers.
   *
   * @returns Random fee payer address
   */
  private getRandomFeePayer(): string {
    const addresses = this.signer.getAddresses();
    if (addresses.length === 0) {
      throw new Error("No fee payer addresses available");
    }
    const randomIndex = Math.floor(Math.random() * addresses.length);

    return addresses[randomIndex];
  }

  /**
   * Get a Keeta Client to perform requests to the network.
   * Uses the UserClient of the first signer account and returns its client.
   *
   * @param network - Network to get the client for
   * @returns KeetaNet.Client
   */
  private getKeetaClient(network: Network): InstanceType<typeof KeetaNet.Client> {
    return this.signer.getKeetaUserClient(this.signer.getAddresses()[0], network).client;
  }

  /**
   * Verifies that the given payment operation matches the requirements.
   *
   * @param payOperation - Operation that should pay the required funds to the server
   * @param requirements - Requirements the operation must fulfill
   * @returns VerifyResponse on failure, null on success
   */
  private verifyPaymentOperation(
    payOperation: InstanceType<typeof KeetaNet.lib.Block>["operations"][0],
    requirements: PaymentRequirements,
  ): VerifyResponse | null {
    // 4.4 The operation is a SEND operation
    if (payOperation.type !== KeetaNet.lib.Block.OperationType.SEND) {
      return {
        isValid: false,
        invalidReason: "invalid_exact_keeta_payload_payment_operation_type",
        payer: "",
      };
    }

    // 4.4.1 The token matches the requirements.asset
    if (!payOperation.token.comparePublicKey(requirements.asset)) {
      return {
        isValid: false,
        invalidReason: "invalid_exact_keeta_payload_payment_asset_mismatch",
        payer: "",
      };
    }

    // 4.4.2 The amount matches the requirements.amount
    try {
      if (payOperation.amount !== BigInt(requirements.amount)) {
        return {
          isValid: false,
          invalidReason: "invalid_exact_keeta_payload_payment_amount_mismatch",
          payer: "",
        };
      }
    } catch (error) {
      this.logger?.error("Error parsing payment amount:", error);

      return {
        isValid: false,
        invalidReason: "invalid_exact_keeta_payload_payment_amount_invalid",
        payer: "",
      };
    }

    // 4.4.3 The to matches the requirements.payTo
    if (!payOperation.to.comparePublicKey(requirements.payTo)) {
      return {
        isValid: false,
        invalidReason: "invalid_exact_keeta_payload_payment_to_mismatch",
        payer: "",
      };
    }

    // 4.4.4 The external matches the extra.external if set
    if (requirements.extra?.external && payOperation.external !== requirements.extra.external) {
      return {
        isValid: false,
        invalidReason: "invalid_exact_keeta_payload_payment_external_mismatch",
        payer: "",
      };
    }

    return null;
  }

  /**
   * Simulates whether the given payment operation would succeed based on a few cheap checks.
   *
   * @param block - Block that should be simulated
   * @param requirements - Requirements the transaction must fulfill
   * @returns VerifyResponse on failure, null on success
   */
  private async simulateTransaction(
    block: InstanceType<typeof KeetaNet.lib.Block>,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse | null> {
    let signer: InstanceType<typeof KeetaNet.lib.Account>;
    const isMultiSig = Array.isArray(block.signer);
    if (isMultiSig) {
      signer = block.signer[0];
    } else {
      signer = block.signer;
    }

    const client = this.getKeetaClient(requirements.network);

    const [accountInfo, permissions] = await Promise.all([
      client.getAccountInfo(block.account),
      block.account.comparePublicKey(signer)
        ? null
        : client.listACLsByPrincipal(signer, [block.account]),
    ]);

    // 4.5.1 Sufficient balance
    const tokenBalance = accountInfo.balances.find(balance =>
      balance.token.comparePublicKey(requirements.asset),
    );
    if (tokenBalance === undefined || tokenBalance.balance < BigInt(requirements.amount)) {
      return {
        isValid: false,
        invalidReason: "invalid_exact_keeta_payload_insufficient_funds",
        payer: "",
      };
    }

    // 4.5.2 Account's head block matches block's previous
    if (
      (accountInfo.currentHeadBlock &&
        !block.previous.compareHexString(accountInfo.currentHeadBlock)) ||
      (!accountInfo.currentHeadBlock &&
        !block.previous.compareHexString(KeetaNet.lib.Block.getAccountOpeningHash(block.account)))
    ) {
      return {
        isValid: false,
        invalidReason: "invalid_exact_keeta_payload_previous_head_mismatch",
        payer: "",
      };
    }

    // 4.5.3 Block's signer is allowed to send as account
    // If the block's account is equal to the signer permission is given.
    // Otherwise, check if the signer is allowed to send on behalf of the account.
    if (!block.account.comparePublicKey(signer)) {
      const permission = permissions?.find(permission =>
        permission.entity.comparePublicKey(block.account),
      );

      if (
        permission === undefined ||
        (!permission.permissions.base.hasFlags("OWNER") &&
          !permission.permissions.base.hasFlags("SEND_ON_BEHALF"))
      ) {
        return {
          isValid: false,
          invalidReason: "invalid_exact_keeta_payload_missing_permission",
          payer: "",
        };
      }
    }

    return null;
  }
}
