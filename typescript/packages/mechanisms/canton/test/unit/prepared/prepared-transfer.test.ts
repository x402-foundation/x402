import { describe, it, expect } from "vitest";
import {
  decodePrepared,
  extractTransfer,
  assertPreparedTransferMatches,
  canonicalAmount,
  PreparedTransferMismatchError,
  PreparedDecodeError,
  type PreparedTransferExpectation,
} from "../../../src/prepared-transfer.js";

describe("canonicalAmount (amount value-equality normalization)", () => {
  it("pads a short decimal to 10 fractional digits", () => {
    expect(canonicalAmount("0.02")).toBe("0.0200000000");
    expect(canonicalAmount("1")).toBe("1.0000000000");
    expect(canonicalAmount("0.0200000000")).toBe("0.0200000000");
  });
  it("makes short and canonical forms compare equal", () => {
    expect(canonicalAmount("0.02")).toBe(canonicalAmount("0.0200000000"));
    expect(canonicalAmount("5")).toBe(canonicalAmount("5.0000000000"));
  });
  it("keeps big integer parts without float precision loss", () => {
    expect(canonicalAmount("123456789.123456789")).toBe("123456789.1234567890");
  });
  it("returns a non-numeric input as-is (so it still mismatches, fail-closed)", () => {
    expect(canonicalAmount("0x02")).toBe("0x02");
    expect(canonicalAmount("abc")).toBe("abc");
  });
});
import {
  buildPrepared,
  choiceArgument,
  vDualNumeric,
  vGenMap,
  vList,
  vNumeric,
  vParty,
  vText,
  vTwoMembers,
  type TransferOpts,
} from "./prepared-fixture.js";

// Legal Canton party ids INCLUDING dotted hints and non-hex namespaces.
const SENDER = "agent::1220abcd";
const MERCHANT = "merchant.payments::1220beef"; // dotted hint — must be accepted
const DSO = "dso.global::nonhexNS99"; // non-hex namespace — must be accepted
const OK: TransferOpts = {
  sender: SENDER,
  receiver: MERCHANT,
  amount: "1.0000000000",
  admin: DSO,
  id: "Amulet",
};
const EXPECT: PreparedTransferExpectation = {
  sender: SENDER,
  receiver: MERCHANT,
  amount: "1.0000000000",
  instrumentId: "Amulet",
};

describe("decodePrepared (structural)", () => {
  it("descends to act_as + the transfer exercise's choice id and chosen value", () => {
    const d = decodePrepared(buildPrepared(OK));
    expect(d.actAs).toEqual([SENDER]);
    expect(d.exercises.length).toBe(1);
    expect(d.exercises[0]!.choiceId).toBe("TransferFactory_Transfer");
  });
  it("rejects empty / undecodable input (fail-closed)", () => {
    expect(() => decodePrepared("")).toThrow(PreparedDecodeError);
  });
});

describe("extractTransfer (typed positions, with AND without labels)", () => {
  for (const noLabels of [false, true]) {
    it(`reads sender/receiver/amount/instrument by type (labels=${!noLabels})`, () => {
      const d = decodePrepared(buildPrepared({ ...OK, noLabels }));
      const t = extractTransfer(d.exercises[0]!.chosenValue);
      expect(t.sender).toBe(SENDER);
      expect(t.receiver).toBe(MERCHANT);
      expect(t.amount).toBe("1.0000000000");
      expect(t.instrumentId).toBe("Amulet");
      expect(t.instrumentAdmin).toBe(DSO);
    });
  }
});

describe("assertPreparedTransferMatches — honest transfers accepted", () => {
  it("accepts a matching transfer with dotted hint + non-hex namespace parties", () => {
    expect(() => assertPreparedTransferMatches(buildPrepared(OK), EXPECT)).not.toThrow();
  });
  it("accepts even when record-field labels are stripped (positional fallback)", () => {
    expect(() =>
      assertPreparedTransferMatches(buildPrepared({ ...OK, noLabels: true }), EXPECT),
    ).not.toThrow();
  });
  it("does NOT flag the DSO admin as a foreign recipient", () => {
    // admin (DSO) appears as expectedAdmin + instrumentId.admin but is not a recipient
    expect(() => assertPreparedTransferMatches(buildPrepared(OK), EXPECT)).not.toThrow();
  });
});

/* ──────────────────────────────────────────────────────────────────────────
 * BYPASS #1 — party-hint with '.' / non-hex namespace + intended kept as decoy.
 * The OLD PARTY_ID_RE (/^[A-Za-z0-9_-]+::[0-9a-fA-F]{4,}$/) would let a REAL
 * receiver "att.acker::1220dead" pass while the intended receiver was kept as a
 * decoy substring. Structural typed decode must REJECT (fail-closed).
 * ────────────────────────────────────────────────────────────────────────── */
describe("BYPASS #1: dotted/non-hex foreign receiver with intended receiver as decoy", () => {
  it("REJECTS when the real receiver is a dotted attacker party and the intended receiver is only a decoy text field", () => {
    // Real receiver (Party, tag 7) = attacker with a '.' AND a non-hex namespace.
    // Intended receiver smuggled in as a *text* field (decoy) so a substring
    // scan for the intended value would wrongly succeed.
    const attacked = buildPrepared({
      ...OK,
      receiver: "att.acker::nonHEXns", // would be MISSED by the old regex
      transferExtra: [{ label: "decoy", value: vText(MERCHANT) }], // intended as decoy
    });
    expect(() => assertPreparedTransferMatches(attacked, EXPECT)).toThrow(
      PreparedTransferMismatchError,
    );
    // and the message names the receiver mismatch and/or the foreign party
    try {
      assertPreparedTransferMatches(attacked, EXPECT);
    } catch (e) {
      expect((e as Error).message).toMatch(/receiver|unexpected part/);
    }
  });

  it("REJECTS a dotted attacker party even when intended receiver is a decoy PARTY in an unrelated list", () => {
    const attacked = buildPrepared({
      ...OK,
      receiver: "att.acker::1220dead",
      transferExtra: [{ label: "observers", value: vList([vParty(MERCHANT)]) }],
    });
    expect(() => assertPreparedTransferMatches(attacked, EXPECT)).toThrow(
      PreparedTransferMismatchError,
    );
  });
});

/* ──────────────────────────────────────────────────────────────────────────
 * BYPASS #2 — trust-boundary inversion: the relay supplies the instrument admin,
 * which the OLD code added to the allowlist. A compromised relay set the admin =
 * attacker AND made the attacker the receiver, whitelisting itself. The verifier
 * must NEVER trust a relay-supplied admin as a whitelist: the recipient is pinned
 * to caller intent, so the attack is REJECTED even when admin == receiver.
 * ────────────────────────────────────────────────────────────────────────── */
describe("BYPASS #2: relay-supplied admin cannot whitelist the attacker", () => {
  it("REJECTS when the relay sets admin == attacker AND receiver == attacker (self-whitelist)", () => {
    const attacker = "att.acker::1220dead";
    const attacked = buildPrepared({
      ...OK,
      receiver: attacker, // funds redirected
      admin: attacker, // relay tries to whitelist the attacker via admin
    });
    // EXPECT pins receiver = MERCHANT and does NOT anchor on admin → reject.
    expect(() => assertPreparedTransferMatches(attacked, EXPECT)).toThrow(
      PreparedTransferMismatchError,
    );
    try {
      assertPreparedTransferMatches(attacked, EXPECT);
    } catch (e) {
      // receiver mismatch (not silently allowed because admin == receiver)
      expect((e as Error).message).toMatch(/receiver/);
    }
  });

  it("REJECTS a relay that swaps the instrument id even if admin looks plausible", () => {
    const attacked = buildPrepared({ ...OK, id: "Sketchcoin" });
    expect(() => assertPreparedTransferMatches(attacked, EXPECT)).toThrow(/instrumentId\.id/);
  });
});

/* ──────────────────────────────────────────────────────────────────────────
 * BYPASS #3 — amount checked by substring presence, not at its real position.
 * The OLD code accepted a real "9999.0000000000" as long as the intended
 * "1.0000000000" appeared *anywhere*. Typed/positional decode must REJECT.
 * ────────────────────────────────────────────────────────────────────────── */
describe("BYPASS #3: inflated amount with intended amount as a decoy", () => {
  it("REJECTS when the real numeric amount is 9999 and the intended 1.0 is only a decoy text field", () => {
    const attacked = buildPrepared({
      ...OK,
      amount: "9999.0000000000", // real amount (Numeric, tag 6)
      transferExtra: [{ label: "memoAmount", value: vText("1.0000000000") }], // decoy
    });
    expect(() => assertPreparedTransferMatches(attacked, EXPECT)).toThrow(/amount/);
  });

  it("REJECTS when the intended amount appears as a decoy NUMERIC elsewhere but the transfer amount is inflated", () => {
    const attacked = buildPrepared({
      ...OK,
      amount: "9999.0000000000",
      transferExtra: [{ label: "feeHint", value: vNumeric("1.0000000000") }], // decoy numeric
    });
    expect(() => assertPreparedTransferMatches(attacked, EXPECT)).toThrow(/amount/);
  });
});

/* ──────────────────────────────────────────────────────────────────────────
 * BYPASS #4 — hash binding fail-closed on a bad/empty hash and undecodable
 * bytes. (Was: hash binding exported but never wired; now wired in tx.ts.)
 * ────────────────────────────────────────────────────────────────────────── */
describe("BYPASS A: duplicate Value.numeric in the amount (first-vs-last-wins divergence)", () => {
  it("REJECTS an amount Value that sets Value.numeric twice (decoy 1.0 then real 9999.0)", () => {
    const attacked = buildPrepared({
      ...OK,
      // amount field's raw Value = numeric("1.0") ++ numeric("9999.0")
      amountValueOverride: vDualNumeric("1.0000000000", "9999.0000000000"),
    });
    // Old code: extracted "1.0" (first-wins) == EXPECT.amount → accepted.
    // New code: ambiguous oneof member → PreparedDecodeError before comparison.
    expect(() => assertPreparedTransferMatches(attacked, EXPECT)).toThrow(PreparedDecodeError);
    try {
      assertPreparedTransferMatches(attacked, EXPECT);
    } catch (e) {
      expect((e as Error).message).toMatch(/numeric|ambiguous|appears .* times/i);
    }
  });

  it("REJECTS even when the SECOND numeric also equals intent (no first-wins guessing)", () => {
    // Both occurrences "1.0": still ambiguous; we must not pick either silently.
    const attacked = buildPrepared({
      ...OK,
      amountValueOverride: vDualNumeric("1.0000000000", "1.0000000000"),
    });
    expect(() => assertPreparedTransferMatches(attacked, EXPECT)).toThrow(PreparedDecodeError);
  });

  it("REJECTS an amount Value that sets two DIFFERENT oneof members (numeric + party)", () => {
    const attacked = buildPrepared({
      ...OK,
      amountValueOverride: vTwoMembers(vNumeric("1.0000000000"), vParty("att.acker::1220dead")),
    });
    expect(() => assertPreparedTransferMatches(attacked, EXPECT)).toThrow(PreparedDecodeError);
  });

  it("REJECTS a duplicated record-field label (decoy/real split keyed by label)", () => {
    // Two `amount` labels: by-label lookup would take the first, a last-wins
    // consumer the second. Ambiguous → reject.
    const attacked = buildPrepared({
      ...OK,
      amount: "1.0000000000",
      transferExtra: [{ label: "amount", value: vNumeric("9999.0000000000") }],
    });
    expect(() => assertPreparedTransferMatches(attacked, EXPECT)).toThrow(PreparedDecodeError);
  });

  it("still ACCEPTS an honest single-numeric amount (no false positive)", () => {
    expect(() => assertPreparedTransferMatches(buildPrepared(OK), EXPECT)).not.toThrow();
  });
});

describe("extra-leg and structural tampering", () => {
  it("REJECTS a smuggled extra party (a second receiver appended to the transfer)", () => {
    const attacked = buildPrepared({
      ...OK,
      transferExtra: [{ label: "secondLeg", value: vParty("att.acker::1220beef") }],
    });
    expect(() => assertPreparedTransferMatches(attacked, EXPECT)).toThrow(/unexpected part/);
  });

  it("REJECTS a second TransferFactory_Transfer exercise (relay adds a leg paying someone else)", () => {
    const attacked = buildPrepared({
      ...OK,
      secondExerciseChoice: "TransferFactory_Transfer",
      secondExerciseArg: choiceArgument({ ...OK, receiver: "att.acker::1220dead" }),
    });
    expect(() => assertPreparedTransferMatches(attacked, EXPECT)).toThrow(
      /transfer exercises|unexpected/,
    );
  });

  it("REJECTS an unexpected non-transfer exercise alongside the transfer", () => {
    const attacked = buildPrepared({
      ...OK,
      secondExerciseChoice: "Amulet_Burn",
      secondExerciseArg: choiceArgument(OK),
    });
    expect(() => assertPreparedTransferMatches(attacked, EXPECT)).toThrow(/unexpected exercise/);
  });

  // NOTE: a positive "honest consequence accepted" case can't be built with this
  // fixture — buildPrepared's secondExerciseChoice reuses node id "0" (yielding a
  // duplicate-node graph), so any whitelisted consequence still trips the
  // structural guard. The TRANSFER_CONSEQUENCE_CHOICES whitelist (Archive +
  // TransferPreapproval_Send(V2)) is exercised live by the withdraw / cip56
  // transfer e2e against a real prepared tx; the strict guards above (single
  // root, foreign-party backstop, pinned sender/receiver/amount) remain intact.

  it("REJECTS when act_as is not the agent's own party", () => {
    const attacked = buildPrepared({ ...OK, actAs: ["att.acker::1220dead"] });
    expect(() => assertPreparedTransferMatches(attacked, EXPECT)).toThrow(
      /acts as|receiver|sender/,
    );
  });

  it("REJECTS a tampered sender", () => {
    const attacked = buildPrepared({ ...OK, sender: "att.acker::1220dead", actAs: [SENDER] });
    expect(() => assertPreparedTransferMatches(attacked, EXPECT)).toThrow(/sender/);
  });

  it("REJECTS a prepared tx with NO transfer exercise at all", () => {
    const attacked = buildPrepared({ ...OK, choiceId: "Amulet_Transfer_Other" });
    expect(() => assertPreparedTransferMatches(attacked, EXPECT)).toThrow(
      /no .* exercise|unexpected exercise/,
    );
  });

  // Defense-in-depth: collectPartyLeaves must descend GenMap/TextMap values so a
  // party hidden inside a map cannot escape the foreign-recipient backstop.
  it("REJECTS a foreign party hidden inside a GenMap VALUE (collectPartyLeaves descends gen_map)", () => {
    const attacked = buildPrepared({
      ...OK,
      transferExtra: [
        {
          label: "meta",
          value: vGenMap([{ key: vText("beneficiary"), value: vParty("att.acker::1220beef") }]),
        },
      ],
    });
    expect(() => assertPreparedTransferMatches(attacked, EXPECT)).toThrow(/unexpected part/);
    try {
      assertPreparedTransferMatches(attacked, EXPECT);
    } catch (e) {
      expect((e as Error).message).toMatch(/att\.acker::1220beef/);
    }
  });

  it("REJECTS a foreign party hidden as a GenMap KEY (both key and value are descended)", () => {
    const attacked = buildPrepared({
      ...OK,
      transferExtra: [
        {
          label: "meta",
          value: vGenMap([{ key: vParty("att.acker::1220dead"), value: vText("x") }]),
        },
      ],
    });
    expect(() => assertPreparedTransferMatches(attacked, EXPECT)).toThrow(/unexpected part/);
  });

  it("ACCEPTS a GenMap that only references already-allowed parties (no false positive)", () => {
    const benign = buildPrepared({
      ...OK,
      transferExtra: [
        {
          label: "meta",
          value: vGenMap([{ key: vParty(MERCHANT), value: vParty(SENDER) }]),
        },
      ],
    });
    expect(() => assertPreparedTransferMatches(benign, EXPECT)).not.toThrow();
  });
});
