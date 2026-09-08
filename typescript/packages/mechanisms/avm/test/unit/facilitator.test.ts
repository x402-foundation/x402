import { describe, it, expect, vi } from "vitest";
import { decodeAddress } from "@algorandfoundation/algokit-utils/common";
import {
  Transaction,
  groupTransactions,
  encodeTransactionRaw,
  encodeSignedTransaction,
} from "@algorandfoundation/algokit-utils/transact";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { ExactAvmScheme as ExactAvmFacilitator } from "../../src/exact/facilitator/scheme";
import * as Errors from "../../src/exact/facilitator/errors";
import {
  ALGORAND_TESTNET_CAIP2,
  ALGORAND_TESTNET_GENESIS_HASH,
  USDC_TESTNET_ASA_ID,
  toClientAvmSigner,
  encodeTransaction,
} from "../../src";
import type { ExactAvmPayloadV2 } from "../../src/types";
import type { FacilitatorAvmSigner } from "../../src/signer";

const CLIENT_KEY =
  "mZHHvLfOqJrIxIMTYPFdGWxfZy1MtaT3J6aJny+4yW1jkF6o6oKpKU7m5JfNdghc26oLTvRnEEBkDjY14WU3Cw==";
const FACIL_KEY =
  "4f3r4kJFn4a1l7ZdHdKQ6S9NSfXs2-8TRIKRwFiBLU4TPTtroT7kFdGQlQ0QryHbYq3AlGpDx6NlNnZOFg8yGw==";

const PAY_TO = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ";
const AMOUNT = "1000";

const baseRequirements: PaymentRequirements = {
  scheme: "exact",
  network: ALGORAND_TESTNET_CAIP2,
  asset: USDC_TESTNET_ASA_ID,
  amount: AMOUNT,
  payTo: PAY_TO,
  maxTimeoutSeconds: 3600,
  extra: {},
};

async function buildPaymentGroup(overrides?: {
  amount?: bigint;
  assetId?: bigint;
  receiver?: string;
  clientKey?: string;
  facilitatorKey?: string;
  fee?: bigint;
  includeFeePayer?: boolean;
}): Promise<{
  paymentGroup: string[];
  paymentIndex: number;
  clientAddress: string;
  facilitatorAddress: string;
}> {
  const client = toClientAvmSigner(overrides?.clientKey ?? CLIENT_KEY);
  const facilitator = toClientAvmSigner(overrides?.facilitatorKey ?? FACIL_KEY);
  const genesisHash = Buffer.from(ALGORAND_TESTNET_GENESIS_HASH, "base64");
  const includeFeePayer = overrides?.includeFeePayer ?? true;

  const txns: Transaction[] = [];
  let paymentIndex = 0;

  if (includeFeePayer) {
    txns.push(
      new Transaction({
        type: "pay",
        sender: decodeAddress(facilitator.address),
        fee: overrides?.fee ?? 2000n,
        firstValid: 1000n,
        lastValid: 2000n,
        genesisHash,
        genesisId: "testnet-v1.0",
        payment: { amount: 0n, receiver: decodeAddress(facilitator.address) },
      }),
    );
    paymentIndex = 1;
  }

  txns.push(
    new Transaction({
      type: "axfer",
      sender: decodeAddress(client.address),
      fee: includeFeePayer ? 0n : 1000n,
      firstValid: 1000n,
      lastValid: 2000n,
      genesisHash,
      genesisId: "testnet-v1.0",
      assetTransfer: {
        assetId: overrides?.assetId ?? BigInt(USDC_TESTNET_ASA_ID),
        amount: overrides?.amount ?? BigInt(AMOUNT),
        receiver: decodeAddress(overrides?.receiver ?? PAY_TO),
      },
    }),
  );

  const grouped = groupTransactions(txns);
  const encoded = grouped.map(t => encodeTransactionRaw(t));
  const signed = await client.signTransactions(encoded, [paymentIndex]);
  const paymentGroup = encoded.map((b, i) => encodeTransaction(signed[i] ?? b));

  return {
    paymentGroup,
    paymentIndex,
    clientAddress: client.address,
    facilitatorAddress: facilitator.address,
  };
}

function makePayload(
  paymentGroup: string[],
  paymentIndex: number,
  requirements: PaymentRequirements = baseRequirements,
): PaymentPayload {
  const payload: ExactAvmPayloadV2 = { paymentGroup, paymentIndex };
  return {
    x402Version: 2,
    resource: { url: "https://example.com", description: "test", mimeType: "application/json" },
    accepted: requirements,
    payload: payload as unknown as Record<string, unknown>,
  };
}

function mockFacilitatorSigner(
  facilitatorAddress: string,
  overrides: Partial<FacilitatorAvmSigner> = {},
): FacilitatorAvmSigner {
  const realFacilitator = toClientAvmSigner(FACIL_KEY);
  return {
    getAddresses: () => [facilitatorAddress],
    signTransaction: async (txn, sender) => {
      void sender;
      const signed = await realFacilitator.signTransactions([txn], [0]);
      return signed[0]!;
    },
    getAlgodClient: vi.fn() as FacilitatorAvmSigner["getAlgodClient"],
    simulateTransactions: vi.fn(async () => ({ txnGroups: [{ failureMessage: undefined }] })),
    sendTransactions: vi.fn(async () => "tx-id"),
    waitForConfirmation: vi.fn(async () => ({})),
    ...overrides,
  };
}

describe("ExactAvm facilitator scheme", () => {
  it("exposes feePayer via getExtra and addresses via getSigners", async () => {
    const { facilitatorAddress } = await buildPaymentGroup();
    const scheme = new ExactAvmFacilitator(mockFacilitatorSigner(facilitatorAddress));

    expect(scheme.getSigners(ALGORAND_TESTNET_CAIP2)).toEqual([facilitatorAddress]);
    expect(scheme.getExtra(ALGORAND_TESTNET_CAIP2)).toEqual({ feePayer: facilitatorAddress });
    expect(scheme.getExtra(ALGORAND_TESTNET_CAIP2)).toEqual({ feePayer: facilitatorAddress });
  });

  it("returns undefined getExtra when facilitator has no addresses", () => {
    const scheme = new ExactAvmFacilitator({
      ...mockFacilitatorSigner("addr"),
      getAddresses: () => [],
    });
    expect(scheme.getExtra(ALGORAND_TESTNET_CAIP2)).toBeUndefined();
  });

  it("verifies a valid sponsored payment group", async () => {
    const { paymentGroup, paymentIndex, clientAddress, facilitatorAddress } =
      await buildPaymentGroup();
    const scheme = new ExactAvmFacilitator(mockFacilitatorSigner(facilitatorAddress));
    const result = await scheme.verify(makePayload(paymentGroup, paymentIndex), baseRequirements);

    expect(result.isValid).toBe(true);
    expect(result.payer).toBe(clientAddress);
  });

  it("rejects wrong x402 version, scheme, and network", async () => {
    const { paymentGroup, paymentIndex, facilitatorAddress } = await buildPaymentGroup();
    const scheme = new ExactAvmFacilitator(mockFacilitatorSigner(facilitatorAddress));
    const payload = makePayload(paymentGroup, paymentIndex);

    expect(
      (await scheme.verify({ ...payload, x402Version: 1 }, baseRequirements)).invalidReason,
    ).toBe(Errors.ErrInvalidVersion);

    const wrongSchemeReq = { ...baseRequirements, scheme: "permit" as "exact" };
    expect(
      (await scheme.verify({ ...payload, accepted: wrongSchemeReq }, wrongSchemeReq)).invalidReason,
    ).toBe(Errors.ErrInvalidScheme);

    const mainnetReq = {
      ...baseRequirements,
      network: "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73k" as typeof ALGORAND_TESTNET_CAIP2,
    };
    expect(
      (await scheme.verify({ ...payload, accepted: mainnetReq }, baseRequirements)).invalidReason,
    ).toBe(Errors.ErrNetworkMismatch);
  });

  it("rejects malformed payload and invalid payment index", async () => {
    const { paymentGroup, facilitatorAddress } = await buildPaymentGroup();
    const scheme = new ExactAvmFacilitator(mockFacilitatorSigner(facilitatorAddress));

    const badPayload = makePayload(paymentGroup, 0);
    badPayload.payload = { not: "valid" };
    expect((await scheme.verify(badPayload, baseRequirements)).invalidReason).toBe(
      Errors.ErrInvalidPayload,
    );

    expect(
      (await scheme.verify(makePayload(paymentGroup, 99), baseRequirements)).invalidReason,
    ).toBe(Errors.ErrInvalidPaymentIndex);
  });

  it("rejects amount, receiver, and asset mismatches", async () => {
    const { paymentGroup, paymentIndex, facilitatorAddress } = await buildPaymentGroup();
    const scheme = new ExactAvmFacilitator(mockFacilitatorSigner(facilitatorAddress));
    const payload = makePayload(paymentGroup, paymentIndex);

    expect(
      (await scheme.verify(payload, { ...baseRequirements, amount: "9999" })).invalidReason,
    ).toBe(Errors.ErrAmountMismatch);
    expect(
      (
        await scheme.verify(payload, {
          ...baseRequirements,
          payTo: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
        })
      ).invalidReason,
    ).toBe(Errors.ErrReceiverMismatch);
    expect(
      (await scheme.verify(payload, { ...baseRequirements, asset: "99999999" })).invalidReason,
    ).toBe(Errors.ErrAssetMismatch);
  });

  it("rejects facilitator-as-payer and unsigned payment transactions", async () => {
    const { paymentGroup, paymentIndex, facilitatorAddress } = await buildPaymentGroup({
      clientKey: FACIL_KEY,
      includeFeePayer: false,
    });
    const scheme = new ExactAvmFacilitator(mockFacilitatorSigner(facilitatorAddress));
    expect(
      (await scheme.verify(makePayload(paymentGroup, paymentIndex), baseRequirements))
        .invalidReason,
    ).toBe(Errors.ErrFacilitatorTransferring);

    const client = toClientAvmSigner(CLIENT_KEY);
    const genesisHash = Buffer.from(ALGORAND_TESTNET_GENESIS_HASH, "base64");
    const unsignedAxfer = encodeTransaction(
      encodeSignedTransaction({
        txn: new Transaction({
          type: "axfer",
          sender: decodeAddress(client.address),
          fee: 1000n,
          firstValid: 1000n,
          lastValid: 2000n,
          genesisHash,
          genesisId: "testnet-v1.0",
          assetTransfer: {
            assetId: BigInt(USDC_TESTNET_ASA_ID),
            amount: BigInt(AMOUNT),
            receiver: decodeAddress(PAY_TO),
          },
        }),
      }),
    );
    expect(
      (await scheme.verify(makePayload([unsignedAxfer], 0), baseRequirements)).invalidReason,
    ).toBe(Errors.ErrPaymentNotSigned);
  });

  it("rejects invalid transactions, group id mismatch, and simulation failures", async () => {
    const { paymentGroup, paymentIndex, facilitatorAddress } = await buildPaymentGroup();
    const scheme = new ExactAvmFacilitator(mockFacilitatorSigner(facilitatorAddress));

    const invalidTxnPayload = makePayload(["not-valid-base64!!!"], 0);
    expect((await scheme.verify(invalidTxnPayload, baseRequirements)).invalidReason).toBe(
      Errors.ErrInvalidTransaction,
    );

    const { paymentGroup: otherGroup } = await buildPaymentGroup({ amount: 2000n });
    const mismatchedGroup = [paymentGroup[0], otherGroup[1]];
    expect(
      (await scheme.verify(makePayload(mismatchedGroup, paymentIndex), baseRequirements))
        .invalidReason,
    ).toBe(Errors.ErrInvalidGroupId);

    const simFailScheme = new ExactAvmFacilitator(
      mockFacilitatorSigner(facilitatorAddress, {
        simulateTransactions: vi.fn(async () => ({
          txnGroups: [{ failureMessage: "simulation failed" }],
        })),
      }),
    );
    expect(
      (await simFailScheme.verify(makePayload(paymentGroup, paymentIndex), baseRequirements))
        .invalidReason,
    ).toBe(Errors.ErrSimulationFailed);
  });

  it("rejects invalid fee payer transactions", async () => {
    const { paymentGroup, paymentIndex, facilitatorAddress } = await buildPaymentGroup({
      fee: 999999n,
    });
    const scheme = new ExactAvmFacilitator(mockFacilitatorSigner(facilitatorAddress));
    expect(
      (await scheme.verify(makePayload(paymentGroup, paymentIndex), baseRequirements))
        .invalidReason,
    ).toBe(Errors.ErrFeeTooHigh);
  });

  it("settles successfully when verify passes", async () => {
    const { paymentGroup, paymentIndex, clientAddress, facilitatorAddress } =
      await buildPaymentGroup();
    const signer = mockFacilitatorSigner(facilitatorAddress);
    const scheme = new ExactAvmFacilitator(signer);
    const payload = makePayload(paymentGroup, paymentIndex);

    const result = await scheme.settle(payload, baseRequirements);
    expect(result.success).toBe(true);
    expect(result.payer).toBe(clientAddress);
    expect(result.transaction).toBeDefined();
    expect(signer.sendTransactions).toHaveBeenCalled();
    expect(signer.waitForConfirmation).toHaveBeenCalled();
  });

  it("returns verify errors from settle without submitting", async () => {
    const { paymentGroup, facilitatorAddress } = await buildPaymentGroup();
    const signer = mockFacilitatorSigner(facilitatorAddress);
    const scheme = new ExactAvmFacilitator(signer);
    const result = await scheme.settle(makePayload(paymentGroup, 99), baseRequirements);

    expect(result.success).toBe(false);
    expect(result.errorReason).toBe(Errors.ErrInvalidPaymentIndex);
    expect(signer.sendTransactions).not.toHaveBeenCalled();
  });

  it("returns settle and confirmation errors", async () => {
    const { paymentGroup, paymentIndex, facilitatorAddress } = await buildPaymentGroup();
    const payload = makePayload(paymentGroup, paymentIndex);

    const submitFail = new ExactAvmFacilitator(
      mockFacilitatorSigner(facilitatorAddress, {
        sendTransactions: vi.fn(async () => {
          throw new Error("submit failed");
        }),
      }),
    );
    const submitResult = await submitFail.settle(payload, baseRequirements);
    expect(submitResult.success).toBe(false);
    expect(submitResult.errorReason).toBe(Errors.ErrSettleFailed);

    const confirmFail = new ExactAvmFacilitator(
      mockFacilitatorSigner(facilitatorAddress, {
        waitForConfirmation: vi.fn(async () => {
          throw new Error("confirm failed");
        }),
      }),
    );
    const confirmResult = await confirmFail.settle(payload, baseRequirements);
    expect(confirmResult.success).toBe(false);
    expect(confirmResult.errorReason).toBe(Errors.ErrConfirmationFailed);
  });
});
