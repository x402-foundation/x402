/**
 * Tests for Swap Settlement Extension
 */

import { describe, it, expect } from "vitest";
import { encodeFunctionData, toFunctionSelector, verifyTypedData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  SWAP_SETTLEMENT,
  SWAP_SETTLEMENT_KEY,
  CANONICAL_PERMIT2_ADDRESS,
  SWAP_WITNESS_TYPE_STRING,
  jcsSerialize,
  computeRequirementsHash,
  computeQuoteIdHash,
  deriveEip3009Nonce,
  buildQuoteRequest,
  assertRequirementsHashMatches,
  buildSwapWitness,
  buildPermit2WitnessTypedData,
  buildEip3009TypedData,
  buildIntentTypedData,
  buildSwapSettlementExtension,
  extractSwapSettlementInfo,
  extractSwapSettlementServerInfo,
  validateSwapSettlementInfo,
  declareSwapSettlementExtension,
  swapSettlementResourceServerExtension,
  swapSettlerABI,
  withSwapSettlement,
} from "../src/swap-settlement/index";
import type {
  AllowanceAuthorization,
  Eip2612Authorization,
  Eip3009Authorization,
  Permit2Authorization,
  SwapAuthorizationMethod,
  SwapQuoteResponse,
  SwapSettlementPayloadInfo,
  SwapWitness,
} from "../src/swap-settlement/types";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";

// ---------------------------------------------------------------------------
// Golden vectors (pin cross-language compatibility with the Solidity +
// backend suites — do not change).
// ---------------------------------------------------------------------------

const goldenRequirements: PaymentRequirements = {
  scheme: "exact",
  network: "eip155:8453",
  amount: "10000000",
  payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
  maxTimeoutSeconds: 60,
  asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  extra: { name: "USD Coin", version: "2" },
};

const GOLDEN_JCS =
  '{"amount":"10000000","asset":"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913","extra":{"name":"USD Coin","version":"2"},"maxTimeoutSeconds":60,"network":"eip155:8453","payTo":"0x209693Bc6afc0C5328bA36FaF03C514EF312287C","scheme":"exact"}';
const GOLDEN_REQUIREMENTS_HASH =
  "0x96e7f6618cfb269ac3e914ffaa2836a6c61befefd722909a8ff23df25a215861";
const GOLDEN_QUOTE_ID = "q_8f14e45fceea167a";
const GOLDEN_QUOTE_ID_HASH = "0x0ec5c6c5204979cad4df1caaebefd368acc5979cb6cca282942c65485cbcb9f9";
const GOLDEN_EIP3009_NONCE = "0x70a9fff73f30c7fc0c32bf61e2cd3039b8a1aa0b7e82bb1d3cfdeb488ae01d1b";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const PAYER = "0x857b06519E91e3A54538791bDbb0E22373e36b66";
const SETTLER = "0x402085c248EeA27D92E8b30b2C58ed07f9E20001";
const WETH = "0x4200000000000000000000000000000000000006" as const;
const CBBTC = "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf";
const SIGNATURE = `0x${"ab".repeat(65)}`;

// Fixed, well-known test key (anvil account 0).
const TEST_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

const quote: SwapQuoteResponse = {
  quoteId: GOLDEN_QUOTE_ID,
  requirementsHash: GOLDEN_REQUIREMENTS_HASH,
  network: "eip155:8453",
  inputAsset: WETH,
  maxAmountIn: "3021500000000000",
  settler: SETTLER,
  expiresAt: "2026-07-04T12:00:30Z",
  fees: {
    facilitatorFee: "15000000000000",
    estimatedRouteFee: "9000000000000",
  },
  authorizationMethods: [
    { method: "eip3009", ready: true },
    { method: "permit2", ready: true, spender: CANONICAL_PERMIT2_ADDRESS },
    { method: "eip2612", ready: true, spender: CANONICAL_PERMIT2_ADDRESS },
    { method: "allowance", ready: false, spender: SETTLER },
  ],
};

const wireWitness: SwapWitness = {
  quoteIdHash: GOLDEN_QUOTE_ID_HASH,
  requirementsHash: GOLDEN_REQUIREMENTS_HASH,
  payTo: goldenRequirements.payTo,
  outputAsset: goldenRequirements.asset,
  outputAmount: goldenRequirements.amount,
};

const permit2Authorization: Permit2Authorization = {
  permitted: { token: WETH, amount: "3021500000000000" },
  from: PAYER,
  spender: SETTLER,
  nonce: "33247007178036348590600198031289925668252061821958005840077069883511451257277",
  deadline: "1740672154",
  witness: wireWitness,
  signature: SIGNATURE,
};

const eip3009Authorization: Eip3009Authorization = {
  from: PAYER,
  to: SETTLER,
  value: "3021500000000000",
  validAfter: "0",
  validBefore: "1740672154",
  nonce: GOLDEN_EIP3009_NONCE,
  signature: SIGNATURE,
};

const eip2612Authorization: Eip2612Authorization = {
  owner: PAYER,
  spender: CANONICAL_PERMIT2_ADDRESS,
  value: "3021500000000000",
  nonce: "0",
  deadline: "1740672154",
  signature: SIGNATURE,
};

const allowanceAuthorization: AllowanceAuthorization = {
  from: PAYER,
  maxAmountIn: "3021500000000000",
  deadline: "1740672154",
  signature: SIGNATURE,
};

const makeInfo = (
  method: SwapAuthorizationMethod,
  authorizations: Partial<SwapSettlementPayloadInfo> = {},
): SwapSettlementPayloadInfo => ({
  version: "1",
  quoteId: GOLDEN_QUOTE_ID,
  inputAsset: WETH,
  method,
  ...authorizations,
});

const makePayload = (extensionValue: unknown): PaymentPayload =>
  ({
    x402Version: 2,
    accepted: goldenRequirements,
    payload: {},
    extensions: { [SWAP_SETTLEMENT_KEY]: extensionValue },
  }) as unknown as PaymentPayload;

describe("Swap Settlement Extension", () => {
  describe("SWAP_SETTLEMENT constant", () => {
    it("should export the correct extension identifier", () => {
      expect(SWAP_SETTLEMENT_KEY).toBe("swap-settlement");
      expect(SWAP_SETTLEMENT.key).toBe("swap-settlement");
    });
  });

  describe("jcsSerialize", () => {
    it("should sort object keys by UTF-16 code units, including nested objects", () => {
      expect(jcsSerialize({ b: { d: 1, c: 2 }, a: 3 })).toBe('{"a":3,"b":{"c":2,"d":1}}');
      // Uppercase letters sort before lowercase in UTF-16 code unit order.
      expect(jcsSerialize({ a: 1, B: 2 })).toBe('{"B":2,"a":1}');
    });

    it("should escape strings like JSON.stringify (quotes, backslash, control chars)", () => {
      expect(jcsSerialize({ 'a"b': "c\\d\ne\u0001" })).toBe('{"a\\"b":"c\\\\d\\ne\\u0001"}');
      expect(jcsSerialize("tab\there")).toBe('"tab\\there"');
    });

    it("should serialize booleans and null as literals", () => {
      expect(jcsSerialize(true)).toBe("true");
      expect(jcsSerialize(false)).toBe("false");
      expect(jcsSerialize(null)).toBe("null");
    });

    it("should emit safe integers without exponent notation and normalize -0", () => {
      expect(jcsSerialize(60)).toBe("60");
      expect(jcsSerialize(0)).toBe("0");
      expect(jcsSerialize(-0)).toBe("0");
      expect(jcsSerialize(-42)).toBe("-42");
      expect(jcsSerialize(Number.MAX_SAFE_INTEGER)).toBe("9007199254740991");
    });

    it("should serialize arrays recursively", () => {
      expect(jcsSerialize([1, "two", { b: 2, a: 1 }, true, null, []])).toBe(
        '[1,"two",{"a":1,"b":2},true,null,[]]',
      );
    });

    it("should throw on non-integer and unsafe-integer numbers", () => {
      expect(() => jcsSerialize(1.5)).toThrow(TypeError);
      expect(() => jcsSerialize(NaN)).toThrow(TypeError);
      expect(() => jcsSerialize(Infinity)).toThrow(TypeError);
      expect(() => jcsSerialize(-Infinity)).toThrow(TypeError);
      expect(() => jcsSerialize(1e21)).toThrow(TypeError);
      expect(() => jcsSerialize({ a: Number.MAX_SAFE_INTEGER + 2 })).toThrow(TypeError);
    });

    it("should throw on undefined, bigint, symbol, and function values", () => {
      expect(() => jcsSerialize(undefined)).toThrow(TypeError);
      expect(() => jcsSerialize(10n)).toThrow(TypeError);
      expect(() => jcsSerialize(Symbol("x"))).toThrow(TypeError);
      expect(() => jcsSerialize(() => 1)).toThrow(TypeError);
      expect(() => jcsSerialize({ a: undefined })).toThrow(TypeError);
    });
  });

  describe("golden vectors", () => {
    it("should serialize the golden requirements to the exact canonical form", () => {
      expect(jcsSerialize(goldenRequirements)).toBe(GOLDEN_JCS);
    });

    it("should compute the golden requirementsHash", () => {
      expect(computeRequirementsHash(goldenRequirements)).toBe(GOLDEN_REQUIREMENTS_HASH);
    });

    it("should compute the golden quoteIdHash", () => {
      expect(computeQuoteIdHash(GOLDEN_QUOTE_ID)).toBe(GOLDEN_QUOTE_ID_HASH);
    });

    it("should derive the golden EIP-3009 nonce", () => {
      expect(deriveEip3009Nonce(GOLDEN_QUOTE_ID_HASH, GOLDEN_REQUIREMENTS_HASH)).toBe(
        GOLDEN_EIP3009_NONCE,
      );
    });

    it("should reject non-bytes32 inputs when deriving the EIP-3009 nonce", () => {
      expect(() => deriveEip3009Nonce("0x1234", GOLDEN_REQUIREMENTS_HASH)).toThrow(TypeError);
      expect(() => deriveEip3009Nonce(GOLDEN_QUOTE_ID_HASH, "not-hex")).toThrow(TypeError);
    });
  });

  describe("SWAP_WITNESS_TYPE_STRING", () => {
    it("should equal the spec typestring byte-for-byte", () => {
      expect(SWAP_WITNESS_TYPE_STRING).toBe(
        "SwapWitness witness)SwapWitness(bytes32 quoteIdHash,bytes32 requirementsHash,address payTo,address outputAsset,uint256 outputAmount)TokenPermissions(address token,uint256 amount)",
      );
    });
  });

  describe("buildQuoteRequest", () => {
    it("should build the quote request body with the unmodified requirements", () => {
      const request = buildQuoteRequest(goldenRequirements, PAYER, WETH);
      expect(request).toEqual({
        x402Version: 2,
        paymentRequirements: goldenRequirements,
        payer: PAYER,
        inputAsset: WETH,
      });
    });
  });

  describe("assertRequirementsHashMatches", () => {
    it("should pass when the quoted hash matches the locally recomputed hash", () => {
      expect(() => assertRequirementsHashMatches(goldenRequirements, quote)).not.toThrow();
    });

    it("should throw when the quoted hash does not match", () => {
      const tampered = { ...quote, requirementsHash: `0x${"00".repeat(32)}` };
      expect(() => assertRequirementsHashMatches(goldenRequirements, tampered)).toThrow(
        /requirementsHash mismatch/,
      );
    });

    it("should throw when the requirements differ from the quoted ones", () => {
      const differentRequirements = { ...goldenRequirements, amount: "20000000" };
      expect(() => assertRequirementsHashMatches(differentRequirements, quote)).toThrow();
    });
  });

  describe("buildSwapWitness", () => {
    it("should derive hashes and copy delivery fields from the requirements", () => {
      const witness = buildSwapWitness(quote, goldenRequirements);
      expect(witness).toEqual({
        quoteIdHash: GOLDEN_QUOTE_ID_HASH,
        requirementsHash: GOLDEN_REQUIREMENTS_HASH,
        payTo: goldenRequirements.payTo,
        outputAsset: goldenRequirements.asset,
        outputAmount: goldenRequirements.amount,
      });
    });
  });

  describe("typed-data builders", () => {
    const account = privateKeyToAccount(TEST_PRIVATE_KEY);

    it("should build Permit2 PermitWitnessTransferFrom typed data with the witness in the right slots", async () => {
      const witness = buildSwapWitness(quote, goldenRequirements);
      const typedData = buildPermit2WitnessTypedData({
        chainId: 8453,
        settler: SETTLER,
        inputAsset: WETH,
        maxAmountIn: quote.maxAmountIn,
        nonce: permit2Authorization.nonce,
        deadline: "1740672154",
        witness,
      });

      expect(typedData.primaryType).toBe("PermitWitnessTransferFrom");
      expect(typedData.domain).toEqual({
        name: "Permit2",
        chainId: 8453,
        verifyingContract: CANONICAL_PERMIT2_ADDRESS,
      });
      expect(typedData.message.permitted).toEqual({ token: WETH, amount: 3021500000000000n });
      expect(typedData.message.spender).toBe(SETTLER);
      expect(typedData.message.nonce).toBe(BigInt(permit2Authorization.nonce));
      expect(typedData.message.deadline).toBe(1740672154n);
      expect(typedData.message.witness).toEqual({
        quoteIdHash: GOLDEN_QUOTE_ID_HASH,
        requirementsHash: GOLDEN_REQUIREMENTS_HASH,
        payTo: goldenRequirements.payTo,
        outputAsset: goldenRequirements.asset,
        outputAmount: 10000000n,
      });

      const signature = await account.signTypedData(typedData);
      const valid = await verifyTypedData({
        ...typedData,
        address: account.address,
        signature,
      });
      expect(valid).toBe(true);
    });

    it("should honor a permit2Address override", () => {
      const customPermit2 = "0x1111111111111111111111111111111111111111";
      const typedData = buildPermit2WitnessTypedData({
        chainId: 8453,
        settler: SETTLER,
        inputAsset: WETH,
        maxAmountIn: quote.maxAmountIn,
        nonce: "1",
        deadline: "1740672154",
        witness: buildSwapWitness(quote, goldenRequirements),
        permit2Address: customPermit2,
      });
      expect(typedData.domain.verifyingContract).toBe(customPermit2);
    });

    it("should build EIP-3009 ReceiveWithAuthorization typed data with the derived nonce", async () => {
      const typedData = buildEip3009TypedData({
        chainId: 8453,
        token: CBBTC,
        tokenName: "Coinbase Wrapped BTC",
        tokenVersion: "1",
        from: PAYER,
        settler: SETTLER,
        maxAmountIn: quote.maxAmountIn,
        validAfter: "0",
        validBefore: "1740672154",
        quoteIdHash: GOLDEN_QUOTE_ID_HASH,
        requirementsHash: GOLDEN_REQUIREMENTS_HASH,
      });

      expect(typedData.primaryType).toBe("ReceiveWithAuthorization");
      expect(typedData.domain).toEqual({
        name: "Coinbase Wrapped BTC",
        version: "1",
        chainId: 8453,
        verifyingContract: CBBTC,
      });
      expect(typedData.message.from).toBe(PAYER);
      expect(typedData.message.to).toBe(SETTLER);
      expect(typedData.message.value).toBe(3021500000000000n);
      expect(typedData.message.validAfter).toBe(0n);
      expect(typedData.message.validBefore).toBe(1740672154n);
      expect(typedData.message.nonce).toBe(GOLDEN_EIP3009_NONCE);

      const signature = await account.signTypedData(typedData);
      const valid = await verifyTypedData({
        ...typedData,
        address: account.address,
        signature,
      });
      expect(valid).toBe(true);
    });

    it("should build SwapSettlementIntent typed data bound to the settler domain", async () => {
      const typedData = buildIntentTypedData({
        chainId: 8453,
        settler: SETTLER,
        quoteIdHash: GOLDEN_QUOTE_ID_HASH,
        requirementsHash: GOLDEN_REQUIREMENTS_HASH,
        inputAsset: WETH,
        maxAmountIn: quote.maxAmountIn,
        deadline: "1740672154",
      });

      expect(typedData.primaryType).toBe("SwapSettlementIntent");
      expect(typedData.domain).toEqual({
        name: "x402 swap-settlement",
        version: "1",
        chainId: 8453,
        verifyingContract: SETTLER,
      });
      expect(typedData.message).toEqual({
        quoteIdHash: GOLDEN_QUOTE_ID_HASH,
        requirementsHash: GOLDEN_REQUIREMENTS_HASH,
        inputAsset: WETH,
        maxAmountIn: 3021500000000000n,
        deadline: 1740672154n,
      });

      const signature = await account.signTypedData(typedData);
      const valid = await verifyTypedData({
        ...typedData,
        address: account.address,
        signature,
      });
      expect(valid).toBe(true);
    });
  });

  describe("buildSwapSettlementExtension", () => {
    it("should wrap the info under the spec key", () => {
      const info = makeInfo("permit2", { permit2Authorization });
      const extension = buildSwapSettlementExtension(info);
      expect(extension).toEqual({ "swap-settlement": { info } });
    });
  });

  describe("extractSwapSettlementInfo", () => {
    it("should extract info from the { info: { ... } } wrapper", () => {
      const info = makeInfo("permit2", { permit2Authorization });
      const result = extractSwapSettlementInfo(makePayload({ info }));
      expect(result).not.toBeNull();
      expect(result!.quoteId).toBe(GOLDEN_QUOTE_ID);
      expect(result!.method).toBe("permit2");
      expect(result!.permit2Authorization).toEqual(permit2Authorization);
    });

    it("should return null for a bare (unwrapped) info object", () => {
      const info = makeInfo("eip3009", { eip3009Authorization });
      expect(extractSwapSettlementInfo(makePayload(info))).toBeNull();
    });

    it("should return null when no extensions", () => {
      const payload = { x402Version: 2 } as unknown as PaymentPayload;
      expect(extractSwapSettlementInfo(payload)).toBeNull();
    });

    it("should return null when the extension is missing", () => {
      const payload = { x402Version: 2, extensions: {} } as unknown as PaymentPayload;
      expect(extractSwapSettlementInfo(payload)).toBeNull();
    });

    it("should return null when base fields are missing", () => {
      const result = extractSwapSettlementInfo(
        makePayload({ info: { version: "1", quoteId: GOLDEN_QUOTE_ID } }),
      );
      expect(result).toBeNull();
    });

    it("should return null when the extension value is not an object", () => {
      expect(extractSwapSettlementInfo(makePayload("nonsense"))).toBeNull();
      expect(extractSwapSettlementInfo(makePayload([1, 2, 3]))).toBeNull();
    });
  });

  describe("extractSwapSettlementServerInfo", () => {
    it("should return the advertised info for a declared extension", () => {
      const declared = declareSwapSettlementExtension({
        quoteUrl: "https://facilitator.example.com/x402/swap/quote",
        networks: ["eip155:8453"],
      });
      const info = extractSwapSettlementServerInfo({ extensions: declared });
      expect(info).not.toBeNull();
      expect(info!.quoteUrl).toBe("https://facilitator.example.com/x402/swap/quote");
      expect(info!.networks).toEqual(["eip155:8453"]);
    });

    it("should return null when extensions are missing or malformed", () => {
      expect(extractSwapSettlementServerInfo({})).toBeNull();
      expect(extractSwapSettlementServerInfo({ extensions: {} })).toBeNull();
      expect(
        extractSwapSettlementServerInfo({ extensions: { [SWAP_SETTLEMENT_KEY]: "nonsense" } }),
      ).toBeNull();
      // Bare (unwrapped) info object is not the spec wire format.
      expect(
        extractSwapSettlementServerInfo({
          extensions: {
            [SWAP_SETTLEMENT_KEY]: { quoteUrl: "https://x.example/quote", networks: [] },
          },
        }),
      ).toBeNull();
      // Wrapped but missing required discovery fields.
      expect(
        extractSwapSettlementServerInfo({
          extensions: { [SWAP_SETTLEMENT_KEY]: { info: { quoteUrl: 42, networks: [] } } },
        }),
      ).toBeNull();
    });
  });

  describe("validateSwapSettlementInfo", () => {
    it("should accept a valid permit2 payload", () => {
      expect(validateSwapSettlementInfo(makeInfo("permit2", { permit2Authorization }))).toBe(true);
    });

    it("should accept a valid eip3009 payload", () => {
      expect(validateSwapSettlementInfo(makeInfo("eip3009", { eip3009Authorization }))).toBe(true);
    });

    it("should accept a valid eip2612 payload (spender = settler form)", () => {
      expect(validateSwapSettlementInfo(makeInfo("eip2612", { eip2612Authorization }))).toBe(true);
    });

    it("should accept a valid eip2612 payload in Permit2-bootstrap form (permit + permit2 witness)", () => {
      expect(
        validateSwapSettlementInfo(
          makeInfo("eip2612", { eip2612Authorization, permit2Authorization }),
        ),
      ).toBe(true);
    });

    it("should accept a valid allowance payload", () => {
      expect(validateSwapSettlementInfo(makeInfo("allowance", { allowanceAuthorization }))).toBe(
        true,
      );
    });

    it("should reject a missing matching authorization", () => {
      expect(validateSwapSettlementInfo(makeInfo("permit2"))).toBe(false);
      expect(validateSwapSettlementInfo(makeInfo("eip3009"))).toBe(false);
      expect(validateSwapSettlementInfo(makeInfo("eip2612"))).toBe(false);
      expect(validateSwapSettlementInfo(makeInfo("allowance"))).toBe(false);
    });

    it("should reject a wrong-method authorization", () => {
      expect(validateSwapSettlementInfo(makeInfo("permit2", { eip3009Authorization }))).toBe(false);
      expect(validateSwapSettlementInfo(makeInfo("eip3009", { permit2Authorization }))).toBe(false);
      expect(validateSwapSettlementInfo(makeInfo("eip2612", { permit2Authorization }))).toBe(false);
      expect(validateSwapSettlementInfo(makeInfo("allowance", { eip2612Authorization }))).toBe(
        false,
      );
    });

    it("should reject foreign authorization objects alongside the matching one", () => {
      expect(
        validateSwapSettlementInfo(
          makeInfo("permit2", { permit2Authorization, eip3009Authorization }),
        ),
      ).toBe(false);
      expect(
        validateSwapSettlementInfo(
          makeInfo("eip3009", { eip3009Authorization, allowanceAuthorization }),
        ),
      ).toBe(false);
      expect(
        validateSwapSettlementInfo(
          makeInfo("eip2612", { eip2612Authorization, eip3009Authorization }),
        ),
      ).toBe(false);
      expect(
        validateSwapSettlementInfo(
          makeInfo("allowance", { allowanceAuthorization, permit2Authorization }),
        ),
      ).toBe(false);
    });

    it("should reject an unknown method", () => {
      const info = makeInfo("unknown" as SwapAuthorizationMethod, { permit2Authorization });
      expect(validateSwapSettlementInfo(info)).toBe(false);
    });

    it("should reject a wrong version", () => {
      const info = {
        ...makeInfo("permit2", { permit2Authorization }),
        version: "2",
      } as unknown as SwapSettlementPayloadInfo;
      expect(validateSwapSettlementInfo(info)).toBe(false);
    });

    it("should reject an empty quoteId", () => {
      const info = { ...makeInfo("permit2", { permit2Authorization }), quoteId: "" };
      expect(validateSwapSettlementInfo(info)).toBe(false);
    });

    it("should reject an invalid inputAsset address", () => {
      const info = { ...makeInfo("permit2", { permit2Authorization }), inputAsset: "not-hex" };
      expect(validateSwapSettlementInfo(info)).toBe(false);
    });

    it("should reject a malformed authorization object", () => {
      const badNonce = { ...eip3009Authorization, nonce: "1234" };
      expect(
        validateSwapSettlementInfo(makeInfo("eip3009", { eip3009Authorization: badNonce })),
      ).toBe(false);

      const badWitness = {
        ...permit2Authorization,
        witness: { ...wireWitness, outputAmount: "not-a-number" },
      };
      expect(
        validateSwapSettlementInfo(makeInfo("permit2", { permit2Authorization: badWitness })),
      ).toBe(false);
    });
  });

  describe("declareSwapSettlementExtension", () => {
    it("should round-trip the config into the 402 extensions fragment", () => {
      const result = declareSwapSettlementExtension({
        quoteUrl: "https://facilitator.example.com/x402/swap/quote",
        networks: ["eip155:8453", "eip155:42161"],
        authorizationMethods: ["eip3009", "permit2"],
        inputAssetsUrl: "https://facilitator.example.com/x402/swap/assets",
        description: "Swap and settle.",
      });

      expect(result).toHaveProperty(SWAP_SETTLEMENT_KEY);
      const extension = result[SWAP_SETTLEMENT_KEY];
      expect(extension.info).toEqual({
        version: "1",
        description: "Swap and settle.",
        quoteUrl: "https://facilitator.example.com/x402/swap/quote",
        networks: ["eip155:8453", "eip155:42161"],
        authorizationMethods: ["eip3009", "permit2"],
        inputAssetsUrl: "https://facilitator.example.com/x402/swap/assets",
      });
    });

    it("should default to all four authorization methods and omit inputAssetsUrl", () => {
      const result = declareSwapSettlementExtension({
        quoteUrl: "https://facilitator.example.com/x402/swap/quote",
        networks: ["eip155:8453"],
      });

      const info = result[SWAP_SETTLEMENT_KEY].info;
      expect(info.version).toBe("1");
      expect(info.authorizationMethods).toEqual(["eip3009", "permit2", "eip2612", "allowance"]);
      expect(info.description).toBeTruthy();
      expect(info).not.toHaveProperty("inputAssetsUrl");
    });

    it("should include a JSON schema describing the client payload info", () => {
      const result = declareSwapSettlementExtension({
        quoteUrl: "https://facilitator.example.com/x402/swap/quote",
        networks: ["eip155:8453"],
      });

      const schema = result[SWAP_SETTLEMENT_KEY].schema!;
      expect(schema).toHaveProperty("$schema");
      expect(schema).toHaveProperty("type", "object");
      expect(schema).toHaveProperty("properties");

      const required = schema.required as string[];
      expect(required).toContain("version");
      expect(required).toContain("quoteId");
      expect(required).toContain("inputAsset");
      expect(required).toContain("method");
    });
  });
});

describe("swapSettlementResourceServerExtension", () => {
  it("marks every advertised discovery field as dynamic so payment payloads pass echo validation", () => {
    expect(swapSettlementResourceServerExtension.key).toBe(SWAP_SETTLEMENT_KEY);

    const declared = declareSwapSettlementExtension({
      quoteUrl: "https://facilitator.example.com/x402/swap/quote",
      networks: ["eip155:8453"],
      inputAssetsUrl: "https://facilitator.example.com/x402/swap/assets",
    });
    const advertisedInfo = declared[SWAP_SETTLEMENT_KEY]!.info as Record<string, unknown>;

    // Every advertised info field except the shared `version` must be listed as dynamic:
    // the client's payload replaces discovery info with payment data (spec), so any
    // non-dynamic leftover field would trip the core server's extension_echo_mismatch.
    const advertisedFields = Object.keys(advertisedInfo).filter(f => f !== "version");
    for (const field of advertisedFields) {
      expect(swapSettlementResourceServerExtension.dynamicInfoFields).toContain(field);
    }
  });
});

describe("withSwapSettlement client scheme", () => {
  const signerAccount = privateKeyToAccount(
    "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  );
  const MOCK_SETTLER = "0x1111111111111111111111111111111111111111" as const;

  const innerCalls: string[] = [];
  const inner = {
    scheme: "exact",
    createPaymentPayload: async (x402Version: number) => {
      innerCalls.push("inner");
      return { x402Version, payload: { direct: true } };
    },
  };

  const quoteFor = (reqs: PaymentRequirements, overrides: Record<string, unknown> = {}) => ({
    quoteId: "q_8f14e45fceea167a",
    requirementsHash: computeRequirementsHash(reqs),
    network: reqs.network,
    inputAsset: WETH,
    maxAmountIn: "3021500000000000",
    settler: MOCK_SETTLER,
    expiresAt: new Date(Date.now() + 45_000).toISOString(),
    fees: { facilitatorFee: "0", estimatedRouteFee: "0" },
    authorizationMethods: [{ method: "permit2", ready: true, spender: MOCK_SETTLER }],
    ...overrides,
  });

  const fetchReturning = (quoteBody: unknown): typeof fetch =>
    (async () => ({
      ok: true,
      status: 200,
      json: async () => quoteBody,
      text: async () => JSON.stringify(quoteBody),
    })) as unknown as typeof fetch;

  const declaration = declareSwapSettlementExtension({
    quoteUrl: "https://facilitator.example/x402/swap/quote",
    networks: ["eip155:8453"],
  });

  it("delegates to the inner scheme when the server does not declare the extension", async () => {
    innerCalls.length = 0;
    const scheme = withSwapSettlement(inner, signerAccount, { inputAsset: WETH });
    const result = await scheme.createPaymentPayload(2, goldenRequirements, { extensions: {} });
    expect(innerCalls).toEqual(["inner"]);
    expect(result.payload).toEqual({ direct: true });
  });

  it("delegates when the input asset equals the required asset", async () => {
    innerCalls.length = 0;
    const scheme = withSwapSettlement(inner, signerAccount, {
      inputAsset: goldenRequirements.asset as `0x${string}`,
    });
    await scheme.createPaymentPayload(2, goldenRequirements, { extensions: declaration });
    expect(innerCalls).toEqual(["inner"]);
  });

  it("delegates when the requirement's network is not in the declared networks", async () => {
    innerCalls.length = 0;
    const foreignDeclaration = declareSwapSettlementExtension({
      quoteUrl: "https://facilitator.example/x402/swap/quote",
      networks: ["eip155:42161"],
    });
    const scheme = withSwapSettlement(inner, signerAccount, { inputAsset: WETH });
    const result = await scheme.createPaymentPayload(2, goldenRequirements, {
      extensions: foreignDeclaration,
    });
    expect(innerCalls).toEqual(["inner"]);
    expect(result.payload).toEqual({ direct: true });
  });

  it("quotes, signs and attaches the swap-settlement payload automatically", async () => {
    const quoteBody = quoteFor(goldenRequirements);
    const scheme = withSwapSettlement(inner, signerAccount, {
      inputAsset: WETH,
      fetch: fetchReturning(quoteBody),
    });
    const result = await scheme.createPaymentPayload(2, goldenRequirements, {
      extensions: declaration,
    });

    expect(result.payload).toEqual({});
    const info = (result.extensions?.["swap-settlement"] as { info: SwapSettlementPayloadInfo })
      .info;
    expect(info.method).toBe("permit2");
    expect(info.quoteId).toBe(quoteBody.quoteId);
    const auth = info.permit2Authorization!;
    expect(auth.spender).toBe(MOCK_SETTLER);
    expect(auth.permitted.amount).toBe(quoteBody.maxAmountIn);
    expect(auth.witness.requirementsHash).toBe(quoteBody.requirementsHash);

    // The signature must verify against the reconstructed witness typed data
    const typedData = buildPermit2WitnessTypedData({
      chainId: 8453,
      settler: MOCK_SETTLER,
      inputAsset: WETH,
      maxAmountIn: BigInt(quoteBody.maxAmountIn),
      nonce: BigInt(auth.nonce),
      deadline: BigInt(auth.deadline),
      witness: auth.witness,
    });
    const valid = await verifyTypedData({
      ...typedData,
      address: signerAccount.address,
      signature: auth.signature as `0x${string}`,
    });
    expect(valid).toBe(true);
  });

  it("throws when permit2 is not ready instead of signing blind", async () => {
    const quoteBody = quoteFor(goldenRequirements, {
      authorizationMethods: [{ method: "permit2", ready: false, spender: MOCK_SETTLER }],
    });
    const scheme = withSwapSettlement(inner, signerAccount, {
      inputAsset: WETH,
      fetch: fetchReturning(quoteBody),
    });
    await expect(
      scheme.createPaymentPayload(2, goldenRequirements, { extensions: declaration }),
    ).rejects.toThrow(/permit2 not ready/);
  });

  it("refuses to sign when the quoted requirementsHash does not match", async () => {
    const quoteBody = quoteFor(goldenRequirements, {
      requirementsHash: computeRequirementsHash({ ...goldenRequirements, amount: "1" }),
    });
    const scheme = withSwapSettlement(inner, signerAccount, {
      inputAsset: WETH,
      fetch: fetchReturning(quoteBody),
    });
    await expect(
      scheme.createPaymentPayload(2, goldenRequirements, { extensions: declaration }),
    ).rejects.toThrow();
  });
});

describe("swapSettlerABI", () => {
  it("encodes all four settlement entrypoints against the spec-normative Quote layout", () => {
    const quote = {
      quoteIdHash: `0x${"aa".repeat(32)}`,
      requirementsHash: `0x${"bb".repeat(32)}`,
      payer: "0x857b06519E91e3A54538791bDbb0E22373e36b66",
      inputAsset: "0x4200000000000000000000000000000000000006",
      maxAmountIn: 1n,
      facilitatorFee: 0n,
      outputAsset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      outputAmount: 1n,
      payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
      swapTarget: "0x1111111111111111111111111111111111111111",
      deadline: 1n,
    } as const;
    const permit2Auth = { nonce: 1n, deadline: 1n, signature: "0x" } as const;

    // Spec-normative Quote struct field order (specs/extensions/swap_settlement.md).
    const QUOTE_TUPLE =
      "(bytes32,bytes32,address,address,uint256,uint256,address,uint256,address,address,uint256)";

    const with3009 = encodeFunctionData({
      abi: swapSettlerABI,
      functionName: "settleWith3009",
      args: [quote, { validAfter: 0n, validBefore: 1n, signature: "0x" }, "0x"],
    });
    expect(with3009.slice(0, 10)).toBe(
      toFunctionSelector(`settleWith3009(${QUOTE_TUPLE},(uint256,uint256,bytes),bytes)`),
    );

    const withPermit2 = encodeFunctionData({
      abi: swapSettlerABI,
      functionName: "settleWithPermit2",
      args: [quote, permit2Auth, "0x"],
    });
    expect(withPermit2.slice(0, 10)).toBe(
      toFunctionSelector(`settleWithPermit2(${QUOTE_TUPLE},(uint256,uint256,bytes),bytes)`),
    );

    const with2612 = encodeFunctionData({
      abi: swapSettlerABI,
      functionName: "settleWith2612",
      args: [
        quote,
        { value: 1n, deadline: 1n, r: `0x${"00".repeat(32)}`, s: `0x${"00".repeat(32)}`, v: 27 },
        permit2Auth,
        "0x",
      ],
    });
    expect(with2612.slice(0, 10)).toBe(
      toFunctionSelector(
        `settleWith2612(${QUOTE_TUPLE},(uint256,uint256,bytes32,bytes32,uint8),(uint256,uint256,bytes),bytes)`,
      ),
    );

    const withAllowance = encodeFunctionData({
      abi: swapSettlerABI,
      functionName: "settleWithAllowance",
      args: [quote, { deadline: 1n, signature: "0x" }, "0x"],
    });
    expect(withAllowance.slice(0, 10)).toBe(
      toFunctionSelector(`settleWithAllowance(${QUOTE_TUPLE},(uint256,bytes),bytes)`),
    );
  });
});
