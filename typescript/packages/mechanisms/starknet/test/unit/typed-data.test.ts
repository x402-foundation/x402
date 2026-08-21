import { describe, it, expect } from "vitest";
import { OutsideExecutionVersion, outsideExecution, typedData as snTypedData } from "starknet";
import {
  buildTransferCall,
  parseOutsideExecution,
  buildCanonicalOutsideExecutionTypedData,
  chainIdToFelt,
  OUTSIDE_EXECUTION_TYPES,
  type OutsideExecutionMessage,
} from "../../src/typed-data";
import { ANY_CALLER } from "../../src/constants";

describe("canonical typed data - interop known-answer", () => {
  // The SNIP-12 message hash is the interop contract: every conformant client,
  // facilitator, and account must compute the same one. Lock our reconstruction
  // to starknet.js's own SNIP-9 v2 builder so any drift in a type string, field
  // order, or domain value fails loudly here instead of onchain.
  it("hashes identically to starknet.js's own outsideExecution.getTypedData", () => {
    const chainId = "0x534e5f5345504f4c4941";
    const payer = "0x03f16efeb2ae57f7d8befb03af08a3a370562dde15149c3506ac2038ffa9be24";
    const caller = "0x05f2e02acd59f37f1e19da7ea1db6bf31d49e6e5ba66a7f1c2f0e2ba1be36f81";
    const nonce = "0x71b7b5";
    const call = {
      contractAddress: "0x0512feac6339ff7889822cb5aa2a86c848e9d392bb0e3e237c008674feed8343",
      entrypoint: "transfer",
      calldata: [
        "0x02dd1b492765c064eac4039e3841aa5f382773b598097a40073bd8b48170ab57",
        "0x2710",
        "0x0",
      ],
    };

    const theirs = outsideExecution.getTypedData(
      chainId,
      { caller, nonce, execute_after: 1, execute_before: 2_000_000_000 },
      nonce,
      [call],
      OutsideExecutionVersion.V2,
    );
    const ours = buildCanonicalOutsideExecutionTypedData(chainId, {
      Caller: caller,
      Nonce: nonce,
      "Execute After": 1,
      "Execute Before": 2_000_000_000,
      Calls: [
        {
          To: call.contractAddress,
          Selector: "0x83afd3f4caedc6eebf44246fe54e38c95e3179a5ec9ea81740eca5b482d12e",
          Calldata: call.calldata,
        },
      ],
    });

    expect(snTypedData.getMessageHash(ours, payer)).toBe(snTypedData.getMessageHash(theirs, payer));
    // Pinned value so a lockstep change in BOTH builders (e.g. a starknet.js
    // regression) is still caught.
    expect(snTypedData.getMessageHash(ours, payer)).toBe(
      "0x2c57d2f7ae807751d47a9bc4972fd721e15a796759e7053c047388c018f3573",
    );
  });
});

describe("buildTransferCall", () => {
  it("builds a correct SNIP-2 transfer call", () => {
    const call = buildTransferCall("0x123", "0x456", "1000");
    expect(call).toEqual({
      contractAddress: "0x123",
      entrypoint: "transfer",
      calldata: ["0x456", "1000", "0"],
    });
  });

  it("splits u256 limbs for amounts >= 2^128", () => {
    const amount = ((2n << 128n) + 5n).toString();
    const call = buildTransferCall("0x123", "0x456", amount);
    expect(call.calldata[1]).toBe("5");
    expect(call.calldata[2]).toBe("2");
  });

  it("preserves exact address values", () => {
    const token = "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7";
    const recipient = "0x0512feAc6339Ff7889822cb5aA2a86C848e9D392bB0E3E237C008674feeD8343";
    const call = buildTransferCall(token, recipient, "500");
    expect(call.contractAddress).toBe(token);
    expect(call.calldata[0]).toBe(recipient);
  });
});

describe("chainIdToFelt", () => {
  it("parses hex chain ids", () => {
    expect(chainIdToFelt("0x534e5f5345504f4c4941")).toBe(BigInt("0x534e5f5345504f4c4941"));
  });

  it("parses decimal chain ids", () => {
    expect(chainIdToFelt("42")).toBe(42n);
  });

  it("encodes short-string chain ids to the same felt", () => {
    expect(chainIdToFelt("SN_SEPOLIA")).toBe(BigInt("0x534e5f5345504f4c4941"));
    expect(chainIdToFelt("SN_MAIN")).toBe(BigInt("0x534e5f4d41494e"));
  });
});

/**
 * A structurally-valid OutsideExecution message. Caller is left to each test:
 * the canonical builder does not enforce the caller binding (the facilitator
 * does), so ANY_CALLER is fine as a neutral placeholder here.
 */
function validMessage(): OutsideExecutionMessage {
  return {
    Caller: ANY_CALLER,
    Nonce: "0x71b7b56b17c8e0f4dcd0d9427c30d0a8bfa3c53f4d95a3b26f6cf14f3d0f8e2",
    "Execute After": "1",
    "Execute Before": "1893456000",
    Calls: [
      {
        To: "0x0512feac6339ff7889822cb5aa2a86c848e9d392bb0e3e237c008674feed8343",
        Selector: "0x0083afd3f4caedc6eebf44246fe54e38c95e3179a5ec9ea81740eca5b482d12e",
        Calldata: [
          "0x2dd1b492765c064eac4039e3841aa5f382773b598097a40073bd8b48170ab57",
          "0x2710",
          "0x0",
        ],
      },
    ],
  };
}

describe("buildCanonicalOutsideExecutionTypedData", () => {
  const chainId = "0x534e5f5345504f4c4941";

  it("emits the canonical SNIP-9 v2 / SNIP-12 rev 1 domain and types", () => {
    const td = buildCanonicalOutsideExecutionTypedData(chainId, validMessage());
    expect(td.primaryType).toBe("OutsideExecution");
    expect(td.types).toBe(OUTSIDE_EXECUTION_TYPES);
    expect(td.domain).toEqual({
      name: "Account.execute_from_outside",
      version: "2",
      chainId,
      revision: "1",
    });
  });

  // Hex, not decimal. The SNIP-12 hash is the same either way, but a SNIP-29
  // paymaster parses these fields as hex when rebuilding the onchain calldata,
  // and misparses a decimal string - the account then recomputes a different
  // hash and rejects the signature. Verified against a live paymaster.
  it("emits every felt in hex", () => {
    const message = validMessage();
    message["Execute After"] = 1;
    message["Execute Before"] = 1893456000;
    const td = buildCanonicalOutsideExecutionTypedData(chainId, message);
    expect(td.message["Execute After"]).toBe("0x1");
    expect(td.message["Execute Before"]).toBe("0x70dbd880");
    expect(td.message.Calls[0].Calldata.every(c => /^0x[0-9a-f]+$/.test(c))).toBe(true);
  });

  it("hashes identically whether the caller supplied decimal or hex", () => {
    const dec = validMessage();
    dec["Execute After"] = 1;
    dec["Execute Before"] = 1893456000;
    const hex = validMessage();
    hex["Execute After"] = "0x1";
    hex["Execute Before"] = "0x70dbd880";
    const a = buildCanonicalOutsideExecutionTypedData(chainId, dec);
    const b = buildCanonicalOutsideExecutionTypedData(chainId, hex);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("round-trips through parseOutsideExecution", () => {
    const td = buildCanonicalOutsideExecutionTypedData(chainId, validMessage());
    const parsed = parseOutsideExecution(td);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.chainId).toBe(chainId);
      expect(BigInt(parsed.message.Calls[0].To)).toBe(BigInt(validMessage().Calls[0].To));
    }
  });
});

describe("parseOutsideExecution", () => {
  const chainId = "0x534e5f5345504f4c4941";

  it("accepts canonical typed data", () => {
    const td = buildCanonicalOutsideExecutionTypedData(chainId, validMessage());
    const parsed = parseOutsideExecution(td);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.chainId).toBe(chainId);
      expect(parsed.message.Calls).toHaveLength(1);
    }
  });

  it("rejects non-objects and wrong primaryType", () => {
    expect(parseOutsideExecution(null).ok).toBe(false);
    expect(parseOutsideExecution({ some: "data" }).ok).toBe(false);
    const td = buildCanonicalOutsideExecutionTypedData(chainId, validMessage()) as {
      primaryType: string;
    };
    td.primaryType = "Other";
    expect(parseOutsideExecution(td).ok).toBe(false);
  });

  it("rejects unknown keys in message", () => {
    const td = buildCanonicalOutsideExecutionTypedData(chainId, validMessage());
    (td.message as Record<string, unknown>)["Extra Field"] = "0x1";
    expect(parseOutsideExecution(td).ok).toBe(false);
  });

  it("rejects missing message keys", () => {
    const td = buildCanonicalOutsideExecutionTypedData(chainId, validMessage());
    delete (td.message as Record<string, unknown>)["Nonce"];
    expect(parseOutsideExecution(td).ok).toBe(false);
  });

  it("rejects unknown keys in domain", () => {
    const td = buildCanonicalOutsideExecutionTypedData(chainId, validMessage());
    (td.domain as Record<string, unknown>)["extra"] = "x";
    expect(parseOutsideExecution(td).ok).toBe(false);
  });

  it("rejects SNIP-9 v1 domains", () => {
    const td = buildCanonicalOutsideExecutionTypedData(chainId, validMessage());
    (td.domain as Record<string, unknown>).version = "1";
    const parsed = parseOutsideExecution(td);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toContain("v1");
  });

  it("rejects unknown keys inside a Call", () => {
    const td = buildCanonicalOutsideExecutionTypedData(chainId, validMessage());
    (td.message.Calls[0] as unknown as Record<string, unknown>)["Sneaky"] = "0x1";
    expect(parseOutsideExecution(td).ok).toBe(false);
  });

  it("rejects non-felt calldata entries", () => {
    // Three elements on purpose: with fewer, the length check fires first and
    // this test would pass without ever reaching the felt scan it is named for.
    const td = buildCanonicalOutsideExecutionTypedData(chainId, validMessage());
    (td.message.Calls[0] as { Calldata: string[] }).Calldata = ["not-a-felt", "0x2710", "0x0"];
    const parsed = parseOutsideExecution(td);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toContain("invalid Call calldata");
  });
});

describe("parseOutsideExecution - chainId well-formedness", () => {
  const chainId = "0x534e5f5345504f4c4941";

  const withChainId = (value: unknown) => {
    const td = buildCanonicalOutsideExecutionTypedData(chainId, {
      Caller: "0x1",
      Nonce: "0x2",
      "Execute After": "1",
      "Execute Before": "2000000000",
      Calls: [{ To: "0x3", Selector: "0x4", Calldata: ["0x5", "0x6", "0x0"] }],
    });
    (td.domain as Record<string, unknown>).chainId = value;
    return td;
  };

  it("rejects an empty chainId", () => {
    expect(parseOutsideExecution(withChainId("")).ok).toBe(false);
  });

  it("rejects a non-string chainId", () => {
    expect(parseOutsideExecution(withChainId(123)).ok).toBe(false);
  });

  it("rejects an oversized chainId", () => {
    expect(parseOutsideExecution(withChainId("0x" + "a".repeat(80))).ok).toBe(false);
  });

  it("accepts the short-string form", () => {
    expect(parseOutsideExecution(withChainId("SN_SEPOLIA")).ok).toBe(true);
  });
});

describe("parseOutsideExecution - Call selector grammar", () => {
  const chainId = "0x534e5f5345504f4c4941";

  // A decimal selector compares equal numerically in rule 7, but the canonical
  // reconstruction emits hex, so the payer's account would hash a different
  // message and reject the signature. Reject it at parse instead.
  it("rejects a decimal-encoded Call selector", () => {
    const td = buildCanonicalOutsideExecutionTypedData(chainId, validMessage());
    const call = td.message.Calls[0] as { Selector: string };
    call.Selector = BigInt(call.Selector).toString(10);
    const parsed = parseOutsideExecution(td);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toContain("selector");
  });

  it("accepts the canonical hex selector", () => {
    const td = buildCanonicalOutsideExecutionTypedData(chainId, validMessage());
    expect(parseOutsideExecution(td).ok).toBe(true);
  });
});

// /verify is unauthenticated, so everything the parser touches is attacker-
// supplied and must be bounded before any signature check runs.
describe("parseOutsideExecution - pre-authentication input bounds", () => {
  const chainId = "0x534e5f5345504f4c4941";

  // Assigned onto the built object, NOT routed through the canonical builder:
  // the builder hex-normalizes every felt, so a fixture passed through it can
  // never reach the decimal branch these cases exist to cover.
  const withNonce = (nonce: unknown) => {
    const td = buildCanonicalOutsideExecutionTypedData(chainId, validMessage());
    (td.message as unknown as Record<string, unknown>).Nonce = nonce;
    return td;
  };

  it("rejects a felt string longer than any legal felt", () => {
    expect(parseOutsideExecution(withNonce("9".repeat(500_000))).ok).toBe(false);
  });

  it("accepts a 78-digit decimal felt but rejects a 79-digit one", () => {
    expect(parseOutsideExecution(withNonce("1".repeat(78))).ok).toBe(true);
    expect(parseOutsideExecution(withNonce("1".repeat(79))).ok).toBe(false);
  });

  it("rejects a hex felt longer than any legal felt", () => {
    expect(parseOutsideExecution(withNonce("0x" + "a".repeat(64))).ok).toBe(true);
    expect(parseOutsideExecution(withNonce("0x" + "a".repeat(65))).ok).toBe(false);
  });

  // Past 2^53 a JSON number has already lost precision, so the felt that would
  // be hashed is not the one the client meant.
  it("rejects a number felt beyond safe-integer precision", () => {
    expect(parseOutsideExecution(withNonce(12345678901234567890)).ok).toBe(false);
  });

  it("rejects a message carrying more than one call", () => {
    const td = buildCanonicalOutsideExecutionTypedData(chainId, validMessage());
    td.message.Calls = [td.message.Calls[0], td.message.Calls[0]];
    const parsed = parseOutsideExecution(td);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toContain("exactly 1 call");
  });

  it("rejects transfer calldata that is not exactly three felts", () => {
    const td = buildCanonicalOutsideExecutionTypedData(chainId, validMessage());
    td.message.Calls[0].Calldata = [...td.message.Calls[0].Calldata, "0x0"];
    const parsed = parseOutsideExecution(td);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toContain("recipient, amount_low, amount_high");
  });
});
