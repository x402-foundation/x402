import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeErrorResult,
  getAddress,
  hexToBigInt,
  serializeErc6492Signature,
  type Log,
  zeroAddress,
} from "viem";
import { AuthCaptureEvmScheme } from "../../../src/auth-capture/facilitator/scheme";
import {
  facilitatorAddresses,
  normalizePaymentState,
  PAYMENT_STATE_MAX_ATTEMPTS,
  PAYMENT_STATE_RETRY_DELAYS_MS,
  readPaymentStateForBalances,
  readPaymentStateOnce,
  selectSubmitter,
} from "../../../src/auth-capture/facilitator/utils";
import {
  ESCROW_ABI_WITH_ERRORS,
  ESCROW_EVENTS_ABI_V1_1,
  PAYMENT_INFO_COMPONENTS,
} from "../../../src/auth-capture/abi";
import {
  AUTH_CAPTURE_ESCROW_ADDRESS,
  AUTH_CAPTURE_ESCROW_V1_0_ADDRESS,
  DEFAULT_CUSTOM_OPERATOR_AUTHORIZE_GAS_LIMIT,
  EIP3009_TOKEN_COLLECTOR_ADDRESS,
  EIP3009_TOKEN_COLLECTOR_V1_0_ADDRESS,
  OPERATOR_REFUND_COLLECTOR_ADDRESS,
  PERMIT2_TOKEN_COLLECTOR_ADDRESS,
} from "../../../src/auth-capture/constants";
import {
  computePayerAgnosticPaymentInfoHash,
  computePaymentInfoHash,
  deriveBoundSalt,
} from "../../../src/auth-capture/nonce";
import { paymentInfoToContractTuple } from "../../../src/auth-capture/utils";
import { BUILDER_CODE_KEY } from "../../../src/shared/extensions";
import type { FacilitatorEvmSigner } from "../../../src/signer";
import type { PaymentInfoStruct } from "../../../src/auth-capture/types";

const DEPLOYED_BYTECODE = "0x6080604052" as const;
const ERC1271_MAGIC_VALUE = "0x1626ba7e" as const;
const MOCK_TX_HASH = ("0x" + "ab".repeat(32)) as `0x${string}`;
const TOKEN_STORE = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" as `0x${string}`;
const INITIAL_BALANCE = BigInt("1000000000");

function makeEscrowEventLog(
  eventName: "PaymentAuthorized" | "PaymentCharged",
  paymentInfo: PaymentInfoStruct,
  amount: bigint,
  tokenCollector: `0x${string}`,
  chainId: number,
  fee?: { feeAmount: string | bigint; feeReceiver: `0x${string}` },
): Log {
  const paymentInfoHash = computePaymentInfoHash(chainId, paymentInfo);
  const tuple = paymentInfoToContractTuple(paymentInfo);
  if (eventName === "PaymentAuthorized") {
    const topics = encodeEventTopics({
      abi: ESCROW_EVENTS_ABI_V1_1,
      eventName: "PaymentAuthorized",
      args: { paymentInfoHash },
    });
    const data = encodeAbiParameters(
      [
        { type: "tuple", name: "paymentInfo", components: [...PAYMENT_INFO_COMPONENTS] },
        { type: "uint256", name: "amount" },
        { type: "address", name: "tokenCollector" },
      ],
      [tuple, amount, tokenCollector],
    );
    return {
      address: AUTH_CAPTURE_ESCROW_ADDRESS,
      topics,
      data,
      blockHash: "0x1111111111111111111111111111111111111111111111111111111111111111",
      blockNumber: 1n,
      transactionHash: "0x2222222222222222222222222222222222222222222222222222222222222222",
      transactionIndex: 0,
      logIndex: 0,
      removed: false,
    };
  }

  const topics = encodeEventTopics({
    abi: ESCROW_EVENTS_ABI_V1_1,
    eventName: "PaymentCharged",
    args: { paymentInfoHash },
  });
  const data = encodeAbiParameters(
    [
      { type: "tuple", name: "paymentInfo", components: [...PAYMENT_INFO_COMPONENTS] },
      { type: "uint256", name: "amount" },
      { type: "address", name: "tokenCollector" },
      { type: "uint256", name: "feeAmount" },
      { type: "address", name: "feeReceiver" },
    ],
    [tuple, amount, tokenCollector, BigInt(fee!.feeAmount), fee!.feeReceiver],
  );
  return {
    address: AUTH_CAPTURE_ESCROW_ADDRESS,
    topics,
    data,
    blockHash: "0x1111111111111111111111111111111111111111111111111111111111111111",
    blockNumber: 1n,
    transactionHash: "0x2222222222222222222222222222222222222222222222222222222222222222",
    transactionIndex: 0,
    logIndex: 0,
    removed: false,
  };
}

describe("AuthCaptureEvmScheme", () => {
  /**
   * Signature verification mirrors on-chain SignatureChecker: it reads the
   * payer's bytecode and, for addresses with code, calls ERC-1271
   * `isValidSignature`. The payer here is a deployed smart account so the
   * fixtures' placeholder signatures verify without real ECDSA material, while
   * every other address (notably `captureAuthorizer`) reads as an EOA so
   * `resolveSettleTarget` targets the canonical escrow.
   */
  const createMockSigner = (
    addresses: readonly `0x${string}`[] = ["0x1234567890123456789012345678901234567890"],
  ) => ({
    getAddresses: () => addresses,
    readContract: vi.fn().mockImplementation(async (args: { functionName: string }) => {
      if (args?.functionName === "isValidSignature") return ERC1271_MAGIC_VALUE;
      if (args?.functionName === "getTokenStore") return TOKEN_STORE;
      if (args?.functionName === "paymentState") {
        return {
          hasCollectedPayment: true,
          capturableAmount: BigInt("1000000"),
          refundableAmount: 0n,
        };
      }
      return INITIAL_BALANCE;
    }),
    writeContract: vi.fn().mockResolvedValue(MOCK_TX_HASH),
    verifyTypedData: vi.fn().mockResolvedValue(true),
    sendTransaction: vi.fn(),
    waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: "success" }),
    getCode: vi.fn().mockImplementation(async ({ address }: { address: `0x${string}` }) => {
      const lower = address.toLowerCase();
      if (lower === PAYER.toLowerCase() || lower === RECEIVER_AUTHORIZER.toLowerCase()) {
        return DEPLOYED_BYTECODE;
      }
      return "0x";
    }),
  });

  let mockSigner: ReturnType<typeof createMockSigner>;

  function installCustomOperatorSimulation(opts: {
    paymentInfo: PaymentInfoStruct;
    amount?: bigint;
    tokenCollector?: `0x${string}`;
    functionName?: "authorize" | "charge";
    gasUsed?: bigint;
    logs?: Log[];
    forwardedStatus?: "success" | "failure";
    postState?: {
      hasCollectedPayment: boolean;
      capturableAmount: bigint;
      refundableAmount: bigint;
    };
    payerDelta?: bigint;
    tokenStoreDelta?: bigint;
    receiverDelta?: bigint;
    feeReceiverDelta?: bigint;
    facilitatorDelta?: bigint;
    settledPayerDelta?: bigint;
    settledTokenStoreDelta?: bigint;
    settledReceiverDelta?: bigint;
    settledFeeReceiverDelta?: bigint;
    settledFacilitatorDelta?: bigint;
    facilitatorAddress?: `0x${string}`;
    feeAmount?: string | bigint;
    feeReceiver?: `0x${string}`;
    receiptLogs?: Log[];
    rejectDataSuffix?: `0x${string}`;
  }) {
    const amount = opts.amount ?? BigInt("1000000");
    const tokenCollector = opts.tokenCollector ?? EIP3009_TOKEN_COLLECTOR_ADDRESS;
    const functionName = opts.functionName ?? "authorize";
    const feeAmount = opts.feeAmount ?? 0;
    const feeReceiver = opts.feeReceiver ?? FEE_RECIPIENT;
    const logs =
      opts.logs ??
      (functionName === "charge"
        ? [
            makeEscrowEventLog("PaymentCharged", opts.paymentInfo, amount, tokenCollector, 84532, {
              feeAmount,
              feeReceiver,
            }),
          ]
        : [
            makeEscrowEventLog(
              "PaymentAuthorized",
              opts.paymentInfo,
              amount,
              tokenCollector,
              84532,
            ),
          ]);

    const freshState = {
      hasCollectedPayment: false,
      capturableAmount: 0n,
      refundableAmount: 0n,
    };
    const defaultPostState =
      functionName === "authorize"
        ? { hasCollectedPayment: true, capturableAmount: amount, refundableAmount: 0n }
        : { hasCollectedPayment: true, capturableAmount: 0n, refundableAmount: amount };
    const postState = opts.postState ?? defaultPostState;
    const payerDelta = opts.payerDelta ?? -amount;
    const tokenStoreDelta = opts.tokenStoreDelta ?? (functionName === "authorize" ? amount : 0n);
    const fee = BigInt(feeAmount);
    const receiverDelta = opts.receiverDelta ?? (functionName === "charge" ? amount - fee : 0n);
    const feeReceiverDelta = opts.feeReceiverDelta ?? fee;
    const facilitatorDelta = opts.facilitatorDelta ?? 0n;
    const settledPayerDelta = opts.settledPayerDelta ?? payerDelta;
    const settledTokenStoreDelta = opts.settledTokenStoreDelta ?? tokenStoreDelta;
    const settledReceiverDelta = opts.settledReceiverDelta ?? receiverDelta;
    const settledFeeReceiverDelta = opts.settledFeeReceiverDelta ?? feeReceiverDelta;
    const settledFacilitatorDelta = opts.settledFacilitatorDelta ?? facilitatorDelta;
    const facilitatorAddress = opts.facilitatorAddress ?? FACILITATOR_EOA;
    let settled = false;

    mockSigner.simulateCalls = vi.fn().mockImplementation(async ({ calls }) => {
      const forwardedIndex = calls.findIndex(
        (call: { data?: string; functionName?: string }) => call.data && !call.functionName,
      );
      const results = calls.map(
        (
          call: { functionName?: string; args?: readonly unknown[]; data?: string },
          index: number,
        ) => {
          if (call.data && !call.functionName) {
            if (opts.forwardedStatus === "failure") {
              return { status: "failure" as const };
            }
            if (opts.rejectDataSuffix && call.data.endsWith(opts.rejectDataSuffix.slice(2))) {
              return {
                status: "success" as const,
                logs: [],
                gasUsed: opts.gasUsed ?? 100_000n,
              };
            }
            return {
              status: "success" as const,
              logs,
              gasUsed: opts.gasUsed ?? 100_000n,
            };
          }
          if (call.functionName === "paymentState") {
            return {
              status: "success" as const,
              result: index < forwardedIndex ? freshState : postState,
            };
          }
          if (call.functionName === "balanceOf") {
            const account = (call.args?.[0] as string).toLowerCase();
            const isPre = index < forwardedIndex;
            let base = INITIAL_BALANCE;
            if (account === TOKEN_STORE.toLowerCase()) base = 0n;
            if (account === PAY_TO.toLowerCase()) base = 0n;
            if (account === FEE_RECIPIENT.toLowerCase()) base = 0n;
            if (!isPre) {
              if (account === TOKEN_STORE.toLowerCase()) {
                return { status: "success" as const, result: base + tokenStoreDelta };
              }
              if (account === PAYER.toLowerCase()) {
                return { status: "success" as const, result: base + payerDelta };
              }
              if (account === facilitatorAddress.toLowerCase()) {
                return { status: "success" as const, result: base + facilitatorDelta };
              }
              if (account === PAY_TO.toLowerCase() && functionName === "charge") {
                return { status: "success" as const, result: base + receiverDelta };
              }
              if (account === FEE_RECIPIENT.toLowerCase() && functionName === "charge") {
                return { status: "success" as const, result: base + feeReceiverDelta };
              }
            }
            return { status: "success" as const, result: base };
          }
          return { status: "success" as const, result: 0n };
        },
      );
      return { results };
    });

    mockSigner.writeContract.mockImplementation(async () => {
      settled = true;
      return MOCK_TX_HASH;
    });
    mockSigner.readContract.mockImplementation(
      async (args: { functionName: string; address?: string; args?: readonly unknown[] }) => {
        if (args.functionName === "getTokenStore") return TOKEN_STORE;
        if (args.functionName === "isValidSignature") return ERC1271_MAGIC_VALUE;
        if (args.functionName === "paymentState") {
          return {
            hasCollectedPayment: true,
            capturableAmount: functionName === "authorize" ? amount : 0n,
            refundableAmount: functionName === "charge" ? amount : 0n,
          };
        }
        if (args.functionName === "balanceOf") {
          const account = (args.args?.[0] as string).toLowerCase();
          let base = INITIAL_BALANCE;
          if (account === TOKEN_STORE.toLowerCase()) base = 0n;
          if (account === PAY_TO.toLowerCase()) base = 0n;
          if (account === FEE_RECIPIENT.toLowerCase()) base = 0n;
          if (!settled) return base;
          if (account === TOKEN_STORE.toLowerCase()) return base + settledTokenStoreDelta;
          if (account === PAYER.toLowerCase()) return base + settledPayerDelta;
          if (account === facilitatorAddress.toLowerCase()) {
            return base + settledFacilitatorDelta;
          }
          if (account === PAY_TO.toLowerCase() && functionName === "charge") {
            return base + settledReceiverDelta;
          }
          if (account === FEE_RECIPIENT.toLowerCase() && functionName === "charge") {
            return base + settledFeeReceiverDelta;
          }
          return base;
        }
        return INITIAL_BALANCE;
      },
    );

    mockSigner.waitForTransactionReceipt.mockResolvedValue({
      status: "success",
      logs: opts.receiptLogs ?? logs,
    });
  }

  function customOperatorConfig() {
    return { operators: [{ address: CUSTOM_OPERATOR, operatorType: "custom" as const }] };
  }

  function customOperatorRequirements() {
    return {
      ...mockRequirements,
      extra: {
        ...mockRequirements.extra,
        captureAuthorizer: CUSTOM_OPERATOR,
        operatorType: "custom" as const,
      },
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockSigner = createMockSigner();
  });

  /**
   * Make the escrow simulation revert while leaving ERC-1271 verification and
   * the `balanceOf` fallback intact, so the test asserts revert decoding rather
   * than tripping over an earlier step.
   *
   * @param error - Error the simulated `authorize`/`charge` call throws.
   * @param balance - Payer balance returned by the `balanceOf` fallback.
   */
  function mockSimulationRevert(error: unknown, balance = BigInt("1000000000")) {
    mockSigner.readContract.mockImplementation(async (args: { functionName: string }) => {
      if (args.functionName === "isValidSignature") return ERC1271_MAGIC_VALUE;
      if (args.functionName === "balanceOf") return balance;
      throw error;
    });
  }

  const futureSeconds = Math.floor(Date.now() / 1000) + 3600;
  const captureDeadline = futureSeconds + 86400;
  const refundDeadline = captureDeadline + 86400;

  const FACILITATOR_EOA = "0x1234567890123456789012345678901234567890" as `0x${string}`;
  const SUBMITTER_B = "0x2222222222222222222222222222222222222222" as `0x${string}`;
  const SUBMITTER_C = "0x5555555555555555555555555555555555555555" as `0x${string}`;
  const MULTI_SUBMITTERS = [FACILITATOR_EOA, SUBMITTER_B, SUBMITTER_C] as const;
  const PAYER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as `0x${string}`;
  const ASSET = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as `0x${string}`;
  const PAY_TO = "0xdddddddddddddddddddddddddddddddddddddddd" as `0x${string}`;
  const CAPTURE_AUTHORIZER = FACILITATOR_EOA;
  const RECEIVER_AUTHORIZER = "0x1111111111111111111111111111111111111111" as `0x${string}`;
  const CUSTOM_OPERATOR = "0xcccccccccccccccccccccccccccccccccccccccc" as `0x${string}`;
  const FEE_RECIPIENT = "0x4444444444444444444444444444444444444444" as `0x${string}`;
  const SALT =
    "0x0000000000000000000000000000000000000000000000000000000000000abc" as `0x${string}`;
  const SALT_NONCE =
    "0x2222222222222222222222222222222222222222222222222222222222222222" as `0x${string}`;
  const BOUND_SALT = deriveBoundSalt(RECEIVER_AUTHORIZER, zeroAddress, SALT_NONCE);

  const mockRequirements = {
    scheme: "auth-capture",
    network: "eip155:84532",
    amount: "1000000",
    asset: ASSET,
    payTo: PAY_TO,
    maxTimeoutSeconds: 60,
    extra: {
      captureAuthorizer: CAPTURE_AUTHORIZER,
      captureDeadline,
      refundDeadline,
      feeRecipient: FEE_RECIPIENT,
      minFeeBps: 0,
      maxFeeBps: 100,
      name: "USDC",
      version: "2",
    },
  };

  // Build a PaymentInfoStruct that matches what the facilitator will reconstruct.
  function buildPaymentInfo(operator: `0x${string}` = CAPTURE_AUTHORIZER): PaymentInfoStruct {
    return {
      operator,
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
      salt: SALT,
    };
  }

  function buildEip3009Payload(operator: `0x${string}` = CAPTURE_AUTHORIZER) {
    const paymentInfo = buildPaymentInfo(operator);
    const nonce = computePayerAgnosticPaymentInfoHash(84532, paymentInfo);
    const extra = { ...mockRequirements.extra, captureAuthorizer: operator };
    const accepted = { ...mockRequirements, extra };
    return {
      x402Version: 2,
      scheme: "auth-capture",
      resource: { url: "https://example.com/weather", method: "GET" },
      accepted,
      payload: {
        authorization: {
          from: PAYER,
          to: EIP3009_TOKEN_COLLECTOR_ADDRESS,
          value: "1000000",
          validAfter: "0",
          validBefore: String(futureSeconds),
          nonce,
        },
        signature: "0xabcd" as `0x${string}`,
        salt: SALT,
      },
    };
  }

  function buildPermit2Payload(operator: `0x${string}` = CAPTURE_AUTHORIZER) {
    const paymentInfo = buildPaymentInfo(operator);
    const nonce = computePayerAgnosticPaymentInfoHash(84532, paymentInfo);
    const extra = {
      ...mockRequirements.extra,
      captureAuthorizer: operator,
      assetTransferMethod: "permit2" as const,
    };
    const accepted = { ...mockRequirements, extra };
    return {
      x402Version: 2,
      scheme: "auth-capture",
      resource: { url: "https://example.com/weather", method: "GET" },
      accepted,
      payload: {
        permit2Authorization: {
          from: PAYER,
          permitted: { token: ASSET, amount: "1000000" },
          spender: PERMIT2_TOKEN_COLLECTOR_ADDRESS,
          nonce: hexToBigInt(nonce).toString(),
          deadline: String(futureSeconds),
        },
        signature: "0xabcd" as `0x${string}`,
        salt: SALT,
      },
    };
  }

  function boundPaymentInfo(operator: `0x${string}` = CAPTURE_AUTHORIZER): PaymentInfoStruct {
    return { ...buildPaymentInfo(operator), salt: BOUND_SALT };
  }

  function boundExtra(overrides: Record<string, unknown> = {}) {
    return {
      ...mockRequirements.extra,
      receiverAuthorizer: RECEIVER_AUTHORIZER,
      ...overrides,
    };
  }

  function buildBoundEip3009Payload(
    operator: `0x${string}` = CAPTURE_AUTHORIZER,
    extraOverrides: Record<string, unknown> = {},
  ) {
    const paymentInfo = boundPaymentInfo(operator);
    const nonce = computePayerAgnosticPaymentInfoHash(84532, paymentInfo);
    const extra = boundExtra({ captureAuthorizer: operator, ...extraOverrides });
    const accepted = { ...mockRequirements, extra };
    return {
      x402Version: 2,
      scheme: "auth-capture",
      resource: { url: "https://example.com/weather", method: "GET" },
      accepted,
      payload: {
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
      },
    };
  }

  function buildChargeEip3009Payload(
    operator: `0x${string}` = CAPTURE_AUTHORIZER,
    extraOverrides: Record<string, unknown> = {},
  ) {
    const envelope = buildBoundEip3009Payload(operator, {
      paymentFlow: "authorization",
      ...extraOverrides,
    });
    return {
      ...envelope,
      payload: {
        ...envelope.payload,
        amount: "1000000",
        feeAmount: "0",
        feeReceiver: FEE_RECIPIENT,
        authorizerSignature: "0xabcd" as `0x${string}`,
      },
    };
  }

  function buildChargePermit2Payload(
    operator: `0x${string}` = CAPTURE_AUTHORIZER,
    extraOverrides: Record<string, unknown> = {},
  ) {
    const paymentInfo = boundPaymentInfo(operator);
    const nonce = computePayerAgnosticPaymentInfoHash(84532, paymentInfo);
    const extra = boundExtra({
      captureAuthorizer: operator,
      assetTransferMethod: "permit2",
      paymentFlow: "authorization",
      ...extraOverrides,
    });
    const accepted = { ...mockRequirements, extra };
    return {
      x402Version: 2,
      scheme: "auth-capture",
      resource: { url: "https://example.com/weather", method: "GET" },
      accepted,
      payload: {
        permit2Authorization: {
          from: PAYER,
          permitted: { token: ASSET, amount: "1000000" },
          spender: PERMIT2_TOKEN_COLLECTOR_ADDRESS,
          nonce: hexToBigInt(nonce).toString(),
          deadline: String(futureSeconds),
        },
        signature: "0xabcd" as `0x${string}`,
        salt: BOUND_SALT,
        saltNonce: SALT_NONCE,
        amount: "1000000",
        feeAmount: "0",
        feeReceiver: FEE_RECIPIENT,
        authorizerSignature: "0xabcd" as `0x${string}`,
      },
    };
  }

  function buildCapturePayload(overrides: Record<string, unknown> = {}) {
    const extra = boundExtra();
    const accepted = { ...mockRequirements, extra };
    return {
      x402Version: 2,
      accepted,
      payload: {
        type: "capture",
        paymentInfo: boundPaymentInfo(),
        saltNonce: SALT_NONCE,
        amount: "500000",
        feeAmount: "0",
        feeReceiver: FEE_RECIPIENT,
        expectedCapturableAmount: "1000000",
        expectedRefundableAmount: "0",
        authorizerSignature: "0xabcd",
        ...overrides,
      },
    };
  }

  describe("settle — builder-code dataSuffix", () => {
    const BUILDER_SUFFIX = "0xdeadbeef" as const;

    function mockBuilderCodeContext() {
      return {
        getExtension: vi.fn().mockImplementation((key: string) => {
          if (key === BUILDER_CODE_KEY) {
            return {
              key: BUILDER_CODE_KEY,
              buildDataSuffix: vi.fn().mockReturnValue(BUILDER_SUFFIX),
            };
          }
          return undefined;
        }),
      };
    }

    it("should append builder-code dataSuffix on collect authorize", async () => {
      const scheme = new AuthCaptureEvmScheme(mockSigner);
      await scheme.settle(buildEip3009Payload(), mockRequirements, mockBuilderCodeContext());

      expect(mockSigner.writeContract).toHaveBeenCalledWith(
        expect.objectContaining({
          functionName: "authorize",
          dataSuffix: BUILDER_SUFFIX,
        }),
      );
    });

    it("should include builder-code dataSuffix in custom-operator simulation", async () => {
      const paymentInfo = buildPaymentInfo(CUSTOM_OPERATOR);
      installCustomOperatorSimulation({ paymentInfo });
      const scheme = new AuthCaptureEvmScheme(mockSigner, customOperatorConfig());
      const envelope = buildEip3009Payload(CUSTOM_OPERATOR);
      const requirements = customOperatorRequirements();
      const context = mockBuilderCodeContext();
      const verification = await scheme.verify(envelope, requirements, context);
      const result = await scheme.settle(envelope, requirements, context);

      expect(verification.isValid).toBe(true);
      expect(result.success).toBe(true);
      for (const call of mockSigner.simulateCalls.mock.calls) {
        const simulation = call[0] as {
          calls: readonly { data?: `0x${string}`; functionName?: string }[];
        };
        const forwarded = simulation.calls.find(item => item.data && !item.functionName);
        expect(forwarded?.data?.endsWith(BUILDER_SUFFIX.slice(2))).toBe(true);
      }
      expect(mockSigner.writeContract).toHaveBeenCalledWith(
        expect.objectContaining({ dataSuffix: BUILDER_SUFFIX }),
      );
    });

    it("should reject a custom operator that changes behavior for suffixed calldata", async () => {
      const paymentInfo = buildPaymentInfo(CUSTOM_OPERATOR);
      installCustomOperatorSimulation({
        paymentInfo,
        rejectDataSuffix: BUILDER_SUFFIX,
      });
      const scheme = new AuthCaptureEvmScheme(mockSigner, customOperatorConfig());
      const result = await scheme.settle(
        buildEip3009Payload(CUSTOM_OPERATOR),
        customOperatorRequirements(),
        mockBuilderCodeContext(),
      );

      expect(result.success).toBe(false);
      expect(result.errorReason).toBe("invalid_auth_capture_evm_simulation_failed");
      expect(mockSigner.writeContract).not.toHaveBeenCalled();
    });

    it("should append builder-code dataSuffix on lifecycle capture and remainder void", async () => {
      const scheme = new AuthCaptureEvmScheme(mockSigner);
      const envelope = buildCapturePayload({ voidAuthorizerSignature: "0xabcd" });
      await scheme.settle(envelope, envelope.accepted, mockBuilderCodeContext());

      expect(mockSigner.writeContract).toHaveBeenCalledTimes(2);
      for (const call of mockSigner.writeContract.mock.calls) {
        expect(call[0]).toEqual(
          expect.objectContaining({
            dataSuffix: BUILDER_SUFFIX,
          }),
        );
      }
      const names = mockSigner.writeContract.mock.calls.map(
        (call: [{ functionName: string }]) => call[0].functionName,
      );
      expect(names).toEqual(["capture", "void"]);
    });
  });

  describe("settle — paymentFlow routing", () => {
    it("should default to authorize when paymentFlow is absent (escrow)", async () => {
      const scheme = new AuthCaptureEvmScheme(mockSigner);
      await scheme.settle(buildEip3009Payload(), mockRequirements);

      expect(mockSigner.writeContract).toHaveBeenCalledWith(
        expect.objectContaining({ functionName: "authorize" }),
      );
    });

    it("should call charge when paymentFlow is authorization", async () => {
      const scheme = new AuthCaptureEvmScheme(mockSigner);
      const envelope = buildChargeEip3009Payload();
      await scheme.settle(envelope, envelope.accepted);

      expect(mockSigner.writeContract).toHaveBeenCalledWith(
        expect.objectContaining({ functionName: "charge" }),
      );
    });

    it("should call authorize when paymentFlow is escrow", async () => {
      const scheme = new AuthCaptureEvmScheme(mockSigner);
      const reqs = {
        ...mockRequirements,
        extra: { ...mockRequirements.extra, paymentFlow: "escrow" as const },
      };
      await scheme.settle(buildEip3009Payload(), reqs);

      expect(mockSigner.writeContract).toHaveBeenCalledWith(
        expect.objectContaining({ functionName: "authorize" }),
      );
    });

    it("should reject autoCapture: true", async () => {
      const scheme = new AuthCaptureEvmScheme(mockSigner);
      const reqs = {
        ...mockRequirements,
        extra: { ...mockRequirements.extra, autoCapture: true },
      };
      const result = await scheme.verify(buildEip3009Payload(), reqs);
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_auth_capture_evm_unsupported_payment_flow");
    });
  });

  describe("settle — target address", () => {
    it("should target the canonical AuthCaptureEscrow address when captureAuthorizer is an EOA", async () => {
      // Default mock: only the payer has code, so captureAuthorizer is an EOA.
      const scheme = new AuthCaptureEvmScheme(mockSigner);
      await scheme.settle(buildEip3009Payload(), mockRequirements);

      expect(mockSigner.writeContract).toHaveBeenCalledWith(
        expect.objectContaining({ address: AUTH_CAPTURE_ESCROW_ADDRESS }),
      );
    });

    it("should route authorize × eip3009 × custom operator via the captureAuthorizer with the literal escrow ABI and 4 args", async () => {
      const paymentInfo = buildPaymentInfo(CUSTOM_OPERATOR);
      installCustomOperatorSimulation({ paymentInfo });
      const scheme = new AuthCaptureEvmScheme(mockSigner, customOperatorConfig());
      const reqs = customOperatorRequirements();
      await scheme.settle(buildEip3009Payload(CUSTOM_OPERATOR), reqs);

      const call = mockSigner.writeContract.mock.calls[0][0];
      expect(call.address).toBe(getAddress(CUSTOM_OPERATOR));
      expect(call.functionName).toBe("authorize");
      expect(call.args).toHaveLength(4);
      expect(call.args[2]).toBe(EIP3009_TOKEN_COLLECTOR_ADDRESS);
      expect(call.gas).toBe(DEFAULT_CUSTOM_OPERATOR_AUTHORIZE_GAS_LIMIT);
    });

    it("should route charge × eip3009 × custom operator via the captureAuthorizer with the 6-arg ABI", async () => {
      const paymentInfo = boundPaymentInfo(CUSTOM_OPERATOR);
      installCustomOperatorSimulation({ paymentInfo, functionName: "charge" });
      const scheme = new AuthCaptureEvmScheme(mockSigner, customOperatorConfig());
      const envelope = buildChargeEip3009Payload(CUSTOM_OPERATOR, {
        operatorType: "custom",
      });
      await scheme.settle(envelope, envelope.accepted);

      const call = mockSigner.writeContract.mock.calls[0][0];
      expect(call.address).toBe(getAddress(CUSTOM_OPERATOR));
      expect(call.functionName).toBe("charge");
      expect(call.args).toHaveLength(6);
      expect(call.args[2]).toBe(EIP3009_TOKEN_COLLECTOR_ADDRESS);
      expect(call.args[4]).toBe(0n);
      expect(call.args[5]).toBe(FEE_RECIPIENT);
      expect(call.gas).toBe(DEFAULT_CUSTOM_OPERATOR_AUTHORIZE_GAS_LIMIT);
    });

    it("should route authorize × permit2 × custom operator via the captureAuthorizer with the permit2 collector", async () => {
      const paymentInfo = buildPaymentInfo(CUSTOM_OPERATOR);
      installCustomOperatorSimulation({
        paymentInfo,
        tokenCollector: PERMIT2_TOKEN_COLLECTOR_ADDRESS,
      });
      const scheme = new AuthCaptureEvmScheme(mockSigner, customOperatorConfig());
      const reqs = {
        ...customOperatorRequirements(),
        extra: {
          ...customOperatorRequirements().extra,
          assetTransferMethod: "permit2" as const,
        },
      };
      await scheme.settle(buildPermit2Payload(CUSTOM_OPERATOR), reqs);

      const call = mockSigner.writeContract.mock.calls[0][0];
      expect(call.address).toBe(getAddress(CUSTOM_OPERATOR));
      expect(call.functionName).toBe("authorize");
      expect(call.args).toHaveLength(4);
      expect(call.args[2]).toBe(PERMIT2_TOKEN_COLLECTOR_ADDRESS);
    });

    it("should forward raw ERC-6492 collectorData while verifying its inner signature", async () => {
      const wrappedSignature = serializeErc6492Signature({
        address: "0xca11bde05977b3631167028862be2a173976ca11",
        data: "0xdeadbeef",
        signature: "0xabcd",
      });
      const envelope = buildEip3009Payload(CUSTOM_OPERATOR);
      envelope.payload.signature = wrappedSignature;
      const paymentInfo = buildPaymentInfo(CUSTOM_OPERATOR);
      installCustomOperatorSimulation({ paymentInfo });
      const scheme = new AuthCaptureEvmScheme(mockSigner, customOperatorConfig());

      const result = await scheme.settle(envelope, customOperatorRequirements());

      expect(result.success).toBe(true);
      const call = mockSigner.writeContract.mock.calls[0]![0];
      expect(call.args[3]).toBe(wrappedSignature);
      const simulation = mockSigner.simulateCalls.mock.calls[0]![0] as {
        calls: readonly { data?: `0x${string}`; functionName?: string }[];
      };
      const forwarded = simulation.calls.find(item => item.data && !item.functionName);
      expect(forwarded?.data).toBeDefined();
      const decoded = decodeFunctionData({
        abi: ESCROW_ABI_WITH_ERRORS,
        data: forwarded!.data!,
      });
      expect(decoded.args?.[3]).toBe(wrappedSignature);
    });

    it("should route charge × permit2 × custom operator via the captureAuthorizer with 6 args + permit2 collector", async () => {
      const paymentInfo = boundPaymentInfo(CUSTOM_OPERATOR);
      installCustomOperatorSimulation({
        paymentInfo,
        functionName: "charge",
        tokenCollector: PERMIT2_TOKEN_COLLECTOR_ADDRESS,
      });
      const scheme = new AuthCaptureEvmScheme(mockSigner, customOperatorConfig());
      const envelope = buildChargePermit2Payload(CUSTOM_OPERATOR, {
        operatorType: "custom",
      });
      await scheme.settle(envelope, envelope.accepted);

      const call = mockSigner.writeContract.mock.calls[0][0];
      expect(call.address).toBe(getAddress(CUSTOM_OPERATOR));
      expect(call.functionName).toBe("charge");
      expect(call.args).toHaveLength(6);
      expect(call.args[2]).toBe(PERMIT2_TOKEN_COLLECTOR_ADDRESS);
    });

    it("should preflight custom collect via simulateCalls with a gas cap", async () => {
      const paymentInfo = buildPaymentInfo(CUSTOM_OPERATOR);
      installCustomOperatorSimulation({ paymentInfo });
      const scheme = new AuthCaptureEvmScheme(mockSigner, customOperatorConfig());
      await scheme.verify(buildEip3009Payload(CUSTOM_OPERATOR), customOperatorRequirements());

      expect(mockSigner.simulateCalls).toHaveBeenCalledWith(
        expect.objectContaining({
          account: FACILITATOR_EOA,
          calls: expect.arrayContaining([
            expect.objectContaining({
              to: getAddress(CUSTOM_OPERATOR),
              gas: DEFAULT_CUSTOM_OPERATOR_AUTHORIZE_GAS_LIMIT,
            }),
          ]),
        }),
      );
    });

    it("should pass EIP3009_TOKEN_COLLECTOR as the tokenCollector arg for eip3009", async () => {
      const scheme = new AuthCaptureEvmScheme(mockSigner);
      await scheme.settle(buildEip3009Payload(), mockRequirements);

      const call = mockSigner.writeContract.mock.calls[0][0];
      expect(call.args[2]).toBe(EIP3009_TOKEN_COLLECTOR_ADDRESS);
    });

    it("should pass PERMIT2_TOKEN_COLLECTOR as the tokenCollector arg for permit2", async () => {
      const scheme = new AuthCaptureEvmScheme(mockSigner);
      const reqs = {
        ...mockRequirements,
        extra: { ...mockRequirements.extra, assetTransferMethod: "permit2" as const },
      };
      await scheme.settle(buildPermit2Payload(), reqs);

      const call = mockSigner.writeContract.mock.calls[0][0];
      expect(call.args[2]).toBe(PERMIT2_TOKEN_COLLECTOR_ADDRESS);
    });
  });

  describe("verify — invariants", () => {
    it("should reject when extra is missing required fields", async () => {
      const scheme = new AuthCaptureEvmScheme(mockSigner);
      const bad = {
        ...mockRequirements,
        extra: { name: "USDC", version: "2" } as unknown as typeof mockRequirements.extra,
      };
      const result = await scheme.verify(buildEip3009Payload(), bad);
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_auth_capture_evm_extra");
    });

    it("should reject charge when receiverAuthorizer is absent", async () => {
      const scheme = new AuthCaptureEvmScheme(mockSigner);
      const requirements = {
        ...mockRequirements,
        extra: { ...mockRequirements.extra, paymentFlow: "authorization" as const },
      };
      const result = await scheme.verify(buildEip3009Payload(), requirements);
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_auth_capture_evm_missing_receiver_authorizer");
    });

    it("should verify raw charge intent but reject settle without authorizer-signed fields", async () => {
      const scheme = new AuthCaptureEvmScheme(mockSigner);
      const envelope = buildBoundEip3009Payload(CAPTURE_AUTHORIZER, {
        paymentFlow: "authorization",
      });
      const verification = await scheme.verify(envelope, envelope.accepted);
      expect(verification.isValid).toBe(true);

      const settlement = await scheme.settle(envelope, envelope.accepted);
      expect(settlement.success).toBe(false);
      expect(settlement.errorReason).toBe("invalid_auth_capture_evm_payload_format");
    });

    it("should reject when refundDeadline is not after captureDeadline", async () => {
      const scheme = new AuthCaptureEvmScheme(mockSigner);
      const bad = {
        ...mockRequirements,
        extra: { ...mockRequirements.extra, refundDeadline: captureDeadline - 1 },
      };
      const result = await scheme.verify(buildEip3009Payload(), bad);
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_auth_capture_evm_deadline_ordering");
    });

    it("should reject when payload method does not match assetTransferMethod", async () => {
      const scheme = new AuthCaptureEvmScheme(mockSigner);
      const reqs = {
        ...mockRequirements,
        extra: { ...mockRequirements.extra, assetTransferMethod: "permit2" as const },
      };
      const result = await scheme.verify(buildEip3009Payload(), reqs);
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_auth_capture_evm_payload_method_mismatch");
    });

    it("should reject when EIP-3009 payload.to is not the canonical collector", async () => {
      const scheme = new AuthCaptureEvmScheme(mockSigner);
      const payload = buildEip3009Payload();
      payload.payload.authorization.to =
        "0x9999999999999999999999999999999999999999" as `0x${string}`;
      const result = await scheme.verify(payload, mockRequirements);
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_auth_capture_evm_token_collector_mismatch");
    });

    it("should reject when Permit2 payload.spender is not the canonical collector", async () => {
      const scheme = new AuthCaptureEvmScheme(mockSigner);
      const reqs = {
        ...mockRequirements,
        extra: { ...mockRequirements.extra, assetTransferMethod: "permit2" as const },
      };
      const payload = buildPermit2Payload();
      payload.payload.permit2Authorization.spender =
        "0x9999999999999999999999999999999999999999" as `0x${string}`;
      const result = await scheme.verify(payload, reqs);
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_auth_capture_evm_token_collector_mismatch");
    });

    it("should reject when Permit2 token does not match requirements.asset", async () => {
      const scheme = new AuthCaptureEvmScheme(mockSigner);
      const reqs = {
        ...mockRequirements,
        extra: { ...mockRequirements.extra, assetTransferMethod: "permit2" as const },
      };
      const payload = buildPermit2Payload();
      payload.payload.permit2Authorization.permitted.token =
        "0x9999999999999999999999999999999999999999" as `0x${string}`;
      const result = await scheme.verify(payload, reqs);
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_auth_capture_evm_token_mismatch");
    });

    it("should reject when authorization.value does not match requirements.amount", async () => {
      const scheme = new AuthCaptureEvmScheme(mockSigner);
      const payload = buildEip3009Payload();
      payload.payload.authorization.value = "999999";
      const result = await scheme.verify(payload, mockRequirements);
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_auth_capture_evm_amount_mismatch");
    });

    it("should reject when EIP-3009 validBefore is in the past", async () => {
      const scheme = new AuthCaptureEvmScheme(mockSigner);
      const payload = buildEip3009Payload();
      payload.payload.authorization.validBefore = String(Math.floor(Date.now() / 1000) - 60);
      const result = await scheme.verify(payload, mockRequirements);
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_auth_capture_evm_authorization_expired");
    });

    it("should reject when EIP-3009 validAfter is in the future", async () => {
      const scheme = new AuthCaptureEvmScheme(mockSigner);
      const payload = buildEip3009Payload();
      payload.payload.authorization.validAfter = String(Math.floor(Date.now() / 1000) + 3600);
      const result = await scheme.verify(payload, mockRequirements);
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_auth_capture_evm_authorization_not_yet_valid");
    });

    it("should reject unsupported assetTransferMethod", async () => {
      const scheme = new AuthCaptureEvmScheme(mockSigner);
      const reqs = {
        ...mockRequirements,
        extra: {
          ...mockRequirements.extra,
          assetTransferMethod: "allowance" as unknown as "eip3009",
        },
      };
      const result = await scheme.verify(buildEip3009Payload(), reqs);
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe(
        "invalid_auth_capture_evm_unsupported_asset_transfer_method",
      );
    });

    it("should reject when payload.accepted.network differs from requirements.network", async () => {
      const scheme = new AuthCaptureEvmScheme(mockSigner);
      const payload = buildEip3009Payload();
      payload.accepted = { ...payload.accepted, network: "eip155:8453" };
      const result = await scheme.verify(payload, mockRequirements);
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_auth_capture_evm_network_mismatch");
    });

    it("should reject invalid signature", async () => {
      // Payer has code, so strict verification takes the ERC-1271 path; a
      // non-magic return means the smart account rejected the signature.
      mockSigner.readContract.mockImplementation(async (args: { functionName: string }) =>
        args.functionName === "isValidSignature" ? "0x00000000" : BigInt("1000000000"),
      );
      const scheme = new AuthCaptureEvmScheme(mockSigner);
      const result = await scheme.verify(buildEip3009Payload(), mockRequirements);
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_auth_capture_evm_signature");
    });

    it("should run signature verification through the strict primitive (getCode + isValidSignature)", async () => {
      const scheme = new AuthCaptureEvmScheme(mockSigner);
      await scheme.verify(buildEip3009Payload(), mockRequirements);

      expect(mockSigner.getCode).toHaveBeenCalledWith(
        expect.objectContaining({ address: getAddress(PAYER) }),
      );
      expect(mockSigner.readContract).toHaveBeenCalledWith(
        expect.objectContaining({ functionName: "isValidSignature" }),
      );
      // The weaker signer.verifyTypedData path (ECDSA fallback on EIP-1271
      // failure) must not be used — it diverges from on-chain SignatureChecker.
      expect(mockSigner.verifyTypedData).not.toHaveBeenCalled();
    });

    it("should reject when simulation reverts and balance is sufficient", async () => {
      mockSimulationRevert(new Error("execution reverted"));
      const scheme = new AuthCaptureEvmScheme(mockSigner);
      const result = await scheme.verify(buildEip3009Payload(), mockRequirements);
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_auth_capture_evm_simulation_failed");
    });

    it("should surface insufficient_balance when simulation fails and balance is short", async () => {
      mockSimulationRevert(new Error("execution reverted"), BigInt("1"));
      const scheme = new AuthCaptureEvmScheme(mockSigner);
      const result = await scheme.verify(buildEip3009Payload(), mockRequirements);
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_auth_capture_evm_insufficient_balance");
    });

    it("should reject when preApprovalExpiry exceeds captureDeadline", async () => {
      // maxTimeoutSeconds = 60s, but captureDeadline only 5s in the future →
      // preApprovalExpiry (now + 60) > captureDeadline. Mirrors the on-chain
      // _validatePayment ordering check.
      const scheme = new AuthCaptureEvmScheme(mockSigner);
      const tightCaptureDeadline = Math.floor(Date.now() / 1000) + 30;
      const reqs = {
        ...mockRequirements,
        extra: {
          ...mockRequirements.extra,
          captureDeadline: tightCaptureDeadline,
          refundDeadline: tightCaptureDeadline + 86400,
        },
      };
      // Build payload with a fresh preApprovalExpiry that exceeds captureDeadline
      const futureSecondsLocal = Math.floor(Date.now() / 1000) + 3600;
      const paymentInfo: PaymentInfoStruct = {
        operator: CAPTURE_AUTHORIZER,
        payer: PAYER,
        receiver: PAY_TO,
        token: ASSET,
        maxAmount: "1000000",
        preApprovalExpiry: futureSecondsLocal,
        authorizationExpiry: tightCaptureDeadline,
        refundExpiry: tightCaptureDeadline + 86400,
        minFeeBps: 0,
        maxFeeBps: 100,
        feeReceiver: FEE_RECIPIENT,
        salt: SALT,
      };
      const nonce = computePayerAgnosticPaymentInfoHash(84532, paymentInfo);
      const payload = {
        x402Version: 2,
        scheme: "auth-capture",
        resource: { url: "https://example.com", method: "GET" },
        accepted: { ...reqs },
        payload: {
          authorization: {
            from: PAYER,
            to: EIP3009_TOKEN_COLLECTOR_ADDRESS,
            value: "1000000",
            validAfter: "0",
            validBefore: String(futureSecondsLocal),
            nonce,
          },
          signature: "0xabcd" as `0x${string}`,
          salt: SALT,
        },
      };
      const result = await scheme.verify(payload, reqs);
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_auth_capture_evm_deadline_ordering");
    });
  });

  describe("verify — nonce binding (regression for payer-agnostic-hash design)", () => {
    it("should reject when salt is mutated after signing", async () => {
      const scheme = new AuthCaptureEvmScheme(mockSigner);
      const payload = buildEip3009Payload();
      // Tamper with salt — wire nonce was computed against SALT, not this new value
      payload.payload.salt =
        "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef" as `0x${string}`;
      const result = await scheme.verify(payload, mockRequirements);
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_auth_capture_evm_nonce_mismatch");
    });

    it("should reject when extra.captureAuthorizer is mutated after signing", async () => {
      const scheme = new AuthCaptureEvmScheme(mockSigner);
      const tampered = {
        ...mockRequirements,
        extra: {
          ...mockRequirements.extra,
          captureAuthorizer: "0x9999999999999999999999999999999999999999" as `0x${string}`,
        },
      };
      const result = await scheme.verify(buildEip3009Payload(), tampered);
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_auth_capture_evm_operator_not_admitted");
    });

    it("should reject when requirements.amount is mutated after signing (Permit2)", async () => {
      const scheme = new AuthCaptureEvmScheme(mockSigner);
      const payload = buildPermit2Payload();
      payload.payload.permit2Authorization.permitted.amount = "999999";
      const reqs = {
        ...mockRequirements,
        extra: { ...mockRequirements.extra, assetTransferMethod: "permit2" as const },
      };
      const result = await scheme.verify(payload, reqs);
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_auth_capture_evm_amount_mismatch");
    });
  });

  describe("verify — ERC-6492 counterfactual payers", () => {
    const FACTORY = "0x7777777777777777777777777777777777777777" as `0x${string}`;

    /**
     * A counterfactual payer's signature cannot be checked locally, so these tests make the
     * payer read as undeployed and rely on the escrow simulation as the only signature check.
     *
     * @returns An EIP-3009 envelope whose signature is an ERC-6492 envelope naming `FACTORY`.
     */
    function buildCounterfactualPayload() {
      const envelope = buildEip3009Payload();
      envelope.payload.signature = serializeErc6492Signature({
        address: FACTORY,
        data: "0xdeadbeef",
        signature: "0xabcd",
      });
      return envelope;
    }

    beforeEach(() => {
      mockSigner.getCode.mockImplementation(async () => "0x");
    });

    it("should accept a counterfactual payer whose factory is allowlisted", async () => {
      const scheme = new AuthCaptureEvmScheme(mockSigner, {
        eip6492AllowedFactories: [FACTORY],
      });

      const result = await scheme.verify(buildCounterfactualPayload(), mockRequirements);

      expect(result.isValid).toBe(true);
      expect(result.payer).toBe(PAYER);
      // Deferred to the escrow simulation, never to a local ERC-1271 call.
      const readFunctions = mockSigner.readContract.mock.calls.map(
        (call: [{ functionName: string }]) => call[0].functionName,
      );
      expect(readFunctions).toContain("authorize");
      expect(readFunctions).not.toContain("isValidSignature");
    });

    it("should match allowlist entries case-insensitively and ignore surrounding space", async () => {
      const scheme = new AuthCaptureEvmScheme(mockSigner, {
        eip6492AllowedFactories: [` ${FACTORY.toUpperCase()} `],
      });

      const result = await scheme.verify(buildCounterfactualPayload(), mockRequirements);

      expect(result.isValid).toBe(true);
    });

    it("should reject a counterfactual payer whose factory is not allowlisted", async () => {
      const scheme = new AuthCaptureEvmScheme(mockSigner, {
        eip6492AllowedFactories: ["0x8888888888888888888888888888888888888888"],
      });

      const result = await scheme.verify(buildCounterfactualPayload(), mockRequirements);

      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_auth_capture_evm_erc6492_factory_not_allowed");
    });

    it("should reject a counterfactual payer when no allowlist is configured", async () => {
      const scheme = new AuthCaptureEvmScheme(mockSigner);

      const result = await scheme.verify(buildCounterfactualPayload(), mockRequirements);

      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_auth_capture_evm_erc6492_factory_not_allowed");
    });

    it("should reject an allowlisted counterfactual payer when the simulation reverts", async () => {
      mockSimulationRevert(new Error("execution reverted"));
      const scheme = new AuthCaptureEvmScheme(mockSigner, {
        eip6492AllowedFactories: [FACTORY],
      });

      const result = await scheme.verify(buildCounterfactualPayload(), mockRequirements);

      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_auth_capture_evm_simulation_failed");
    });

    it("should settle an allowlisted counterfactual payer forwarding the wrapper intact", async () => {
      const scheme = new AuthCaptureEvmScheme(mockSigner, {
        eip6492AllowedFactories: [FACTORY],
      });
      const envelope = buildCounterfactualPayload();

      const result = await scheme.settle(envelope, mockRequirements);

      expect(result.success).toBe(true);
      const call = mockSigner.writeContract.mock.calls[0]![0];
      expect(call.functionName).toBe("authorize");
      expect(call.args[3]).toBe(envelope.payload.signature);
      // No separate deployment transaction: the token collector deploys via Multicall3.
      expect(mockSigner.sendTransaction).not.toHaveBeenCalled();
    });

    it("should verify a deployed wallet locally even when its signature stays wrapped", async () => {
      mockSigner.getCode.mockImplementation(async ({ address }: { address: `0x${string}` }) =>
        address.toLowerCase() === PAYER.toLowerCase() ? DEPLOYED_BYTECODE : "0x",
      );
      const scheme = new AuthCaptureEvmScheme(mockSigner);

      const result = await scheme.verify(buildCounterfactualPayload(), mockRequirements);

      expect(result.isValid).toBe(true);
      const isValidSignatureCall = mockSigner.readContract.mock.calls.find(
        (call: [{ functionName: string }]) => call[0].functionName === "isValidSignature",
      );
      // The inner signature is what ERC-1271 sees; the wrapper is stripped onchain.
      expect(isValidSignatureCall?.[0].args?.[1]).toBe("0xabcd");
    });
  });

  describe("verify — typed simulation revert decoding", () => {
    /**
     * Build a viem ContractFunctionExecutionError that wraps a real
     * ContractFunctionRevertedError encoded from the named custom error.
     * Mirrors what viem produces when the chain reverts with a known error
     * declared in the call's ABI.
     */
    function buildRevertError(errorName: string): Error {
      const errorAbi = [{ type: "error" as const, name: errorName, inputs: [] }];
      const data = encodeErrorResult({ abi: errorAbi, errorName });
      const inner = new ContractFunctionRevertedError({
        abi: errorAbi,
        data,
        functionName: "authorize",
      });
      return new ContractFunctionExecutionError(inner, {
        abi: errorAbi,
        functionName: "authorize",
        args: [],
      });
    }

    it("should decode AfterPreApprovalExpiry → authorization_expired", async () => {
      mockSimulationRevert(buildRevertError("AfterPreApprovalExpiry"));
      const scheme = new AuthCaptureEvmScheme(mockSigner);
      const result = await scheme.verify(buildEip3009Payload(), mockRequirements);
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_auth_capture_evm_authorization_expired");
    });

    it("should decode PaymentAlreadyCollected → payment_already_collected", async () => {
      mockSimulationRevert(buildRevertError("PaymentAlreadyCollected"));
      const scheme = new AuthCaptureEvmScheme(mockSigner);
      const result = await scheme.verify(buildEip3009Payload(), mockRequirements);
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_auth_capture_evm_payment_already_collected");
    });

    it("should decode FeeBpsOutOfRange → fee_bps_out_of_range", async () => {
      mockSimulationRevert(buildRevertError("FeeBpsOutOfRange"));
      const scheme = new AuthCaptureEvmScheme(mockSigner);
      const result = await scheme.verify(buildEip3009Payload(), mockRequirements);
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_auth_capture_evm_fee_bps_out_of_range");
    });

    it("should decode InvalidFeeReceiver → invalid_fee_receiver", async () => {
      mockSimulationRevert(buildRevertError("InvalidFeeReceiver"));
      const scheme = new AuthCaptureEvmScheme(mockSigner);
      const result = await scheme.verify(buildEip3009Payload(), mockRequirements);
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_auth_capture_evm_fee_receiver");
    });

    it("should decode TokenCollectionFailed → token_collection_failed", async () => {
      mockSimulationRevert(buildRevertError("TokenCollectionFailed"));
      const scheme = new AuthCaptureEvmScheme(mockSigner);
      const result = await scheme.verify(buildEip3009Payload(), mockRequirements);
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_auth_capture_evm_token_collection_failed");
    });

    it("should fall through unknown reverts to generic simulation_failed", async () => {
      mockSimulationRevert(buildRevertError("SomeUnmappedError"));
      const scheme = new AuthCaptureEvmScheme(mockSigner);
      const result = await scheme.verify(buildEip3009Payload(), mockRequirements);
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_auth_capture_evm_simulation_failed");
    });

    it("should fall through plain Error (not BaseError) to simulation_failed", async () => {
      mockSimulationRevert(new Error("RPC went sideways"));
      const scheme = new AuthCaptureEvmScheme(mockSigner);
      const result = await scheme.verify(buildEip3009Payload(), mockRequirements);
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_auth_capture_evm_simulation_failed");
    });
  });

  describe("settle — charge fee args (ABI 6-arg correctness)", () => {
    it("should pass feeAmount and feeReceiver as args[4] and args[5] for charge", async () => {
      const scheme = new AuthCaptureEvmScheme(mockSigner);
      const envelope = buildChargeEip3009Payload();
      await scheme.settle(envelope, envelope.accepted);

      const call = mockSigner.writeContract.mock.calls[0][0];
      expect(call.functionName).toBe("charge");
      expect(call.args.length).toBe(6);
      expect(call.args[4]).toBe(0n);
      expect(call.args[5]).toBe(FEE_RECIPIENT);
    });

    it("should pass 4 args for authorize (no feeAmount/feeReceiver)", async () => {
      const scheme = new AuthCaptureEvmScheme(mockSigner);
      await scheme.settle(buildEip3009Payload(), mockRequirements);
      const call = mockSigner.writeContract.mock.calls[0][0];
      expect(call.functionName).toBe("authorize");
      expect(call.args.length).toBe(4);
    });

    it("should use v1.0 feeBps wire and collectors when extra.authCaptureEscrow pins v1.0", async () => {
      const paymentInfo = boundPaymentInfo();
      const nonce = computePayerAgnosticPaymentInfoHash(
        84532,
        paymentInfo,
        AUTH_CAPTURE_ESCROW_V1_0_ADDRESS,
      );
      const extra = boundExtra({
        authCaptureEscrow: AUTH_CAPTURE_ESCROW_V1_0_ADDRESS,
        paymentFlow: "authorization",
      });
      const accepted = { ...mockRequirements, extra };
      const envelope = {
        x402Version: 2,
        scheme: "auth-capture",
        resource: { url: "https://example.com/weather", method: "GET" },
        accepted,
        payload: {
          authorization: {
            from: PAYER,
            to: EIP3009_TOKEN_COLLECTOR_V1_0_ADDRESS,
            value: "1000000",
            validAfter: "0",
            validBefore: String(futureSeconds),
            nonce,
          },
          signature: "0xabcd" as `0x${string}`,
          salt: BOUND_SALT,
          saltNonce: SALT_NONCE,
          amount: "1000000",
          feeBps: 0,
          feeReceiver: FEE_RECIPIENT,
          authorizerSignature: "0xabcd" as `0x${string}`,
        },
      };
      const scheme = new AuthCaptureEvmScheme(mockSigner);
      await scheme.settle(envelope, accepted);

      const call = mockSigner.writeContract.mock.calls[0][0];
      expect(call.address).toBe(AUTH_CAPTURE_ESCROW_V1_0_ADDRESS);
      expect(call.functionName).toBe("charge");
      expect(call.args[2]).toBe(EIP3009_TOKEN_COLLECTOR_V1_0_ADDRESS);
      expect(call.args[4]).toBe(0);
    });
  });

  describe("getExtra", () => {
    it("should advertise a captureAuthorizer from getAddresses when unconfigured", () => {
      const scheme = new AuthCaptureEvmScheme(mockSigner);
      const extra = scheme.getExtra("eip155:8453");
      expect(extra).toBeDefined();
      expect(mockSigner.getAddresses()).toContain(extra?.captureAuthorizer);
    });

    it("should return undefined for an empty signer set", () => {
      const scheme = new AuthCaptureEvmScheme([]);
      expect(scheme.getExtra("eip155:8453")).toBeUndefined();
    });

    it("should advertise grouped fee terms and operators when simulateCalls is wired", () => {
      const signerWithSim = { ...mockSigner, simulateCalls: vi.fn() };
      const scheme = new AuthCaptureEvmScheme(signerWithSim, {
        feeTerms: { feeRecipient: FEE_RECIPIENT, minFeeBps: 100, maxFeeBps: 100 },
        operators: [{ address: "*", operatorType: "custom" }],
        receiverAuthorizer: FACILITATOR_EOA,
      });
      const extra = scheme.getExtra("eip155:8453");
      expect(extra).toMatchObject({
        receiverAuthorizer: FACILITATOR_EOA,
        feeRecipient: FEE_RECIPIENT,
        minFeeBps: 100,
        maxFeeBps: 100,
        operators: [{ address: "*", operatorType: "custom" }],
      });
      expect(signerWithSim.getAddresses()).toContain(extra?.captureAuthorizer);
    });

    it("should omit operators from getExtra when simulateCalls is unavailable", () => {
      const scheme = new AuthCaptureEvmScheme(mockSigner, {
        operators: [{ address: "*", operatorType: "custom" }],
      });
      const extra = scheme.getExtra("eip155:8453");
      expect(extra).not.toHaveProperty("operators");
      expect(mockSigner.getAddresses()).toContain(extra?.captureAuthorizer);
    });
  });

  describe("constructor and getSigners", () => {
    it("should accept a single signer and return its addresses", () => {
      const scheme = new AuthCaptureEvmScheme(mockSigner);
      expect(scheme.getSigners("eip155:84532")).toEqual([FACILITATOR_EOA]);
    });

    it("should accept an array of signers and return the union", () => {
      const signerB = createMockSigner([SUBMITTER_B]);
      const scheme = new AuthCaptureEvmScheme([mockSigner, signerB]);
      expect(scheme.getSigners("eip155:84532")).toEqual([FACILITATOR_EOA, SUBMITTER_B]);
    });
  });

  describe("multi-signer submitter selection", () => {
    function createThreeSigners() {
      return MULTI_SUBMITTERS.map(address => createMockSigner([address]));
    }

    it("should verify and settle from addresses[2], not addresses[0]", async () => {
      const signers = createThreeSigners();
      const scheme = new AuthCaptureEvmScheme(signers);
      const payload = buildEip3009Payload(SUBMITTER_C);
      const requirements = { ...payload.accepted };

      const verified = await scheme.verify(payload, requirements);
      expect(verified.isValid).toBe(true);

      const settled = await scheme.settle(payload, requirements);
      expect(settled.success).toBe(true);
      expect(signers[2]!.writeContract).toHaveBeenCalled();
      expect(signers[0]!.writeContract).not.toHaveBeenCalled();

      const simulateAccount = signers[2]!.readContract.mock.calls.find(
        (call: [{ functionName: string; account?: string }]) =>
          call[0].functionName === "authorize",
      )?.[0].account;
      expect(simulateAccount).toBe(SUBMITTER_C);
    });

    it("should reject a captureAuthorizer outside the signer set", async () => {
      const scheme = new AuthCaptureEvmScheme(createThreeSigners());
      const outsider = "0x9999999999999999999999999999999999999999" as `0x${string}`;
      const result = await scheme.verify(buildEip3009Payload(outsider), {
        ...mockRequirements,
        extra: { ...mockRequirements.extra, captureAuthorizer: outsider },
      });
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_auth_capture_evm_operator_not_admitted");
    });

    it("should match a lowercase advertised address to a checksummed signer", async () => {
      const scheme = new AuthCaptureEvmScheme(createThreeSigners());
      const lowercase = SUBMITTER_C.toLowerCase() as `0x${string}`;
      const payload = buildEip3009Payload(lowercase);
      const result = await scheme.verify(payload, payload.accepted);
      expect(result.isValid).toBe(true);
    });

    it("should settle a lifecycle capture from the paymentInfo.operator signer", async () => {
      const signers = createThreeSigners();
      const scheme = new AuthCaptureEvmScheme(signers);
      const envelope = buildCapturePayload({
        paymentInfo: boundPaymentInfo(SUBMITTER_C),
      });
      envelope.accepted = {
        ...envelope.accepted,
        extra: boundExtra({ captureAuthorizer: SUBMITTER_C }),
      };
      const result = await scheme.settle(envelope, envelope.accepted);
      expect(result.success).toBe(true);
      expect(signers[2]!.writeContract).toHaveBeenCalledWith(
        expect.objectContaining({ functionName: "capture" }),
      );
      expect(signers[0]!.writeContract).not.toHaveBeenCalled();
    });

    it("should snapshot the custom-path submitter and fail when that balance drops", async () => {
      const signers = createThreeSigners();
      mockSigner = signers[0]!;
      const paymentInfo = buildPaymentInfo(CUSTOM_OPERATOR);
      installCustomOperatorSimulation({
        paymentInfo,
        facilitatorAddress: FACILITATOR_EOA,
        facilitatorDelta: -1n,
      });
      const scheme = new AuthCaptureEvmScheme(signers, customOperatorConfig());
      const result = await scheme.verify(
        buildEip3009Payload(CUSTOM_OPERATOR),
        customOperatorRequirements(),
      );
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_auth_capture_evm_simulation_failed");
      expect(signers[0]!.simulateCalls).toHaveBeenCalledWith(
        expect.objectContaining({ account: FACILITATOR_EOA }),
      );
    });

    it("should settle custom collect from the first signer", async () => {
      const signers = createThreeSigners();
      mockSigner = signers[0]!;
      const paymentInfo = buildPaymentInfo(CUSTOM_OPERATOR);
      installCustomOperatorSimulation({
        paymentInfo,
        facilitatorAddress: FACILITATOR_EOA,
      });
      const scheme = new AuthCaptureEvmScheme(signers, customOperatorConfig());
      const result = await scheme.settle(
        buildEip3009Payload(CUSTOM_OPERATOR),
        customOperatorRequirements(),
      );
      expect(result.success).toBe(true);
      expect(signers[0]!.writeContract).toHaveBeenCalled();
      expect(signers[2]!.writeContract).not.toHaveBeenCalled();
      expect(signers[0]!.simulateCalls).toHaveBeenCalledWith(
        expect.objectContaining({ account: FACILITATOR_EOA }),
      );
    });
  });

  describe("custom operator — simulateCalls outcome checks", () => {
    it("should verify happy authorize with event, state, token deltas, and gas under the limit", async () => {
      const paymentInfo = buildPaymentInfo(CUSTOM_OPERATOR);
      installCustomOperatorSimulation({ paymentInfo });
      const scheme = new AuthCaptureEvmScheme(mockSigner, customOperatorConfig());
      const result = await scheme.verify(
        buildEip3009Payload(CUSTOM_OPERATOR),
        customOperatorRequirements(),
      );
      expect(result.isValid).toBe(true);
    });

    it("should reject when simulated gasUsed exceeds the custom gas limit", async () => {
      const paymentInfo = buildPaymentInfo(CUSTOM_OPERATOR);
      installCustomOperatorSimulation({
        paymentInfo,
        gasUsed: DEFAULT_CUSTOM_OPERATOR_AUTHORIZE_GAS_LIMIT + 1n,
      });
      const scheme = new AuthCaptureEvmScheme(mockSigner, customOperatorConfig());
      const result = await scheme.verify(
        buildEip3009Payload(CUSTOM_OPERATOR),
        customOperatorRequirements(),
      );
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_auth_capture_evm_simulation_failed");
      expect(mockSigner.writeContract).not.toHaveBeenCalled();
    });

    it("should reject when the forwarded call succeeds but emits no escrow-address log", async () => {
      const paymentInfo = buildPaymentInfo(CUSTOM_OPERATOR);
      installCustomOperatorSimulation({ paymentInfo, logs: [] });
      const scheme = new AuthCaptureEvmScheme(mockSigner, customOperatorConfig());
      const result = await scheme.verify(
        buildEip3009Payload(CUSTOM_OPERATOR),
        customOperatorRequirements(),
      );
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_auth_capture_evm_simulation_failed");
    });

    it("should reject authorize-then-void style final paymentState", async () => {
      const paymentInfo = buildPaymentInfo(CUSTOM_OPERATOR);
      installCustomOperatorSimulation({
        paymentInfo,
        postState: {
          hasCollectedPayment: false,
          capturableAmount: 0n,
          refundableAmount: 0n,
        },
      });
      const scheme = new AuthCaptureEvmScheme(mockSigner, customOperatorConfig());
      const result = await scheme.verify(
        buildEip3009Payload(CUSTOM_OPERATOR),
        customOperatorRequirements(),
      );
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_auth_capture_evm_simulation_failed");
    });

    it("should reject token delta mismatch", async () => {
      const paymentInfo = buildPaymentInfo(CUSTOM_OPERATOR);
      installCustomOperatorSimulation({
        paymentInfo,
        tokenStoreDelta: 0n,
      });
      const scheme = new AuthCaptureEvmScheme(mockSigner, customOperatorConfig());
      const result = await scheme.verify(
        buildEip3009Payload(CUSTOM_OPERATOR),
        customOperatorRequirements(),
      );
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_auth_capture_evm_simulation_failed");
    });

    it("should reject when facilitator balance decreases", async () => {
      const paymentInfo = buildPaymentInfo(CUSTOM_OPERATOR);
      installCustomOperatorSimulation({
        paymentInfo,
        facilitatorDelta: -1n,
      });
      const scheme = new AuthCaptureEvmScheme(mockSigner, customOperatorConfig());
      const result = await scheme.verify(
        buildEip3009Payload(CUSTOM_OPERATOR),
        customOperatorRequirements(),
      );
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_auth_capture_evm_simulation_failed");
    });

    it("should reject custom collect when simulateCalls is missing", async () => {
      const scheme = new AuthCaptureEvmScheme(mockSigner, customOperatorConfig());
      const result = await scheme.verify(
        buildEip3009Payload(CUSTOM_OPERATOR),
        customOperatorRequirements(),
      );
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_auth_capture_evm_simulation_failed");
    });

    it("should fail settle when the mined receipt lacks the escrow event", async () => {
      const paymentInfo = buildPaymentInfo(CUSTOM_OPERATOR);
      installCustomOperatorSimulation({ paymentInfo, receiptLogs: [] });
      const scheme = new AuthCaptureEvmScheme(mockSigner, customOperatorConfig());
      const result = await scheme.settle(
        buildEip3009Payload(CUSTOM_OPERATOR),
        customOperatorRequirements(),
      );
      expect(result.success).toBe(false);
      expect(result.errorReason).toBe("invalid_auth_capture_evm_simulation_failed");
    });

    it("should fail settle when mined token deltas differ from simulation", async () => {
      const paymentInfo = buildPaymentInfo(CUSTOM_OPERATOR);
      installCustomOperatorSimulation({
        paymentInfo,
        settledTokenStoreDelta: BigInt("999999"),
      });
      const scheme = new AuthCaptureEvmScheme(mockSigner, customOperatorConfig());
      const result = await scheme.settle(
        buildEip3009Payload(CUSTOM_OPERATOR),
        customOperatorRequirements(),
      );

      expect(result.success).toBe(false);
      expect(result.errorReason).toBe("invalid_auth_capture_evm_simulation_failed");
      expect(result.transaction).toBe(MOCK_TX_HASH);
    });

    it("should fail settle when the mined call spends facilitator payment tokens", async () => {
      const paymentInfo = buildPaymentInfo(CUSTOM_OPERATOR);
      installCustomOperatorSimulation({
        paymentInfo,
        settledFacilitatorDelta: -1n,
      });
      const scheme = new AuthCaptureEvmScheme(mockSigner, customOperatorConfig());
      const result = await scheme.settle(
        buildEip3009Payload(CUSTOM_OPERATOR),
        customOperatorRequirements(),
      );

      expect(result.success).toBe(false);
      expect(result.errorReason).toBe("invalid_auth_capture_evm_simulation_failed");
    });
  });

  describe("verify — operator types and salt binding", () => {
    it("should reject operatorType policy", async () => {
      const scheme = new AuthCaptureEvmScheme(mockSigner);
      const reqs = {
        ...mockRequirements,
        extra: { ...mockRequirements.extra, operatorType: "policy" },
      };
      const result = await scheme.verify(buildEip3009Payload(), reqs);
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_auth_capture_evm_unsupported_operator_type");
    });

    it("should reject custom operators that are not allowlisted", async () => {
      const scheme = new AuthCaptureEvmScheme(mockSigner);
      const reqs = {
        ...mockRequirements,
        extra: {
          ...mockRequirements.extra,
          captureAuthorizer: CUSTOM_OPERATOR,
          operatorType: "custom" as const,
        },
      };
      const result = await scheme.verify(buildEip3009Payload(CUSTOM_OPERATOR), reqs);
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_auth_capture_evm_operator_not_admitted");
    });

    it("should reject a bound extra without saltNonce", async () => {
      const scheme = new AuthCaptureEvmScheme(mockSigner);
      const reqs = {
        ...mockRequirements,
        extra: {
          ...mockRequirements.extra,
          receiverAuthorizer: "0x1111111111111111111111111111111111111111" as `0x${string}`,
        },
      };
      const result = await scheme.verify(buildEip3009Payload(), reqs);
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_auth_capture_evm_payload_format");
    });

    it("should reject a lifecycle payload for delegated without a receiver authorizer", async () => {
      const scheme = new AuthCaptureEvmScheme(mockSigner);
      const payload = {
        x402Version: 2,
        accepted: mockRequirements,
        payload: {
          type: "void",
          paymentInfo: buildPaymentInfo(),
          saltNonce: SALT,
          authorizerSignature: "0xabcd" as `0x${string}`,
        },
      };
      const result = await scheme.verify(payload, mockRequirements);
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_auth_capture_evm_lifecycle_not_relayed");
    });

    it("should accept a bound collect payload with matching saltNonce", async () => {
      const scheme = new AuthCaptureEvmScheme(mockSigner);
      const payload = buildBoundEip3009Payload();
      const result = await scheme.verify(payload, payload.accepted);
      expect(result.isValid).toBe(true);
    });

    it("should reject a bound collect payload whose salt does not match saltNonce", async () => {
      const scheme = new AuthCaptureEvmScheme(mockSigner);
      const payload = buildBoundEip3009Payload();
      payload.payload.salt = SALT;
      const result = await scheme.verify(payload, payload.accepted);
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_auth_capture_evm_salt_binding_mismatch");
    });
  });

  describe("verify/settle — lifecycle payloads", () => {
    it("should reject capture when paymentState balances do not match the signed expectations", async () => {
      mockSigner.readContract.mockImplementation(async (args: { functionName: string }) => {
        if (args.functionName === "isValidSignature") return ERC1271_MAGIC_VALUE;
        if (args.functionName === "paymentState") {
          return {
            hasCollectedPayment: true,
            capturableAmount: BigInt("400000"),
            refundableAmount: 0n,
          };
        }
        return BigInt("1000000000");
      });
      const scheme = new AuthCaptureEvmScheme(mockSigner);
      const envelope = buildCapturePayload();
      const result = await scheme.verify(envelope, envelope.accepted);
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_auth_capture_evm_unexpected_payment_state");
    });

    it("should retry stale paymentState reads before capture verify", async () => {
      let paymentStateCalls = 0;
      mockSigner.readContract.mockImplementation(async (args: { functionName: string }) => {
        if (args.functionName === "isValidSignature") return ERC1271_MAGIC_VALUE;
        if (args.functionName === "paymentState") {
          paymentStateCalls += 1;
          if (paymentStateCalls === 1) {
            return {
              hasCollectedPayment: false,
              capturableAmount: 0n,
              refundableAmount: 0n,
            };
          }
          return {
            hasCollectedPayment: true,
            capturableAmount: BigInt("1000000"),
            refundableAmount: 0n,
          };
        }
        return BigInt("1000000000");
      });

      vi.useFakeTimers();
      const scheme = new AuthCaptureEvmScheme(mockSigner);
      const envelope = buildCapturePayload();
      const verifyPromise = scheme.verify(envelope, envelope.accepted);
      await vi.advanceTimersByTimeAsync(200);
      const result = await verifyPromise;
      vi.useRealTimers();

      expect(result.isValid).toBe(true);
      expect(paymentStateCalls).toBe(2);
    });

    it("should reject voidAuthorizerSignature on a full capture", async () => {
      const scheme = new AuthCaptureEvmScheme(mockSigner);
      const envelope = buildCapturePayload({
        amount: "1000000",
        voidAuthorizerSignature: "0xabcd",
      });
      const result = await scheme.verify(envelope, envelope.accepted);
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_auth_capture_evm_void_remainder_full_capture");
    });

    it("should reject voidAuthorizerSignature on a void payload", async () => {
      const scheme = new AuthCaptureEvmScheme(mockSigner);
      const extra = boundExtra();
      const accepted = { ...mockRequirements, extra };
      const result = await scheme.verify(
        {
          x402Version: 2,
          accepted,
          payload: {
            type: "void",
            paymentInfo: boundPaymentInfo(),
            saltNonce: SALT_NONCE,
            authorizerSignature: "0xabcd",
            voidAuthorizerSignature: "0xabcd",
          },
        },
        accepted,
      );
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_auth_capture_evm_void_authorizer_signature");
    });

    it("should settle capture then void when voidAuthorizerSignature is present", async () => {
      const scheme = new AuthCaptureEvmScheme(mockSigner);
      const envelope = buildCapturePayload({ voidAuthorizerSignature: "0xabcd" });
      const result = await scheme.settle(envelope, envelope.accepted);
      expect(result.success).toBe(true);
      expect(result.amount).toBe("500000");
      const names = mockSigner.writeContract.mock.calls.map(
        (call: [{ functionName: string }]) => call[0].functionName,
      );
      expect(names).toEqual(["capture", "void"]);
    });

    it("should keep the capture transaction when the trailing void fails on RPC", async () => {
      const captureTx = "0xcafe000000000000000000000000000000000000000000000000000000000001";
      mockSigner.writeContract.mockImplementation(
        async ({ functionName }: { functionName: string }) => {
          if (functionName === "void") throw new Error("Transaction receipt timeout after 60s");
          return captureTx as `0x${string}`;
        },
      );
      const scheme = new AuthCaptureEvmScheme(mockSigner);
      const envelope = buildCapturePayload({ voidAuthorizerSignature: "0xabcd" });

      const result = await scheme.settle(envelope, envelope.accepted);

      expect(result.success).toBe(true);
      expect(result.transaction).toBe(captureTx);
      expect(result.amount).toBe("500000");
    });

    it("should keep the capture transaction when the trailing void reverts", async () => {
      const captureTx = "0xcafe000000000000000000000000000000000000000000000000000000000002";
      mockSigner.writeContract.mockResolvedValue(captureTx as `0x${string}`);
      mockSigner.waitForTransactionReceipt.mockImplementation(async () =>
        mockSigner.writeContract.mock.calls.length > 1
          ? { status: "reverted" }
          : { status: "success" },
      );
      const scheme = new AuthCaptureEvmScheme(mockSigner);
      const envelope = buildCapturePayload({ voidAuthorizerSignature: "0xabcd" });

      const result = await scheme.settle(envelope, envelope.accepted);

      expect(result.success).toBe(true);
      expect(result.transaction).toBe(captureTx);
    });

    it("should reject delegated refunds when refundFunding is not configured", async () => {
      const scheme = new AuthCaptureEvmScheme(mockSigner);
      const extra = boundExtra();
      const accepted = { ...mockRequirements, extra };
      const result = await scheme.verify(
        {
          x402Version: 2,
          accepted,
          payload: {
            type: "refund",
            paymentInfo: boundPaymentInfo(),
            saltNonce: SALT_NONCE,
            amount: "100000",
            expectedCapturableAmount: "0",
            expectedRefundableAmount: "1000000",
            authorizerSignature: "0xabcd",
          },
        },
        accepted,
      );
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_auth_capture_evm_refund_funding_unavailable");
    });

    it("should settle a refund through the operator refund collector when funding is configured", async () => {
      mockSigner.readContract.mockImplementation(async (args: { functionName: string }) => {
        if (args.functionName === "isValidSignature") return ERC1271_MAGIC_VALUE;
        if (args.functionName === "paymentState") {
          return {
            hasCollectedPayment: true,
            capturableAmount: 0n,
            refundableAmount: BigInt("1000000"),
          };
        }
        return BigInt("1000000000");
      });
      const scheme = new AuthCaptureEvmScheme(mockSigner, { refundFunding: true });
      const extra = boundExtra();
      const accepted = { ...mockRequirements, extra };
      const envelope = {
        x402Version: 2,
        accepted,
        payload: {
          type: "refund" as const,
          paymentInfo: boundPaymentInfo(),
          saltNonce: SALT_NONCE,
          amount: "250000",
          expectedCapturableAmount: "0",
          expectedRefundableAmount: "1000000",
          authorizerSignature: "0xabcd" as `0x${string}`,
        },
      };
      const result = await scheme.settle(envelope, accepted);
      expect(result.success).toBe(true);
      const call = mockSigner.writeContract.mock.calls[0][0];
      expect(call.functionName).toBe("refund");
      expect(call.args[2]).toBe(OPERATOR_REFUND_COLLECTOR_ADDRESS);
    });
  });
});

describe("auth-capture paymentState reads", () => {
  describe("normalizePaymentState", () => {
    it("should parse flat object shapes from viem", () => {
      expect(
        normalizePaymentState({
          hasCollectedPayment: true,
          capturableAmount: 10000n,
          refundableAmount: 0n,
        }),
      ).toEqual({
        hasCollectedPayment: true,
        capturableAmount: 10000n,
        refundableAmount: 0n,
      });
    });

    it("should parse tuple arrays", () => {
      expect(normalizePaymentState([true, 10000n, 0n])).toEqual({
        hasCollectedPayment: true,
        capturableAmount: 10000n,
        refundableAmount: 0n,
      });
    });

    it("should unwrap nested state objects", () => {
      expect(
        normalizePaymentState({
          state: { hasCollectedPayment: false, capturableAmount: 1n, refundableAmount: 2n },
        }),
      ).toEqual({
        hasCollectedPayment: false,
        capturableAmount: 1n,
        refundableAmount: 2n,
      });
    });

    it("should return undefined for unrecognized values", () => {
      expect(normalizePaymentState(null)).toBeUndefined();
      expect(normalizePaymentState({})).toBeUndefined();
      expect(normalizePaymentState([true])).toBeUndefined();
    });
  });

  describe("readPaymentStateForBalances", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    function createSigner(readImpl: () => Promise<unknown>): FacilitatorEvmSigner {
      return {
        readContract: vi.fn().mockImplementation(readImpl),
      } as unknown as FacilitatorEvmSigner;
    }

    it("should return immediately when balances match", async () => {
      const signer = createSigner(async () => ({
        hasCollectedPayment: true,
        capturableAmount: 10000n,
        refundableAmount: 0n,
      }));

      const result = await readPaymentStateForBalances(
        signer,
        "0x1234567890123456789012345678901234567890123456789012345678901234",
        10000n,
        0n,
      );

      expect(result).toEqual({
        state: {
          hasCollectedPayment: true,
          capturableAmount: 10000n,
          refundableAmount: 0n,
        },
        readFailed: false,
        attempts: 1,
      });
      expect(signer.readContract).toHaveBeenCalledTimes(1);
    });

    it("should retry stale zero balances until RPC catches up", async () => {
      let calls = 0;
      const signer = createSigner(async () => {
        calls += 1;
        if (calls === 1) {
          return { hasCollectedPayment: false, capturableAmount: 0n, refundableAmount: 0n };
        }
        return { hasCollectedPayment: true, capturableAmount: 10000n, refundableAmount: 0n };
      });

      const resultPromise = readPaymentStateForBalances(
        signer,
        "0x1234567890123456789012345678901234567890123456789012345678901234",
        10000n,
        0n,
      );
      await vi.advanceTimersByTimeAsync(PAYMENT_STATE_RETRY_DELAYS_MS[0]!);
      const result = await resultPromise;

      expect(result.state?.capturableAmount).toBe(10000n);
      expect(result.readFailed).toBe(false);
      expect(result.attempts).toBe(2);
      expect(signer.readContract).toHaveBeenCalledTimes(2);
    });

    it("should retry stale zero balances after charge until RPC catches up", async () => {
      let calls = 0;
      const signer = createSigner(async () => {
        calls += 1;
        if (calls === 1) {
          return { hasCollectedPayment: false, capturableAmount: 0n, refundableAmount: 0n };
        }
        return { hasCollectedPayment: true, capturableAmount: 0n, refundableAmount: 10000n };
      });

      const resultPromise = readPaymentStateForBalances(
        signer,
        "0x1234567890123456789012345678901234567890123456789012345678901234",
        0n,
        10000n,
      );
      await vi.advanceTimersByTimeAsync(PAYMENT_STATE_RETRY_DELAYS_MS[0]!);
      const result = await resultPromise;

      expect(result.state?.refundableAmount).toBe(10000n);
      expect(result.readFailed).toBe(false);
      expect(result.attempts).toBe(2);
      expect(signer.readContract).toHaveBeenCalledTimes(2);
    });

    it("should stop retrying when balances genuinely mismatch", async () => {
      const signer = createSigner(async () => ({
        hasCollectedPayment: true,
        capturableAmount: 5000n,
        refundableAmount: 0n,
      }));

      const result = await readPaymentStateForBalances(
        signer,
        "0x1234567890123456789012345678901234567890123456789012345678901234",
        10000n,
        0n,
      );

      expect(result.state?.capturableAmount).toBe(5000n);
      expect(result.readFailed).toBe(false);
      expect(result.attempts).toBe(1);
      expect(signer.readContract).toHaveBeenCalledTimes(1);
    });

    it("should exhaust retries when reads keep failing", async () => {
      const signer = createSigner(async () => {
        throw new Error("rpc down");
      });

      const resultPromise = readPaymentStateForBalances(
        signer,
        "0x1234567890123456789012345678901234567890123456789012345678901234",
        10000n,
        0n,
      );
      await vi.advanceTimersByTimeAsync(
        PAYMENT_STATE_RETRY_DELAYS_MS.reduce((sum, delay) => sum + delay, 0),
      );
      const result = await resultPromise;

      expect(result.readFailed).toBe(true);
      expect(result.state).toBeUndefined();
      expect(result.attempts).toBe(PAYMENT_STATE_MAX_ATTEMPTS);
      expect(signer.readContract).toHaveBeenCalledTimes(PAYMENT_STATE_MAX_ATTEMPTS);
    });
  });

  describe("readPaymentStateOnce", () => {
    it("should return undefined when readContract throws", async () => {
      const signer = {
        readContract: vi.fn().mockRejectedValue(new Error("rpc down")),
      } as unknown as FacilitatorEvmSigner;

      await expect(
        readPaymentStateOnce(
          signer,
          "0x1234567890123456789012345678901234567890123456789012345678901234",
        ),
      ).resolves.toBeUndefined();
    });
  });
});

describe("facilitatorAddresses and selectSubmitter", () => {
  const addrA = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as `0x${string}`;
  const addrB = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as `0x${string}`;
  const addrC = "0xcccccccccccccccccccccccccccccccccccccccc" as `0x${string}`;

  function stubSigner(addresses: readonly `0x${string}`[]): FacilitatorEvmSigner {
    return { getAddresses: () => addresses } as FacilitatorEvmSigner;
  }

  it("should flatten and dedupe addresses across members", () => {
    const signers = [stubSigner([addrA, addrB]), stubSigner([addrB, addrC])];
    expect(facilitatorAddresses(signers)).toEqual([addrA, addrB, addrC]);
  });

  it("should return the owning signer", () => {
    const owner = stubSigner([addrB]);
    const other = stubSigner([addrA]);
    expect(selectSubmitter([other, owner], addrB)).toBe(owner);
  });

  it("should match across checksum and lowercase", () => {
    const owner = stubSigner([getAddress(addrB)]);
    expect(selectSubmitter([owner], addrB.toLowerCase() as `0x${string}`)).toBe(owner);
  });

  it("should return undefined for an unknown address", () => {
    expect(selectSubmitter([stubSigner([addrA])], addrB)).toBeUndefined();
  });
});
