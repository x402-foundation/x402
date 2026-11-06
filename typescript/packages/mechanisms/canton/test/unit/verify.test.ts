/**
 * Facilitator VERIFY, on real MainNet prepared-transaction fixtures.
 *
 * - CC (Amulet): passes on the signed transaction alone (factory, preapproval and
 *   inputs are proven from its input contracts); tampered amount/receiver, a
 *   self-payment, and a fee-payer mismatch each fail with the matching reason.
 * - USDCx (CIP-56 registry): passes only when the registrar is one this
 *   facilitator settles for, with the operator+bridge trusted.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import {
  classifyMismatch,
  isInlineCarriage,
  verifyInlineTransfer,
} from "../../src/exact/facilitator/verify-inline.js";
import { encodeInlinePaymentPayload } from "../../src/inline-payload.js";
import { decodePrepared } from "../../src/prepared-transfer.js";
import type { FacilitatorCantonSigner } from "../../src/signer.js";

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
    executeSubmission: async () => ({ updateId: "1220-x" }),
    lookupSubmission: async () => ({ status: "absent" }),
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

const SERVED = { networks: [NETWORK] };

/** The refusal reason, or undefined when verify passed. */
const reasonOf = (r: Awaited<ReturnType<typeof verifyInlineTransfer>>) =>
  r.ok ? undefined : r.reason;

describe("verifyInlineTransfer — Canton Coin", () => {
  it("passes on the signed transaction alone", async () => {
    const now = nowFor(CC_RAW);
    const r = await verifyInlineTransfer(
      inlinePayload(CC_RAW),
      ccReqs(),
      stubSigner(),
      SERVED,
      now,
    );
    expect(r.ok).toBe(true);
    expect(r.payer).toBe(CC.sender);
    if (!r.ok) throw new Error(r.reason);
    expect(r.transferKind).toBe("amulet");
    expect(r.commandId).toBeTruthy();
    expect(r.commitDeadlineMs).toBeGreaterThan(now);
  });

  it("fails a tampered amount", async () => {
    const now = nowFor(CC_RAW);
    const r = await verifyInlineTransfer(
      inlinePayload(CC_RAW),
      ccReqs({ amount: "200000000" }),
      stubSigner(),
      SERVED,
      now,
    );
    expect(r.ok).toBe(false);
    expect(reasonOf(r)).toBe("invalid_exact_canton_amount_mismatch");
  });

  it("fails a tampered receiver", async () => {
    const now = nowFor(CC_RAW);
    const r = await verifyInlineTransfer(
      inlinePayload(CC_RAW),
      ccReqs({ payTo: "attacker::1220" + "00".repeat(32) }),
      stubSigner(),
      SERVED,
      now,
    );
    expect(r.ok).toBe(false);
    expect(reasonOf(r)).toBe("invalid_exact_canton_merchant_mismatch");
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
      stubSigner(),
      SERVED,
      now,
    );
    expect(r.ok).toBe(false);
    expect(reasonOf(r)).toBe("invalid_exact_canton_instrument_id_mismatch");
  });

  it("fails a fee-payer mismatch (feePayer not this facilitator)", async () => {
    const now = nowFor(CC_RAW);
    const r = await verifyInlineTransfer(
      inlinePayload(CC_RAW),
      ccReqs({ extra: { ...ccReqs().extra, feePayer: "someone::1220" + "11".repeat(32) } }),
      stubSigner(),
      SERVED,
      now,
    );
    expect(r.ok).toBe(false);
    expect(reasonOf(r)).toBe("invalid_exact_canton_fee_payer_mismatch");
  });

  it("fails a self-payment (payer is the facilitator)", async () => {
    const now = nowFor(CC_RAW);
    const r = await verifyInlineTransfer(
      inlinePayload(CC_RAW),
      ccReqs(),
      // The fixture's sender is the payer; make it a facilitator address.
      stubSigner({ getAddresses: () => [CC.sender] }),
      SERVED,
      now,
    );
    expect(r.ok).toBe(false);
    expect(reasonOf(r)).toBe("invalid_exact_canton_self_payment");
  });

  it("rejects a bad signature", async () => {
    const now = nowFor(CC_RAW);
    const r = await verifyInlineTransfer(
      inlinePayload(CC_RAW),
      ccReqs(),
      stubSigner({ verifySignature: async () => ({ verified: false }) }),
      SERVED,
      now,
    );
    expect(r.ok).toBe(false);
    expect(reasonOf(r)).toBe("invalid_exact_canton_signature_invalid");
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
    ...SERVED,
    registryTrustedParties: { [USDCX_ADMIN]: [OPERATOR, BRIDGE] },
  };

  it("passes with the registrar configured and operator+bridge trusted", async () => {
    const r = await verifyInlineTransfer(
      inlinePayload(USDCX_RAW),
      usdcxReqs(),
      stubSigner(),
      config,
      NOW_MS,
    );
    if (!r.ok) throw new Error(r.reason);
    expect(r.transferKind).toBe("registry");
  });

  it("fails when the registry infra parties are NOT trusted (foreign-party backstop)", async () => {
    const r = await verifyInlineTransfer(
      inlinePayload(USDCX_RAW),
      usdcxReqs(),
      stubSigner(),
      SERVED,
      NOW_MS,
    );
    expect(r.ok).toBe(false);
  });

  it("refuses a registrar this facilitator does not settle for", async () => {
    const r = await verifyInlineTransfer(
      inlinePayload(USDCX_RAW),
      usdcxReqs(),
      stubSigner(),
      // The infra parties are trusted under another registrar, so the transfer
      // clears the foreign-party backstop but not the factory pin.
      {
        ...SERVED,
        registryTrustedParties: {
          ["other::1220" + "33".repeat(32)]: [OPERATOR, BRIDGE, USDCX_ADMIN],
        },
      },
      NOW_MS,
    );
    expect(r.ok).toBe(false);
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
      stubSigner(),
      { ...SERVED, ...config },
      now,
    );
  }

  it("fails an assetTransferMethod other than transfer-factory", async () => {
    const reqs = ccReqs();
    const r = await run({ ...reqs, extra: { ...reqs.extra, assetTransferMethod: "allocation" } });
    expect(r.ok).toBe(false);
    expect(reasonOf(r)).toBe("invalid_exact_canton_malformed_payload");
  });

  it("fails a missing assetTransferMethod", async () => {
    const reqs = ccReqs();
    const extra = { ...(reqs.extra as Record<string, unknown>) };
    delete extra.assetTransferMethod;
    const r = await run({ ...reqs, extra });
    expect(r.ok).toBe(false);
    expect(reasonOf(r)).toBe("invalid_exact_canton_malformed_payload");
  });

  it("pins to the facilitator's own synchronizer when extra omits it", async () => {
    expect((await run(ccReqs(), { synchronizerId: SIGNED_SYNC })).ok).toBe(true);
    const r = await run(ccReqs(), { synchronizerId: OTHER_SYNC });
    expect(r.ok).toBe(false);
    expect(reasonOf(r)).toBe("invalid_exact_canton_malformed_payload");
  });

  it("fails when extra.synchronizerId differs from the signed domain", async () => {
    const reqs = ccReqs();
    const r = await run(
      { ...reqs, extra: { ...reqs.extra, synchronizerId: OTHER_SYNC } },
      { synchronizerId: SIGNED_SYNC },
    );
    expect(r.ok).toBe(false);
    expect(reasonOf(r)).toBe("invalid_exact_canton_malformed_payload");
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

describe("verifyInlineTransfer — scheme and network", () => {
  async function run(
    payload: PaymentPayload,
    reqs: PaymentRequirements,
    config: { networks: readonly string[] } = SERVED,
  ) {
    return verifyInlineTransfer(payload, reqs, stubSigner(), config, nowFor(CC_RAW));
  }

  it("rejects when the accepted network differs from the requirements", async () => {
    const p = { ...inlinePayload(CC_RAW), accepted: { scheme: "exact", network: "canton:devnet" } };
    const r = await run(p as never, ccReqs());
    expect(r.ok).toBe(false);
    expect(reasonOf(r)).toBe("invalid_network");
  });

  it("rejects a network this facilitator does not serve", async () => {
    const r = await run(inlinePayload(CC_RAW), ccReqs(), { networks: ["canton:devnet"] });
    expect(r.ok).toBe(false);
    expect(reasonOf(r)).toBe("invalid_network");
  });

  it("passes on a served network", async () => {
    const r = await run(inlinePayload(CC_RAW), ccReqs(), { networks: [NETWORK] });
    expect(r.ok).toBe(true);
  });

  it("rejects a non-exact scheme", async () => {
    const p = { ...inlinePayload(CC_RAW), accepted: { scheme: "upto", network: NETWORK } };
    const r = await run(p as never, ccReqs());
    expect(r.ok).toBe(false);
    expect(reasonOf(r)).toBe("unsupported_scheme");
  });
});

describe("verifyInlineTransfer — payload, deadline and merchant policy", () => {
  const now = nowFor(CC_RAW);
  const PROVIDER = decodePrepared(CC_RAW)
    .inputContracts.find(
      ic => ic.templateQualifiedName === "Splice.AmuletRules:TransferPreapproval",
    )!
    .signatories.find(p => p.startsWith("Cantex-validator-1::"))!;
  const run = (
    over: {
      payload?: PaymentPayload;
      reqs?: PaymentRequirements;
      signer?: FacilitatorCantonSigner;
    } = {},
    config: Record<string, unknown> = {},
    at = now,
  ) =>
    verifyInlineTransfer(
      over.payload ?? inlinePayload(CC_RAW),
      over.reqs ?? ccReqs(),
      over.signer ?? stubSigner(),
      { ...SERVED, ...config },
      at,
    );

  it("refuses a payload without the signed transaction", async () => {
    const p = { ...inlinePayload(CC_RAW), payload: {} };
    expect(reasonOf(await run({ payload: p }))).toBe("invalid_exact_canton_missing_proof");
  });

  it("refuses bytes that are not a prepared transaction", async () => {
    const p = {
      ...inlinePayload(CC_RAW),
      payload: {
        ...encodeInlinePaymentPayload({
          preparedTransactionBytes: Buffer.from("not a prepared transaction"),
          preparedTxHash: "ab".repeat(32),
          signatureB64: Buffer.alloc(64, 7).toString("base64"),
        }),
      },
    };
    expect(reasonOf(await run({ payload: p }))).toBe("invalid_exact_canton_malformed_payload");
  });

  it("refuses requirements without a full instrument id", async () => {
    const reqs = ccReqs({
      extra: { ...ccReqs().extra, instrumentId: { admin: CC.instrumentId.admin } },
    });
    expect(reasonOf(await run({ reqs }))).toBe("invalid_exact_canton_instrument_id_mismatch");
  });

  it("refuses an amount that is not an atomic integer", async () => {
    expect(reasonOf(await run({ reqs: ccReqs({ amount: "0.5" }) }))).toBe(
      "invalid_exact_canton_amount_mismatch",
    );
  });

  it("refuses a memo the transfer does not carry", async () => {
    const reqs = ccReqs({ extra: { ...ccReqs().extra, memo: "invoice-1" } });
    expect(reasonOf(await run({ reqs }))).toBe("invalid_exact_canton_memo_mismatch");
  });

  it("refuses an executeBefore further ahead than the facilitator allows", async () => {
    expect(reasonOf(await run({}, { maxExecuteBeforeSeconds: 10 }))).toBe(
      "invalid_exact_canton_execute_before_too_far",
    );
  });

  it("refuses a transfer about to expire", async () => {
    const deadline = Number(decodePrepared(CC_RAW).maxLedgerEffectiveTime! / 1000n);
    expect(reasonOf(await run({}, {}, deadline - 1_000))).toBe("invalid_exact_canton_expired");
  });

  it("a failed key read is a ledger error, not an invalid signature", async () => {
    const signer = stubSigner({
      verifySignature: async () => {
        throw new Error("topology unavailable");
      },
    });
    expect(reasonOf(await run({ signer }))).toBe("unexpected_canton_ledger_error");
  });

  it("provider policy: relays for merchants whose preapproval this facilitator provides", async () => {
    const asProvider = stubSigner({ getAddresses: () => [FAC, PROVIDER] });
    expect((await run({ signer: asProvider }, { merchantPolicy: "provider" })).ok).toBe(true);
    expect(reasonOf(await run({}, { merchantPolicy: "provider" }))).toBe(
      "invalid_exact_canton_merchant_not_registered",
    );
  });

  it("allowlist policy: relays only for listed merchants", async () => {
    expect(
      (await run({}, { merchantPolicy: "allowlist", merchantAllowlist: [CC.receiver] })).ok,
    ).toBe(true);
    expect(reasonOf(await run({}, { merchantPolicy: "allowlist", merchantAllowlist: [] }))).toBe(
      "invalid_exact_canton_merchant_not_registered",
    );
  });
});

describe("classifyMismatch and isInlineCarriage", () => {
  it("maps validator messages onto the scheme's codes", () => {
    const cases: Array<[string, string]> = [
      ["amount differs", "invalid_exact_canton_amount_mismatch"],
      ["receiver differs", "invalid_exact_canton_merchant_mismatch"],
      ["instrument differs", "invalid_exact_canton_instrument_id_mismatch"],
      ["memo differs", "invalid_exact_canton_memo_mismatch"],
      ["no input holding", "invalid_exact_canton_insufficient_inputs"],
      ["executeBefore already in the past", "invalid_exact_canton_expired"],
      ["something else", "invalid_exact_canton_malformed_payload"],
    ];
    for (const [message, code] of cases) expect(classifyMismatch(message)).toBe(code);
  });

  it("recognizes the inline carriage", () => {
    expect(isInlineCarriage({ preparedTransaction: "x" })).toBe(true);
    expect(isInlineCarriage({})).toBe(false);
    expect(isInlineCarriage(null)).toBe(false);
  });
});
