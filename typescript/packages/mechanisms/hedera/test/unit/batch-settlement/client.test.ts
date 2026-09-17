import { describe, expect, it } from "vitest";
import {
  ErrCumulativeAmountMismatch,
  computeChannelId,
  isBatchSettlementDepositPayload,
  isBatchSettlementVoucherPayload,
} from "../../../src/batch-settlement";
import {
  BatchSettlementHederaScheme,
  InMemoryClientChannelStorage,
  signVoucher,
} from "../../../src/batch-settlement/client";
import { NETWORK, USDC_ADDRESS, clientSigner, makeAccount, requirements } from "./helpers";

describe("client scheme", () => {
  for (const type of ["ED25519", "ECDSA"] as const) {
    it(`builds a deposit payload first, then voucher-only payloads (${type})`, async () => {
      const payer = makeAccount(type);
      const receiverAuth = makeAccount("ED25519");
      const req = requirements(receiverAuth.evmAddress, "1000");
      const storage = new InMemoryClientChannelStorage();
      const scheme = new BatchSettlementHederaScheme(clientSigner(payer), { storage });

      const first = await scheme.createPaymentPayload(2, req);
      expect(isBatchSettlementDepositPayload(first.payload)).toBe(true);
      const dep = first.payload as {
        deposit: {
          amount: string;
          authorization: { hederaAllowanceAuthorization: { signature: string } };
        };
        voucher: { maxClaimableAmount: string };
        channelConfig: { payer: string; token: string };
      };
      expect(dep.deposit.amount).toBe("10000"); // server minDeposit hint
      expect(dep.voucher.maxClaimableAmount).toBe("1000");
      expect(dep.channelConfig.payer).toBe(payer.evmAddress);
      expect(dep.channelConfig.token).toBe(USDC_ADDRESS);
      expect(dep.deposit.authorization.hederaAllowanceAuthorization.signature).toMatch(/^0x/);

      // simulate a successful settle: balance funded, 700 charged
      const config = scheme.buildChannelConfig(req);
      const channelId = computeChannelId(config, NETWORK);
      await storage.set(channelId, { balance: "10000", chargedCumulativeAmount: "700" });

      const second = await scheme.createPaymentPayload(2, req);
      expect(isBatchSettlementVoucherPayload(second.payload)).toBe(true);
      expect(
        (second.payload as { voucher: { maxClaimableAmount: string } }).voucher.maxClaimableAmount,
      ).toBe("1700");
    });
  }

  it("delegates voucher signing to a separate account and commits it as payerAuthorizer", async () => {
    const payer = makeAccount("ED25519");
    const voucherAcct = makeAccount("ECDSA");
    const receiverAuth = makeAccount("ECDSA");
    const req = requirements(receiverAuth.evmAddress);
    const scheme = new BatchSettlementHederaScheme(clientSigner(payer), {
      voucherSigner: clientSigner(voucherAcct),
    });
    const config = scheme.buildChannelConfig(req);
    expect(config.payer).toBe(payer.evmAddress);
    expect(config.payerAuthorizer).toBe(voucherAcct.evmAddress);
    expect(
      () =>
        new BatchSettlementHederaScheme(clientSigner(payer), {
          voucherSigner: clientSigner(voucherAcct),
          payerAuthorizer: payer.evmAddress,
        }),
    ).toThrow(/payerAuthorizer/);
  });

  it("recovers from a corrective 402 carrying its own voucher signature", async () => {
    const payer = makeAccount("ECDSA");
    const receiverAuth = makeAccount("ECDSA");
    const req = requirements(receiverAuth.evmAddress);
    const storage = new InMemoryClientChannelStorage();
    const signer = clientSigner(payer, async args =>
      args.functionName === "channels" ? [10_000n, 500n] : 0n,
    );
    const scheme = new BatchSettlementHederaScheme(signer, { storage });
    const config = scheme.buildChannelConfig(req);
    const channelId = computeChannelId(config, NETWORK);
    const voucher = await signVoucher(signer, channelId, "3200", NETWORK);

    const recovered = await scheme.processCorrectivePaymentRequired({
      x402Version: 2,
      error: ErrCumulativeAmountMismatch,
      resource: {
        url: "https://example.test/weather",
        description: "",
        mimeType: "application/json",
      },
      accepts: [
        {
          ...req,
          extra: {
            ...req.extra,
            channelState: {
              channelId,
              balance: "10000",
              totalClaimed: "500",
              withdrawRequestedAt: 0,
              refundNonce: "0",
              chargedCumulativeAmount: "3200",
            },
            voucherState: { signedMaxClaimable: "3200", signature: voucher.signature },
          },
        },
      ],
    });
    expect(recovered).toBe(true);
    const ctx = await storage.get(channelId);
    expect(ctx?.chargedCumulativeAmount).toBe("3200");
    expect(ctx?.balance).toBe("10000");

    // A voucher signed by someone else must not be adopted.
    const other = makeAccount("ECDSA");
    const bad = await signVoucher(clientSigner(other), channelId, "9000", NETWORK);
    const adopted = await scheme.processCorrectivePaymentRequired({
      x402Version: 2,
      error: ErrCumulativeAmountMismatch,
      resource: {
        url: "https://example.test/weather",
        description: "",
        mimeType: "application/json",
      },
      accepts: [
        {
          ...req,
          extra: {
            ...req.extra,
            channelState: {
              channelId,
              balance: "10000",
              totalClaimed: "500",
              withdrawRequestedAt: 0,
              refundNonce: "0",
              chargedCumulativeAmount: "9000",
            },
            voucherState: { signedMaxClaimable: "9000", signature: bad.signature },
          },
        },
      ],
    });
    expect(adopted).toBe(false);
  });
});
