import { describe, it, expect, vi } from "vitest";
import { zeroAddress } from "viem";
import { verifyCollect } from "../../../src/auth-capture/facilitator/collect";
import { EIP3009_TOKEN_COLLECTOR_ADDRESS } from "../../../src/auth-capture/constants";
import {
  computePayerAgnosticPaymentInfoHash,
  deriveBoundSalt,
} from "../../../src/auth-capture/nonce";
import type { FacilitatorEvmSigner } from "../../../src/signer";
import type { PaymentInfoStruct } from "../../../src/auth-capture/types";

const ERC1271_MAGIC_VALUE = "0x1626ba7e" as const;
const PAYER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as `0x${string}`;
const ASSET = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as `0x${string}`;
const PAY_TO = "0xdddddddddddddddddddddddddddddddddddddddd" as `0x${string}`;
const CAPTURE_AUTHORIZER = "0x1234567890123456789012345678901234567890" as `0x${string}`;
const RECEIVER_AUTHORIZER = "0x1111111111111111111111111111111111111111" as `0x${string}`;
const FEE_RECIPIENT = "0x4444444444444444444444444444444444444444" as `0x${string}`;
const SALT_NONCE =
  "0x2222222222222222222222222222222222222222222222222222222222222222" as `0x${string}`;
const BOUND_SALT = deriveBoundSalt(RECEIVER_AUTHORIZER, zeroAddress, SALT_NONCE);

const futureSeconds = Math.floor(Date.now() / 1000) + 3600;
const captureDeadline = futureSeconds + 86400;
const refundDeadline = captureDeadline + 86400;

function buildPaymentInfo(): PaymentInfoStruct {
  return {
    operator: CAPTURE_AUTHORIZER,
    payer: PAYER,
    receiver: PAY_TO,
    token: ASSET,
    maxAmount: "1000000",
    preApprovalExpiry: futureSeconds,
    authorizationExpiry: captureDeadline,
    refundExpiry: refundDeadline,
    minFeeBps: 0,
    maxFeeBps: 100,
    feeReceiver: FEE_RECIPIENT,
    salt: BOUND_SALT,
  };
}

function createSigner(): FacilitatorEvmSigner {
  return {
    getAddresses: () => [CAPTURE_AUTHORIZER],
    readContract: vi.fn().mockImplementation(async (args: { functionName: string }) => {
      if (args.functionName === "isValidSignature") return ERC1271_MAGIC_VALUE;
      return BigInt("1000000000");
    }),
    writeContract: vi.fn(),
    waitForTransactionReceipt: vi.fn(),
  } as FacilitatorEvmSigner;
}

describe("verifyCollect", () => {
  it("requires charge-completion fields at settle time on authorization routes", async () => {
    const paymentInfo = buildPaymentInfo();
    const nonce = computePayerAgnosticPaymentInfoHash(84532, paymentInfo);
    const extra = {
      captureAuthorizer: CAPTURE_AUTHORIZER,
      captureDeadline,
      refundDeadline,
      feeRecipient: FEE_RECIPIENT,
      minFeeBps: 0,
      maxFeeBps: 100,
      name: "USDC",
      version: "2",
      receiverAuthorizer: RECEIVER_AUTHORIZER,
      paymentFlow: "authorization" as const,
    };
    const accepted = {
      scheme: "auth-capture",
      network: "eip155:84532",
      amount: "1000000",
      asset: ASSET,
      payTo: PAY_TO,
      maxTimeoutSeconds: 60,
      extra,
    };
    const collect = {
      authorization: {
        from: PAYER,
        to: EIP3009_TOKEN_COLLECTOR_ADDRESS,
        value: "1000000",
        validAfter: "0",
        validBefore: String(futureSeconds),
        nonce,
      },
      signature: "0xabcd" as `0x${string}`,
      salt: BOUND_SALT,
      saltNonce: SALT_NONCE,
    };
    const envelope = { x402Version: 2, accepted, payload: collect };
    const result = await verifyCollect(
      [createSigner()],
      undefined,
      envelope,
      accepted,
      collect,
      undefined,
      true,
    );
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("invalid_auth_capture_evm_payload_format");
  });
});
