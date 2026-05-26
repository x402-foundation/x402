import { AccountAddress, Deserializer, Ed25519PublicKey, PublicKey } from "@aptos-labs/ts-sdk";
import type {
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkFacilitator,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import type { FacilitatorAptosSigner } from "../../signer";
import type { ExactAptosPayload } from "../../types";
import { createAptosClient, deserializeAptosPayment } from "../../utils";
import { getAptosChainId, MAX_GAS_AMOUNT } from "../../constants";

/**
 * Aptos facilitator implementation for the Exact payment scheme.
 */
export class ExactAptosScheme implements SchemeNetworkFacilitator {
  readonly scheme = "exact";
  readonly caipFamily = "aptos:*";

  /**
   * Creates a new ExactAptosFacilitator instance.
   *
   * @param signer - The Aptos facilitator signer for transaction submission
   * @param sponsorTransactions - Whether to sponsor transactions (pay gas fees). Defaults to true.
   */
  constructor(
    private readonly signer: FacilitatorAptosSigner,
    private readonly sponsorTransactions: boolean = true,
  ) {}

  /**
   * Get mechanism-specific extra data for the supported kinds endpoint.
   *
   * @param _ - The network identifier (unused)
   * @returns Extra data with fee payer address, or undefined if sponsorship is disabled
   */
  getExtra(_: string): Record<string, unknown> | undefined {
    if (!this.sponsorTransactions) {
      return undefined;
    }
    const addresses = this.signer.getAddresses();
    const randomIndex = Math.floor(Math.random() * addresses.length);
    return { feePayer: addresses[randomIndex] };
  }

  /**
   * Get signer addresses used by this facilitator.
   *
   * @param _ - The network identifier (unused)
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
    try {
      const aptosPayload = payload.payload as ExactAptosPayload;
      const signerAddresses = this.signer.getAddresses();
      const isSponsored = typeof requirements.extra?.feePayer === "string";

      // Step 2: Verify x402Version is 2
      if (payload.x402Version !== 2) {
        return {
          isValid: false,
          invalidReason: "invalid_exact_aptos_payload_unsupported_version",
          payer: "",
        };
      }

      // Step 3: Verify the network matches
      if (payload.accepted.scheme !== "exact" || requirements.scheme !== "exact") {
        return { isValid: false, invalidReason: "unsupported_scheme", payer: "" };
      }

      if (payload.accepted.network !== requirements.network) {
        return { isValid: false, invalidReason: "network_mismatch", payer: "" };
      }

      // If sponsored, verify the fee payer is managed by this facilitator
      if (isSponsored && !signerAddresses.includes(requirements.extra.feePayer as string)) {
        return { isValid: false, invalidReason: "fee_payer_not_managed_by_facilitator", payer: "" };
      }

      // Step 4: Deserialize the BCS-encoded transaction and verify the signature
      const { transaction, senderAuthenticator, entryFunction } = deserializeAptosPayment(
        aptosPayload.transaction,
      );
      const senderAddress = transaction.rawTransaction.sender.toString();

      // Verify chain ID matches expected network
      const expectedChainId = getAptosChainId(requirements.network);
      const txChainId = Number(transaction.rawTransaction.chain_id.chainId);
      if (txChainId !== expectedChainId) {
        return {
          isValid: false,
          invalidReason: `invalid_exact_aptos_payload_chain_id_mismatch: expected ${expectedChainId}, got ${txChainId}`,
          payer: senderAddress,
        };
      }

      // Verify sender matches authenticator public key (for Ed25519 accounts)
      // Note: SingleKey and MultiKey authenticators are validated during simulation (step 11)
      if (senderAuthenticator.isEd25519()) {
        const pubKey = senderAuthenticator.public_key as Ed25519PublicKey;
        const derivedAddress = AccountAddress.from(pubKey.authKey().derivedAddress());
        if (!derivedAddress.equals(transaction.rawTransaction.sender)) {
          return {
            isValid: false,
            invalidReason: "invalid_exact_aptos_payload_sender_authenticator_mismatch",
            payer: senderAddress,
          };
        }
      }

      // For sponsored transactions, verify max gas to prevent gas draining
      if (isSponsored) {
        const maxGasAmount = BigInt(transaction.rawTransaction.max_gas_amount);
        if (maxGasAmount > MAX_GAS_AMOUNT) {
          return {
            isValid: false,
            invalidReason: `invalid_exact_aptos_payload_gas_too_high: ${maxGasAmount} > ${MAX_GAS_AMOUNT}`,
            payer: senderAddress,
          };
        }
      }

      // For sponsored transactions, verify fee payer address matches
      if (isSponsored) {
        const expectedFeePayer = AccountAddress.from(requirements.extra.feePayer as string);
        if (!transaction.feePayerAddress || !expectedFeePayer.equals(transaction.feePayerAddress)) {
          return {
            isValid: false,
            invalidReason: "invalid_exact_aptos_payload_fee_payer_mismatch",
            payer: senderAddress,
          };
        }
      }

      // SECURITY (reference implementation): Prevent facilitator from signing away their own tokens
      if (isSponsored && signerAddresses.includes(senderAddress)) {
        return {
          isValid: false,
          invalidReason: "invalid_exact_aptos_payload_fee_payer_transferring_funds",
          payer: senderAddress,
        };
      }

      // Step 5: Verify the transaction has not expired
      const EXPIRATION_BUFFER_SECONDS = 5;
      const expirationTimestamp = Number(transaction.rawTransaction.expiration_timestamp_secs);
      if (expirationTimestamp < Math.floor(Date.now() / 1000) + EXPIRATION_BUFFER_SECONDS) {
        return {
          isValid: false,
          invalidReason: "invalid_exact_aptos_payload_transaction_expired",
          payer: senderAddress,
        };
      }

      // Step 6: Verify the transaction contains a fungible asset transfer operation
      // We accept both primary_fungible_store::transfer and fungible_asset::transfer:
      // - primary_fungible_store::transfer operates on primary stores (the default store for each asset)
      //   and automatically creates the recipient's store if it doesn't exist
      // - fungible_asset::transfer is a lower-level function for arbitrary store-to-store transfers
      //   and is more gas efficient when stores already exist
      if (!entryFunction) {
        return {
          isValid: false,
          invalidReason: "invalid_exact_aptos_payload_missing_entry_function",
          payer: senderAddress,
        };
      }

      const moduleAddress = entryFunction.module_name.address;
      const moduleName = entryFunction.module_name.name.identifier;
      const functionName = entryFunction.function_name.identifier;

      const isPrimaryFungibleStore =
        AccountAddress.ONE.equals(moduleAddress) &&
        moduleName === "primary_fungible_store" &&
        functionName === "transfer";

      const isFungibleAsset =
        AccountAddress.ONE.equals(moduleAddress) &&
        moduleName === "fungible_asset" &&
        functionName === "transfer";

      if (!isPrimaryFungibleStore && !isFungibleAsset) {
        return {
          isValid: false,
          invalidReason: "invalid_exact_aptos_payload_wrong_function",
          payer: senderAddress,
        };
      }

      if (entryFunction.type_args.length !== 1) {
        return {
          isValid: false,
          invalidReason: "invalid_exact_aptos_payload_wrong_type_args",
          payer: senderAddress,
        };
      }

      const args = entryFunction.args;
      if (args.length !== 3) {
        return {
          isValid: false,
          invalidReason: "invalid_exact_aptos_payload_wrong_args",
          payer: senderAddress,
        };
      }

      const [faAddressArg, recipientAddressArg, amountArg] = args;

      // Step 7: Verify the transfer is for the correct asset
      const faAddress = AccountAddress.from(faAddressArg.bcsToBytes());
      if (!faAddress.equals(AccountAddress.from(requirements.asset))) {
        return {
          isValid: false,
          invalidReason: "invalid_exact_aptos_payload_asset_mismatch",
          payer: senderAddress,
        };
      }

      // Step 8: Verify the transfer amount matches
      const amount = new Deserializer(amountArg.bcsToBytes()).deserializeU64().toString(10);
      if (amount !== requirements.amount) {
        return {
          isValid: false,
          invalidReason: "invalid_exact_aptos_payload_amount_mismatch",
          payer: senderAddress,
        };
      }

      // Step 9: Verify the transfer recipient matches
      const recipientAddress = AccountAddress.from(recipientAddressArg.bcsToBytes());
      if (!recipientAddress.equals(AccountAddress.from(requirements.payTo))) {
        return {
          isValid: false,
          invalidReason: "invalid_exact_aptos_payload_recipient_mismatch",
          payer: senderAddress,
        };
      }

      // Step 10: Verify the sender has sufficient balance
      const aptos = createAptosClient(requirements.network);
      const balance = await aptos.getCurrentFungibleAssetBalances({
        options: {
          where: {
            owner_address: { _eq: senderAddress },
            asset_type: { _eq: requirements.asset },
          },
        },
      });
      const currentBalance = BigInt(balance[0]?.amount ?? 0);
      if (currentBalance < BigInt(requirements.amount)) {
        return {
          isValid: false,
          invalidReason: "invalid_exact_aptos_payload_insufficient_balance",
          payer: senderAddress,
        };
      }

      // Step 11: Simulate the transaction
      let publicKey: PublicKey | undefined;
      if (senderAuthenticator.isEd25519()) {
        publicKey = senderAuthenticator.public_key;
      } else if (senderAuthenticator.isSingleKey()) {
        publicKey = senderAuthenticator.public_key;
      } else if (senderAuthenticator.isMultiKey()) {
        publicKey = senderAuthenticator.public_keys;
      }

      const simulationResult = (
        await aptos.transaction.simulate.simple({ signerPublicKey: publicKey, transaction })
      )[0];

      if (!simulationResult.success) {
        return {
          isValid: false,
          invalidReason: `invalid_exact_aptos_payload_simulation_failed: ${simulationResult.vm_status}`,
          payer: senderAddress,
        };
      }

      return { isValid: true, invalidReason: undefined, payer: senderAddress };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        isValid: false,
        invalidReason: `invalid_exact_aptos_payload_verification_error: ${errorMessage}`,
        payer: "",
      };
    }
  }

  /**
   * Settles a payment by submitting the transaction.
   *
   * @param payload - The payment payload to settle
   * @param requirements - The payment requirements
   * @returns Promise resolving to settlement response
   */
  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    const aptosPayload = payload.payload as ExactAptosPayload;

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
      const { transaction, senderAuthenticator } = deserializeAptosPayment(
        aptosPayload.transaction,
      );
      const senderAddress = transaction.rawTransaction.sender.toStringLong();
      const isSponsored = typeof requirements.extra?.feePayer === "string";

      const pendingTxn = isSponsored
        ? await this.signer.signAndSubmitAsFeePayer(
            transaction,
            senderAuthenticator,
            requirements.network,
          )
        : await this.signer.submitTransaction(
            transaction,
            senderAuthenticator,
            requirements.network,
          );

      await this.signer.waitForTransaction(pendingTxn.hash, requirements.network);

      return {
        success: true,
        transaction: pendingTxn.hash,
        network: payload.accepted.network,
        payer: senderAddress,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        errorReason: `transaction_failed: ${errorMessage}`,
        transaction: "",
        network: payload.accepted.network,
        payer: valid.payer || "",
      };
    }
  }
}
