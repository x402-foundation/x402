/**
 * Facilitator VERIFY, on real MainNet prepared-transaction fixtures.
 *
 * - CC (Amulet): passes with a live preapproval; tampered amount/receiver, a
 *   missing preapproval, a self-payment, and a fee-payer mismatch each fail with
 *   the matching reason.
 * - USDCx (CIP-56 registry): passes only when the registrar is a configured
 *   registry AND the operator+bridge are trusted; an untrusted set fails.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { verifyInlineTransfer } from "../../src/exact/facilitator/verify-inline.js";
import { encodeInlinePaymentPayload } from "../../src/inline-payload.js";
import { decodePrepared } from "../../src/prepared-transfer.js";
import type { FacilitatorCantonSigner, PreapprovalView } from "../../src/signer.js";

const FIX = fileURLToPath(new URL("../../src/__fixtures__/", import.meta.url));
const read = (f: string) => readFileSync(FIX + f, "utf8").trim();

const CC_RAW = read("mainnet-transfer-preapproval-0.1.21.b64");
const CC = JSON.parse(read("mainnet-0.1.21.json")).transfer as {
  sender: string;
  receiver: string;
  amount: string;
  instrumentId: { admin: string; id: string };
};
const USDCX_RAW = read("mainnet-usdcx-transfer-preapproval.b64");

const FAC = "facilitator::1220" + "ff".repeat(32);
const NETWORK = "canton:mainnet" as const;

/** The contract id the fixture's single root exercise targets (its factory). */
function rootCid(b64: string): string {
  const d = decodePrepared(b64);
  return d.nodes.find(n => n.nodeId === d.roots[0])!.exercise!.contractId!;
}
const CC_FACTORY = rootCid(CC_RAW);
const USDCX_FACTORY = rootCid(USDCX_RAW);

/** now inside a fixture's ledger window: preparationTime (µs) → ms, +1s. */
function nowFor(b64: string): number {
  const prep = decodePrepared(b64).preparationTime ?? 0n;
  return Number(prep / 1000n) + 1000;
}

function inlinePayload(rawB64: string): PaymentPayload {
  return {
    x402Version: 2,
    accepted: { scheme: "exact", network: NETWORK } as never,
    payload: {
      ...encodeInlinePaymentPayload({
        preparedTransactionBytes: Buffer.from(rawB64, "base64"),
        preparedTxHash: "ab".repeat(32),
        signatureB64: Buffer.alloc(64, 7).toString("base64"),
      }),
    },
  };
}

function stubSigner(over: Partial<FacilitatorCantonSigner> = {}): FacilitatorCantonSigner {
  return {
    getAddresses: () => [FAC],
    verifySignature: async () => ({ verified: true, preparedTxHashHex: "cd".repeat(32) }),
    fetchPreapproval: async () => null,
    registryBaseUrl: () => undefined,
    resolveTransferFactoryId: async ({ instrumentId }) =>
      instrumentId.id === "Amulet" ? CC_FACTORY : USDCX_FACTORY,
    executeSubmission: async () => ({ updateId: "1220-x", transferred: true }),
    ...over,
  };
}

function ccReqs(over: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    scheme: "exact",
    network: NETWORK,
    amount: "100000000", // 0.01 CC atomic
    asset: "CC",
    payTo: CC.receiver,
    maxTimeoutSeconds: 60,
    extra: {
      assetTransferMethod: "transfer-factory",
      feePayer: FAC,
      instrumentId: CC.instrumentId,
      executeBeforeSeconds: 120,
    },
    ...over,
  };
}

const livePreapproval = (now: number): PreapprovalView => ({
  receiver: CC.receiver,
  dso: CC.instrumentId.admin,
  expiresAt: new Date(now + 1_000_000_000).toISOString(),
});

describe("verifyInlineTransfer — Canton Coin", () => {
  it("passes with a live preapproval", async () => {
    const now = nowFor(CC_RAW);
    const r = await verifyInlineTransfer(
      inlinePayload(CC_RAW),
      ccReqs(),
      stubSigner({ fetchPreapproval: async () => livePreapproval(now) }),
      {},
      now,
    );
    expect(r.ok).toBe(true);
    expect(r.payer).toBe(CC.sender);
    expect(r.transferKind).toBe("amulet");
  });

  it("fails a tampered amount", async () => {
    const now = nowFor(CC_RAW);
    const r = await verifyInlineTransfer(
      inlinePayload(CC_RAW),
      ccReqs({ amount: "200000000" }),
      stubSigner({ fetchPreapproval: async () => livePreapproval(now) }),
      {},
      now,
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("invalid_exact_canton_amount_mismatch");
  });

  it("fails a tampered receiver", async () => {
    const now = nowFor(CC_RAW);
    const r = await verifyInlineTransfer(
      inlinePayload(CC_RAW),
      ccReqs({ payTo: "attacker::1220" + "00".repeat(32) }),
      stubSigner({ fetchPreapproval: async () => livePreapproval(now) }),
      {},
      now,
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("invalid_exact_canton_merchant_mismatch");
  });

  it("fails a tampered instrument admin (bytes carry the DSO)", async () => {
    const now = nowFor(CC_RAW);
    const r = await verifyInlineTransfer(
      inlinePayload(CC_RAW),
      ccReqs({
        extra: {
          ...ccReqs().extra,
          instrumentId: { admin: "evil::1220" + "22".repeat(32), id: "Amulet" },
        },
      }),
      stubSigner({ fetchPreapproval: async () => livePreapproval(now) }),
      {},
      now,
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("invalid_exact_canton_instrument_id_mismatch");
  });

  it("fails with no live preapproval", async () => {
    const now = nowFor(CC_RAW);
    const r = await verifyInlineTransfer(
      inlinePayload(CC_RAW),
      ccReqs(),
      stubSigner({ fetchPreapproval: async () => null }),
      {},
      now,
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("invalid_exact_canton_preapproval_missing");
  });

  it("fails a fee-payer mismatch (feePayer not this facilitator)", async () => {
    const now = nowFor(CC_RAW);
    const r = await verifyInlineTransfer(
      inlinePayload(CC_RAW),
      ccReqs({ extra: { ...ccReqs().extra, feePayer: "someone::1220" + "11".repeat(32) } }),
      stubSigner({ fetchPreapproval: async () => livePreapproval(now) }),
      {},
      now,
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("invalid_exact_canton_fee_payer_mismatch");
  });

  it("fails a self-payment (payer is the facilitator)", async () => {
    const now = nowFor(CC_RAW);
    const r = await verifyInlineTransfer(
      inlinePayload(CC_RAW),
      ccReqs(),
      // The fixture's sender is the payer; make it a facilitator address.
      stubSigner({ getAddresses: () => [CC.sender] }),
      {},
      now,
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("invalid_exact_canton_self_payment");
  });

  it("rejects a bad signature", async () => {
    const now = nowFor(CC_RAW);
    const r = await verifyInlineTransfer(
      inlinePayload(CC_RAW),
      ccReqs(),
      stubSigner({
        fetchPreapproval: async () => livePreapproval(now),
        verifySignature: async () => ({ verified: false }),
      }),
      {},
      now,
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("invalid_exact_canton_signature_invalid");
  });
});

describe("verifyInlineTransfer — USDCx (CIP-56 registry)", () => {
  const USDCX_ADMIN =
    "decentralized-usdc-interchain-rep::12208115f1e168dd7e792320be9c4ca720c751a02a3053c7606e1c1cd3dad9bf60ef";
  const RECEIVER = "devilXXX::1220c065ad977ae4e480b6ea5bcd96d6d73025a91ad27fa60d1385010ca01cdd39f9";
  const OPERATOR =
    "auth0_007c6643538f2eadd3e573dd05b9::12205bcc106efa0eaa7f18dc491e5c6f5fb9b0cc68dc110ae66f4ed6467475d7c78e";
  const BRIDGE =
    "Bridge-Operator::1220c8448890a70e65f6906bd48d797ee6551f094e9e6a53e329fd5b2b549334f13f";
  const NOW_MS = 1787383310000;

  const usdcxReqs = (): PaymentRequirements => ({
    scheme: "exact",
    network: NETWORK,
    amount: "10000000", // 0.001 USDCx atomic
    asset: "USDCx",
    payTo: RECEIVER,
    maxTimeoutSeconds: 60,
    extra: {
      assetTransferMethod: "transfer-factory",
      feePayer: FAC,
      instrumentId: { admin: USDCX_ADMIN, id: "USDCx" },
      executeBeforeSeconds: 120,
    },
  });

  const config = {
    registryTrustedParties: { [USDCX_ADMIN]: [OPERATOR, BRIDGE] },
  };
  // The registry map lives on the signer only (single source).
  const registrySigner = (over: Partial<FacilitatorCantonSigner> = {}) =>
    stubSigner({
      registryBaseUrl: admin =>
        admin === USDCX_ADMIN ? "https://api.utilities.digitalasset.com" : undefined,
      ...over,
    });

  it("passes with the registrar configured and operator+bridge trusted", async () => {
    const r = await verifyInlineTransfer(
      inlinePayload(USDCX_RAW),
      usdcxReqs(),
      registrySigner(),
      config,
      NOW_MS,
    );
    expect(r.ok).toBe(true);
    expect(r.transferKind).toBe("registry");
  });

  it("fails when the registry infra parties are NOT trusted (foreign-party backstop)", async () => {
    const r = await verifyInlineTransfer(
      inlinePayload(USDCX_RAW),
      usdcxReqs(),
      registrySigner(),
      {},
      NOW_MS,
    );
    expect(r.ok).toBe(false);
  });

  it("takes the preapproval path when the signer does not know the registrar", async () => {
    const r = await verifyInlineTransfer(
      inlinePayload(USDCX_RAW),
      usdcxReqs(),
      stubSigner(),
      config,
      NOW_MS,
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("invalid_exact_canton_preapproval_missing");
  });
});

describe("verifyInlineTransfer — requirements gates", () => {
  const SIGNED_SYNC = decodePrepared(CC_RAW).synchronizerId!;
  const OTHER_SYNC = "global-domain::1220" + "00".repeat(32);

  async function run(
    reqs: PaymentRequirements,
    config: { synchronizerId?: string } = {},
  ): Promise<Awaited<ReturnType<typeof verifyInlineTransfer>>> {
    const now = nowFor(CC_RAW);
    return verifyInlineTransfer(
      inlinePayload(CC_RAW),
      reqs,
      stubSigner({ fetchPreapproval: async () => livePreapproval(now) }),
      config,
      now,
    );
  }

  it("fails an assetTransferMethod other than transfer-factory", async () => {
    const reqs = ccReqs();
    const r = await run({ ...reqs, extra: { ...reqs.extra, assetTransferMethod: "allocation" } });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("invalid_exact_canton_malformed_payload");
  });

  it("fails a missing assetTransferMethod", async () => {
    const reqs = ccReqs();
    const extra = { ...(reqs.extra as Record<string, unknown>) };
    delete extra.assetTransferMethod;
    const r = await run({ ...reqs, extra });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("invalid_exact_canton_malformed_payload");
  });

  it("pins to the facilitator's own synchronizer when extra omits it", async () => {
    expect((await run(ccReqs(), { synchronizerId: SIGNED_SYNC })).ok).toBe(true);
    const r = await run(ccReqs(), { synchronizerId: OTHER_SYNC });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("invalid_exact_canton_malformed_payload");
  });

  it("fails when extra.synchronizerId differs from the signed domain", async () => {
    const reqs = ccReqs();
    const r = await run(
      { ...reqs, extra: { ...reqs.extra, synchronizerId: OTHER_SYNC } },
      { synchronizerId: SIGNED_SYNC },
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("invalid_exact_canton_malformed_payload");
  });

  it("passes when facilitator and extra both name the signed domain", async () => {
    const reqs = ccReqs();
    const r = await run(
      { ...reqs, extra: { ...reqs.extra, synchronizerId: SIGNED_SYNC } },
      { synchronizerId: SIGNED_SYNC },
    );
    expect(r.ok).toBe(true);
  });
});

describe("verifyInlineTransfer — transfer factory pin", () => {
  const OTHER_FACTORY = "00" + "ab".repeat(33);

  async function run(signer: FacilitatorCantonSigner) {
    const now = nowFor(CC_RAW);
    return verifyInlineTransfer(inlinePayload(CC_RAW), ccReqs(), signer, {}, now);
  }
  const withPreapproval = (over: Partial<FacilitatorCantonSigner>) => {
    const now = nowFor(CC_RAW);
    return stubSigner({ fetchPreapproval: async () => livePreapproval(now), ...over });
  };

  it("rejects a root exercise on a contract other than the resolved factory", async () => {
    const calls: Array<boolean | undefined> = [];
    const r = await run(
      withPreapproval({
        resolveTransferFactoryId: async args => {
          calls.push(args.refresh);
          return OTHER_FACTORY;
        },
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("invalid_exact_canton_malformed_payload");
    expect(calls).toEqual([undefined, true]); // one refresh, then refuse
  });

  it("accepts after one refresh when the cached factory was stale", async () => {
    const r = await run(
      withPreapproval({
        resolveTransferFactoryId: async args => (args.refresh ? CC_FACTORY : OTHER_FACTORY),
      }),
    );
    expect(r.ok).toBe(true);
  });

  it("resolves with the transfer's own parties, amount, instrument and inputs", async () => {
    let seen: Parameters<FacilitatorCantonSigner["resolveTransferFactoryId"]>[0] | undefined;
    await run(
      withPreapproval({
        resolveTransferFactoryId: async args => {
          seen = args;
          return CC_FACTORY;
        },
      }),
    );
    expect(seen?.sender).toBe(CC.sender);
    expect(seen?.receiver).toBe(CC.receiver);
    expect(seen?.instrumentId).toEqual(CC.instrumentId);
    expect(seen?.inputHoldingCids.length).toBeGreaterThan(0);
  });

  it("fails closed when the factory cannot be resolved", async () => {
    const r = await run(
      withPreapproval({
        resolveTransferFactoryId: async () => {
          throw new Error("scan down");
        },
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("unexpected_canton_ledger_error");
  });
});

describe("verifyInlineTransfer — scheme and network", () => {
  async function run(
    payload: PaymentPayload,
    reqs: PaymentRequirements,
    config: { networks?: readonly string[] } = {},
  ) {
    const now = nowFor(CC_RAW);
    return verifyInlineTransfer(
      payload,
      reqs,
      stubSigner({ fetchPreapproval: async () => livePreapproval(now) }),
      config,
      now,
    );
  }

  it("rejects when the accepted network differs from the requirements", async () => {
    const p = { ...inlinePayload(CC_RAW), accepted: { scheme: "exact", network: "canton:devnet" } };
    const r = await run(p as never, ccReqs());
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("invalid_network");
  });

  it("rejects a network this facilitator does not serve", async () => {
    const r = await run(inlinePayload(CC_RAW), ccReqs(), { networks: ["canton:devnet"] });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("invalid_network");
  });

  it("passes on a served network", async () => {
    const r = await run(inlinePayload(CC_RAW), ccReqs(), { networks: [NETWORK] });
    expect(r.ok).toBe(true);
  });

  it("rejects a non-exact scheme", async () => {
    const p = { ...inlinePayload(CC_RAW), accepted: { scheme: "upto", network: NETWORK } };
    const r = await run(p as never, ccReqs());
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("unsupported_scheme");
  });
});
