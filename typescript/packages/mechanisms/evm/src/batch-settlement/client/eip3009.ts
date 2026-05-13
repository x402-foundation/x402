import { PaymentRequirements, PaymentPayloadResult } from "@x402/core/types";
import { getAddress } from "viem";
import { ClientEvmSigner } from "../../signer";
import { ChannelConfig, BatchSettlementDepositPayload } from "../types";
import { ERC3009_DEPOSIT_COLLECTOR_ADDRESS, receiveAuthorizationTypes } from "../constants";
import { createNonce, getEvmChainId } from "../../utils";
import { signVoucher } from "./voucher";
import { computeChannelId } from "../utils";
import { buildErc3009DepositNonce } from "../encoding";

/**
 * Creates a deposit payload that bundles an ERC-3009 `receiveWithAuthorization` approval
 * together with a cumulative voucher signature.
 *
 * When the facilitator submits this payload onchain, the contract atomically transfers
 * tokens from the payer into the channel and records the initial voucher.
 *
 * @param signer - Client wallet used to sign the ERC-3009 authorization (`from` = payer).
 * @param x402Version - Protocol version to embed in the payload envelope.
 * @param paymentRequirements - Server-provided payment requirements (asset, network, amount, etc.).
 * @param channelConfig - Immutable channel configuration (payer, receiver, token, …).
 * @param depositAmount - Number of tokens (decimal string) to deposit into the channel.
 * @param maxClaimableAmount - Cumulative ceiling for the accompanying voucher.
 * @param voucherSigner - Optional key that signs the voucher; defaults to `signer` (same as payer).
 * @returns A {@link PaymentPayloadResult} containing the signed deposit + voucher payload.
 */
export async function createBatchSettlementEIP3009DepositPayload(
  signer: ClientEvmSigner,
  x402Version: number,
  paymentRequirements: PaymentRequirements,
  channelConfig: ChannelConfig,
  depositAmount: string,
  maxClaimableAmount: string,
  voucherSigner?: ClientEvmSigner,
): Promise<PaymentPayloadResult> {
  const salt = createNonce();
  const now = Math.floor(Date.now() / 1000);
  const chainId = getEvmChainId(paymentRequirements.network);

  if (!paymentRequirements.extra?.name || !paymentRequirements.extra?.version) {
    throw new Error(
      `EIP-712 domain parameters (name, version) are required in payment requirements for asset ${paymentRequirements.asset}`,
    );
  }

  const { name, version } = paymentRequirements.extra;

  const channelId = computeChannelId(channelConfig, paymentRequirements.network);

  const erc3009Nonce = buildErc3009DepositNonce(channelId, salt);

  const signature = await signer.signTypedData({
    domain: {
      name,
      version,
      chainId,
      verifyingContract: getAddress(paymentRequirements.asset),
    },
    types: receiveAuthorizationTypes,
    primaryType: "ReceiveWithAuthorization",
    message: {
      from: getAddress(signer.address),
      to: getAddress(ERC3009_DEPOSIT_COLLECTOR_ADDRESS),
      value: BigInt(depositAmount),
      validAfter: BigInt(now - 600),
      validBefore: BigInt(now + paymentRequirements.maxTimeoutSeconds),
      nonce: erc3009Nonce,
    },
  });

  const vSigner = voucherSigner ?? signer;
  const voucher = await signVoucher(
    vSigner,
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
        erc3009Authorization: {
          validAfter: (now - 600).toString(),
          validBefore: (now + paymentRequirements.maxTimeoutSeconds).toString(),
          salt,
          signature,
        },
      },
    },
  };

  return {
    x402Version,
    payload,
  };
}
