import { describe, expect, it } from "vitest";

import {
  deriveScriptHashHex,
  scriptAddressMatches,
} from "../../src/exact/facilitator/scriptAddress";
import { MAX_CARDANO_SCRIPT_BYTES, MAX_CARDANO_SCRIPT_PARAMETERS } from "../../src/limits";
import type { CardanoExtraScript } from "../../src/types";
import { freshPreprodAddress, MINIMAL_PLUTUS_V3, scriptAddressFor } from "../helpers/stubs";

// Minimal always-succeeds Plutus script (raw flat-encoded bytes).
const CODE = MINIMAL_PLUTUS_V3;

describe("scriptAddressMatches", () => {
  // Ground-truth script address/hash derived directly (no parameter application);
  // the inline-code test below anchors that the reconstruction path matches.
  const { address: addr, scriptHash: hash } = scriptAddressFor(CODE);

  it("matches when payTo is the script address reconstructed from inline code", () => {
    // Anchors correctness: the applyParamsToScript([]) + unwrap path must yield
    // the same hash as hashing the raw script directly.
    const extra: CardanoExtraScript = {
      assetTransferMethod: "script",
      script: { type: "plutusV3", code: CODE },
    };
    expect(scriptAddressMatches(extra, addr)).toBe(true);
  });

  it("matches when only scriptHash is supplied", () => {
    const extra: CardanoExtraScript = { assetTransferMethod: "script", scriptHash: hash };
    expect(scriptAddressMatches(extra, addr)).toBe(true);
  });

  it("rejects a non-script (key-credential) payTo", async () => {
    const keyAddr = await freshPreprodAddress();
    const extra: CardanoExtraScript = { assetTransferMethod: "script", scriptHash: hash };
    expect(scriptAddressMatches(extra, keyAddr)).toBe(false);
  });

  it("rejects a mismatched scriptHash", () => {
    const extra: CardanoExtraScript = {
      assetTransferMethod: "script",
      scriptHash: "00".repeat(28),
    };
    expect(scriptAddressMatches(extra, addr)).toBe(false);
  });

  it("is parameter-sensitive: applying a parameter no longer matches the bare address", () => {
    const extra: CardanoExtraScript = {
      assetTransferMethod: "script",
      script: { type: "plutusV3", code: CODE },
      parameters: { p1: { value: "42", type: "bigint" } },
    };
    expect(scriptAddressMatches(extra, addr)).toBe(false);
  });

  it("rejects when neither script nor scriptHash is supplied", () => {
    const extra = { assetTransferMethod: "script" } as CardanoExtraScript;
    expect(scriptAddressMatches(extra, addr)).toBe(false);
  });

  it("rejects oversized scripts and parameter sets before applying them", () => {
    expect(
      scriptAddressMatches(
        {
          assetTransferMethod: "script",
          script: { type: "plutusV3", code: "00".repeat(MAX_CARDANO_SCRIPT_BYTES + 1) },
        },
        addr,
      ),
    ).toBe(false);
    const parameters = Object.fromEntries(
      Array.from({ length: MAX_CARDANO_SCRIPT_PARAMETERS + 1 }, (_, index) => [
        `p${index}`,
        { type: "integer" as const, value: "1" },
      ]),
    );
    expect(
      scriptAddressMatches(
        { assetTransferMethod: "script", script: { type: "plutusV3", code: CODE }, parameters },
        addr,
      ),
    ).toBe(false);
  });

  it("rejects unsafe or non-canonical integer parameters", () => {
    for (const value of [1.5, Number.MAX_SAFE_INTEGER + 1, "01", "1e3", "+1", "-0"]) {
      expect(() =>
        deriveScriptHashHex({
          assetTransferMethod: "script",
          script: { type: "plutusV3", code: CODE },
          parameters: { p1: { type: "integer", value } },
        }),
      ).toThrow(/integer parameter/);
    }
  });

  it("accepts canonical signed integer parameters", () => {
    expect(
      deriveScriptHashHex({
        assetTransferMethod: "script",
        script: { type: "plutusV3", code: CODE },
        parameters: { p1: { type: "integer", value: "-42" } },
      }),
    ).toMatch(/^[0-9a-f]{56}$/);
  });
});
