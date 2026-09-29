import { PaymentRequirements, PaymentPayloadResult } from "@x402/core/types";
import { getAddress } from "viem";
import { PERMIT2_ADDRESS } from "../../constants";
import { ClientEvmSigner } from "../../signer";
import { createPermit2Nonce, getEvmChainId } from "../../utils";
import { PERMIT2_DEPOSIT_COLLECTOR_ADDRESS, batchPermit2WitnessTypes } from "../constants";
import { ChannelConfig, BatchSettlementDepositPayload } from "../types";
import { computeChannelId } from "../utils";
import { signVoucher } from "./voucher";

/**
 * Builds a batch deposit payload using a channel-bound Permit2 witness transfer.
 *
 * @param signer - Payer signer for the Permit2 authorization.
 * @param x402Version - Protocol version for the payment envelope.
 * @param paymentRequirements - Server-provided payment requirements.
 * @param channelConfig - Channel configuration bound into the voucher and witness.
 * @param depositAmount - Token amount deposited into the channel.
 * @param maxClaimableAmount - Cumulative amount signed in the voucher.
 * @param voucherSigner - Optional signer for the voucher.
 * @returns Signed deposit payload and voucher.
 */
export async function createBatchSettlementPermit2DepositPayload(
  signer: ClientEvmSigner,
  x402Version: number,
  paymentRequirements: PaymentRequirements,
  channelConfig: ChannelConfig,
  depositAmount: string,
  maxClaimableAmount: string,
  voucherSigner?: ClientEvmSigner,
): Promise<PaymentPayloadResult> {
  const chainId = getEvmChainId(paymentRequirements.network);
  const nonce = createPermit2Nonce();
  const deadline = Math.floor(Date.now() / 1000 + paymentRequirements.maxTimeoutSeconds).toString();
  const channelId = computeChannelId(channelConfig, paymentRequirements.network);

  const permit2Authorization = {
    from: signer.address,
    permitted: {
      token: getAddress(paymentRequirements.asset),
      amount: depositAmount,
    },
    spender: getAddress(PERMIT2_DEPOSIT_COLLECTOR_ADDRESS),
    nonce,
    deadline,
    witness: {
      channelId,
    },
  };

  const signature = await signer.signTypedData({
    domain: { name: "Permit2", chainId, verifyingContract: PERMIT2_ADDRESS },
    types: batchPermit2WitnessTypes,
    primaryType: "PermitWitnessTransferFrom",
    message: {
      permitted: {
        token: permit2Authorization.permitted.token,
        amount: BigInt(permit2Authorization.permitted.amount),
      },
      spender: permit2Authorization.spender,
      nonce: BigInt(permit2Authorization.nonce),
      deadline: BigInt(permit2Authorization.deadline),
      witness: {
        channelId,
      },
    },
  });

  const voucher = await signVoucher(
    voucherSigner ?? signer,
    channelId,
    maxClaimableAmount,
    paymentRequirements.network,
  );

  const payload: BatchSettlementDepositPayload = {
    type: "deposit",
    channelConfig,
    voucher,
    deposit: {
      amount: depositAmount,
      authorization: {
        permit2Authorization: {
          ...permit2Authorization,
          signature,
        },
      },
    },
  };

  return { x402Version, payload };
}
