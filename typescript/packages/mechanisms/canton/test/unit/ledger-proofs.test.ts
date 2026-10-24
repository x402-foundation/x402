/**
 * Settlement-path proofs on real MainNet prepared transactions, and on copies
 * whose input contracts are altered the way a payer forging a payload would
 * alter them. Each alteration must be refused with the matching reason.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  proveSettlementPath,
  type SettlementPathExpectation,
} from "../../src/exact/facilitator/ledger-proofs.js";
import {
  decodePrepared,
  extractTransfer,
  type DecodedInputContract,
  type DecodedPrepared,
} from "../../src/prepared-transfer.js";

const FIX = fileURLToPath(new URL("../../src/__fixtures__/", import.meta.url));
const read = (f: string) => readFileSync(FIX + f, "utf8").trim();

const CC_RAW = read("mainnet-transfer-preapproval-0.1.21.b64");
const USDCX_RAW = read("mainnet-usdcx-transfer-preapproval.b64");
const DSO = "DSO::1220b1431ef217342db44d516bb9befde802be7d8899637d290895fa58880f19accc";
const USDCX_ADMIN =
  "decentralized-usdc-interchain-rep::12208115f1e168dd7e792320be9c4ca720c751a02a3053c7606e1c1cd3dad9bf60ef";
const STRANGER = "stranger::1220" + "44".repeat(32);

/**
 * The expectation an honest facilitator derives for a fixture.
 *
 * @param pt - The decoded fixture.
 * @param instrumentId - The fixture's instrument.
 * @param amount - The fixture's transfer amount.
 * @returns The expectation, with the transfer's own parties and inputs.
 */
function expectationFor(
  pt: DecodedPrepared,
  instrumentId: { admin: string; id: string },
  amount: string,
): SettlementPathExpectation {
  const root = pt.nodes.find(n => n.nodeId === pt.roots[0])!.exercise!;
  const t = extractTransfer(root.chosenValue!);
  return {
    payer: pt.actAs[0]!,
    payTo: t.receiver,
    instrumentId,
    amount,
    inputHoldingCids: t.inputHoldingCids,
    rootContractId: root.contractId!,
    trustedRegistrars: new Set([USDCX_ADMIN]),
    nowMs: Number(pt.preparationTime! / 1000n),
  };
}

/**
 * A copy of the decoded transaction with the input contracts matching
 * `template` rewritten.
 *
 * @param pt - The decoded transaction.
 * @param template - Template qualified name to alter.
 * @param alter - The change to apply.
 * @returns The altered copy.
 */
function withInput(
  pt: DecodedPrepared,
  template: string,
  alter: (ic: DecodedInputContract) => DecodedInputContract | undefined,
): DecodedPrepared {
  const inputContracts = pt.inputContracts.flatMap(ic => {
    if (ic.templateQualifiedName !== template) return [ic];
    const next = alter(ic);
    return next ? [next] : [];
  });
  return { ...pt, inputContracts };
}

describe("proveSettlementPath — Canton Coin", () => {
  const pt = decodePrepared(CC_RAW);
  const base = expectationFor(pt, { admin: DSO, id: "Amulet" }, "0.0100000000");

  it("proves the honest transfer and returns the preapproval provider", () => {
    const r = proveSettlementPath(pt, base);
    expect(r).toMatchObject({ ok: true, kind: "amulet" });
    expect(r.ok && r.preapprovalProvider).toMatch(/^Cantex-validator-1::/);
  });

  it("refuses a factory the DSO did not sign (look-alike template)", () => {
    const forged = withInput(
      pt,
      "Splice.ExternalPartyAmuletRules:ExternalPartyAmuletRules",
      ic => ({
        ...ic,
        signatories: [base.payer],
      }),
    );
    expect(proveSettlementPath(forged, base)).toEqual({
      ok: false,
      reason: "invalid_exact_canton_malformed_payload",
    });
  });

  it("refuses two input contracts under one contract id", () => {
    const dup = { ...pt, inputContracts: [...pt.inputContracts, pt.inputContracts[0]!] };
    expect(proveSettlementPath(dup, base)).toEqual({
      ok: false,
      reason: "invalid_exact_canton_malformed_payload",
    });
  });

  it("refuses a root exercise on a contract that is not an input contract", () => {
    const r = proveSettlementPath(pt, { ...base, rootContractId: "00" + "ab".repeat(33) });
    expect(r).toEqual({ ok: false, reason: "invalid_exact_canton_malformed_payload" });
  });

  it("refuses a different instrument admin than the factory's signatory", () => {
    const r = proveSettlementPath(pt, { ...base, instrumentId: { admin: STRANGER, id: "Amulet" } });
    expect(r.ok).toBe(false);
  });

  it("refuses a transfer that does not deliver through the merchant's preapproval", () => {
    const noPreapproval = withInput(pt, "Splice.AmuletRules:TransferPreapproval", () => undefined);
    expect(proveSettlementPath(noPreapproval, base)).toEqual({
      ok: false,
      reason: "invalid_exact_canton_preapproval_missing",
    });
  });

  it("refuses an expired preapproval", () => {
    const r = proveSettlementPath(pt, { ...base, nowMs: Date.UTC(2030, 0, 1) });
    expect(r).toEqual({ ok: false, reason: "invalid_exact_canton_preapproval_missing" });
  });

  it("refuses a preapproval that is not yet valid", () => {
    const r = proveSettlementPath(pt, { ...base, nowMs: Date.UTC(2020, 0, 1) });
    expect(r).toEqual({ ok: false, reason: "invalid_exact_canton_preapproval_missing" });
  });

  it("refuses inputs that do not cover the amount", () => {
    const r = proveSettlementPath(pt, { ...base, amount: "1000.0000000000" });
    expect(r).toEqual({ ok: false, reason: "invalid_exact_canton_insufficient_inputs" });
  });

  it("refuses a declared input that is not among the input contracts", () => {
    const r = proveSettlementPath(pt, {
      ...base,
      inputHoldingCids: [...base.inputHoldingCids, "00" + "cd".repeat(33)],
    });
    expect(r).toEqual({ ok: false, reason: "invalid_exact_canton_insufficient_inputs" });
  });

  it("refuses a holding someone else owns", () => {
    const foreign = withInput(pt, "Splice.Amulet:Amulet", ic => ({
      ...ic,
      signatories: [DSO, STRANGER],
    }));
    expect(proveSettlementPath(foreign, base)).toEqual({
      ok: false,
      reason: "invalid_exact_canton_insufficient_inputs",
    });
  });

  it("refuses a repeated input cid", () => {
    const cid = base.inputHoldingCids[0]!;
    const r = proveSettlementPath(pt, { ...base, inputHoldingCids: [cid, cid] });
    expect(r).toEqual({ ok: false, reason: "invalid_exact_canton_insufficient_inputs" });
  });

  it("refuses an empty input list", () => {
    const r = proveSettlementPath(pt, { ...base, inputHoldingCids: [] });
    expect(r).toEqual({ ok: false, reason: "invalid_exact_canton_insufficient_inputs" });
  });

  it("refuses a malformed amount", () => {
    const r = proveSettlementPath(pt, { ...base, amount: "0.01000000001" });
    expect(r).toEqual({ ok: false, reason: "invalid_exact_canton_insufficient_inputs" });
  });
});

describe("proveSettlementPath — preapproval providers", () => {
  /**
   * The expectation for a preapproval capture, at its preparation time.
   *
   * @param raw - The capture.
   * @returns The decoded capture and its expectation.
   */
  function capture(raw: string) {
    const pt = decodePrepared(raw);
    const root = pt.nodes.find(n => n.nodeId === pt.roots[0])!.exercise!;
    const t = extractTransfer(root.chosenValue!);
    return {
      pt,
      base: expectationFor(pt, { admin: t.instrumentAdmin, id: t.instrumentId }, t.amount),
    };
  }

  it("proves a merchant that is its own provider (signed by the DSO and the merchant)", () => {
    const { pt, base } = capture(read("mainnet-preapproval-self-provider.b64"));
    const r = proveSettlementPath(pt, base);
    expect(r).toMatchObject({ ok: true, kind: "amulet", preapprovalProvider: base.payTo });
  });

  it("proves a merchant whose validator is its provider", () => {
    const { pt, base } = capture(read("mainnet-preapproval-distinct-provider.b64"));
    const r = proveSettlementPath(pt, base);
    expect(r.ok).toBe(true);
    expect(r.ok && r.preapprovalProvider).not.toBe(base.payTo);
  });

  it("refuses a self-provided preapproval with a third, foreign signatory", () => {
    const { pt, base } = capture(read("mainnet-preapproval-self-provider.b64"));
    const forged = withInput(pt, "Splice.AmuletRules:TransferPreapproval", ic => ({
      ...ic,
      signatories: [...ic.signatories, STRANGER],
    }));
    expect(proveSettlementPath(forged, base)).toEqual({
      ok: false,
      reason: "invalid_exact_canton_preapproval_missing",
    });
  });

  it("refuses two preapprovals (a decoy next to the real one)", () => {
    const { pt, base } = capture(read("mainnet-preapproval-self-provider.b64"));
    const pre = pt.inputContracts.find(
      ic => ic.templateQualifiedName === "Splice.AmuletRules:TransferPreapproval",
    )!;
    const doubled = {
      ...pt,
      inputContracts: [...pt.inputContracts, { ...pre, contractId: "00decoy" }],
    };
    expect(proveSettlementPath(doubled, base).ok).toBe(false);
  });
});

describe("proveSettlementPath — registry token (USDCx)", () => {
  const pt = decodePrepared(USDCX_RAW);
  const base = expectationFor(pt, { admin: USDCX_ADMIN, id: "USDCx" }, "0.0010000000");

  it("proves the honest transfer", () => {
    expect(proveSettlementPath(pt, base)).toEqual({ ok: true, kind: "registry" });
  });

  it("refuses a registrar this facilitator does not settle for", () => {
    const r = proveSettlementPath(pt, { ...base, trustedRegistrars: new Set() });
    expect(r).toEqual({ ok: false, reason: "invalid_exact_canton_malformed_payload" });
  });

  it("refuses a factory preapproval not signed by the receiver alone", () => {
    const forged = withInput(
      pt,
      "Utility.Registry.App.V0.Model.TransferPreapproval:TransferPreapproval",
      ic => ({ ...ic, signatories: [base.payer] }),
    );
    expect(proveSettlementPath(forged, base).ok).toBe(false);
  });

  it("refuses a receiver other than the factory preapproval's", () => {
    expect(proveSettlementPath(pt, { ...base, payTo: STRANGER }).ok).toBe(false);
  });

  it("refuses a TransferRule the registrar did not sign", () => {
    const forged = withInput(pt, "Utility.Registry.V0.Rule.Transfer:TransferRule", ic => ({
      ...ic,
      signatories: [base.payer],
    }));
    expect(proveSettlementPath(forged, base)).toEqual({
      ok: false,
      reason: "invalid_exact_canton_preapproval_missing",
    });
  });

  it("refuses a transfer with no direct delivery", () => {
    const noRule = withInput(pt, "Utility.Registry.V0.Rule.Transfer:TransferRule", () => undefined);
    expect(proveSettlementPath(noRule, base)).toEqual({
      ok: false,
      reason: "invalid_exact_canton_preapproval_missing",
    });
  });

  it("refuses a holding of another instrument id", () => {
    const r = proveSettlementPath(pt, {
      ...base,
      instrumentId: { admin: USDCX_ADMIN, id: "CBTC" },
    });
    expect(r).toEqual({ ok: false, reason: "invalid_exact_canton_insufficient_inputs" });
  });

  it("refuses a holding someone else owns", () => {
    const foreign = withInput(pt, "Utility.Registry.Holding.V0.Holding:Holding", ic => ({
      ...ic,
      signatories: [USDCX_ADMIN, STRANGER],
    }));
    expect(proveSettlementPath(foreign, base)).toEqual({
      ok: false,
      reason: "invalid_exact_canton_insufficient_inputs",
    });
  });

  it("refuses inputs that do not cover the amount", () => {
    const r = proveSettlementPath(pt, { ...base, amount: "100.0000000000" });
    expect(r).toEqual({ ok: false, reason: "invalid_exact_canton_insufficient_inputs" });
  });
});
