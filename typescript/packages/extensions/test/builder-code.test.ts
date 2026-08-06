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
  MAX_CLIENT_SERVICE_CODES,
  MAX_SERVER_SERVICE_CODES,
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

    it("omits s when no service codes are given", () => {
      const declared = declareBuilderCodeExtension(APP);
      expect(declared.info).toEqual({ a: APP });
    });

    it("declares service codes when given", () => {
      const declared = declareBuilderCodeExtension(APP, ["bc_server_sdk", "bc_other"]);
      expect(declared.info).toEqual({ a: APP, s: ["bc_server_sdk", "bc_other"] });
    });

    it("declares a single service code when given a string", () => {
      const declared = declareBuilderCodeExtension(APP, "bc_server_sdk");
      expect(declared.info).toEqual({ a: APP, s: ["bc_server_sdk"] });
    });

    it("rejects invalid service codes", () => {
      expect(() => declareBuilderCodeExtension(APP, "Bad-Code")).toThrow(/Invalid builder code/);
    });

    it("rejects more than MAX_SERVER_SERVICE_CODES service codes", () => {
      const tooMany = Array.from({ length: MAX_SERVER_SERVICE_CODES + 1 }, (_, i) => `bc_${i}`);
      expect(() => declareBuilderCodeExtension(APP, tooMany)).toThrow(/Too many service codes/);
    });

    it("accepts exactly MAX_SERVER_SERVICE_CODES service codes", () => {
      const atMax = Array.from({ length: MAX_SERVER_SERVICE_CODES }, (_, i) => `bc_${i}`);
      expect(declareBuilderCodeExtension(APP, atMax).info).toEqual({ a: APP, s: atMax });
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

    it("rejects more than MAX_CLIENT_SERVICE_CODES service codes", () => {
      const tooMany = Array.from({ length: MAX_CLIENT_SERVICE_CODES + 1 }, (_, i) => `bc_${i}`);
      expect(() => new BuilderCodeClientExtension(tooMany)).toThrow(/Too many service codes/);
    });

    it("accepts exactly MAX_CLIENT_SERVICE_CODES service codes", () => {
      const atMax = Array.from({ length: MAX_CLIENT_SERVICE_CODES }, (_, i) => `bc_${i}`);
      expect(() => new BuilderCodeClientExtension(atMax)).not.toThrow();
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

    it("truncates echoed service codes to the client+server budget (10 valid entries)", () => {
      const codes = Array.from({ length: 11 }, (_, i) => `bc_${i + 1}`);
      const parsed = parsedFromFacilitator(
        suffixContext({
          paymentPayloadExtensions: {
            [BUILDER_CODE]: { info: { s: codes }, schema: {} },
          },
        }),
      );

      expect(parsed).toEqual({
        w: WALLET,
        s: Array.from({ length: 10 }, (_, i) => `bc_${i + 1}`),
      });
    });

    it("filters invalid service codes before truncating to the echoed budget", () => {
      const codes = ["INVALID", ...Array.from({ length: 12 }, (_, i) => `bc_${i + 1}`)];
      const parsed = parsedFromFacilitator(
        suffixContext({
          paymentPayloadExtensions: {
            [BUILDER_CODE]: {
              info: { s: codes },
              schema: {},
            },
          },
        }),
      );

      expect(parsed).toEqual({
        w: WALLET,
        s: Array.from({ length: 10 }, (_, i) => `bc_${i + 1}`),
      });
    });

    it("does not drop server entries when client and server each use their full reservation", () => {
      // Regression test: client provides MAX_CLIENT_SERVICE_CODES codes and server
      // provides MAX_SERVER_SERVICE_CODES codes; neither side should crowd out the other.
      const clientCodes = ["bc_c1", "bc_c2", "bc_c3", "bc_c4", "bc_c5"];
      const serverCodes = ["bc_s1", "bc_s2", "bc_s3", "bc_s4", "bc_s5"];
      const parsed = parsedFromFacilitator(
        suffixContext({
          paymentPayloadExtensions: {
            [BUILDER_CODE]: { info: { s: [...clientCodes, ...serverCodes] }, schema: {} },
          },
        }),
      );

      expect(parsed).toEqual({ w: WALLET, s: [...clientCodes, ...serverCodes] });
    });

    it("appends the facilitator's own service code after echoed codes", () => {
      const ext = new BuilderCodeFacilitatorExtension({
        builderCode: WALLET,
        serviceCode: "bc_fac",
      });
      const suffix = ext.buildDataSuffix(
        suffixContext({
          paymentPayloadExtensions: {
            [BUILDER_CODE]: { info: { s: [SERVICE] }, schema: {} },
          },
        }),
      );
      if (!suffix) {
        throw new Error("Expected builder-code suffix");
      }
      const parsed = parseBuilderCodeSuffixFromCalldata(
        `0xdeadbeef${suffix.slice(2)}` as `0x${string}`,
      );

      expect(parsed).toEqual({ w: WALLET, s: [SERVICE, "bc_fac"] });
    });

    it("does not duplicate the facilitator's service code when already echoed", () => {
      const ext = new BuilderCodeFacilitatorExtension({
        builderCode: WALLET,
        serviceCode: SERVICE,
      });
      const suffix = ext.buildDataSuffix(
        suffixContext({
          paymentPayloadExtensions: {
            [BUILDER_CODE]: { info: { s: [SERVICE] }, schema: {} },
          },
        }),
      );
      if (!suffix) {
        throw new Error("Expected builder-code suffix");
      }
      const parsed = parseBuilderCodeSuffixFromCalldata(
        `0xdeadbeef${suffix.slice(2)}` as `0x${string}`,
      );

      expect(parsed).toEqual({ w: WALLET, s: [SERVICE] });
    });

    it("rejects an invalid facilitator service code", () => {
      expect(() => new BuilderCodeFacilitatorExtension({ serviceCode: "Bad-Code" })).toThrow(
        /Invalid builder code/,
      );
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
