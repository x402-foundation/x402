import {
  Account,
  Address,
  Chain,
  getAddress,
  Hex,
  parseErc6492Signature,
  parseSignature,
  Transport,
} from "viem";
import { getNetworkId } from "../../../shared";
import { getVersion, getERC20Balance } from "../../../shared/evm";
import {
  usdcABI as abi,
  authorizationTypes,
  config,
  ConnectedClient,
  SignerWallet,
} from "../../../types/shared/evm";
import {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  VerifyResponse,
  ExactEvmPayload,
} from "../../../types/verify";
import { SCHEME } from "../../exact";

/**
 * Verifies a payment payload against the required payment details
 *
 * This function performs several verification steps:
 * - Verifies protocol version compatibility
 * - Validates the permit signature
 * - Confirms USDC contract address is correct for the chain
 * - Checks permit deadline is sufficiently in the future
 * - Verifies client has sufficient USDC balance
 * - Ensures payment amount meets required minimum
 *
 * @param client - The public client used for blockchain interactions
 * @param payload - The signed payment payload containing transfer parameters and signature
 * @param paymentRequirements - The payment requirements that the payload must satisfy
 * @returns A ValidPaymentRequest indicating if the payment is valid and any invalidation reason
 */
export async function verify<
  transport extends Transport,
  chain extends Chain,
  account extends Account | undefined,
>(
  client: ConnectedClient<transport, chain, account>,
  payload: PaymentPayload,
  paymentRequirements: PaymentRequirements,
): Promise<VerifyResponse> {
  /* TODO: work with security team on brainstorming more verification steps
  verification steps:
    - ✅ verify payload version
    - ✅ verify usdc address is correct for the chain
    - ✅ verify permit signature
    - ✅ verify deadline
    - verify nonce is current
    - ✅ verify client has enough funds to cover paymentRequirements.maxAmountRequired
    - ✅ verify value in payload is enough to cover paymentRequirements.maxAmountRequired
    - check min amount is above some threshold we think is reasonable for covering gas
    - verify resource is not already paid for (next version)
    */

  const exactEvmPayload = payload.payload as ExactEvmPayload;

  // Verify payload version
  if (payload.scheme !== SCHEME || paymentRequirements.scheme !== SCHEME) {
    return {
      isValid: false,
      invalidReason: `unsupported_scheme`,
      payer: exactEvmPayload.authorization.from,
    };
  }

  let name: string;
  let chainId: number;
  let erc20Address: Address;
  let version: string;
  try {
    chainId = getNetworkId(payload.network);
    name = paymentRequirements.extra?.name ?? config[chainId.toString()].usdcName;
    erc20Address = paymentRequirements.asset as Address;
    version = paymentRequirements.extra?.version ?? (await getVersion(client));
  } catch {
    return {
      isValid: false,
      invalidReason: `invalid_network`,
      payer: (payload.payload as ExactEvmPayload).authorization.from,
    };
  }
  // Verify permit signature is recoverable for the owner address
  const permitTypedData = {
    types: authorizationTypes,
    primaryType: "TransferWithAuthorization" as const,
    domain: {
      name,
      version,
      chainId,
      verifyingContract: erc20Address,
    },
    message: {
      from: exactEvmPayload.authorization.from,
      to: exactEvmPayload.authorization.to,
      value: exactEvmPayload.authorization.value,
      validAfter: exactEvmPayload.authorization.validAfter,
      validBefore: exactEvmPayload.authorization.validBefore,
      nonce: exactEvmPayload.authorization.nonce,
    },
  };
  const recoveredAddress = await client.verifyTypedData({
    address: exactEvmPayload.authorization.from as Address,
    ...permitTypedData,
    signature: exactEvmPayload.signature as Hex,
  });
  if (!recoveredAddress) {
    return {
      isValid: false,
      invalidReason: "invalid_exact_evm_payload_signature", //"Invalid permit signature",
      payer: exactEvmPayload.authorization.from,
    };
  }

  // Verify that payment was made to the correct address
  if (getAddress(exactEvmPayload.authorization.to) !== getAddress(paymentRequirements.payTo)) {
    return {
      isValid: false,
      invalidReason: "invalid_exact_evm_payload_recipient_mismatch",
      payer: exactEvmPayload.authorization.from,
    };
  }

  // Verify deadline is not yet expired
  // Pad 3 block to account for round tripping
  if (
    BigInt(exactEvmPayload.authorization.validBefore) < BigInt(Math.floor(Date.now() / 1000) + 6)
  ) {
    return {
      isValid: false,
      invalidReason: "invalid_exact_evm_payload_authorization_valid_before", //"Deadline on permit isn't far enough in the future",
      payer: exactEvmPayload.authorization.from,
    };
  }
  // Verify deadline is not yet valid
  if (BigInt(exactEvmPayload.authorization.validAfter) > BigInt(Math.floor(Date.now() / 1000))) {
    return {
      isValid: false,
      invalidReason: "invalid_exact_evm_payload_authorization_valid_after", //"Deadline on permit is in the future",
      payer: exactEvmPayload.authorization.from,
    };
  }
  // Verify client has enough funds to cover paymentRequirements.maxAmountRequired
  const balance = await getERC20Balance(
    client,
    erc20Address,
    exactEvmPayload.authorization.from as Address,
  );
  if (balance < BigInt(paymentRequirements.maxAmountRequired)) {
    return {
      isValid: false,
      invalidReason: "insufficient_funds", //"Client does not have enough funds",
      payer: exactEvmPayload.authorization.from,
    };
  }
  // Verify value in payload is enough to cover paymentRequirements.maxAmountRequired
  if (BigInt(exactEvmPayload.authorization.value) < BigInt(paymentRequirements.maxAmountRequired)) {
    return {
      isValid: false,
      invalidReason: "invalid_exact_evm_payload_authorization_value", //"Value in payload is not enough to cover paymentRequirements.maxAmountRequired",
      payer: exactEvmPayload.authorization.from,
    };
  }

  // Check if smart wallet is deployed
  // Smart wallet signatures are detected by length > 130 (65 bytes = 130 hex chars for EOA)
  const signature = exactEvmPayload.signature;
  const signatureLength = signature.startsWith("0x") ? signature.length - 2 : signature.length;
  const isSmartWallet = signatureLength > 130;

  if (isSmartWallet) {
    const payerAddress = exactEvmPayload.authorization.from as Address;
    const bytecode = await client.getCode({ address: payerAddress });

    if (!bytecode || bytecode === "0x") {
      // Wallet is not deployed. Check if it's EIP-6492 with deployment info.
      // EIP-6492 signatures contain factory address and calldata needed for deployment.
      // Non-EIP-6492 undeployed wallets cannot succeed (no way to deploy them).
      const erc6492Data = parseErc6492Signature(exactEvmPayload.signature as Hex);
      const hasDeploymentInfo = erc6492Data.address && erc6492Data.data;

      if (!hasDeploymentInfo) {
        // Non-EIP-6492 undeployed smart wallet - will always fail at settlement
        // since EIP-3009 requires on-chain EIP-1271 validation
        return {
          isValid: false,
          invalidReason: "invalid_exact_evm_payload_undeployed_smart_wallet",
          payer: payerAddress,
        };
      }
      // EIP-6492 signature with deployment info - allow through
      // Facilitators with sponsored deployment support can handle this in settle()
    }
  }

  return {
    isValid: true,
    invalidReason: undefined,
    payer: exactEvmPayload.authorization.from,
  };
}

/**
 * Settles a payment by executing a USDC transferWithAuthorization transaction
 *
 * This function executes the actual USDC transfer using the signed authorization from the user.
 * The facilitator wallet submits the transaction but does not need to hold or transfer any tokens itself.
 *
 * @param wallet - The facilitator wallet that will submit the transaction
 * @param paymentPayload - The signed payment payload containing the transfer parameters and signature
 * @param paymentRequirements - The original payment details that were used to create the payload
 * @returns A PaymentExecutionResponse containing the transaction status and hash
 */
export async function settle<transport extends Transport, chain extends Chain>(
  wallet: SignerWallet<chain, transport>,
  paymentPayload: PaymentPayload,
  paymentRequirements: PaymentRequirements,
): Promise<SettleResponse> {
  const payload = paymentPayload.payload as ExactEvmPayload;

  // re-verify to ensure the payment is still valid
  const valid = await verify(wallet, paymentPayload, paymentRequirements);

  if (!valid.isValid) {
    return {
      success: false,
      network: paymentPayload.network,
      transaction: "",
      errorReason: valid.invalidReason ?? "invalid_scheme", //`Payment is no longer valid: ${valid.invalidReason}`,
      payer: payload.authorization.from,
    };
  }

  // Check if smart wallet is deployed before attempting settlement
  // EIP-3009's transferWithAuthorization requires on-chain signature validation via EIP-1271,
  // which fails for undeployed contracts.
  //
  // Note: If we reach this point with an undeployed wallet, it must be an EIP-6492 signature
  // (non-EIP-6492 undeployed wallets are rejected earlier in verify()).
  //
  // Facilitators that want to support undeployed EIP-6492 smart wallets should:
  // 1. Parse the EIP-6492 signature to extract factory address and calldata
  // 2. Deploy the wallet by calling the factory
  // 3. Verify deployment succeeded
  // 4. Then proceed with the transfer below
  const signature = payload.signature;
  const signatureLength = signature.startsWith("0x") ? signature.length - 2 : signature.length;
  const isSmartWallet = signatureLength > 130;

  if (isSmartWallet) {
    const bytecode = await wallet.getCode({ address: payload.authorization.from as Address });
    if (!bytecode || bytecode === "0x") {
      return {
        success: false,
        network: paymentPayload.network,
        transaction: "",
        errorReason: "invalid_exact_evm_payload_undeployed_smart_wallet",
        payer: payload.authorization.from,
      };
    }
  }

  let tx: Hex;

  if (isSmartWallet) {
    // Smart wallets: Use bytes signature overload (requires FiatToken v2.0+)
    // Unwrap EIP-6492 if present (no-op for regular signatures)
    const { signature: unwrappedSignature } = parseErc6492Signature(payload.signature as Hex);

    tx = await wallet.writeContract({
      address: paymentRequirements.asset as Address,
      abi,
      functionName: "transferWithAuthorization" as const,
      args: [
        payload.authorization.from as Address,
        payload.authorization.to as Address,
        BigInt(payload.authorization.value),
        BigInt(payload.authorization.validAfter),
        BigInt(payload.authorization.validBefore),
        payload.authorization.nonce as Hex,
        unwrappedSignature,
      ],
      chain: wallet.chain as Chain,
    });
  } else {
    // EOA: Use (v, r, s) overload for maximum compatibility
    const parsedSig = parseSignature(payload.signature as Hex);
    const v = parsedSig.v !== undefined ? Number(parsedSig.v) : 27 + parsedSig.yParity;

    tx = await wallet.writeContract({
      address: paymentRequirements.asset as Address,
      abi,
      functionName: "transferWithAuthorization" as const,
      args: [
        payload.authorization.from as Address,
        payload.authorization.to as Address,
        BigInt(payload.authorization.value),
        BigInt(payload.authorization.validAfter),
        BigInt(payload.authorization.validBefore),
        payload.authorization.nonce as Hex,
        v,
        parsedSig.r,
        parsedSig.s,
      ],
      chain: wallet.chain as Chain,
    });
  }

  const receipt = await wallet.waitForTransactionReceipt({ hash: tx });

  if (receipt.status !== "success") {
    return {
      success: false,
      errorReason: "invalid_transaction_state", //`Transaction failed`,
      transaction: tx,
      network: paymentPayload.network,
      payer: payload.authorization.from,
    };
  }

  return {
    success: true,
    transaction: tx,
    network: paymentPayload.network,
    payer: payload.authorization.from,
  };
}
