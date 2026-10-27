import { describe, expect, it, vi } from "vitest";
import { x402Client } from "@x402/core/client";
import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { ExactHederaScheme } from "../../src/exact/client/scheme";
import type { ClientHederaSigner } from "../../src/signer";

const AUTHORIZATION = "0x0f2c9d1a";

const transferExecutorRequirements = (
  extra: Record<string, unknown> = {},
): PaymentRequirements => ({
  scheme: "exact",
  network: "hedera:testnet",
  asset: "0.0.0",
  amount: "100000000",
  payTo: "0.0.4001",
  maxTimeoutSeconds: 120,
  extra: {
    assetTransferMethod: "transferExecutor",
    executors: ["0.0.7000"],
    ...extra,
  },
});

const signerWithHook = (executor = "0.0.7000", authorization = AUTHORIZATION) => ({
  accountId: "0.0.5001",
  createPartiallySignedTransferTransaction: vi.fn(async () => "YmFzZTY0LXR4"),
  createTransferExecutorAuthorization: vi.fn(async () => ({
    executor,
    authorization,
  })),
});

describe("ExactHedera client scheme: transferExecutor", () => {
  it("builds the payload from the signer hook", async () => {
    const signer = signerWithHook();
    const requirements = transferExecutorRequirements();

    expect(requirements.extra).not.toHaveProperty("feePayer");

    const result = await new ExactHederaScheme(signer).createPaymentPayload(2, requirements);

    expect(signer.createTransferExecutorAuthorization).toHaveBeenCalledWith(requirements);
    expect(signer.createPartiallySignedTransferTransaction).not.toHaveBeenCalled();
    expect(result).toEqual({
      x402Version: 2,
      payload: { payer: "0.0.5001", executor: "0.0.7000", authorization: AUTHORIZATION },
    });
  });

  it("carries only payer, executor and authorization", async () => {
    const signer = signerWithHook();
    signer.createTransferExecutorAuthorization.mockResolvedValueOnce({
      executor: "0.0.7000",
      authorization: AUTHORIZATION,
      transaction: "YmFzZTY0LXR4",
    } as Awaited<ReturnType<typeof signer.createTransferExecutorAuthorization>>);

    const result = await new ExactHederaScheme(signer).createPaymentPayload(
      2,
      transferExecutorRequirements(),
    );

    expect(Object.keys(result.payload).sort()).toEqual(["authorization", "executor", "payer"]);
  });

  it("refuses a signer without createTransferExecutorAuthorization", async () => {
    const signer: ClientHederaSigner = {
      accountId: "0.0.5001",
      createPartiallySignedTransferTransaction: vi.fn(async () => "YmFzZTY0LXR4"),
    };

    const error = await new ExactHederaScheme(signer)
      .createPaymentPayload(2, transferExecutorRequirements())
      .catch((e: unknown) => e);

    expect(error).not.toBeInstanceOf(TypeError);
    expect((error as Error).message).toMatch(
      /transferExecutor\b.*createTransferExecutorAuthorization/,
    );
    expect(signer.createPartiallySignedTransferTransaction).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", undefined],
    ["empty", []],
    ["not an array", "0.0.7000"],
    ["not all strings", ["0.0.7000", 7000]],
  ])("refuses a quote whose extra.executors is %s", async (_label, executors) => {
    const signer = signerWithHook();

    await expect(
      new ExactHederaScheme(signer).createPaymentPayload(
        2,
        transferExecutorRequirements({ executors }),
      ),
    ).rejects.toThrow("executors is required in paymentRequirements.extra");
    expect(signer.createTransferExecutorAuthorization).not.toHaveBeenCalled();
  });

  it("refuses an executor that is not in extra.executors", async () => {
    const signer = signerWithHook("0.0.9999");
    const requirements = transferExecutorRequirements({ executors: ["0.0.7000", "0.0.7001"] });

    await expect(
      new ExactHederaScheme(signer).createPaymentPayload(2, requirements),
    ).rejects.toThrow("Executor 0.0.9999 is not in paymentRequirements.extra.executors");
  });

  it("accepts any executor when extra.executors lists the wildcard", async () => {
    const signer = signerWithHook("0.0.9999");
    const requirements = transferExecutorRequirements({ executors: ["*"] });

    const result = await new ExactHederaScheme(signer).createPaymentPayload(2, requirements);

    expect(result.payload).toEqual({
      payer: "0.0.5001",
      executor: "0.0.9999",
      authorization: AUTHORIZATION,
    });
  });

  it.each([
    ["abc", '"abc"', ["*"]],
    ["0.0.x", '"0.0.x"', ["*"]],
    ["", '""', ["*"]],
    [7000, "7000", ["*"]],
    ["abc", '"abc"', ["abc"]],
  ])(
    "refuses a hook executor %j that is not a Hedera contract id",
    async (executor, expectedInMessage, executors) => {
      const signer = signerWithHook(executor as string);

      await expect(
        new ExactHederaScheme(signer).createPaymentPayload(
          2,
          transferExecutorRequirements({ executors }),
        ),
      ).rejects.toThrow(
        `Executor ${expectedInMessage} returned by createTransferExecutorAuthorization is not a Hedera contract id`,
      );
    },
  );

  it.each([
    ["0xzz", '"0xzz"', ["0.0.7000"]],
    ["abc", '"abc"', ["0.0.7000"]],
    ["0x0f2", '"0x0f2"', ["0.0.7000"]],
    ["", '""', ["0.0.7000"]],
    [7000, "7000", ["0.0.7000"]],
    [null, "null", ["0.0.7000"]],
    ["0xzz", '"0xzz"', ["0.0.7001"]],
  ])(
    "refuses a hook authorization %j that is not 0x-prefixed hex",
    async (authorization, expectedInMessage, executors) => {
      const signer = signerWithHook("0.0.7000", authorization as string);

      await expect(
        new ExactHederaScheme(signer).createPaymentPayload(
          2,
          transferExecutorRequirements({ executors }),
        ),
      ).rejects.toThrow(
        `Authorization ${expectedInMessage} returned by createTransferExecutorAuthorization is not 0x-prefixed hex`,
      );
    },
  );

  it.each([["0.0.b794f5"], ["5001"], [""]])(
    "refuses a signer accountId %j that is not a Hedera account id, before calling the hook",
    async accountId => {
      const signer = { ...signerWithHook(), accountId };

      await expect(
        new ExactHederaScheme(signer).createPaymentPayload(2, transferExecutorRequirements()),
      ).rejects.toThrow(
        `Signer accountId ${JSON.stringify(accountId)} is not a Hedera account id, so it cannot be payload.payer`,
      );
      expect(signer.createTransferExecutorAuthorization).not.toHaveBeenCalled();
    },
  );

  it.each([[null], [undefined], ["0x0f2c9d1a"]])(
    "refuses a hook result %j that is not an object, naming the hook",
    async hookResult => {
      const signer = signerWithHook();
      signer.createTransferExecutorAuthorization.mockResolvedValueOnce(hookResult as never);

      const error = await new ExactHederaScheme(signer)
        .createPaymentPayload(2, transferExecutorRequirements())
        .catch((e: unknown) => e);

      expect(error).not.toBeInstanceOf(TypeError);
      expect((error as Error).message).toBe(
        `createTransferExecutorAuthorization returned ${JSON.stringify(hookResult)}, not { executor, authorization }`,
      );
    },
  );

  it("accepts an empty 0x authorization", async () => {
    const signer = signerWithHook("0.0.7000", "0x");

    const result = await new ExactHederaScheme(signer).createPaymentPayload(
      2,
      transferExecutorRequirements(),
    );

    expect(result.payload).toEqual({
      payer: "0.0.5001",
      executor: "0.0.7000",
      authorization: "0x",
    });
  });
});

describe("ExactHedera client scheme: assetTransferMethod dispatch", () => {
  it.each([
    ["foo", '"foo"'],
    ["default", '"default"'],
    [42, "42"],
  ])("refuses the unrecognized method %j", async (assetTransferMethod, expectedInMessage) => {
    const signer = signerWithHook();
    const requirements = transferExecutorRequirements({
      assetTransferMethod,
      feePayer: "0.0.9000",
    });

    await expect(
      new ExactHederaScheme(signer).createPaymentPayload(2, requirements),
    ).rejects.toThrow(`Unsupported assetTransferMethod for Hedera exact: ${expectedInMessage}`);
    expect(signer.createPartiallySignedTransferTransaction).not.toHaveBeenCalled();
    expect(signer.createTransferExecutorAuthorization).not.toHaveBeenCalled();
  });

  it("pays a null method with cryptoTransfer", async () => {
    const signer = signerWithHook();

    const result = await new ExactHederaScheme(signer).createPaymentPayload(2, {
      ...transferExecutorRequirements({ assetTransferMethod: null, feePayer: "0.0.9000" }),
    });

    expect(result).toEqual({ x402Version: 2, payload: { transaction: "YmFzZTY0LXR4" } });
    expect(signer.createTransferExecutorAuthorization).not.toHaveBeenCalled();
  });

  it("treats an explicit cryptoTransfer exactly like an absent method", async () => {
    const signer = signerWithHook();
    const scheme = new ExactHederaScheme(signer);
    const base: PaymentRequirements = {
      scheme: "exact",
      network: "hedera:testnet",
      asset: "0.0.2001",
      amount: "1000",
      payTo: "0.0.4001",
      maxTimeoutSeconds: 180,
      extra: { feePayer: "0.0.5001" },
    };

    const absent = await scheme.createPaymentPayload(2, base);
    const explicit = await scheme.createPaymentPayload(2, {
      ...base,
      extra: { ...base.extra, assetTransferMethod: "cryptoTransfer" },
    });

    expect(absent).toEqual({ x402Version: 2, payload: { transaction: "YmFzZTY0LXR4" } });
    expect(explicit).toEqual(absent);
    expect(signer.createTransferExecutorAuthorization).not.toHaveBeenCalled();
  });
});

describe("ExactHedera client scheme: transferExecutor through x402Client", () => {
  it("echoes assetTransferMethod and executors in accepted.extra", async () => {
    const requirements = transferExecutorRequirements({ executors: ["0.0.7000", "0.0.7001"] });
    const paymentRequired: PaymentRequired = {
      x402Version: 2,
      resource: { url: "https://example.com/weather" },
      accepts: [requirements],
    };
    const client = new x402Client()
      .register("hedera:testnet", new ExactHederaScheme(signerWithHook()))
      .setSpendControls(false);

    const paymentPayload = await client.createPaymentPayload(paymentRequired);

    expect(paymentPayload.accepted.extra).toEqual({
      assetTransferMethod: "transferExecutor",
      executors: ["0.0.7000", "0.0.7001"],
    });
    expect(paymentPayload.payload).toEqual({
      payer: "0.0.5001",
      executor: "0.0.7000",
      authorization: AUTHORIZATION,
    });
  });
});
