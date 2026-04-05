import { describe, expect, it } from "vitest";
import type { PaymentRequired } from "@x402/core";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";

import {
  OPERATION_BINDING,
  computeOperationDigest,
  createOperationBindingInput,
  createOperationReceiptEIP712,
  createOperationReceiptJWS,
  declareOperationBindingExtension,
  extractOperationReceiptPayload,
  getOperationBindingCanonicalBytes,
  operationBindingResourceServerExtension,
  operationBindingSchema,
  verifyOperationReceiptMatchesInput,
  verifyOperationReceiptSignatureEIP712,
  verifyOperationReceiptSignatureJWS,
  type OperationBindingInfo,
} from "../src/operation-binding";
import { createES256KSigner, generateES256KKeyPair } from "./offer-receipt-test-utils";

const TEST_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;

const WEATHER_BINDING: OperationBindingInfo = {
  transport: "http",
  resourceUrl: "https://api.example.com/weather/SF",
  method: "GET",
  pathTemplate: "/weather/:city",
  operationId: "weather.getCurrent",
  policyVersion: "2026-04-04",
  canonicalization: "rfc8785-jcs",
  digestAlgorithm: "sha-256",
  bindPathParams: true,
  bindQuery: true,
  bindBody: false,
};

const SEARCH_BINDING: OperationBindingInfo = {
  transport: "http",
  resourceUrl: "https://api.example.com/search",
  method: "POST",
  pathTemplate: "/search",
  operationId: "search.run",
  policyVersion: "2026-04-04",
  canonicalization: "rfc8785-jcs",
  digestAlgorithm: "sha-256",
  bindPathParams: false,
  bindQuery: false,
  bindBody: true,
};

const OPERATION_DIGEST_VECTORS = [
  {
    name: "matches the RFC 8785 digest for weather path and query input",
    binding: WEATHER_BINDING,
    components: {
      pathParams: { city: "SF" },
      query: { units: "metric" },
    },
    digest: "fc54afe61f8ecb553a313c317bc31785def72ac348213718235077586956fd45",
  },
  {
    name: "matches the RFC 8785 digest for weather query expansion",
    binding: WEATHER_BINDING,
    components: {
      pathParams: { city: "SF" },
      query: { units: "metric", lang: "en" },
    },
    digest: "263839b2849b379b304775feb8e88724ac5b0d7f3fb418a71b197ec4a4e35618",
  },
  {
    name: "matches the RFC 8785 digest for a basic search body",
    binding: SEARCH_BINDING,
    components: {
      body: {
        query: "x402",
        limit: 10,
      },
    },
    digest: "44bb1eb7c73f954faf13b4996eaeb0f1c2b98a9cc5c4e741c5e25d3d21dc0a11",
  },
  {
    name: "matches the RFC 8785 digest for a newline-containing body",
    binding: SEARCH_BINDING,
    components: {
      body: {
        query: "line1\nline2",
        limit: 1,
      },
    },
    digest: "5caac7f75db73ddc5c662458aec0f25a58f50358c68c12a17cb7925f43291223",
  },
  {
    name: "matches the RFC 8785 digest for tab and unicode content",
    binding: SEARCH_BINDING,
    components: {
      body: {
        q: "hello\tworld",
        emoji: "caf\u00e9 \ud83d\udc22",
      },
    },
    digest: "ac24f9d26314787e218aa0ae946e94a2be76e9cc63325afcca5e3c8b00a04333",
  },
  {
    name: "matches the RFC 8785 digest when bindBody is disabled",
    binding: {
      ...SEARCH_BINDING,
      bindBody: false,
    },
    components: {
      body: {
        should: "be ignored",
      },
    },
    digest: "85d5bd39278b4dda2e79ed21bf0dd21e58399fc17c019283ac939e5cc5bd096b",
  },
  {
    name: "matches the RFC 8785 digest at the max safe integer boundary",
    binding: SEARCH_BINDING,
    components: {
      body: {
        max_safe: 9007199254740991,
      },
    },
    digest: "a1b5ce6dfecedc5adc4793aa97acf61f85107c530bf850fb3331a76f4c071177",
  },
  {
    name: "matches the RFC 8785 digest when DEL is preserved in a string",
    binding: SEARCH_BINDING,
    components: {
      body: {
        s: "a\u007fb",
      },
    },
    digest: "a73790954115b12634364b06ab3aeba5d0eaecffe0dced0daf15e9fc3f05bc9e",
  },
] as const;

describe("Operation-Binding Extension", () => {
  describe("declareOperationBindingExtension", () => {
    it("normalizes defaults for binding flags", () => {
      const declaration = declareOperationBindingExtension({
        operationId: "weather.getCurrent",
        policyVersion: "2026-04-04",
      });

      expect(declaration).toEqual({
        operationId: "weather.getCurrent",
        policyVersion: "2026-04-04",
        bindPathParams: true,
        bindQuery: true,
        bindBody: true,
      });
    });
  });

  describe("operationBindingResourceServerExtension", () => {
    it("exports the correct extension key", () => {
      expect(operationBindingResourceServerExtension.key).toBe(OPERATION_BINDING);
    });

    it("enriches PaymentRequired with HTTP-specific operation metadata", async () => {
      const declaration = declareOperationBindingExtension({
        operationId: "weather.getCurrent",
        policyVersion: "2026-04-04",
        bindBody: false,
      });

      const paymentRequired: PaymentRequired = {
        x402Version: 2,
        resource: {
          url: "https://api.example.com/weather/SF",
          description: "Weather lookup",
          mimeType: "application/json",
        },
        accepts: [],
      };

      const result = await operationBindingResourceServerExtension.enrichPaymentRequiredResponse!(
        declaration,
        {
          requirements: [],
          resourceInfo: paymentRequired.resource,
          paymentRequiredResponse: paymentRequired,
          transportContext: {
            request: {
              method: "GET",
              routePattern: "/weather/[city]",
              adapter: {
                getHeader: () => undefined,
                getMethod: () => "GET",
                getPath: () => "/weather/SF",
                getUrl: () => "https://api.example.com/weather/SF",
                getAcceptHeader: () => "application/json",
                getUserAgent: () => "vitest",
              },
              path: "/weather/SF",
              adapterMethod: "GET",
            },
          },
        } as never,
      );

      expect(result).toEqual({
        info: {
          transport: "http",
          resourceUrl: "https://api.example.com/weather/SF",
          method: "GET",
          pathTemplate: "/weather/:city",
          operationId: "weather.getCurrent",
          policyVersion: "2026-04-04",
          canonicalization: "rfc8785-jcs",
          digestAlgorithm: "sha-256",
          bindPathParams: true,
          bindQuery: true,
          bindBody: false,
        },
        schema: operationBindingSchema,
      });
    });
  });

  describe("digest computation", () => {
    it("creates a stable logical input object", () => {
      const input = createOperationBindingInput(WEATHER_BINDING, {
        pathParams: { city: "SF" },
        query: { units: "metric" },
        body: { ignored: true },
      });

      expect(input).toEqual({
        version: 1,
        transport: "http",
        resourceUrl: "https://api.example.com/weather/SF",
        method: "GET",
        pathTemplate: "/weather/:city",
        operationId: "weather.getCurrent",
        policyVersion: "2026-04-04",
        pathParams: { city: "SF" },
        query: { units: "metric" },
        body: null,
      });
    });

    it("produces identical canonical bytes regardless of object key order", () => {
      const canonicalA = getOperationBindingCanonicalBytes(WEATHER_BINDING, {
        pathParams: { city: "SF" },
        query: { units: "metric", lang: "en" },
      });
      const canonicalB = getOperationBindingCanonicalBytes(WEATHER_BINDING, {
        pathParams: { city: "SF" },
        query: { lang: "en", units: "metric" },
      });

      expect(new TextDecoder().decode(canonicalA)).toBe(new TextDecoder().decode(canonicalB));
    });

    it("produces the same digest for logically equivalent objects", async () => {
      const digestA = await computeOperationDigest(WEATHER_BINDING, {
        pathParams: { city: "SF" },
        query: { units: "metric", lang: "en" },
      });
      const digestB = await computeOperationDigest(WEATHER_BINDING, {
        pathParams: { city: "SF" },
        query: { lang: "en", units: "metric" },
      });

      expect(digestA).toBe(digestB);
    });

    it("changes the digest when a bound field changes", async () => {
      const digestA = await computeOperationDigest(WEATHER_BINDING, {
        pathParams: { city: "SF" },
        query: { units: "metric" },
      });
      const digestB = await computeOperationDigest(WEATHER_BINDING, {
        pathParams: { city: "SF" },
        query: { units: "imperial" },
      });

      expect(digestA).not.toBe(digestB);
    });

    for (const vector of OPERATION_DIGEST_VECTORS) {
      it(vector.name, async () => {
        const digest = await computeOperationDigest(vector.binding, vector.components);
        expect(digest).toBe(vector.digest);
      });
    }
  });

  describe("receipt signing and verification", () => {
    it("creates and verifies a JWS operation receipt", async () => {
      const keyPair = await generateES256KKeyPair();
      const signer = await createES256KSigner(keyPair.privateKey, "did:web:example.com#key-1");

      const receipt = await createOperationReceiptJWS(
        {
          binding: WEATHER_BINDING,
          payer: "0x857b06519E91e3A54538791bDbb0E22373e36b66",
          network: "eip155:8453",
          pathParams: { city: "SF" },
          query: { units: "metric" },
        },
        signer,
      );

      expect(receipt.format).toBe("jws");

      const extracted = extractOperationReceiptPayload(receipt);
      const verified = await verifyOperationReceiptSignatureJWS(receipt, keyPair.publicKey);

      expect(verified.operationDigest).toBe(extracted.operationDigest);
      expect(verified.operationId).toBe("weather.getCurrent");
      expect(verified.pathTemplate).toBe("/weather/:city");
    });

    it("creates and verifies an EIP-712 operation receipt", async () => {
      const account = privateKeyToAccount(TEST_PRIVATE_KEY);

      const receipt = await createOperationReceiptEIP712(
        {
          binding: {
            ...WEATHER_BINDING,
            method: "POST",
            resourceUrl: "https://api.example.com/search",
            pathTemplate: "/search",
            operationId: "search.run",
            bindPathParams: false,
            bindQuery: false,
            bindBody: true,
          },
          payer: "0x857b06519E91e3A54538791bDbb0E22373e36b66",
          network: "eip155:8453",
          body: {
            query: "x402",
            limit: 10,
          },
          issuedAt: 1775289900,
        },
        params => account.signTypedData(params),
      );

      expect(receipt.format).toBe("eip712");

      const verification = await verifyOperationReceiptSignatureEIP712(receipt);
      expect(verification.signer.toLowerCase()).toBe(account.address.toLowerCase());
      expect(verification.payload.operationId).toBe("search.run");
      expect(verification.payload.bindBody).toBe(true);
    });

    it("detects a digest mismatch when bound inputs change", async () => {
      const keyPair = await generateES256KKeyPair();
      const signer = await createES256KSigner(keyPair.privateKey, "did:web:example.com#key-1");

      const receipt = await createOperationReceiptJWS(
        {
          binding: WEATHER_BINDING,
          payer: "0x857b06519E91e3A54538791bDbb0E22373e36b66",
          network: "eip155:8453",
          pathParams: { city: "SF" },
          query: { units: "metric" },
        },
        signer,
      );

      const payload = await verifyOperationReceiptSignatureJWS(receipt, keyPair.publicKey);

      const match = await verifyOperationReceiptMatchesInput(payload, {
        pathParams: { city: "SF" },
        query: { units: "metric" },
      });
      expect(match.matches).toBe(true);

      const mismatch = await verifyOperationReceiptMatchesInput(payload, {
        pathParams: { city: "SF" },
        query: { units: "imperial" },
      });
      expect(mismatch.matches).toBe(false);
      expect(mismatch.expectedDigest).not.toBe(mismatch.actualDigest);
    });
  });
});
