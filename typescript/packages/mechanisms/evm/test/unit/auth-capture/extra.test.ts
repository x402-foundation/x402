import { describe, it, expect } from "vitest";
import { zeroAddress } from "viem";
import {
  AUTH_CAPTURE_DEPLOYMENT_V1_0,
  AUTH_CAPTURE_DEPLOYMENT_V1_1,
  AUTH_CAPTURE_ESCROW_V1_0_ADDRESS,
} from "../../../src/auth-capture/constants";
import * as Errors from "../../../src/auth-capture/errors";
import {
  captureEscrowArgs,
  captureFeeFromPayload,
  chargeEscrowArgs,
  chargeFeeFromCollectPayload,
  defaultSubmittedFee,
  feeFieldMatchesDeployment,
  parseAuthCaptureExtra,
  submittedFeeAmount,
  validateOperator,
  validateSubmittedFee,
  verifyCommon,
} from "../../../src/auth-capture/extra";
import { paymentInfoToContractTuple } from "../../../src/auth-capture/utils";
import type { NormalizedAuthCaptureExtra } from "../../../src/auth-capture/extra";

const FUTURE = Math.floor(Date.now() / 1000) + 86400;

function baseExtra(overrides: Record<string, unknown> = {}) {
  return {
    captureAuthorizer: "0xcccccccccccccccccccccccccccccccccccccccc",
    captureDeadline: FUTURE,
    refundDeadline: FUTURE + 86400,
    feeRecipient: "0x4444444444444444444444444444444444444444",
    minFeeBps: 10,
    maxFeeBps: 100,
    name: "USDC",
    version: "2",
    ...overrides,
  };
}

function parseOk(overrides: Record<string, unknown> = {}): NormalizedAuthCaptureExtra {
  const parsed = parseAuthCaptureExtra(baseExtra(overrides));
  if ("error" in parsed) {
    throw new Error(`expected parse ok, got ${parsed.error}`);
  }
  return parsed.extra;
}

describe("parseAuthCaptureExtra", () => {
  it("rejects removed autoCapture flag", () => {
    const result = parseAuthCaptureExtra({ ...baseExtra(), autoCapture: true });
    expect(result).toEqual({ error: Errors.ErrUnsupportedPaymentFlow });
  });

  it("rejects unknown escrow pins", () => {
    const result = parseAuthCaptureExtra({
      ...baseExtra(),
      authCaptureEscrow: "0x0000000000000000000000000000000000000001",
    });
    expect(result).toEqual({ error: Errors.ErrInvalidAuthCaptureExtra });
  });

  it("rejects unsupported assetTransferMethod values", () => {
    expect(parseAuthCaptureExtra({ ...baseExtra(), assetTransferMethod: "transfer" })).toEqual({
      error: Errors.ErrUnsupportedAssetTransferMethod,
    });
  });

  it("rejects unsupported paymentFlow and captureMode values", () => {
    expect(parseAuthCaptureExtra({ ...baseExtra(), paymentFlow: "hold" })).toEqual({
      error: Errors.ErrUnsupportedPaymentFlow,
    });
    expect(parseAuthCaptureExtra({ ...baseExtra(), captureMode: "later" })).toEqual({
      error: Errors.ErrInvalidAuthCaptureExtra,
    });
  });

  it("rejects policy operator type and unknown operator types", () => {
    expect(parseAuthCaptureExtra({ ...baseExtra(), operatorType: "policy" })).toEqual({
      error: Errors.ErrUnsupportedOperatorType,
    });
    expect(parseAuthCaptureExtra({ ...baseExtra(), operatorType: "relay" })).toEqual({
      error: Errors.ErrUnsupportedOperatorType,
    });
  });

  it("rejects inverted fee bounds and non-integer bps", () => {
    expect(parseAuthCaptureExtra({ ...baseExtra(), minFeeBps: 200, maxFeeBps: 100 })).toEqual({
      error: Errors.ErrInvalidAuthCaptureExtra,
    });
    expect(parseAuthCaptureExtra({ ...baseExtra(), minFeeBps: 1.5 })).toEqual({
      error: Errors.ErrInvalidAuthCaptureExtra,
    });
  });

  it("rejects non-zero fees when feeRecipient is the zero address", () => {
    const result = parseAuthCaptureExtra({
      ...baseExtra(),
      feeRecipient: zeroAddress,
      minFeeBps: 1,
      maxFeeBps: 10,
    });
    expect(result).toEqual({ error: Errors.ErrInvalidAuthCaptureExtra });
  });

  it("requires receiverAuthorizer on authorization flow", () => {
    const result = parseAuthCaptureExtra({
      ...baseExtra(),
      paymentFlow: "authorization",
      receiverAuthorizer: zeroAddress,
    });
    expect(result).toEqual({ error: Errors.ErrMissingReceiverAuthorizer });
  });

  it("normalizes v1.0 escrow pin into deployment metadata", () => {
    const { extra } = parseAuthCaptureExtra({
      ...baseExtra(),
      authCaptureEscrow: AUTH_CAPTURE_ESCROW_V1_0_ADDRESS,
    }) as { extra: NormalizedAuthCaptureExtra };
    expect(extra.deployment).toEqual(AUTH_CAPTURE_DEPLOYMENT_V1_0);
    expect(extra.authCaptureEscrow).toBe(AUTH_CAPTURE_ESCROW_V1_0_ADDRESS);
  });

  it("defaults to v1.1 deployment when escrow is omitted", () => {
    const extra = parseOk();
    expect(extra.deployment).toEqual(AUTH_CAPTURE_DEPLOYMENT_V1_1);
  });
});

describe("validateSubmittedFee", () => {
  it("rejects v1.0 fee bps outside published bounds", () => {
    const extra = parseOk({ minFeeBps: 50, maxFeeBps: 100 });
    expect(
      validateSubmittedFee(extra, "1000000", {
        version: "v1.0",
        feeBps: 10,
        feeReceiver: extra.feeRecipient,
      }),
    ).toBe(Errors.ErrFeeBpsOutOfRange);
  });

  it("rejects v1.1 absolute fee above the max bps-derived amount", () => {
    const extra = parseOk({ minFeeBps: 0, maxFeeBps: 100 });
    expect(
      validateSubmittedFee(extra, "1000000", {
        version: "v1.1",
        feeAmount: "20000",
        feeReceiver: extra.feeRecipient,
      }),
    ).toBe(Errors.ErrFeeBpsOutOfRange);
  });

  it("rejects a mismatched fee receiver when extra pins a non-zero recipient", () => {
    const extra = parseOk();
    expect(
      validateSubmittedFee(extra, "1000000", {
        version: "v1.1",
        feeAmount: "5000",
        feeReceiver: zeroAddress,
      }),
    ).toBe(Errors.ErrInvalidFeeReceiver);
  });

  it("accepts in-range v1.1 absolute fee", () => {
    const extra = parseOk({ minFeeBps: 0, maxFeeBps: 100 });
    expect(
      validateSubmittedFee(extra, "1000000", {
        version: "v1.1",
        feeAmount: "5000",
        feeReceiver: extra.feeRecipient,
      }),
    ).toBeUndefined();
  });

  it("rejects non-zero v1.1 fee when the fee receiver is the zero address", () => {
    const extra = { ...parseOk(), feeRecipient: zeroAddress };
    expect(
      validateSubmittedFee(extra, "1000000", {
        version: "v1.1",
        feeAmount: "5000",
        feeReceiver: zeroAddress,
      }),
    ).toBe(Errors.ErrZeroFeeReceiver);
  });
});

describe("validateOperator", () => {
  const submitters = ["0xcccccccccccccccccccccccccccccccccccccccc"] as const;

  it("rejects custom operators that are not on the facilitator allowlist", () => {
    const extra = parseOk({
      operatorType: "custom",
      captureAuthorizer: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
    expect(validateOperator(extra, [], { operators: [] }, false)).toBe(
      Errors.ErrOperatorNotAdmitted,
    );
  });

  it("rejects delegated operators that are not facilitator submitters", () => {
    const extra = parseOk();
    expect(
      validateOperator(extra, ["0x0000000000000000000000000000000000000001"], undefined, false),
    ).toBe(Errors.ErrOperatorNotAdmitted);
  });

  it("blocks lifecycle relay for custom operators", () => {
    const extra = parseOk({
      operatorType: "custom",
      captureAuthorizer: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
    expect(
      validateOperator(
        extra,
        submitters,
        { operators: [{ operatorType: "custom", address: "*" }] },
        true,
      ),
    ).toBe(Errors.ErrLifecycleNotRelayed);
  });

  it("blocks delegated lifecycle relay when no receiver authorizer is configured", () => {
    const extra = parseOk({ receiverAuthorizer: zeroAddress });
    expect(validateOperator(extra, submitters, undefined, true)).toBe(
      Errors.ErrLifecycleNotRelayed,
    );
  });

  it("rejects non-zero policy addresses", () => {
    const extra = parseOk({ policy: "0x2222222222222222222222222222222222222222" });
    expect(validateOperator(extra, submitters, undefined, false)).toBe(Errors.ErrInvalidPolicy);
  });
});

describe("fee encoding helpers", () => {
  it("matches deployment version to wire fee fields", () => {
    expect(feeFieldMatchesDeployment(AUTH_CAPTURE_DEPLOYMENT_V1_0, { feeBps: 0 })).toBe(true);
    expect(feeFieldMatchesDeployment(AUTH_CAPTURE_DEPLOYMENT_V1_0, { feeAmount: "1" })).toBe(false);
    expect(feeFieldMatchesDeployment(AUTH_CAPTURE_DEPLOYMENT_V1_1, { feeAmount: "1" })).toBe(true);
  });

  it("derives default submitted fee per deployment version", () => {
    const v10 = parseOk({ authCaptureEscrow: AUTH_CAPTURE_ESCROW_V1_0_ADDRESS, minFeeBps: 25 });
    expect(defaultSubmittedFee(v10, "1000000")).toEqual({
      version: "v1.0",
      feeBps: 25,
      feeReceiver: v10.feeRecipient,
    });
    const v11 = parseOk({ minFeeBps: 50 });
    expect(defaultSubmittedFee(v11, "1000000")).toEqual({
      version: "v1.1",
      feeAmount: "5000",
      feeReceiver: v11.feeRecipient,
    });
  });

  it("converts submitted fee to atomic amount for balance checks", () => {
    expect(
      submittedFeeAmount({ version: "v1.0", feeBps: 100, feeReceiver: zeroAddress }, 1_000_000n),
    ).toBe(10_000n);
    expect(
      submittedFeeAmount(
        { version: "v1.1", feeAmount: "123", feeReceiver: zeroAddress },
        1_000_000n,
      ),
    ).toBe(123n);
  });

  it("builds escrow capture and charge args for each deployment", () => {
    const tuple = paymentInfoToContractTuple({
      operator: "0xcccccccccccccccccccccccccccccccccccccccc",
      payer: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      receiver: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      token: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      maxAmount: "1000000",
      preApprovalExpiry: FUTURE,
      authorizationExpiry: FUTURE + 100,
      refundExpiry: FUTURE + 200,
      minFeeBps: 0,
      maxFeeBps: 100,
      feeReceiver: "0x4444444444444444444444444444444444444444",
      salt: "0x" + "11".repeat(32),
    });
    const feeRecipient = "0x4444444444444444444444444444444444444444" as `0x${string}`;
    expect(
      captureEscrowArgs(tuple, 500_000n, {
        version: "v1.0",
        feeBps: 10,
        feeReceiver: feeRecipient,
      }),
    ).toEqual([tuple, 500_000n, 10, feeRecipient]);
    expect(
      captureEscrowArgs(tuple, 500_000n, {
        version: "v1.1",
        feeAmount: "99",
        feeReceiver: feeRecipient,
      }),
    ).toEqual([tuple, 500_000n, 99n, feeRecipient]);
    const collector = "0xdddddddddddddddddddddddddddddddddddddddd" as `0x${string}`;
    const data = "0x1234" as `0x${string}`;
    expect(
      chargeEscrowArgs(tuple, 1n, collector, data, {
        version: "v1.0",
        feeBps: 0,
        feeReceiver: feeRecipient,
      }),
    ).toEqual([tuple, 1n, collector, data, 0, feeRecipient]);
  });

  it("reads capture and charge fees only when wire fields match deployment", () => {
    const v11 = parseOk();
    expect(
      captureFeeFromPayload(v11, {
        feeBps: 1,
        feeReceiver: v11.feeRecipient,
      }),
    ).toBeUndefined();
    expect(
      captureFeeFromPayload(v11, {
        feeAmount: "10",
        feeReceiver: v11.feeRecipient,
      }),
    ).toEqual({ version: "v1.1", feeAmount: "10", feeReceiver: v11.feeRecipient });
    expect(
      chargeFeeFromCollectPayload(v11, { feeAmount: "10", feeReceiver: v11.feeRecipient }),
    ).toEqual({ version: "v1.1", feeAmount: "10", feeReceiver: v11.feeRecipient });
  });
});

describe("verifyCommon", () => {
  const requirements = {
    scheme: "auth-capture",
    network: "eip155:84532",
    amount: "1",
    asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    payTo: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    maxTimeoutSeconds: 60,
    extra: baseExtra(),
  };

  it("rejects scheme and network mismatches before parsing extra", () => {
    expect(
      verifyCommon("exact", "eip155:84532", requirements, "auth-capture", [], undefined, false),
    ).toEqual({ error: Errors.ErrUnsupportedScheme });
    expect(
      verifyCommon("auth-capture", "eip155:1", requirements, "auth-capture", [], undefined, false),
    ).toEqual({ error: Errors.ErrNetworkMismatch });
  });

  it("rejects invalid CAIP-2 network strings", () => {
    const badNetworkRequirements = { ...requirements, network: "not-a-network" };
    expect(
      verifyCommon(
        "auth-capture",
        "not-a-network",
        badNetworkRequirements,
        "auth-capture",
        [],
        undefined,
        false,
      ),
    ).toEqual({ error: Errors.ErrInvalidNetwork });
  });

  it("returns normalized extra when checks pass", () => {
    const submitters = [baseExtra().captureAuthorizer as `0x${string}`];
    const result = verifyCommon(
      "auth-capture",
      "eip155:84532",
      requirements,
      "auth-capture",
      submitters,
      undefined,
      false,
    );
    expect("extra" in result).toBe(true);
  });
});
