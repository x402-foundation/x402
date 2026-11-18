import { describe, it, expect, vi, beforeEach, type MockedFunction } from "vitest";
import { privateKeyToAccount } from "viem/accounts";

vi.mock("../../../src/multicall", async importOriginal => {
  const actual = await importOriginal<typeof import("../../../src/multicall")>();
  return { ...actual, multicall: vi.fn() };
});

import { multicall } from "../../../src/multicall";
import { verifyBatchSettlementVoucherTypedData } from "../../../src/batch-settlement/facilitator/utils";
import { verifyVoucher } from "../../../src/batch-settlement/facilitator/voucher";
import { computeChannelId, verifyEoaVoucherSignature } from "../../../src/batch-settlement/utils";
import { signVoucher } from "../../../src/batch-settlement/client/voucher";
import type { ChannelConfig } from "../../../src/batch-settlement/types";
import type { FacilitatorEvmSigner } from "../../../src/signer";

const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const NETWORK = "eip155:84532";

const payer = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);

const config: ChannelConfig = {
  payer: payer.address,
  payerAuthorizer: payer.address,
  receiver: "0x9876543210987654321098765432109876543210",
  receiverAuthorizer: "0x1111111111111111111111111111111111111111",
  token: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  withdrawDelay: 900,
  salt: "0x0000000000000000000000000000000000000000000000000000000000000000",
};

/** Same key, same digest, s replaced by n - s and the recovery bit flipped. */
function toHighS(sig: `0x${string}`): `0x${string}` {
  const r = sig.slice(2, 66);
  const s = BigInt(`0x${sig.slice(66, 130)}`);
  const v = parseInt(sig.slice(130, 132), 16);
  const hs = (N - s).toString(16).padStart(64, "0");
  const hv = (v === 27 ? 28 : 27).toString(16);
  return `0x${r}${hs}${hv}`;
}

/** Same signature with v written as the raw recovery bit (0/1) instead of 27/28. */
function toYParityV(sig: `0x${string}`): `0x${string}` {
  const v = parseInt(sig.slice(130, 132), 16);
  return `0x${sig.slice(2, 130)}${(v - 27).toString(16).padStart(2, "0")}`;
}

const mockedMulticall = multicall as unknown as MockedFunction<typeof multicall>;

describe("batch-settlement voucher signature form vs x402BatchSettlement (OZ ECDSA)", () => {
  const channelId = computeChannelId(config, NETWORK);
  let canonical: `0x${string}`;

  beforeEach(async () => {
    canonical = (await signVoucher(payer, channelId, "2000", NETWORK)).signature;
    mockedMulticall.mockResolvedValue([
      { status: "success", result: [5000n, 0n] },
      { status: "success", result: [0n, 0n] },
      { status: "success", result: 0n },
    ] as never);
  });

  const signer = {
    getCode: vi.fn().mockResolvedValue("0x"),
    readContract: vi.fn(),
  } as unknown as FacilitatorEvmSigner;

  const requirements = {
    scheme: "batch-settlement",
    network: NETWORK,
    amount: "1000",
    asset: config.token,
    payTo: config.receiver,
    maxTimeoutSeconds: 3600,
    extra: { receiverAuthorizer: config.receiverAuthorizer, withdrawDelay: 900 },
  } as never;

  for (const [name, form] of [
    ["high-s", toHighS],
    ["v in {0,1}", toYParityV],
  ] as const) {
    it(`rejects a ${name} voucher signature that the contract cannot claim`, async () => {
      const sig = form(canonical);
      expect(sig).not.toBe(canonical);

      const ok = await verifyBatchSettlementVoucherTypedData(
        signer,
        {
          channelId,
          maxClaimableAmount: "2000",
          payerAuthorizer: config.payerAuthorizer,
          payer: config.payer,
          signature: sig,
        },
        84532,
      );

      const res = await verifyVoucher(
        signer,
        {
          type: "voucher",
          channelConfig: config,
          voucher: { channelId, maxClaimableAmount: "2000", signature: sig },
        } as never,
        requirements,
        config,
      );
      expect({ verifyTypedData: ok, verifyVoucherIsValid: res.isValid }).toEqual({
        verifyTypedData: false,
        verifyVoucherIsValid: false,
      });
    });

    it(`rejects a ${name} voucher signature on the payer (payerAuthorizer = 0) EOA path`, async () => {
      const zeroConfig = {
        ...config,
        payerAuthorizer: "0x0000000000000000000000000000000000000000" as const,
      };
      const zeroId = computeChannelId(zeroConfig, NETWORK);
      const good = (await signVoucher(payer, zeroId, "2000", NETWORK)).signature;
      const ok = await verifyBatchSettlementVoucherTypedData(
        signer,
        {
          channelId: zeroId,
          maxClaimableAmount: "2000",
          payerAuthorizer: zeroConfig.payerAuthorizer,
          payer: zeroConfig.payer,
          signature: form(good),
        },
        84532,
      );
      expect(ok).toBe(false);
    });

    it(`rejects a ${name} voucher signature in the server's local check`, async () => {
      const ok = await verifyEoaVoucherSignature(
        {
          type: "voucher",
          channelConfig: config,
          voucher: { channelId, maxClaimableAmount: "2000", signature: form(canonical) },
        } as never,
        NETWORK,
      );
      expect(ok).toBe(false);
    });
  }

  it.each([null, "0x1", "0x" + "zz".repeat(65)])(
    "rejects malformed voucher input in facilitator and local verification",
    async input => {
      const signature = input as `0x${string}`;
      const voucher = { channelId, maxClaimableAmount: "2000", signature };
      for (const payerAuthorizer of [
        config.payerAuthorizer,
        "0x0000000000000000000000000000000000000000",
      ] as const) {
        await expect(
          verifyBatchSettlementVoucherTypedData(
            signer,
            { ...voucher, payer: config.payer, payerAuthorizer },
            84532,
          ),
        ).resolves.toBe(false);
      }
      await expect(
        verifyEoaVoucherSignature({ type: "voucher", channelConfig: config, voucher }, NETWORK),
      ).resolves.toBe(false);
    },
  );

  it("forwards a non-ECDSA signature unchanged to isValidSignature when the payer has code", async () => {
    const readContract = vi.fn().mockResolvedValue("0x1626ba7e");
    const contractSigner = {
      getCode: vi.fn().mockResolvedValue("0x6080"),
      readContract,
    } as unknown as FacilitatorEvmSigner;

    const ok = await verifyBatchSettlementVoucherTypedData(
      contractSigner,
      {
        channelId,
        maxClaimableAmount: "2000",
        payerAuthorizer: "0x0000000000000000000000000000000000000000",
        payer: config.payer,
        signature: "0xabcd",
      },
      84532,
    );

    expect(ok).toBe(true);
    expect(contractSigner.getCode).toHaveBeenCalledTimes(1);
    expect(readContract).toHaveBeenCalledTimes(1);
    expect(readContract.mock.calls[0][0]).toMatchObject({
      functionName: "isValidSignature",
      args: [expect.any(String), "0xabcd"],
    });
  });

  it("still accepts the canonical signature", async () => {
    const ok = await verifyBatchSettlementVoucherTypedData(
      signer,
      {
        channelId,
        maxClaimableAmount: "2000",
        payerAuthorizer: config.payerAuthorizer,
        payer: config.payer,
        signature: canonical,
      },
      84532,
    );
    expect(ok).toBe(true);
    const serverOk = await verifyEoaVoucherSignature(
      {
        type: "voucher",
        channelConfig: config,
        voucher: { channelId, maxClaimableAmount: "2000", signature: canonical },
      } as never,
      NETWORK,
    );
    expect(serverOk).toBe(true);
  });
});
