import { generateKeyPairSigner } from "@solana/kit";
import { fetchMint } from "@solana-program/token-2022";
import type { PaymentRequirements } from "@x402/core/types";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { BatchSvmScheme } from "../../src/batch-settlement/client/scheme";
import {
  isServerSignedAccept,
  ServerSignedTrustPolicy,
  UntrustedOperatorError,
} from "../../src/batch-settlement/client/trust";
import { BatchError } from "../../src/batch-settlement/errors";
import { SOLANA_DEVNET_CAIP2, TOKEN_PROGRAM_ADDRESS } from "../../src/constants";
import { USDC_DEVNET_ADDRESS, USDC_MAINNET_ADDRESS } from "../../src/defaultAssets";
import { signVoucher } from "../../src/payment-channels/voucher";
import { createRpcClient, resolveBlockhash, resolveOpenSlot } from "../../src/utils";

vi.mock("@solana-program/token-2022", async importOriginal => ({
  ...(await importOriginal<typeof import("@solana-program/token-2022")>()),
  fetchMint: vi.fn(),
}));

vi.mock("../../src/utils", async importOriginal => ({
  ...(await importOriginal<typeof import("../../src/utils")>()),
  createRpcClient: vi.fn(),
  resolveBlockhash: vi.fn(),
  resolveOpenSlot: vi.fn(),
}));

const NETWORK = SOLANA_DEVNET_CAIP2;
const ORIGIN = "https://api.example.test";

let payer: Awaited<ReturnType<typeof generateKeyPairSigner>>;
let feePayer: Awaited<ReturnType<typeof generateKeyPairSigner>>;
let operator: Awaited<ReturnType<typeof generateKeyPairSigner>>;
let otherOperator: Awaited<ReturnType<typeof generateKeyPairSigner>>;
let receiverAuthorizer: Awaited<ReturnType<typeof generateKeyPairSigner>>;

beforeAll(async () => {
  [payer, feePayer, operator, otherOperator, receiverAuthorizer] = await Promise.all([
    generateKeyPairSigner(),
    generateKeyPairSigner(),
    generateKeyPairSigner(),
    generateKeyPairSigner(),
    generateKeyPairSigner(),
  ]);
});

beforeEach(() => {
  vi.mocked(fetchMint).mockResolvedValue({ programAddress: TOKEN_PROGRAM_ADDRESS } as never);
  vi.mocked(resolveBlockhash).mockResolvedValue({
    blockhash: USDC_MAINNET_ADDRESS,
    lastValidBlockHeight: 10n,
  });
  vi.mocked(resolveOpenSlot).mockResolvedValue(123n);
  vi.mocked(createRpcClient).mockReturnValue({
    getProgramAccounts: vi.fn(() => ({ send: vi.fn().mockResolvedValue([]) })),
  } as never);
});

function clientAccept(overrides: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    amount: "1000",
    asset: USDC_DEVNET_ADDRESS,
    extra: {
      feePayer: feePayer.address,
      receiverAuthorizer: receiverAuthorizer.address,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
      withdrawDelay: 900,
    },
    maxTimeoutSeconds: 300,
    network: NETWORK,
    payTo: USDC_MAINNET_ADDRESS,
    scheme: "batch-settlement",
    ...overrides,
  };
}

function serverAccept(
  operatorAddress = operator.address,
  extra: Record<string, unknown> = {},
  overrides: Partial<PaymentRequirements> = {},
): PaymentRequirements {
  return clientAccept({
    ...overrides,
    extra: {
      ...clientAccept().extra,
      operator: operatorAddress,
      voucherSigner: "server",
      ...extra,
    },
  });
}

function evmAccept(): PaymentRequirements {
  return {
    amount: "1000",
    asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    extra: {},
    maxTimeoutSeconds: 300,
    network: "eip155:84532",
    payTo: "0x0000000000000000000000000000000000000001",
    scheme: "batch-settlement",
  };
}

describe("server-signed trust policy", () => {
  it("rejects malformed policies", () => {
    expect(() => new ServerSignedTrustPolicy({ allowedOperators: [""] })).toThrow(/non-empty/);
    expect(
      () => new ServerSignedTrustPolicy({ allowedOperators: [operator.address], maxDeposit: "$0" }),
    ).toThrow(/positive/);
    expect(
      () =>
        new ServerSignedTrustPolicy({
          allowedAssets: [{ asset: USDC_DEVNET_ADDRESS, maxDeposit: "$1", network: NETWORK }],
          allowedOperators: [operator.address],
        }),
    ).toThrow(/integer atomic amount, not a dollar value/);
    expect(isServerSignedAccept(serverAccept())).toBe(true);
    expect(isServerSignedAccept(clientAccept())).toBe(false);
  });

  it("grants only listed operators and refuses everything without a policy", () => {
    expect(() => new ServerSignedTrustPolicy().grantFor(serverAccept())).toThrow(
      UntrustedOperatorError,
    );
    const policy = new ServerSignedTrustPolicy({ allowedOperators: [operator.address] });
    expect(() => policy.grantFor(serverAccept(otherOperator.address))).toThrow(
      new RegExp(`${otherOperator.address}.*allowedOperators`),
    );
    expect(() => policy.grantFor(clientAccept())).toThrow(UntrustedOperatorError);
  });

  it("resolves the escrow cap like the core spend controls", () => {
    // Default $1 on a 6-decimal default asset.
    expect(
      new ServerSignedTrustPolicy({ allowedOperators: [operator.address] }).grantFor(
        serverAccept(),
      ),
    ).toEqual({ operator: operator.address, maxDeposit: 1_000_000n });
    // Configured USD cap.
    expect(
      new ServerSignedTrustPolicy({
        allowedOperators: [operator.address],
        maxDeposit: "$0.05",
      }).grantFor(serverAccept()),
    ).toEqual({ operator: operator.address, maxDeposit: 50_000n });
    // `false` lifts the cap for default assets.
    expect(
      new ServerSignedTrustPolicy({
        allowedOperators: [operator.address],
        maxDeposit: false,
      }).grantFor(serverAccept()),
    ).toEqual({ operator: operator.address });
    // A non-default asset needs an explicit entry ...
    const exotic = serverAccept(operator.address, {}, { asset: feePayer.address });
    expect(() =>
      new ServerSignedTrustPolicy({ allowedOperators: [operator.address] }).grantFor(exotic),
    ).toThrow(/not a default asset.*allowedAssets/);
    // ... whose atomic cap wins over the USD cap, and which may be uncapped.
    expect(
      new ServerSignedTrustPolicy({
        allowedAssets: [{ asset: feePayer.address, maxDeposit: "777", network: "solana:*" }],
        allowedOperators: [operator.address],
      }).grantFor(exotic),
    ).toEqual({ operator: operator.address, maxDeposit: 777n });
    expect(
      new ServerSignedTrustPolicy({
        allowedAssets: [{ asset: feePayer.address, network: NETWORK }],
        allowedOperators: [operator.address],
      }).grantFor(exotic),
    ).toEqual({ operator: operator.address });
    // A default-asset symbol also matches an entry.
    expect(
      new ServerSignedTrustPolicy({
        allowedAssets: [{ asset: "usdc", maxDeposit: "42", network: NETWORK }],
        allowedOperators: [operator.address],
      }).grantFor(serverAccept()),
    ).toEqual({ operator: operator.address, maxDeposit: 42n });
  });

  it("filters accepts: drops untrusted server-signed ones and prefers trusted ones", () => {
    const policy = new ServerSignedTrustPolicy({ allowedOperators: [operator.address] });
    const evm = evmAccept();
    const client = clientAccept();
    const trusted = serverAccept();
    const untrusted = serverAccept(otherOperator.address);
    // Untrusted dropped, client-signed fallback kept, other schemes untouched.
    expect(policy.filterAccepts([untrusted, client, evm])).toEqual([client, evm]);
    // Trusted server-signed accept moves ahead of the same network's
    // client-signed accept; the EVM accept keeps its place.
    expect(policy.filterAccepts([evm, client, trusted])).toEqual([evm, trusted, client]);
    // Nothing to do when no server-signed accept is offered.
    expect(policy.filterAccepts([client, evm])).toEqual([client, evm]);
    // Every accept needed an untrusted operator: refuse with an actionable message.
    expect(() => policy.filterAccepts([untrusted])).toThrow(
      new RegExp(`${otherOperator.address}.*allowedOperators`),
    );
  });
});

describe("server-signed channels on the client scheme", () => {
  it("never opens a server-signed channel without a grant", async () => {
    const client = new BatchSvmScheme(payer, { discoverChannels: false });
    await expect(client.createPaymentPayload(2, serverAccept())).rejects.toThrow(
      UntrustedOperatorError,
    );
    const other = new BatchSvmScheme(payer, {
      discoverChannels: false,
      serverSignedChannelsPolicy: { allowedOperators: [otherOperator.address] },
    });
    await expect(other.createPaymentPayload(2, serverAccept())).rejects.toThrow(
      /Trust it explicitly/,
    );
  });

  it("opens a server-signed channel for a listed operator on any transport", async () => {
    const client = new BatchSvmScheme(payer, {
      discoverChannels: false,
      serverSignedChannelsPolicy: { allowedOperators: [operator.address] },
    });
    const payment = await client.createPaymentPayload(2, serverAccept());
    expect(payment.payload).toMatchObject({
      type: "deposit",
      channelConfig: { payerAuthorizer: operator.address, voucherSigner: "server" },
    });
  });

  it("falls back to the client-signed accept through its own creation-failure hook", async () => {
    const client = new BatchSvmScheme(payer, { discoverChannels: false });
    const server = serverAccept();
    const fallback = clientAccept();
    const context = { maxAmountPerPayment: "1000" };
    const paymentRequired = {
      accepts: [server, fallback],
      resource: { url: `${ORIGIN}/v1/infer`, description: "", mimeType: "" },
      x402Version: 2,
    };
    const error = await client.createPaymentPayload(2, server, context).catch(e => e as Error);
    expect(error).toBeInstanceOf(UntrustedOperatorError);
    const recovered = await client.schemeHooks.onPaymentCreationFailure!({
      error,
      paymentRequired,
      selectedRequirements: server,
    } as never);
    expect(recovered).toMatchObject({
      recovered: true,
      payload: {
        accepted: fallback,
        payload: { type: "deposit", channelConfig: { payerAuthorizer: payer.address } },
        resource: paymentRequired.resource,
        x402Version: 2,
      },
    });
    // The client-signed twin is paid with the spend-cap context core resolved
    // for the refused accept: 5 × 1000 default multiplier is the ceiling.
    expect(
      (recovered as { payload: { payload: { deposit: { amount: string } } } }).payload.payload,
    ).toMatchObject({ deposit: { amount: "5000" } });

    // No fallback when the alternatives are on another asset, cost more, or
    // are server-signed too; and other errors are left alone.
    const dearer = clientAccept({ amount: "2000" });
    for (const accepts of [
      [server],
      [server, serverAccept(otherOperator.address)],
      [server, dearer],
    ]) {
      await expect(
        client.schemeHooks.onPaymentCreationFailure!({
          error,
          paymentRequired: { ...paymentRequired, accepts },
          selectedRequirements: server,
        } as never),
      ).resolves.toBeUndefined();
    }
    await expect(
      client.schemeHooks.onPaymentCreationFailure!({
        error: new Error("rpc down"),
        paymentRequired,
        selectedRequirements: server,
      } as never),
    ).resolves.toBeUndefined();
  });

  it("caps the escrow at the grant, ignoring larger server hints and fixed deposits", async () => {
    // $0.0025 in USDC (6 decimals) = 2500 atomic.
    const trust = { allowedOperators: [operator.address], maxDeposit: "$0.0025" };
    const hinted = serverAccept(operator.address, { minDeposit: "100000" });
    const client = new BatchSvmScheme(payer, {
      discoverChannels: false,
      serverSignedChannelsPolicy: trust,
    });
    await expect(client.createPaymentPayload(2, hinted)).resolves.toMatchObject({
      payload: { deposit: { amount: "2500" } },
    });
    const fixed = new BatchSvmScheme(payer, {
      depositAmount: 50_000n,
      discoverChannels: false,
      serverSignedChannelsPolicy: trust,
    });
    await expect(fixed.createPaymentPayload(2, hinted)).resolves.toMatchObject({
      payload: { deposit: { amount: "2500" } },
    });
    // The first request alone would already exceed what the client is willing
    // to hand the operator.
    await expect(
      new BatchSvmScheme(payer, {
        discoverChannels: false,
        serverSignedChannelsPolicy: trust,
      }).createPaymentPayload(2, { ...serverAccept(), amount: "3000" }),
    ).rejects.toThrow(/exceeds the remaining serverSignedChannelsPolicy maxDeposit/);
  });

  it("refuses a top-up that would push the escrow past the grant", async () => {
    const client = new BatchSvmScheme(payer, {
      discoverChannels: false,
      serverSignedChannelsPolicy: { allowedOperators: [operator.address], maxDeposit: "$0.0025" },
    });
    const accept = serverAccept();
    const opened = await client.createPaymentPayload(2, accept);
    const channelId = opened.payload.authorization!.channelId;
    const settle = async (payment: typeof opened, cumulative: bigint) =>
      client.schemeHooks.onPaymentResponse!({
        paymentPayload: { accepted: accept, ...payment },
        requirements: accept,
        settleResponse: {
          extra: {
            channelState: { chargedCumulativeAmount: cumulative.toString() },
            commitmentId: `${channelId}:${cumulative}`,
            voucher: {
              channelId,
              expiresAt: 0,
              maxClaimableAmount: cumulative.toString(),
              signature: await signVoucher(operator, {
                channelId,
                cumulativeAmount: cumulative,
                expiresAt: 0n,
              }),
            },
          },
          success: true,
        },
      } as never);
    await settle(opened, 1_000n);
    await settle(await client.createPaymentPayload(2, accept), 2_000n);
    // 2000 charged of 2500 escrowed; the next 1000 ceiling needs 500 more,
    // and the grant has no room left.
    await expect(client.createPaymentPayload(2, accept)).rejects.toThrow(
      /2500 total, 2500 already escrowed/,
    );
  });

  it("refunds server-signed channels with payer authorization only", async () => {
    const accept = serverAccept();
    const client = new BatchSvmScheme(payer, {
      depositAmount: 10_000n,
      discoverChannels: false,
      serverSignedChannelsPolicy: { allowedOperators: [operator.address] },
    });
    const opened = await client.createPaymentPayload(2, accept);
    const channelId = opened.payload.authorization!.channelId;
    const settle = async (payment: typeof opened, cumulative: bigint) =>
      client.schemeHooks.onPaymentResponse!({
        paymentPayload: { accepted: accept, ...payment },
        requirements: accept,
        settleResponse: {
          extra: {
            channelState: { chargedCumulativeAmount: cumulative.toString() },
            commitmentId: `${channelId}:${cumulative}`,
            voucher: {
              channelId,
              expiresAt: 0,
              maxClaimableAmount: cumulative.toString(),
              signature: await signVoucher(operator, {
                channelId,
                cumulativeAmount: cumulative,
                expiresAt: 0n,
              }),
            },
          },
          success: true,
        },
      } as never);

    await settle(opened, 1_000n);
    await settle(await client.createPaymentPayload(2, accept), 2_000n);

    const refund = await client.createRefundPayload(2, accept);
    expect(refund.payload).toMatchObject({
      type: "refund",
      authorization: { authorizedAmount: "0", channelId },
    });
    expect(refund.payload).not.toHaveProperty("voucher");
  });

  it("refunds a server-signed channel when the probe returns a client-signed accept", async () => {
    const accept = serverAccept();
    const client = new BatchSvmScheme(payer, {
      depositAmount: 10_000n,
      discoverChannels: false,
      serverSignedChannelsPolicy: { allowedOperators: [operator.address] },
    });
    const opened = await client.createPaymentPayload(2, accept);
    const channelId = opened.payload.authorization!.channelId;
    await client.schemeHooks.onPaymentResponse!({
      paymentPayload: { accepted: accept, ...opened },
      requirements: accept,
      settleResponse: {
        extra: {
          channelState: { chargedCumulativeAmount: "1000" },
          commitmentId: `${channelId}:1000`,
          voucher: {
            channelId,
            expiresAt: 0,
            maxClaimableAmount: "1000",
            signature: await signVoucher(operator, {
              channelId,
              cumulativeAmount: 1_000n,
              expiresAt: 0n,
            }),
          },
        },
        success: true,
      },
    } as never);

    const refund = await client.createRefundPayload(2, clientAccept());
    expect(refund.payload).toMatchObject({
      type: "refund",
      authorization: { authorizedAmount: "0", channelId },
    });
    expect(refund.payload).not.toHaveProperty("voucher");
  });

  it("adopts a corrective 402 only up to what this client authorized", async () => {
    const trust = { allowedOperators: [operator.address] };
    const accept = serverAccept();
    const run = async (correctiveCumulative: bigint) => {
      const client = new BatchSvmScheme(payer, {
        depositAmount: 10_000n,
        discoverChannels: false,
        serverSignedChannelsPolicy: trust,
      });
      const opened = await client.createPaymentPayload(2, accept);
      const channelId = opened.payload.authorization!.channelId;
      const sign = async (cumulative: bigint) =>
        signVoucher(operator, { channelId, cumulativeAmount: cumulative, expiresAt: 0n });
      await client.schemeHooks.onPaymentResponse!({
        paymentPayload: { accepted: accept, ...opened },
        requirements: accept,
        settleResponse: {
          extra: {
            channelState: { chargedCumulativeAmount: "1000" },
            commitmentId: `${channelId}:1000`,
            voucher: {
              channelId,
              expiresAt: 0,
              maxClaimableAmount: "1000",
              signature: await sign(1_000n),
            },
          },
          success: true,
        },
      } as never);
      const next = await client.createPaymentPayload(2, accept);
      const recovered = await client.schemeHooks.onPaymentResponse!({
        paymentPayload: { accepted: accept, ...next },
        requirements: accept,
        settleResponse: { success: false, errorReason: BatchError.CUMULATIVE_AMOUNT_MISMATCH },
        paymentRequired: {
          error: BatchError.CUMULATIVE_AMOUNT_MISMATCH,
          accepts: [
            {
              ...accept,
              extra: {
                ...accept.extra,
                channelState: {
                  balance: "10000",
                  channelId,
                  chargedCumulativeAmount: correctiveCumulative.toString(),
                  totalClaimed: "0",
                  withdrawRequestedAt: 0,
                },
                voucherState: {
                  expiresAt: 0,
                  signature: await sign(correctiveCumulative),
                  signedMaxClaimable: correctiveCumulative.toString(),
                },
              },
            },
          ],
        },
      } as never);
      return recovered;
    };
    // Confirmed 1000 plus one unresolved 1000 ceiling: 2000 is the most the
    // operator can legitimately say it charged.
    await expect(run(2_000n)).resolves.toEqual({ recovered: true });
    // A validly operator-signed jump to 5000 is refused; the signature is the
    // operator's own and proves nothing about what the client authorized.
    await expect(run(5_000n)).resolves.toBeUndefined();
  });
});
