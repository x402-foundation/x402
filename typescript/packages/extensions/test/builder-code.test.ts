/**
 * Tests for Builder Code Extension (ERC-8021)
 */

import { describe, it, expect } from "vitest";
import type { PaymentPayload, PaymentRequired } from "@x402/core/types";
import {
  BUILDER_CODE,
  declareBuilderCodeExtension,
  BuilderCodeClientExtension,
  BuilderCodeFacilitatorExtension,
  encodeBuilderCodeSuffix,
  parseBuilderCodeSuffixFromCalldata,
  type DataSuffixContext,
} from "../src/builder-code";

const APP = "bc_my_app";
const SERVICE = "bc_my_client";
const WALLET = "bc_my_facilitator";

/**
 * Builds a minimal PaymentRequired with an optional builder-code app declaration.
 *
 * @param appCode - Server app code; omitted when the extension should be absent
 * @returns PaymentRequired for client enrichment tests
 */
function paymentRequiredWithApp(appCode?: string): PaymentRequired {
  return {
    x402Version: 2,
    resource: { url: "https://example.com/resource" },
    accepts: [],
    extensions: appCode ? { [BUILDER_CODE]: declareBuilderCodeExtension(appCode) } : undefined,
  };
}

/**
 * Minimal payment payload for extension enrichment tests.
 *
 * @returns Base payment payload without extensions
 */
function basePayload(): PaymentPayload {
  return {
    x402Version: 2,
    resource: { url: "https://example.com/resource" },
    accepted: {
      scheme: "exact",
      network: "eip155:8453",
      amount: "1000",
      asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      payTo: "0x0000000000000000000000000000000000000001",
      maxTimeoutSeconds: 300,
      extra: {},
    },
    payload: {},
  };
}

/**
 * Builds facilitator data-suffix context from optional extension maps.
 *
 * @param overrides - Extension maps for payment payload
 * @param overrides.paymentPayloadExtensions - Client-side builder-code payload
 * @returns Context passed to BuilderCodeFacilitatorExtension.buildDataSuffix
 */
function suffixContext(overrides: {
  paymentPayloadExtensions?: Record<string, unknown>;
}): DataSuffixContext {
  return {
    paymentPayload: {
      ...basePayload(),
      extensions: overrides.paymentPayloadExtensions,
    },
    paymentRequirements: {
      scheme: "exact",
      network: "eip155:8453",
      amount: "1000",
      asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      payTo: "0x0000000000000000000000000000000000000001",
      maxTimeoutSeconds: 300,
      extra: {},
    },
  };
}

/**
 * Runs buildDataSuffix and parses attribution from synthetic calldata.
 *
 * @param ctx - Facilitator data-suffix context
 * @returns Decoded builder-code fields from the produced suffix
 */
function parsedFromFacilitator(
  ctx: DataSuffixContext,
): ReturnType<typeof parseBuilderCodeSuffixFromCalldata> {
  const ext = new BuilderCodeFacilitatorExtension({ builderCode: WALLET });
  const suffix = ext.buildDataSuffix(ctx);
  if (!suffix) {
    throw new Error("Expected builder-code suffix");
  }
  return parseBuilderCodeSuffixFromCalldata(`0xdeadbeef${suffix.slice(2)}` as `0x${string}`);
}

describe("Builder Code Extension", () => {
  describe("declareBuilderCodeExtension", () => {
    it("rejects invalid app codes", () => {
      expect(() => declareBuilderCodeExtension("INVALID")).toThrow(/Invalid builder code/);
    });
  });

  describe("BuilderCodeClientExtension", () => {
    it("rejects invalid service codes", () => {
      expect(() => new BuilderCodeClientExtension("Bad-Code")).toThrow(/Invalid builder code/);
    });

    it("rejects when any code in an array is invalid", () => {
      expect(() => new BuilderCodeClientExtension([SERVICE, "Bad-Code"])).toThrow(
        /Invalid builder code/,
      );
    });

    it("attaches service code for core extension merging", async () => {
      const client = new BuilderCodeClientExtension(SERVICE);
      const enriched = await client.enrichPaymentPayload!(
        basePayload(),
        paymentRequiredWithApp(APP),
      );

      expect(enriched.extensions?.[BUILDER_CODE]).toEqual({ info: { s: [SERVICE] } });
    });

    it("attaches multiple service codes when given an array", async () => {
      const client = new BuilderCodeClientExtension([SERVICE, "bc_other"]);
      const enriched = await client.enrichPaymentPayload!(
        basePayload(),
        paymentRequiredWithApp(APP),
      );

      expect(enriched.extensions?.[BUILDER_CODE]).toEqual({ info: { s: [SERVICE, "bc_other"] } });
    });

    it("attaches only service code when server omits builder-code", async () => {
      const client = new BuilderCodeClientExtension(SERVICE);
      const enriched = await client.enrichPaymentPayload!(basePayload(), paymentRequiredWithApp());

      expect(enriched.extensions?.[BUILDER_CODE]).toEqual({ info: { s: [SERVICE] } });
    });

    it("leaves server info preservation to core extension merging", async () => {
      const client = new BuilderCodeClientExtension(SERVICE);
      const paymentRequired: PaymentRequired = {
        x402Version: 2,
        resource: { url: "https://example.com/resource" },
        accepts: [],
        extensions: {
          [BUILDER_CODE]: { info: { a: 123 }, schema: {} },
        },
      };

      const enriched = await client.enrichPaymentPayload!(basePayload(), paymentRequired);
      expect(enriched.extensions?.[BUILDER_CODE]).toEqual({ info: { s: [SERVICE] } });
    });

    it("preserves unrelated payload extensions", async () => {
      const client = new BuilderCodeClientExtension(SERVICE);
      const payload = {
        ...basePayload(),
        extensions: { other: { kept: true } },
      };

      const enriched = await client.enrichPaymentPayload!(payload, paymentRequiredWithApp(APP));

      expect(enriched.extensions?.other).toEqual({ kept: true });
      expect(enriched.extensions?.[BUILDER_CODE]).toEqual({ info: { s: [SERVICE] } });
    });
  });

  describe("BuilderCodeFacilitatorExtension", () => {
    it("rejects invalid wallet codes", () => {
      expect(() => new BuilderCodeFacilitatorExtension({ builderCode: "X" })).toThrow(
        /Invalid builder code/,
      );
    });

    it("encodes the facilitator wallet code when configured", () => {
      const parsed = parsedFromFacilitator(suffixContext({}));
      expect(parsed).toEqual({ w: WALLET });
    });

    it("allows the facilitator wallet code to be omitted", () => {
      const ext = new BuilderCodeFacilitatorExtension();
      const suffix = ext.buildDataSuffix(
        suffixContext({
          paymentPayloadExtensions: {
            [BUILDER_CODE]: { info: { a: APP, s: SERVICE }, schema: {} },
          },
        }),
      );
      if (!suffix) {
        throw new Error("Expected builder-code suffix");
      }

      const parsed = parseBuilderCodeSuffixFromCalldata(
        `0xdeadbeef${suffix.slice(2)}` as `0x${string}`,
      );
      expect(parsed).toEqual({ a: APP, s: [SERVICE] });
    });

    it("omits the settlement suffix when no attribution is present", () => {
      const ext = new BuilderCodeFacilitatorExtension();
      expect(ext.buildDataSuffix(suffixContext({}))).toBeUndefined();
    });

    it("uses spec-shaped client app code and service code", () => {
      const parsed = parsedFromFacilitator(
        suffixContext({
          paymentPayloadExtensions: {
            [BUILDER_CODE]: { info: { a: APP, s: SERVICE }, schema: {} },
          },
        }),
      );

      expect(parsed).toEqual({ w: WALLET, a: APP, s: [SERVICE] });
    });

    it("encodes all valid entries from a service code array and drops invalid ones", () => {
      const parsed = parsedFromFacilitator(
        suffixContext({
          paymentPayloadExtensions: {
            [BUILDER_CODE]: { info: { s: ["INVALID", SERVICE, "bc_other"] }, schema: {} },
          },
        }),
      );

      expect(parsed).toEqual({ w: WALLET, s: [SERVICE, "bc_other"] });
    });

    it("truncates service codes to the first 5 valid entries", () => {
      const codes = ["bc_1", "bc_2", "bc_3", "bc_4", "bc_5", "bc_6", "bc_7"];
      const parsed = parsedFromFacilitator(
        suffixContext({
          paymentPayloadExtensions: {
            [BUILDER_CODE]: { info: { s: codes }, schema: {} },
          },
        }),
      );

      expect(parsed).toEqual({ w: WALLET, s: ["bc_1", "bc_2", "bc_3", "bc_4", "bc_5"] });
    });

    it("filters invalid service codes before truncating to 5", () => {
      const parsed = parsedFromFacilitator(
        suffixContext({
          paymentPayloadExtensions: {
            [BUILDER_CODE]: {
              info: {
                s: ["INVALID", "bc_1", "bc_2", "bc_3", "bc_4", "bc_5", "bc_6", "bc_7", "bc_8"],
              },
              schema: {},
            },
          },
        }),
      );

      expect(parsed).toEqual({ w: WALLET, s: ["bc_1", "bc_2", "bc_3", "bc_4", "bc_5"] });
    });

    it("ignores invalid client service codes", () => {
      const parsed = parsedFromFacilitator(
        suffixContext({
          paymentPayloadExtensions: {
            [BUILDER_CODE]: { info: { s: "Also_Invalid" }, schema: {} },
          },
        }),
      );

      expect(parsed).toEqual({ w: WALLET });
    });

    it("reads app code from the client payload extension", () => {
      const parsed = parsedFromFacilitator(
        suffixContext({
          paymentPayloadExtensions: {
            [BUILDER_CODE]: { info: { a: APP }, schema: {} },
          },
        }),
      );

      expect(parsed).toEqual({ w: WALLET, a: APP });
    });
  });

  describe("suffix encode and parse", () => {
    it("round-trips all attribution fields through calldata", () => {
      const suffix = encodeBuilderCodeSuffix({ a: APP, w: WALLET, s: SERVICE });
      const calldata = `0xdeadbeef${suffix.slice(2)}` as `0x${string}`;

      expect(parseBuilderCodeSuffixFromCalldata(calldata)).toEqual({
        a: APP,
        w: WALLET,
        s: [SERVICE],
      });
    });

    it("round-trips multiple service codes through calldata", () => {
      const suffix = encodeBuilderCodeSuffix({ a: APP, w: WALLET, s: [SERVICE, "bc_other"] });
      const calldata = `0xdeadbeef${suffix.slice(2)}` as `0x${string}`;

      expect(parseBuilderCodeSuffixFromCalldata(calldata)).toEqual({
        a: APP,
        w: WALLET,
        s: [SERVICE, "bc_other"],
      });
    });

    it("returns undefined when calldata has no ERC-8021 suffix", () => {
      expect(parseBuilderCodeSuffixFromCalldata("0xdeadbeef")).toBeUndefined();
    });
  });
});
