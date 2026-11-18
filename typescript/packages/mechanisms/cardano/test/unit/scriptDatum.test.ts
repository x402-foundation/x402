import { Data } from "@evolution-sdk/evolution";
import { describe, expect, it } from "vitest";

import type { CardanoExtraScript } from "../../src/types";
import { buildScriptDatumInline } from "../../src/exact/script/datum";
import { MAX_CARDANO_DATUM_BYTES } from "../../src/limits";

/** Builds a script `extra` block with the supplied optional datum. */
function scriptExtra(datum?: string): CardanoExtraScript {
  return { assetTransferMethod: "script", scriptHash: "ab".repeat(28), datum };
}

describe("buildScriptDatumInline", () => {
  it("returns undefined when no datum is supplied (script needs no datum)", () => {
    expect(buildScriptDatumInline(scriptExtra())).toBeUndefined();
  });

  it("wraps the supplied CBOR hex as an inline datum, preserving it exactly", () => {
    // A representative contract datum: Constr 0 [42, 0xdeadbeef].
    const hex = Data.toCBORHex(Data.constr(0n, [Data.int(42n), Data.bytearray("deadbeef")]));
    const inline = buildScriptDatumInline(scriptExtra(hex));
    expect(inline).toBeDefined();
    // The wrapped datum must round-trip back to the exact bytes the server sent,
    // so the funds land at the contract with the datum it expects.
    expect(Data.toCBORHex(inline!.data)).toBe(hex);
  });

  it("throws on an empty datum string", () => {
    expect(() => buildScriptDatumInline(scriptExtra(""))).toThrow(/non-empty CBOR hex/);
  });

  it("throws on a datum that is not valid CBOR hex", () => {
    expect(() => buildScriptDatumInline(scriptExtra("zznothex"))).toThrow(/not valid CBOR hex/);
  });

  it("rejects an oversized datum before decoding CBOR", () => {
    expect(() =>
      buildScriptDatumInline(scriptExtra("00".repeat(MAX_CARDANO_DATUM_BYTES + 1))),
    ).toThrow(/non-empty CBOR hex/);
  });
});
