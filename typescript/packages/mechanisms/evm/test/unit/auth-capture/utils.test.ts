import { describe, it, expect } from "vitest";
import {
  AUTH_CAPTURE_DEPLOYMENT_V1_0,
  AUTH_CAPTURE_DEPLOYMENT_V1_1,
} from "../../../src/auth-capture/constants";
import type {
  AuthCaptureExtra,
  Eip3009Payload,
  Permit2Payload,
} from "../../../src/auth-capture/types";
import {
  paymentInfoToContractTuple,
  reconstructPaymentInfo,
  unpackForSettle,
} from "../../../src/auth-capture/utils";
import type { PaymentRequirements } from "@x402/core/types";

const PAYER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as `0x${string}`;
const SALT = "0x0000000000000000000000000000000000000000000000000000000000000abc" as `0x${string}`;
const EXTRA: AuthCaptureExtra = {
  captureAuthorizer: "0xcccccccccccccccccccccccccccccccccccccccc",
  captureDeadline: 1_800_000_000,
  refundDeadline: 1_900_000_000,
  feeRecipient: "0x4444444444444444444444444444444444444444",
  minFeeBps: 10,
  maxFeeBps: 250,
  name: "USDC",
  version: "2",
};

const REQUIREMENTS: PaymentRequirements = {
  scheme: "auth-capture",
  network: "eip155:84532",
  amount: "1000000",
  asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  payTo: "0x1234567890123456789012345678901234567890",
  maxTimeoutSeconds: 3600,
  extra: EXTRA,
};

describe("reconstructPaymentInfo", () => {
  it("maps wire extra + requirements onto the onchain PaymentInfo field names", () => {
    const info = reconstructPaymentInfo(PAYER, 1_700_000_000, SALT, REQUIREMENTS, EXTRA);

    expect(info).toEqual({
      operator: EXTRA.captureAuthorizer,
      payer: PAYER,
      receiver: REQUIREMENTS.payTo,
      token: REQUIREMENTS.asset,
      maxAmount: REQUIREMENTS.amount,
      preApprovalExpiry: 1_700_000_000,
      authorizationExpiry: EXTRA.captureDeadline,
      refundExpiry: EXTRA.refundDeadline,
      minFeeBps: EXTRA.minFeeBps,
      maxFeeBps: EXTRA.maxFeeBps,
      feeReceiver: EXTRA.feeRecipient,
      salt: SALT,
    });
  });

  it("uses the client-signed maxAmount when it differs from requirements.amount", () => {
    const info = reconstructPaymentInfo(PAYER, 1, SALT, REQUIREMENTS, EXTRA, "42");
    expect(info.maxAmount).toBe("42");
  });
});

describe("paymentInfoToContractTuple", () => {
  it("coerces string maxAmount and salt into bigints for viem encoding", () => {
    const info = reconstructPaymentInfo(PAYER, 99, SALT, REQUIREMENTS, EXTRA);
    const tuple = paymentInfoToContractTuple(info);

    expect(tuple.maxAmount).toBe(1000000n);
    expect(tuple.salt).toBe(BigInt(SALT));
    expect(tuple.operator).toBe(info.operator);
    expect(tuple.payer).toBe(info.payer);
  });
});

describe("unpackForSettle", () => {
  it("unpacks EIP-3009 collect inputs and routes to the v1.1 EIP-3009 collector", () => {
    const payload: Eip3009Payload = {
      authorization: {
        from: PAYER,
        to: AUTH_CAPTURE_DEPLOYMENT_V1_1.eip3009Collector,
        value: "250000",
        validAfter: "0",
        validBefore: "1700000600",
        nonce: "0x1111111111111111111111111111111111111111111111111111111111111111",
      },
      signature: "0xdeadbeef",
      salt: SALT,
    };

    expect(unpackForSettle(payload, "eip3009", AUTH_CAPTURE_DEPLOYMENT_V1_1)).toEqual({
      preApprovalExpiry: 1700000600,
      amount: 250000n,
      tokenCollector: AUTH_CAPTURE_DEPLOYMENT_V1_1.eip3009Collector,
      collectorData: "0xdeadbeef",
    });
  });

  it("unpacks Permit2 collect inputs and routes to the matching deployment collector", () => {
    const payload: Permit2Payload = {
      permit2Authorization: {
        from: PAYER,
        permitted: { token: REQUIREMENTS.asset as `0x${string}`, amount: "777" },
        spender: AUTH_CAPTURE_DEPLOYMENT_V1_0.permit2Collector,
        nonce: "12345",
        deadline: "1800000000",
      },
      signature: "0xcafebabe",
      salt: SALT,
    };

    expect(unpackForSettle(payload, "permit2", AUTH_CAPTURE_DEPLOYMENT_V1_0)).toEqual({
      preApprovalExpiry: 1800000000,
      amount: 777n,
      tokenCollector: AUTH_CAPTURE_DEPLOYMENT_V1_0.permit2Collector,
      collectorData: "0xcafebabe",
    });
  });

  it("passes the raw signature through so an ERC-6492 wrapper is not stripped before collect", () => {
    const wrapped = ("0x" + "ab".repeat(80)) as `0x${string}`;
    const payload: Eip3009Payload = {
      authorization: {
        from: PAYER,
        to: AUTH_CAPTURE_DEPLOYMENT_V1_1.eip3009Collector,
        value: "1",
        validAfter: "0",
        validBefore: "9",
        nonce: "0x2222222222222222222222222222222222222222222222222222222222222222",
      },
      signature: wrapped,
      salt: SALT,
    };

    expect(unpackForSettle(payload, "eip3009", AUTH_CAPTURE_DEPLOYMENT_V1_1).collectorData).toBe(
      wrapped,
    );
  });
});
