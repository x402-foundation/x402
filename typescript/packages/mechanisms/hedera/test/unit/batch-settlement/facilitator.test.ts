import type { PaymentPayload } from "@x402/core/types";
import { describe, expect, it } from "vitest";
import {
  BATCH_SETTLEMENT_SCHEME,
  ErrAllowanceInsufficient,
  ErrAllowanceNonceUsed,
  ErrAllowanceSignatureInvalid,
  ErrChannelNotFound,
  ErrCumulativeExceedsBalance,
  ErrInvalidPayloadType,
  ErrInvalidVoucherSignature,
  ErrNetworkMismatch,
  ErrNothingToSettle,
  ErrReceiverMismatch,
  ErrSettlementPending,
  ErrTokenNotAssociated,
  HEDERA_GAS,
  HederaPendingError,
  computeChannelId,
} from "../../../src/batch-settlement";
import { BatchSettlementHederaScheme } from "../../../src/batch-settlement/facilitator";
import {
  createBatchSettlementHederaAllowanceDepositPayload,
  buildChannelConfig,
  signVoucher,
  InMemoryClientChannelStorage,
} from "../../../src/batch-settlement/client";
import { signClaimBatch } from "../../../src/batch-settlement/authorizerSigner";
import {
  DEPLOYMENT,
  NETWORK,
  RECEIVER_ADDRESS,
  USDC_ADDRESS,
  authorizerSigner,
  clientSigner,
  facilitatorSigner,
  makeAccount,
  makeChain,
  requirements,
  settledLog,
} from "./helpers";

/**
 * Builds a deposit payment payload envelope for `payer`.
 *
 * @param payerType - Key type of the payer.
 * @returns Envelope + helpers.
 */
async function depositFixture(payerType: "ED25519" | "ECDSA") {
  const payer = makeAccount(payerType);
  const receiverAuth = makeAccount("ECDSA");
  const req = requirements(receiverAuth.evmAddress);
  const signer = clientSigner(payer);
  const deps = {
    signer,
    storage: new InMemoryClientChannelStorage(),
    salt: `0x${"00".repeat(32)}` as `0x${string}`,
  };
  const config = buildChannelConfig(deps, req);
  const channelId = computeChannelId(config, NETWORK);
  const result = await createBatchSettlementHederaAllowanceDepositPayload(
    signer,
    2,
    req,
    config,
    "10000",
    "1000",
  );
  const envelope: PaymentPayload = { x402Version: 2, accepted: req, payload: result.payload };
  const chain = makeChain();
  chain.balances[payer.evmAddress.toLowerCase()] = 1_000_000n;
  chain.allowances[payer.evmAddress.toLowerCase()] = 1_000_000n;
  const fac = facilitatorSigner(chain, [payer, receiverAuth]);
  return { payer, receiverAuth, req, config, channelId, envelope, chain, fac, deps };
}

describe("facilitator deposit", () => {
  for (const type of ["ED25519", "ECDSA"] as const) {
    it(`verifies and settles a ${type} payer deposit`, async () => {
      const f = await depositFixture(type);
      const scheme = new BatchSettlementHederaScheme(f.fac, authorizerSigner(f.receiverAuth));

      const verified = await scheme.verify(f.envelope, f.req);
      expect(verified.isValid, verified.invalidReason).toBe(true);
      expect(verified.payer).toBe(f.payer.evmAddress);
      expect(verified.extra?.balance).toBe("0");
      expect(f.fac.simulateContract).toHaveBeenCalledTimes(1);

      // After execution the fake chain reflects the deposit.
      f.chain.nextExecution = async () => {
        f.chain.channels[f.channelId.toLowerCase()] = { balance: 10_000n, totalClaimed: 0n };
        return { transactionId: "0.0.9999@1.1", logs: [] };
      };
      const settled = await scheme.settle(f.envelope, f.req);
      expect(settled.success, settled.errorMessage).toBe(true);
      expect(settled.transaction).toBe("0.0.9999@1.1");
      expect(settled.amount).toBe("10000");
      expect((settled.extra?.channelState as { balance: string }).balance).toBe("10000");
      const exec = f.chain.executions[0];
      expect(exec.functionName).toBe("deposit");
      expect(exec.gas).toBe(HEDERA_GAS.deposit);
      expect((exec.args[2] as string).toLowerCase()).toBe(DEPLOYMENT.collector.toLowerCase());
    });
  }

  it("rejects a used nonce", async () => {
    const f = await depositFixture("ECDSA");
    const auth = (
      f.envelope.payload as {
        deposit: { authorization: { hederaAllowanceAuthorization: { nonce: string } } };
      }
    ).deposit.authorization.hederaAllowanceAuthorization;
    f.chain.usedNonces.add(`${f.payer.evmAddress.toLowerCase()}:${BigInt(auth.nonce)}`);
    const scheme = new BatchSettlementHederaScheme(f.fac);
    const verified = await scheme.verify(f.envelope, f.req);
    expect(verified.isValid).toBe(false);
    expect(verified.invalidReason).toBe(ErrAllowanceNonceUsed);
  });

  it("rejects an insufficient allowance", async () => {
    const f = await depositFixture("ED25519");
    f.chain.allowances[f.payer.evmAddress.toLowerCase()] = 1n;
    const scheme = new BatchSettlementHederaScheme(f.fac);
    const verified = await scheme.verify(f.envelope, f.req);
    expect(verified.invalidReason).toBe(ErrAllowanceInsufficient);
  });

  it("rejects a tampered deposit amount (signature no longer matches)", async () => {
    const f = await depositFixture("ECDSA");
    const payload = f.envelope.payload as { deposit: { amount: string } };
    payload.deposit.amount = "20000";
    const scheme = new BatchSettlementHederaScheme(f.fac);
    const verified = await scheme.verify(f.envelope, f.req);
    expect(verified.invalidReason).toBe(ErrAllowanceSignatureInvalid);
  });

  it("rejects when the escrow is not associated with the token", async () => {
    const f = await depositFixture("ECDSA");
    f.chain.associated.delete(DEPLOYMENT.settlementId);
    const scheme = new BatchSettlementHederaScheme(f.fac);
    const verified = await scheme.verify(f.envelope, f.req);
    expect(verified.invalidReason).toBe(ErrTokenNotAssociated);
  });

  it("rejects a receiver mismatch", async () => {
    const f = await depositFixture("ECDSA");
    const scheme = new BatchSettlementHederaScheme(f.fac);
    const verified = await scheme.verify(f.envelope, { ...f.req, payTo: "0.0.4242" });
    expect(verified.invalidReason).toBe(ErrReceiverMismatch);
  });

  it("returns settlement_pending when the record cannot be fetched", async () => {
    const f = await depositFixture("ECDSA");
    f.chain.nextExecution = async () => {
      throw new HederaPendingError("0.0.9999@7.7", new Error("timeout"));
    };
    const scheme = new BatchSettlementHederaScheme(f.fac);
    const settled = await scheme.settle(f.envelope, f.req);
    expect(settled.success).toBe(false);
    expect(settled.errorReason).toBe(ErrSettlementPending);
    expect(settled.transaction).toBe("0.0.9999@7.7");
  });
});

describe("facilitator voucher", () => {
  it("verifies a voucher against onchain state", async () => {
    const f = await depositFixture("ED25519");
    f.chain.channels[f.channelId.toLowerCase()] = { balance: 10_000n, totalClaimed: 500n };
    const voucher = await signVoucher(clientSigner(f.payer), f.channelId, "2500", NETWORK);
    const envelope: PaymentPayload = {
      x402Version: 2,
      accepted: f.req,
      payload: { type: "voucher", channelConfig: f.config, voucher },
    };
    const scheme = new BatchSettlementHederaScheme(f.fac);
    const verified = await scheme.verify(envelope, f.req);
    expect(verified.isValid, verified.invalidReason).toBe(true);
    expect(verified.extra?.totalClaimed).toBe("500");

    const tooHigh = await signVoucher(clientSigner(f.payer), f.channelId, "20000", NETWORK);
    const r2 = await scheme.verify(
      { ...envelope, payload: { type: "voucher", channelConfig: f.config, voucher: tooHigh } },
      f.req,
    );
    expect(r2.invalidReason).toBe(ErrCumulativeExceedsBalance);
  });

  it("rejects a voucher signed by the wrong account and an empty channel", async () => {
    const f = await depositFixture("ECDSA");
    const other = makeAccount("ECDSA");
    const voucher = await signVoucher(clientSigner(other), f.channelId, "2500", NETWORK);
    const envelope: PaymentPayload = {
      x402Version: 2,
      accepted: f.req,
      payload: { type: "voucher", channelConfig: f.config, voucher },
    };
    const scheme = new BatchSettlementHederaScheme(f.fac);
    expect((await scheme.verify(envelope, f.req)).invalidReason).toBe(ErrInvalidVoucherSignature);

    const good = await signVoucher(clientSigner(f.payer), f.channelId, "2500", NETWORK);
    const r = await scheme.verify(
      { ...envelope, payload: { type: "voucher", channelConfig: f.config, voucher: good } },
      f.req,
    );
    expect(r.invalidReason).toBe(ErrChannelNotFound);
  });
});

describe("facilitator claim / settle / refund", () => {
  it("claims with a facilitator-delegated authorizer and settles with the Settled amount", async () => {
    const f = await depositFixture("ED25519");
    f.chain.channels[f.channelId.toLowerCase()] = { balance: 10_000n, totalClaimed: 0n };
    const voucher = await signVoucher(clientSigner(f.payer), f.channelId, "3000", NETWORK);
    const auth = authorizerSigner(f.receiverAuth);
    const scheme = new BatchSettlementHederaScheme(f.fac, auth, { mirrorLagPollMs: 0 });

    const claim = await scheme.settle(
      {
        x402Version: 2,
        accepted: f.req,
        payload: {
          type: "claim",
          claims: [
            {
              voucher: { channel: f.config, maxClaimableAmount: "3000" },
              signature: voucher.signature,
              totalClaimed: "3000",
            },
          ],
        },
      },
      f.req,
    );
    expect(claim.success, claim.errorMessage).toBe(true);
    const exec = f.chain.executions[0];
    expect(exec.functionName).toBe("claimWithSignature");
    expect(exec.gas).toBe(HEDERA_GAS.claimBase + HEDERA_GAS.claimPerVoucher);

    // nothing to settle yet
    const nothing = await scheme.settle(
      {
        x402Version: 2,
        accepted: f.req,
        payload: { type: "settle", receiver: RECEIVER_ADDRESS, token: USDC_ADDRESS },
      },
      f.req,
    );
    expect(nothing.errorReason).toBe(ErrNothingToSettle);

    f.chain.receivers[`${RECEIVER_ADDRESS.toLowerCase()}:${USDC_ADDRESS.toLowerCase()}`] = {
      totalClaimed: 3000n,
      totalSettled: 0n,
    };
    f.chain.nextLogs = [settledLog(RECEIVER_ADDRESS, USDC_ADDRESS, 3000n)];
    const settled = await scheme.settle(
      {
        x402Version: 2,
        accepted: f.req,
        payload: { type: "settle", receiver: RECEIVER_ADDRESS, token: USDC_ADDRESS },
      },
      f.req,
    );
    expect(settled.success, settled.errorMessage).toBe(true);
    expect(settled.amount).toBe("3000");
  });

  it("refuses to claim without an authorizer signature source", async () => {
    const f = await depositFixture("ECDSA");
    const scheme = new BatchSettlementHederaScheme(f.fac);
    const r = await scheme.settle(
      { x402Version: 2, accepted: f.req, payload: { type: "claim", claims: [] } },
      f.req,
    );
    expect(r.success).toBe(false);
    expect(r.errorReason).toBe(ErrInvalidPayloadType);
  });

  it("refunds with a bundled claim through multicall using server-provided signatures", async () => {
    const f = await depositFixture("ECDSA");
    f.chain.channels[f.channelId.toLowerCase()] = { balance: 10_000n, totalClaimed: 0n };
    f.chain.associated.add(f.payer.evmAddress);
    const auth = authorizerSigner(f.receiverAuth);
    const voucher = await signVoucher(clientSigner(f.payer), f.channelId, "3000", NETWORK);
    const claims = [
      {
        voucher: { channel: f.config, maxClaimableAmount: "3000" },
        signature: voucher.signature,
        totalClaimed: "3000",
      },
    ];
    const claimAuthorizerSignature = await signClaimBatch(auth, claims, NETWORK);
    const scheme = new BatchSettlementHederaScheme(f.fac); // no facilitator authorizer
    const refundDigestSig = await auth.signDigest(
      // signature content is not checked by the fake executor; any valid-looking bytes suffice
      computeChannelId(f.config, NETWORK),
    );
    const r = await scheme.settle(
      {
        x402Version: 2,
        accepted: f.req,
        payload: {
          type: "refund",
          channelConfig: f.config,
          voucher,
          amount: "5000",
          refundNonce: "0",
          claims,
          claimAuthorizerSignature,
          refundAuthorizerSignature: refundDigestSig,
        },
      },
      f.req,
    );
    expect(r.success, r.errorMessage).toBe(true);
    expect(r.amount).toBe("5000");
    const exec = f.chain.executions[0];
    expect(exec.functionName).toBe("multicall");
    expect((r.extra?.channelState as { refundNonce: string }).refundNonce).toBe("1");
  });
});

describe("facilitator scheme dispatch", () => {
  it("rejects unknown networks and payload types", async () => {
    const f = await depositFixture("ECDSA");
    const scheme = new BatchSettlementHederaScheme(f.fac);
    const badNet = { ...f.req, network: "hedera:previewnet" as const };
    const r = await scheme.verify({ ...f.envelope, accepted: badNet }, badNet);
    expect(r.invalidReason).toBe(ErrNetworkMismatch);
    const r2 = await scheme.verify({ ...f.envelope, payload: { type: "nope" } }, f.req);
    expect(r2.invalidReason).toBe(ErrInvalidPayloadType);
    expect(scheme.getSigners(NETWORK)).toEqual(["0.0.9999"]);
    expect(scheme.getExtra(NETWORK)).toBeUndefined();
    expect(scheme.scheme).toBe(BATCH_SETTLEMENT_SCHEME);
  });
});
