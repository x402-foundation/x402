import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, encodeErrorResult } from "viem";
import {
  ErrSettlementPending,
  HederaContractRevertError,
  HederaPendingError,
  batchSettlementABI,
  createMirrorNodeContractReader,
  hederaAllowanceDepositCollectorABI,
  runContractSettlement,
} from "../../../src/batch-settlement";
import { DEPLOYMENT, NETWORK } from "./helpers";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("mirror node contract reader", () => {
  it("decodes successful calls", async () => {
    globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.to).toBe(DEPLOYMENT.settlement);
      expect(body.data).toMatch(/^0x/);
      return new Response(
        JSON.stringify({
          result: encodeAbiParameters([{ type: "uint128" }, { type: "uint128" }], [10n, 3n]),
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    const reader = createMirrorNodeContractReader({ mirrorNodeUrl: "http://mirror.test" });
    const result = await reader.readContract({
      address: DEPLOYMENT.settlement,
      abi: batchSettlementABI,
      functionName: "channels",
      args: [`0x${"11".repeat(32)}`],
    });
    expect(result).toEqual([10n, 3n]);
  });

  it("decodes custom-error reverts from Mirror Node error bodies", async () => {
    const data = encodeErrorResult({
      abi: hederaAllowanceDepositCollectorABI,
      errorName: "HtsTransferFailed",
      args: [292n],
    });
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            _status: { messages: [{ message: "CONTRACT_REVERT_EXECUTED", detail: "", data }] },
          }),
          { status: 400 },
        ),
    ) as typeof fetch;
    const reader = createMirrorNodeContractReader({ mirrorNodeUrl: "http://mirror.test" });
    await expect(
      reader.simulateContract({
        address: DEPLOYMENT.settlement,
        abi: batchSettlementABI,
        functionName: "settle",
        args: [DEPLOYMENT.settlement, DEPLOYMENT.collector],
      }),
    ).rejects.toMatchObject({
      name: "HederaContractRevertError",
      message: "HtsTransferFailed (292)",
    });
  });
});

describe("runContractSettlement", () => {
  it("maps success, revert and pending outcomes", async () => {
    const ok = await runContractSettlement(
      async () => ({ transactionId: "0.0.1@1.1", logs: [] }),
      NETWORK,
      "0xabc",
      { amount: "5" },
    );
    expect(ok).toMatchObject({
      success: true,
      transaction: "0.0.1@1.1",
      amount: "5",
      payer: "0xabc",
    });

    const reverted = await runContractSettlement(
      async () => {
        throw new HederaContractRevertError(
          "CONTRACT_REVERT_EXECUTED",
          "InvalidSignature",
          undefined,
          "0.0.1@2.2",
        );
      },
      NETWORK,
      undefined,
      { failedStatusReason: "boom" },
    );
    expect(reverted).toMatchObject({
      success: false,
      errorReason: "boom",
      transaction: "0.0.1@2.2",
    });

    const pending = await runContractSettlement(
      async () => {
        throw new HederaPendingError("0.0.1@3.3", new Error("record timeout"));
      },
      NETWORK,
      undefined,
    );
    expect(pending).toMatchObject({
      success: false,
      errorReason: ErrSettlementPending,
      transaction: "0.0.1@3.3",
    });

    const onSuccessThrew = await runContractSettlement(
      async () => ({ transactionId: "0.0.1@4.4", logs: [] }),
      NETWORK,
      undefined,
      {
        onSuccess: () => {
          throw new Error("post-processing failed");
        },
      },
    );
    expect(onSuccessThrew).toMatchObject({
      success: false,
      errorReason: ErrSettlementPending,
      transaction: "0.0.1@4.4",
    });
  });
});
