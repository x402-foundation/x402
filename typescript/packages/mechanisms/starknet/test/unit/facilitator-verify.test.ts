import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { hash, RpcError, typedData as snTypedData, type RpcProvider } from "starknet";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { ExactStarknetScheme } from "../../src/exact/facilitator/scheme";
import type { FacilitatorStarknetSigner } from "../../src/signer";
import {
  ANY_CALLER,
  CHAIN_IDS,
  MAX_SIGNATURE_FELTS,
  MIN_REMAINING_WINDOW_SECONDS,
  SKEW_MARGIN_SECONDS,
  STARK_PRIME,
  STARKNET_ERROR_REASONS,
  STARKNET_MAINNET_CAIP2,
  STARKNET_SEPOLIA_CAIP2,
  VALID_SIGNATURE_MAGIC,
} from "../../src/constants";
import {
  buildCanonicalOutsideExecutionTypedData,
  type OutsideExecutionMessage,
} from "../../src/typed-data";

// ---------------------------------------------------------------------------
// Core (standard x402 v2) bare reason tokens. The scheme keeps these private,
// so mirror the exact string values here; assertions use toBe on the bare token
// (human context lives in invalidMessage, checked with toContain).
// ---------------------------------------------------------------------------
const CORE = {
  INVALID_PAYLOAD: "invalid_payload",
  INVALID_SCHEME: "invalid_scheme",
  INVALID_NETWORK: "invalid_network",
  INVALID_PAYMENT_REQUIREMENTS: "invalid_payment_requirements",
  INSUFFICIENT_FUNDS: "insufficient_funds",
  INVALID_X402_VERSION: "invalid_x402_version",
  UNEXPECTED_VERIFY_ERROR: "unexpected_verify_error",
} as const;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// FEE_PAYER is the facilitator-managed address: it is the mock signer's only
// address, the requirements.extra.feePayer, AND the OutsideExecution Caller.
const FEE_PAYER = "0x05f2e02acd59f37f1e19da7ea1db6bf31d49e6e5ba66a7f1c2f0e2ba1be36f81";
const FEE_PAYER_2 = "0x0611223344556677889900aabbccddeeff112233445566778899aabbccddeeff";
const FROM = "0x03f16efeb2ae57f7d8befb03af08a3a370562dde15149c3506ac2038ffa9be24";
const PAY_TO = "0x02dd1b492765c064eac4039e3841aa5f382773b598097a40073bd8b48170ab57";
const ASSET = "0x0512feac6339ff7889822cb5aa2a86c848e9d392bb0e3e237c008674feed8343";
const OTHER = "0x04a1b2c3d4e5f60718293a4b5c6d7e8f90112233445566778899aabbccddeeff";
const SEPOLIA_CHAIN_ID = CHAIN_IDS[STARKNET_SEPOLIA_CAIP2];
const MAINNET_CHAIN_ID = CHAIN_IDS[STARKNET_MAINNET_CAIP2];
const TRANSFER_SELECTOR = hash.getSelectorFromName("transfer");
const TRANSFER_EVENT_KEY = hash.getSelectorFromName("Transfer");
const NOW = 1_800_000_000;

function makeRequirements(overrides?: Partial<PaymentRequirements>): PaymentRequirements {
  return {
    scheme: "exact",
    network: STARKNET_SEPOLIA_CAIP2,
    amount: "10000",
    payTo: PAY_TO,
    asset: ASSET,
    maxTimeoutSeconds: 300,
    extra: { feePayer: FEE_PAYER },
    ...overrides,
  };
}

function makeMessage(overrides?: Partial<OutsideExecutionMessage>): OutsideExecutionMessage {
  return {
    Caller: FEE_PAYER,
    Nonce: "0x71b7b56b17c8e0f4dcd0d9427c30d0a8bfa3c53f4d95a3b26f6cf14f3d0f8e2",
    "Execute After": "1",
    "Execute Before": String(NOW + 300),
    Calls: [
      {
        To: ASSET,
        Selector: TRANSFER_SELECTOR,
        Calldata: [PAY_TO, "0x2710", "0x0"],
      },
    ],
    ...overrides,
  };
}

function makePayload(opts?: {
  requirements?: PaymentRequirements;
  accepted?: PaymentRequirements;
  message?: OutsideExecutionMessage;
  chainId?: string;
  typedData?: unknown;
  from?: string;
  signature?: string[];
}): PaymentPayload {
  const requirements = opts?.requirements ?? makeRequirements();
  const accepted = opts?.accepted ?? requirements;
  const message = opts?.message ?? makeMessage();
  const typedData =
    opts?.typedData ??
    buildCanonicalOutsideExecutionTypedData(opts?.chainId ?? SEPOLIA_CHAIN_ID, message);
  return {
    x402Version: 2,
    accepted,
    payload: {
      from: opts?.from ?? FROM,
      outsideExecution: {
        typedData,
        signature: opts?.signature ?? ["0x1a2b", "0x3c4d"],
      },
    },
  };
}

function successfulTrace(overrides?: { events?: unknown[]; revertReason?: string }) {
  return [
    {
      transaction_trace: {
        execute_invocation: {
          revert_reason: overrides?.revertReason,
          events: overrides?.events ?? [
            {
              from_address: ASSET,
              keys: [TRANSFER_EVENT_KEY, FROM, PAY_TO],
              data: ["0x2710", "0x0"],
            },
          ],
          calls: [],
        },
      },
    },
  ];
}

interface MockOverrides {
  sigResult?: string[];
  nonceResult?: string[];
  balance?: [string, string];
  /** balanceOf reports a structured missing entry point (RpcError code 21). */
  balanceOfThrows?: boolean;
  /** balanceOf fails some other way (transient node fault). */
  balanceOfError?: unknown;
  balanceFallbackError?: unknown;
  deployed?: boolean;
  /** getClassHashAt fails some other way (transient node fault). */
  classHashError?: unknown;
  /** Restrict {@link MockOverrides.classHashError} to a single address. */
  classHashErrorAddress?: string;
  /** is_valid_signature call fails rather than returning a verdict. */
  sigError?: unknown;
  /** is_valid_outside_execution_nonce call fails rather than returning a verdict. */
  nonceError?: unknown;
  simulate?: (invocations: unknown[]) => unknown;
}

interface MockProvider {
  calls: string[];
  simulatedSenders: string[];
  /** Calldata each entry point was called with, for canonicalization assertions. */
  calldataByEntrypoint: Record<string, string[]>;
  provider: RpcProvider;
}

/**
 * A real node rejects an unpinned read: starknet.js's default `pending` tag no
 * longer exists in RPC 0.9+. Modelling it is what makes a lost block pin fail.
 *
 * @param block - The block identifier the call was made with
 */
function requirePinnedRead(block: string | undefined): void {
  if (!block) throw new Error("Invalid block id: read was not pinned");
}

/** Mock RPC: valid signature, unused nonce, sufficient balance, deployed account, clean simulation. */
function mockProvider(overrides: MockOverrides = {}): MockProvider {
  const calls: string[] = [];
  const simulatedSenders: string[] = [];
  const calldataByEntrypoint: Record<string, string[]> = {};
  const provider = {
    async callContract(
      { entrypoint, calldata }: { entrypoint: string; calldata?: string[] },
      block?: string,
    ) {
      requirePinnedRead(block);
      calls.push(entrypoint);
      if (calldata) calldataByEntrypoint[entrypoint] = calldata;
      if (entrypoint === "is_valid_signature") {
        if (overrides.sigError) throw overrides.sigError;
        return overrides.sigResult ?? [VALID_SIGNATURE_MAGIC];
      }
      if (entrypoint === "is_valid_outside_execution_nonce") {
        if (overrides.nonceError) throw overrides.nonceError;
        return overrides.nonceResult ?? ["0x1"];
      }
      if (entrypoint === "balanceOf") {
        // A real node reports a missing entry point as a STRUCTURED RpcError
        // (code 21). That is the only signal that justifies trying the other
        // spelling; a plain fault must not be able to masquerade as one.
        if (overrides.balanceOfThrows) {
          throw new RpcError({ code: 21, message: "entry point not found" } as never);
        }
        if (overrides.balanceOfError) throw overrides.balanceOfError;
        return overrides.balance ?? ["0x2710", "0x0"];
      }
      if (entrypoint === "balance_of") {
        if (overrides.balanceFallbackError) throw overrides.balanceFallbackError;
        return overrides.balance ?? ["0x2710", "0x0"];
      }
      throw new Error(`unexpected entrypoint ${entrypoint}`);
    },
    async getClassHashAt(address: string, block?: string) {
      requirePinnedRead(block);
      // A real node reports an undeployed address as a STRUCTURED RpcError
      // (code 20), which is what distinguishes it from an unreachable node.
      if (overrides.deployed === false) {
        throw new RpcError({ code: 20, message: "contract not found" } as never);
      }
      if (
        overrides.classHashError &&
        (overrides.classHashErrorAddress === undefined ||
          BigInt(overrides.classHashErrorAddress) === BigInt(address))
      ) {
        throw overrides.classHashError;
      }
      return "0x123";
    },
    async getNonceForAddress(_address: string, block?: string) {
      requirePinnedRead(block);
      return "0x5";
    },
    async getContractVersion(
      _address: string,
      classHash?: undefined,
      options?: { blockIdentifier?: string },
    ) {
      // A real node rejects an unpinned read ("Invalid block id"), and the block
      // id is the THIRD argument - passing it second lands in `classHash` and is
      // silently ignored. Model that here so the mock cannot hide it.
      if (classHash !== undefined) throw new Error("block id passed in the classHash slot");
      if (!options?.blockIdentifier) throw new Error("Invalid block id: read was not pinned");
      return { cairo: "1" };
    },
    async getSimulateTransaction(invocations: unknown[], opts?: { blockIdentifier?: string }) {
      requirePinnedRead(opts?.blockIdentifier);
      const sender = (invocations[0] as { contractAddress: string }).contractAddress;
      simulatedSenders.push(sender);
      if (overrides.simulate) return overrides.simulate(invocations);
      return successfulTrace();
    },
  };
  return {
    calls,
    simulatedSenders,
    calldataByEntrypoint,
    provider: provider as unknown as RpcProvider,
  };
}

/**
 * A forwarder-style signer: it announces feePayers but holds keys for none of
 * them, so it can originate no transaction (the SNIP-29 paymaster shape).
 */
function makeSigner(addresses: readonly string[] = [FEE_PAYER]): FacilitatorStarknetSigner {
  return {
    getAddresses: () => addresses,
    executeFromOutside: async () => ({ transactionHash: "0xabc" }),
  };
}

/**
 * A direct-executor signer: the announced feePayer is its own account, so it
 * can originate the full execute_from_outside_v2 call tree.
 */
function makeAccountSigner(addresses: readonly string[] = [FEE_PAYER]): FacilitatorStarknetSigner {
  return {
    ...makeSigner(addresses),
    getOriginationSenders: () => addresses,
  };
}

function facilitatorWith(mock: MockProvider, signer: FacilitatorStarknetSigner = makeSigner()) {
  return new ExactStarknetScheme(signer, { providerFactory: () => mock.provider });
}

// The verify path performs no setTimeout-based waits, so fake timers only pin
// Date.now() to a fixed epoch - every time-window fixture is expressed relative
// to NOW deterministically.
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW * 1000);
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// getExtra / getSigners
// ---------------------------------------------------------------------------

describe("ExactStarknetScheme facilitator - getExtra / getSigners", () => {
  it("advertises the feePayer via getExtra", () => {
    const facilitator = new ExactStarknetScheme(makeSigner());
    expect(facilitator.getExtra(STARKNET_SEPOLIA_CAIP2)).toEqual({ feePayer: FEE_PAYER });
  });

  it("returns the managed feePayer addresses via getSigners", () => {
    const facilitator = new ExactStarknetScheme(makeSigner([FEE_PAYER, FEE_PAYER_2]));
    expect(facilitator.getSigners(STARKNET_SEPOLIA_CAIP2)).toEqual([FEE_PAYER, FEE_PAYER_2]);
  });

  // extra.feePayer is REQUIRED on every Starknet exact kind, and core advertises
  // the kind whatever getExtra returns - so a signer that can commit to no
  // address must be rejected at construction, not silently produce an
  // unsignable 402.
  it("refuses to construct when the signer announces no feePayer", () => {
    expect(() => new ExactStarknetScheme(makeSigner([]))).toThrow(
      /must announce at least one feePayer/,
    );
  });

  // A misconfigured bound must fail at startup, not at the first payment.
  it.each([0, -1, 1.5, Number.NaN])("rejects an invalid maxSignatureFelts (%s)", felts => {
    expect(() => new ExactStarknetScheme(makeSigner(), { maxSignatureFelts: felts })).toThrow(
      /maxSignatureFelts must be a positive integer/,
    );
  });

  it.each([0, -1, 1.5, 2_147_483_648])("rejects an invalid rpcTimeoutMs (%s)", ms => {
    expect(() => new ExactStarknetScheme(makeSigner(), { rpcTimeoutMs: ms })).toThrow(
      /timeoutMs must be a positive integer/,
    );
  });

  it("does not validate rpcTimeoutMs when a providerFactory owns the transport", () => {
    expect(
      () =>
        new ExactStarknetScheme(makeSigner(), {
          rpcTimeoutMs: -1,
          providerFactory: () => mockProvider().provider,
        }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// verify - happy path
// ---------------------------------------------------------------------------

describe("ExactStarknetScheme.verify - happy path", () => {
  it("accepts a fully valid payment and returns { isValid: true, payer }", async () => {
    const mock = mockProvider();
    const result = await facilitatorWith(mock).verify(makePayload(), makeRequirements());
    expect(result.invalidReason).toBeUndefined();
    expect(result.isValid).toBe(true);
    expect(result.payer).toBe(FROM);
  });

  it("runs the wrapper simulation from the bound feePayer when the signer can originate from it", async () => {
    const mock = mockProvider();
    const result = await facilitatorWith(mock, makeAccountSigner()).verify(
      makePayload(),
      makeRequirements(),
    );
    expect(result.isValid).toBe(true);
    expect(mock.simulatedSenders.map(BigInt)).toEqual([BigInt(FEE_PAYER)]);
  });

  // A forwarder contract cannot originate a transaction, so the full call tree
  // is not simulable from it. Routing must be deterministic - decided by whether
  // the signer holds keys for the Caller, never by probing the node and reading
  // the error back (which is what the reference implementation's rewrite removed).
  it("routes deterministically to the inner-transfer simulation for a forwarder feePayer", async () => {
    const mock = mockProvider();
    const result = await facilitatorWith(mock, makeSigner()).verify(
      makePayload(),
      makeRequirements(),
    );
    expect(result.isValid).toBe(true);
    expect(mock.simulatedSenders.map(BigInt)).toEqual([BigInt(FROM)]);
  });

  it("never attempts to originate a simulation from a feePayer it holds no key for", async () => {
    const mock = mockProvider();
    await facilitatorWith(mock, makeSigner()).verify(makePayload(), makeRequirements());
    expect(mock.simulatedSenders.map(BigInt)).not.toContain(BigInt(FEE_PAYER));
  });
});

// ---------------------------------------------------------------------------
// verify - payload shape, version, scheme, network
// ---------------------------------------------------------------------------

describe("ExactStarknetScheme.verify - shape / version / scheme / network", () => {
  it("rejects a malformed payment payload", async () => {
    const payload = { x402Version: 2, accepted: makeRequirements(), payload: {} } as PaymentPayload;
    const result = await facilitatorWith(mockProvider()).verify(payload, makeRequirements());
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(CORE.INVALID_PAYLOAD);
    expect(result.invalidMessage).toContain("malformed");
  });

  it("rejects a signature exceeding the maximum felt length", async () => {
    const signature = Array.from({ length: MAX_SIGNATURE_FELTS + 1 }, () => "0x1");
    const result = await facilitatorWith(mockProvider()).verify(
      makePayload({ signature }),
      makeRequirements(),
    );
    expect(result.invalidReason).toBe(CORE.INVALID_PAYLOAD);
    expect(result.invalidMessage).toContain("malformed");
  });

  // Webauthn and passkey accounts carry signatures well past the default bound,
  // so an operator serving them must be able to raise it.
  it("accepts a longer signature when the bound is raised", async () => {
    const signature = Array.from({ length: MAX_SIGNATURE_FELTS + 8 }, () => "0x1");
    const mock = mockProvider();
    const facilitator = new ExactStarknetScheme(makeSigner(), {
      providerFactory: () => mock.provider,
      maxSignatureFelts: MAX_SIGNATURE_FELTS + 8,
    });
    const result = await facilitator.verify(makePayload({ signature }), makeRequirements());
    expect(result.isValid).toBe(true);
  });

  it("still rejects past the raised bound", async () => {
    const signature = Array.from({ length: MAX_SIGNATURE_FELTS + 9 }, () => "0x1");
    const mock = mockProvider();
    const facilitator = new ExactStarknetScheme(makeSigner(), {
      providerFactory: () => mock.provider,
      maxSignatureFelts: MAX_SIGNATURE_FELTS + 8,
    });
    const result = await facilitator.verify(makePayload({ signature }), makeRequirements());
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(CORE.INVALID_PAYLOAD);
  });

  // The felt check is what makes the length bound meaningful: an arbitrary
  // string is byte-array-encoded by CallData.compile into many more felts than
  // it occupies in the array, so a short array of non-felts would slip past a
  // bound that only counts elements.
  it("rejects a signature element that is not a felt", async () => {
    const result = await facilitatorWith(mockProvider()).verify(
      makePayload({ signature: ["0x1a2b", "definitely not a felt"] }),
      makeRequirements(),
    );
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(CORE.INVALID_PAYLOAD);
  });

  it("rejects a signature element that overflows the felt size", async () => {
    const result = await facilitatorWith(mockProvider()).verify(
      makePayload({ signature: ["0x1a2b", `0x${"f".repeat(65)}`] }),
      makeRequirements(),
    );
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(CORE.INVALID_PAYLOAD);
  });

  // 64 hex digits span 2^256, so the grammar alone admits values above the
  // field modulus; the node refuses those as malformed requests rather than
  // answering about the signature, which would surface as a retryable fault.
  it("rejects a signature element whose value is outside the field", async () => {
    for (const felt of [`0x${"f".repeat(64)}`, `0x${STARK_PRIME.toString(16)}`]) {
      const result = await facilitatorWith(mockProvider()).verify(
        makePayload({ signature: ["0x1a2b", felt] }),
        makeRequirements(),
      );
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe(CORE.INVALID_PAYLOAD);
    }
  });

  it("accepts a zero signature element", async () => {
    const result = await facilitatorWith(mockProvider()).verify(
      makePayload({ signature: ["0x0", "0x3c4d"] }),
      makeRequirements(),
    );
    expect(result.isValid).toBe(true);
  });

  it("rejects the wrong x402Version with the specific code", async () => {
    const payload = makePayload();
    payload.x402Version = 3;
    const result = await facilitatorWith(mockProvider()).verify(payload, makeRequirements());
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(CORE.INVALID_X402_VERSION);
  });

  it("rejects a scheme mismatch", async () => {
    const accepted = makeRequirements({ scheme: "upto" });
    const result = await facilitatorWith(mockProvider()).verify(
      makePayload({ accepted }),
      makeRequirements(),
    );
    expect(result.invalidReason).toBe(CORE.INVALID_SCHEME);
  });

  it("rejects a non-exact requirements scheme even when accepted echoes it", async () => {
    const requirements = makeRequirements({ scheme: "upto" });
    const accepted = makeRequirements({ scheme: "upto" });
    const result = await facilitatorWith(mockProvider()).verify(
      makePayload({ requirements, accepted }),
      requirements,
    );
    expect(result.invalidReason).toBe(CORE.INVALID_SCHEME);
  });

  it("rejects an unsupported requirements network", async () => {
    const requirements = makeRequirements({ network: "starknet:SN_UNKNOWN" });
    const result = await facilitatorWith(mockProvider()).verify(
      makePayload({ requirements }),
      requirements,
    );
    expect(result.invalidReason).toBe(CORE.INVALID_NETWORK);
  });

  it("rejects a network mismatch between accepted and requirements", async () => {
    const accepted = makeRequirements({ network: STARKNET_MAINNET_CAIP2 });
    const result = await facilitatorWith(mockProvider()).verify(
      makePayload({ accepted }),
      makeRequirements(),
    );
    expect(result.invalidReason).toBe(CORE.INVALID_NETWORK);
  });

  it("rejects typed-data whose chainId does not match the network", async () => {
    const payload = makePayload({ chainId: MAINNET_CHAIN_ID });
    const result = await facilitatorWith(mockProvider()).verify(payload, makeRequirements());
    expect(result.invalidReason).toBe(CORE.INVALID_NETWORK);
    expect(result.invalidMessage).toContain("typed data chainId");
  });
});

// ---------------------------------------------------------------------------
// verify - requirements well-formedness
// ---------------------------------------------------------------------------

describe("ExactStarknetScheme.verify - requirements well-formedness", () => {
  it("fails closed when maxTimeoutSeconds is missing (no NaN fail-open)", async () => {
    const requirements = makeRequirements();
    delete (requirements as Partial<PaymentRequirements>).maxTimeoutSeconds;
    const result = await facilitatorWith(mockProvider()).verify(
      makePayload({ requirements }),
      requirements,
    );
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(CORE.INVALID_PAYMENT_REQUIREMENTS);
    expect(result.invalidMessage).toContain("maxTimeoutSeconds");
  });

  it("fails closed on a non-positive maxTimeoutSeconds", async () => {
    const requirements = makeRequirements({ maxTimeoutSeconds: 0 });
    const result = await facilitatorWith(mockProvider()).verify(
      makePayload({ requirements }),
      requirements,
    );
    expect(result.invalidReason).toBe(CORE.INVALID_PAYMENT_REQUIREMENTS);
    expect(result.invalidMessage).toContain("maxTimeoutSeconds");
  });

  // `Execute Before` is a felt, so a fractional window is unsignable. The
  // defect belongs to the 402 that advertised it, not to the client.
  it("fails closed on a fractional maxTimeoutSeconds", async () => {
    const requirements = makeRequirements({ maxTimeoutSeconds: 300.5 });
    const result = await facilitatorWith(mockProvider()).verify(
      makePayload({ requirements }),
      requirements,
    );
    expect(result.invalidReason).toBe(CORE.INVALID_PAYMENT_REQUIREMENTS);
    expect(result.invalidMessage).toContain("maxTimeoutSeconds");
  });

  // Out of the felt range, so no account can live there. Blame must land on the
  // requirements rather than surfacing later as a malformed client payload.
  it.each([
    ["asset", "invalid asset address"],
    ["payTo", "invalid payTo address"],
  ])("blames the requirements for an out-of-range %s", async (field, message) => {
    const requirements = makeRequirements({ [field]: "0x" + "f".repeat(64) });
    const result = await facilitatorWith(mockProvider()).verify(
      makePayload({ requirements, accepted: requirements }),
      requirements,
    );
    expect(result.invalidReason).toBe(CORE.INVALID_PAYMENT_REQUIREMENTS);
    expect(result.invalidMessage).toContain(message);
  });

  // The scheme implements one flow. A resource server announcing a different
  // one is running a trust model this facilitator does not implement, so
  // verifying its payment under authorization semantics anyway is the confusion
  // worth refusing. Absence stays valid - core omits both keys for this scheme.
  describe("protocol-reserved flow keys", () => {
    it("accepts requirements that omit both keys", async () => {
      const result = await facilitatorWith(mockProvider()).verify(
        makePayload(),
        makeRequirements(),
      );
      expect(result.isValid).toBe(true);
    });

    it.each([
      ["assetTransferMethod", "default"],
      ["paymentFlow", "authorization"],
    ])("accepts an explicit %s of its declared value", async (key, value) => {
      const requirements = makeRequirements({
        extra: { feePayer: FEE_PAYER, [key]: value },
      });
      const result = await facilitatorWith(mockProvider()).verify(
        makePayload({ requirements, accepted: requirements }),
        requirements,
      );
      expect(result.isValid).toBe(true);
    });

    it.each([
      ["assetTransferMethod", "permit2"],
      ["paymentFlow", "upfront"],
    ])("rejects requirements declaring an unsupported %s", async (key, value) => {
      const requirements = makeRequirements({
        extra: { feePayer: FEE_PAYER, [key]: value },
      });
      const result = await facilitatorWith(mockProvider()).verify(
        makePayload({ requirements, accepted: requirements }),
        requirements,
      );
      expect(result.invalidReason).toBe(CORE.INVALID_PAYMENT_REQUIREMENTS);
      expect(result.invalidMessage).toContain(key);
    });

    it("blames the client when only accepted declares an unsupported flow", async () => {
      const requirements = makeRequirements();
      const accepted = makeRequirements({
        extra: { feePayer: FEE_PAYER, paymentFlow: "upfront" },
      });
      const result = await facilitatorWith(mockProvider()).verify(
        makePayload({ requirements, accepted }),
        requirements,
      );
      expect(result.invalidReason).toBe(CORE.INVALID_PAYLOAD);
    });

    // A present key with a null value is a key that appears - not absence - so
    // it is held to the same value match as any other present value.
    it("rejects an explicit null under a reserved key", async () => {
      const requirements = makeRequirements({
        extra: { feePayer: FEE_PAYER, paymentFlow: null },
      });
      const result = await facilitatorWith(mockProvider()).verify(
        makePayload({ requirements, accepted: requirements }),
        requirements,
      );
      expect(result.invalidReason).toBe(CORE.INVALID_PAYMENT_REQUIREMENTS);
    });
  });

  it("rejects a maxTimeoutSeconds at or under the settle floor as unsatisfiable", async () => {
    const requirements = makeRequirements({ maxTimeoutSeconds: MIN_REMAINING_WINDOW_SECONDS });
    const result = await facilitatorWith(mockProvider()).verify(
      makePayload({ requirements }),
      requirements,
    );
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(CORE.INVALID_PAYMENT_REQUIREMENTS);
    expect(result.invalidMessage).toContain("maxTimeoutSeconds");
  });

  // The spec only says servers SHOULD advertise comfortably above
  // `skewMargin + minSettleMargin`. A tighter-but-positive window is still
  // conformant, so the facilitator must not refuse it outright - it just leaves
  // the signature usable for less time.
  it("accepts a maxTimeoutSeconds above the floor but under floor + skew", async () => {
    const maxTimeoutSeconds = MIN_REMAINING_WINDOW_SECONDS + SKEW_MARGIN_SECONDS;
    expect(maxTimeoutSeconds).toBeGreaterThan(MIN_REMAINING_WINDOW_SECONDS);
    const requirements = makeRequirements({ maxTimeoutSeconds });
    const result = await facilitatorWith(mockProvider()).verify(
      // The client signs `Execute Before = now + maxTimeoutSeconds`, so the
      // message has to track the tighter window or it trips the upper bound.
      makePayload({
        requirements,
        message: makeMessage({ "Execute Before": String(NOW + maxTimeoutSeconds) }),
      }),
      requirements,
    );
    expect(result.invalidReason).toBeUndefined();
    expect(result.isValid).toBe(true);
  });

  it("fails closed on a malformed requirements.amount", async () => {
    const requirements = makeRequirements({ amount: "not-a-number" });
    const result = await facilitatorWith(mockProvider()).verify(
      makePayload({ requirements }),
      requirements,
    );
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(CORE.INVALID_PAYMENT_REQUIREMENTS);
    expect(result.invalidMessage).toContain("invalid amount");
  });

  it("rejects a hex-encoded requirements amount (base-10 only)", async () => {
    const requirements = makeRequirements({ amount: "0x2710" });
    const result = await facilitatorWith(mockProvider()).verify(
      makePayload({ requirements }),
      requirements,
    );
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(CORE.INVALID_PAYMENT_REQUIREMENTS);
  });
});

// ---------------------------------------------------------------------------
// verify - feePayer / caller binding (merged-spec model)
// ---------------------------------------------------------------------------

describe("ExactStarknetScheme.verify - feePayer / caller binding", () => {
  it("rejects a missing extra.feePayer", async () => {
    const requirements = makeRequirements({ extra: {} });
    const result = await facilitatorWith(mockProvider()).verify(
      makePayload({ requirements }),
      requirements,
    );
    expect(result.invalidReason).toBe(CORE.INVALID_PAYMENT_REQUIREMENTS);
    expect(result.invalidMessage).toContain("extra.feePayer");
  });

  it("rejects a syntactically invalid extra.feePayer", async () => {
    const requirements = makeRequirements({ extra: { feePayer: "not-an-address" } });
    const result = await facilitatorWith(mockProvider()).verify(
      makePayload({ requirements }),
      requirements,
    );
    expect(result.invalidReason).toBe(CORE.INVALID_PAYMENT_REQUIREMENTS);
  });

  // Spec rule 1 places these three constraints on the SERVER-SUPPLIED
  // requirements and pins their rejection to invalid_payment_requirements; the
  // error table reserves the caller token for rule 4 (message.Caller mismatch).
  it("rejects a zero extra.feePayer as a requirements defect", async () => {
    const requirements = makeRequirements({ extra: { feePayer: "0x0" } });
    const result = await facilitatorWith(mockProvider()).verify(
      makePayload({ requirements }),
      requirements,
    );
    expect(result.invalidReason).toBe(CORE.INVALID_PAYMENT_REQUIREMENTS);
    expect(result.invalidMessage).toContain("must not be zero");
  });

  it("rejects an extra.feePayer equal to the ANY_CALLER sentinel", async () => {
    const requirements = makeRequirements({ extra: { feePayer: ANY_CALLER } });
    const message = makeMessage({ Caller: ANY_CALLER });
    const result = await facilitatorWith(mockProvider()).verify(
      makePayload({ requirements, message }),
      requirements,
    );
    expect(result.invalidReason).toBe(CORE.INVALID_PAYMENT_REQUIREMENTS);
    expect(result.invalidMessage).toContain("ANY_CALLER");
  });

  it("rejects an extra.feePayer equal to the payer", async () => {
    const requirements = makeRequirements({ extra: { feePayer: FROM } });
    const result = await facilitatorWith(mockProvider()).verify(
      makePayload({ requirements }),
      requirements,
    );
    expect(result.invalidReason).toBe(CORE.INVALID_PAYMENT_REQUIREMENTS);
    expect(result.invalidMessage).toContain("must not equal the payer");
  });

  // The caller token stays reserved for the rule-4 binding check.
  it("rejects an extra.feePayer not managed by this facilitator", async () => {
    const requirements = makeRequirements({ extra: { feePayer: OTHER } });
    const message = makeMessage({ Caller: OTHER });
    const result = await facilitatorWith(mockProvider()).verify(
      makePayload({ requirements, message }),
      requirements,
    );
    // Not the caller token: a foreign-but-well-formed feePayer is a requirements defect.
    expect(result.invalidReason).toBe(CORE.INVALID_PAYMENT_REQUIREMENTS);
    expect(result.invalidMessage).toContain("not managed by this facilitator");
  });

  it("rejects an accepted.extra.feePayer that does not match requirements", async () => {
    const accepted = makeRequirements({ extra: { feePayer: OTHER } });
    const result = await facilitatorWith(mockProvider()).verify(
      makePayload({ accepted }),
      makeRequirements(),
    );
    expect(result.invalidReason).toBe(CORE.INVALID_PAYLOAD);
    expect(result.invalidMessage).toContain("accepted.extra.feePayer");
  });

  it("rejects a Caller that does not equal the feePayer", async () => {
    const message = makeMessage({ Caller: OTHER });
    const result = await facilitatorWith(mockProvider()).verify(
      makePayload({ message }),
      makeRequirements(),
    );
    expect(result.invalidReason).toBe(STARKNET_ERROR_REASONS.INVALID_CALLER);
    expect(result.invalidMessage).toContain("Caller must equal extra.feePayer");
  });

  it("rejects a payer that is itself a facilitator-managed feePayer", async () => {
    // Two managed addresses: feePayer = FEE_PAYER_2, payer = FEE_PAYER (also managed).
    const signer = makeSigner([FEE_PAYER, FEE_PAYER_2]);
    const requirements = makeRequirements({ extra: { feePayer: FEE_PAYER_2 } });
    const message = makeMessage({ Caller: FEE_PAYER_2 });
    const payload = makePayload({ requirements, message, from: FEE_PAYER });
    const result = await facilitatorWith(mockProvider(), signer).verify(payload, requirements);
    expect(result.invalidReason).toBe(CORE.INVALID_PAYLOAD);
    expect(result.invalidMessage).toContain("payer must not be a facilitator-managed feePayer");
  });

  it("rejects a bad sender address", async () => {
    const result = await facilitatorWith(mockProvider()).verify(
      makePayload({ from: "not-an-address" }),
      makeRequirements(),
    );
    expect(result.invalidReason).toBe(CORE.INVALID_PAYLOAD);
    expect(result.invalidMessage).toContain("bad sender address");
  });
});

// ---------------------------------------------------------------------------
// verify - typed-data structural validation
// ---------------------------------------------------------------------------

describe("ExactStarknetScheme.verify - typed-data structural validation", () => {
  it("rejects unknown keys in the typed-data message", async () => {
    const td = buildCanonicalOutsideExecutionTypedData(SEPOLIA_CHAIN_ID, makeMessage());
    (td.message as Record<string, unknown>)["Injected"] = "0x1";
    const result = await facilitatorWith(mockProvider()).verify(
      makePayload({ typedData: td }),
      makeRequirements(),
    );
    expect(result.invalidReason).toBe(CORE.INVALID_PAYLOAD);
  });

  it("cleanly rejects non-integer numeric calldata instead of throwing", async () => {
    // An attacker supplies raw wire JSON, not something our own builder made,
    // so mutate the payload after construction rather than building through it.
    const payload = makePayload();
    const td = (
      payload.payload as {
        outsideExecution: { typedData: { message: { Calls: { Calldata: unknown[] }[] } } };
      }
    ).outsideExecution.typedData;
    td.message.Calls[0].Calldata = [PAY_TO, 1.5, 0];
    const result = await facilitatorWith(mockProvider()).verify(payload, makeRequirements());
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(CORE.INVALID_PAYLOAD);
  });
});

// ---------------------------------------------------------------------------
// verify - payment intent and exactness
// ---------------------------------------------------------------------------

describe("ExactStarknetScheme.verify - payment intent and exactness", () => {
  it("rejects accepted.amount differing from requirements", async () => {
    const accepted = makeRequirements({ amount: "9999" });
    const result = await facilitatorWith(mockProvider()).verify(
      makePayload({ accepted }),
      makeRequirements(),
    );
    expect(result.invalidReason).toBe(CORE.INVALID_PAYLOAD);
    expect(result.invalidMessage).toContain("accepted does not match");
  });

  // `amount` alone is not enough: each field of the accepted echo is an
  // independent binding, and a regression that dropped any one of them would
  // let the client attest to requirements the server never issued.
  it("rejects accepted.payTo differing from requirements", async () => {
    const accepted = makeRequirements({ payTo: FEE_PAYER });
    const result = await facilitatorWith(mockProvider()).verify(
      makePayload({ accepted }),
      makeRequirements(),
    );
    expect(result.invalidReason).toBe(CORE.INVALID_PAYLOAD);
    expect(result.invalidMessage).toContain("accepted does not match");
  });

  it("rejects accepted.asset differing from requirements", async () => {
    const accepted = makeRequirements({ asset: FEE_PAYER });
    const result = await facilitatorWith(mockProvider()).verify(
      makePayload({ accepted }),
      makeRequirements(),
    );
    expect(result.invalidReason).toBe(CORE.INVALID_PAYLOAD);
    expect(result.invalidMessage).toContain("accepted does not match");
  });

  it("rejects accepted.maxTimeoutSeconds differing from requirements", async () => {
    const accepted = makeRequirements({ maxTimeoutSeconds: 301 });
    const result = await facilitatorWith(mockProvider()).verify(
      makePayload({ accepted }),
      makeRequirements(),
    );
    expect(result.invalidReason).toBe(CORE.INVALID_PAYLOAD);
    expect(result.invalidMessage).toContain("accepted does not match");
  });

  it("rejects more than one call (call smuggling)", async () => {
    const message = makeMessage();
    message.Calls = [...message.Calls, { ...message.Calls[0] }];
    const result = await facilitatorWith(mockProvider()).verify(
      makePayload({ message }),
      makeRequirements(),
    );
    expect(result.invalidReason).toBe(CORE.INVALID_PAYLOAD);
    expect(result.invalidMessage).toContain("exactly 1 call");
  });

  it("rejects a call targeting a different contract (asset mismatch)", async () => {
    const message = makeMessage();
    message.Calls[0].To = OTHER;
    const result = await facilitatorWith(mockProvider()).verify(
      makePayload({ message }),
      makeRequirements(),
    );
    expect(result.invalidReason).toBe(STARKNET_ERROR_REASONS.ASSET_MISMATCH);
  });

  it("rejects a non-transfer selector", async () => {
    const message = makeMessage();
    message.Calls[0].Selector = hash.getSelectorFromName("approve");
    const result = await facilitatorWith(mockProvider()).verify(
      makePayload({ message }),
      makeRequirements(),
    );
    expect(result.invalidReason).toBe(CORE.INVALID_PAYLOAD);
    expect(result.invalidMessage).toContain("not a transfer");
  });

  it("rejects calldata that is not exactly 3 felts", async () => {
    const message = makeMessage();
    message.Calls[0].Calldata = [PAY_TO, "0x2710"];
    const result = await facilitatorWith(mockProvider()).verify(
      makePayload({ message }),
      makeRequirements(),
    );
    expect(result.invalidReason).toBe(CORE.INVALID_PAYLOAD);
    expect(result.invalidMessage).toContain("exactly");
  });

  it("rejects a wrong recipient", async () => {
    const message = makeMessage();
    message.Calls[0].Calldata = [OTHER, "0x2710", "0x0"];
    const result = await facilitatorWith(mockProvider()).verify(
      makePayload({ message }),
      makeRequirements(),
    );
    expect(result.invalidReason).toBe(STARKNET_ERROR_REASONS.RECIPIENT_MISMATCH);
  });

  it("rejects underpayment AND overpayment (exact scheme)", async () => {
    for (const amount of ["0x270f", "0x2711"]) {
      const message = makeMessage();
      message.Calls[0].Calldata = [PAY_TO, amount, "0x0"];
      const result = await facilitatorWith(mockProvider()).verify(
        makePayload({ message }),
        makeRequirements(),
      );
      expect(result.invalidReason).toBe(STARKNET_ERROR_REASONS.AMOUNT_MISMATCH);
    }
  });

  it("rejects non-canonical u256 limbs", async () => {
    const message = makeMessage();
    // low = 2^128 + 10000 sums to a matching value but the low limb overflows u128.
    message.Calls[0].Calldata = [PAY_TO, "0x" + ((1n << 128n) + 0x2710n).toString(16), "0x0"];
    const result = await facilitatorWith(mockProvider()).verify(
      makePayload({ message }),
      makeRequirements(),
    );
    expect(result.invalidReason).toBe(CORE.INVALID_PAYLOAD);
    expect(result.invalidMessage).toContain("limbs");
  });
});

// ---------------------------------------------------------------------------
// verify - execution time window
// ---------------------------------------------------------------------------

describe("ExactStarknetScheme.verify - execution time window", () => {
  it("rejects an expired Execute Before", async () => {
    const message = makeMessage({ "Execute Before": String(NOW - 10) });
    const result = await facilitatorWith(mockProvider()).verify(
      makePayload({ message }),
      makeRequirements(),
    );
    expect(result.invalidReason).toBe(STARKNET_ERROR_REASONS.EXPIRED);
  });

  it("rejects an Execute Before too close to expiry", async () => {
    const message = makeMessage({ "Execute Before": String(NOW + 10) });
    const result = await facilitatorWith(mockProvider()).verify(
      makePayload({ message }),
      makeRequirements(),
    );
    expect(result.invalidReason).toBe(STARKNET_ERROR_REASONS.EXPIRED);
  });

  it("rejects a stale authorization that no longer covers the advertised window", async () => {
    // Above the minimum window but below now + maxTimeoutSeconds - skewMargin.
    const message = makeMessage({ "Execute Before": String(NOW + 250) });
    const result = await facilitatorWith(mockProvider()).verify(
      makePayload({ message }),
      makeRequirements(),
    );
    expect(result.invalidReason).toBe(STARKNET_ERROR_REASONS.EXPIRED);
    expect(result.invalidMessage).toContain("advertised settlement window");
  });

  it("rejects a window exceeding maxTimeoutSeconds", async () => {
    const message = makeMessage({ "Execute Before": String(NOW + 10_000) });
    const result = await facilitatorWith(mockProvider()).verify(
      makePayload({ message }),
      makeRequirements(),
    );
    expect(result.invalidReason).toBe(STARKNET_ERROR_REASONS.WINDOW_EXCEEDS_MAX_TIMEOUT);
  });

  it("rejects an Execute After that is not sufficiently in the past", async () => {
    const message = makeMessage({ "Execute After": String(NOW - 5) });
    const result = await facilitatorWith(mockProvider()).verify(
      makePayload({ message }),
      makeRequirements(),
    );
    expect(result.invalidReason).toBe(CORE.INVALID_PAYLOAD);
    expect(result.invalidMessage).toContain("Execute After");
  });
});

// ---------------------------------------------------------------------------
// verify - onchain checks
// ---------------------------------------------------------------------------

describe("ExactStarknetScheme.verify - onchain checks", () => {
  it("rejects an undeployed account", async () => {
    const result = await facilitatorWith(mockProvider({ deployed: false })).verify(
      makePayload(),
      makeRequirements(),
    );
    expect(result.invalidReason).toBe(STARKNET_ERROR_REASONS.ACCOUNT_NOT_DEPLOYED);
  });

  // A preflight read can fail because the chain answered (a fact about the
  // payment) or because the node did not answer at all (a fact about the
  // facilitator). Only the first justifies a domain verdict: telling a client
  // its nonce is spent because a node timed out would permanently retire an
  // authorization that never executed.
  describe("transport faults are not domain verdicts", () => {
    const transportFault = new Error("socket hang up");

    it("reports an unreachable node as an unexpected error, not a missing account", async () => {
      const result = await facilitatorWith(mockProvider({ classHashError: transportFault })).verify(
        makePayload(),
        makeRequirements(),
      );
      expect(result.invalidReason).toBe(CORE.UNEXPECTED_VERIFY_ERROR);
    });

    it("reports a failed signature read as an unexpected error, not an invalid signature", async () => {
      const result = await facilitatorWith(mockProvider({ sigError: transportFault })).verify(
        makePayload(),
        makeRequirements(),
      );
      expect(result.invalidReason).toBe(CORE.UNEXPECTED_VERIFY_ERROR);
    });

    it("reports a failed nonce read as an unexpected error, not a consumed nonce", async () => {
      const result = await facilitatorWith(mockProvider({ nonceError: transportFault })).verify(
        makePayload(),
        makeRequirements(),
      );
      expect(result.invalidReason).toBe(CORE.UNEXPECTED_VERIFY_ERROR);
    });

    it("still treats a reverting signature call as an invalid signature", async () => {
      const result = await facilitatorWith(
        mockProvider({ sigError: new RpcError({ code: 40, message: "contract error" } as never) }),
      ).verify(makePayload(), makeRequirements());
      expect(result.invalidReason).toBe(STARKNET_ERROR_REASONS.INVALID_SIGNATURE);
    });

    it("still treats a missing SNIP-9 entry point as a terminal nonce rejection", async () => {
      const result = await facilitatorWith(
        mockProvider({
          nonceError: new RpcError({ code: 21, message: "entry point not found" } as never),
        }),
      ).verify(makePayload(), makeRequirements());
      expect(result.invalidReason).toBe(STARKNET_ERROR_REASONS.NONCE_ALREADY_USED);
    });

    // The inner-transfer fallback is weaker evidence than the full call tree,
    // and it is only warranted when the chain says the sender cannot originate
    // a transaction. A node that failed to answer must not buy that downgrade.
    it("does not downgrade to the inner-transfer fallback on a sender preflight fault", async () => {
      const mock = mockProvider({
        classHashError: transportFault,
        classHashErrorAddress: FEE_PAYER,
      });
      const result = await facilitatorWith(mock, makeAccountSigner()).verify(
        makePayload(),
        makeRequirements(),
      );
      // The unreachable node is the FACILITATOR's own account here, so the
      // answer is a retryable error, not a verdict that the payment failed.
      expect(result.invalidReason).toBe(CORE.UNEXPECTED_VERIFY_ERROR);
      expect(mock.simulatedSenders).toEqual([]);
    });

    it("reports a fault on the fallback sender preflight as retryable too", async () => {
      // Forwarder signer: the fallback simulates from the payer, so a fault
      // there is still the facilitator failing to read, not the payer failing.
      const mock = mockProvider({ classHashError: transportFault, classHashErrorAddress: FROM });
      const result = await facilitatorWith(mock).verify(makePayload(), makeRequirements());
      expect(result.invalidReason).toBe(CORE.UNEXPECTED_VERIFY_ERROR);
      expect(mock.simulatedSenders).toEqual([]);
    });

    it("still reports a simulation the node ran and rejected as simulation_failed", async () => {
      const mock = mockProvider({
        simulate: () => successfulTrace({ revertReason: "u256_sub Overflow" }),
      });
      const result = await facilitatorWith(mock).verify(makePayload(), makeRequirements());
      expect(result.invalidReason).toBe(STARKNET_ERROR_REASONS.SIMULATION_FAILED);
    });

    // An announced executor the chain says is not a contract is a feePayer this
    // facilitator cannot settle through (spec rule 1). Verifying the payment on
    // the weaker inner-transfer evidence would serve the resource and then fail
    // at every settlement, so it is reported as a fault about the facilitator.
    it("reports an executor the chain says is not a contract as a facilitator fault", async () => {
      const mock = mockProvider({
        classHashError: new RpcError({ code: 20, message: "contract not found" } as never),
        classHashErrorAddress: FEE_PAYER,
      });
      const result = await facilitatorWith(mock, makeAccountSigner()).verify(
        makePayload(),
        makeRequirements(),
      );
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe(CORE.UNEXPECTED_VERIFY_ERROR);
      expect(mock.simulatedSenders).toEqual([]);
    });
  });

  it("rejects an invalid signature (non-VALID magic)", async () => {
    const result = await facilitatorWith(mockProvider({ sigResult: ["0x0"] })).verify(
      makePayload(),
      makeRequirements(),
    );
    expect(result.invalidReason).toBe(STARKNET_ERROR_REASONS.INVALID_SIGNATURE);
  });

  it("rejects a consumed SNIP-9 nonce", async () => {
    const result = await facilitatorWith(mockProvider({ nonceResult: ["0x0"] })).verify(
      makePayload(),
      makeRequirements(),
    );
    expect(result.invalidReason).toBe(STARKNET_ERROR_REASONS.NONCE_ALREADY_USED);
    expect(result.payer).toBe(FROM);
  });

  it("rejects insufficient balance", async () => {
    const result = await facilitatorWith(mockProvider({ balance: ["0x1", "0x0"] })).verify(
      makePayload(),
      makeRequirements(),
    );
    expect(result.invalidReason).toBe(CORE.INSUFFICIENT_FUNDS);
    expect(result.payer).toBe(FROM);
  });

  it("falls back to balance_of when balanceOf is missing", async () => {
    const mock = mockProvider({ balanceOfThrows: true });
    const result = await facilitatorWith(mock).verify(makePayload(), makeRequirements());
    expect(result.isValid).toBe(true);
    expect(mock.calls).toContain("balance_of");
  });

  it("treats a token exposing neither balance getter as a requirements defect", async () => {
    const mock = mockProvider({
      balanceOfThrows: true,
      balanceFallbackError: new RpcError({ code: 21, message: "entry point not found" } as never),
    });
    const result = await facilitatorWith(mock).verify(makePayload(), makeRequirements());
    expect(result.invalidReason).toBe(CORE.INVALID_PAYMENT_REQUIREMENTS);
  });

  it("treats a transient balance RPC failure as an unexpected error, not a defect", async () => {
    const mock = mockProvider({
      balanceOfThrows: true,
      balanceFallbackError: new Error("socket hang up"),
    });
    const result = await facilitatorWith(mock).verify(makePayload(), makeRequirements());
    expect(result.invalidReason).toBe(CORE.UNEXPECTED_VERIFY_ERROR);
  });
});

// ---------------------------------------------------------------------------
// verify - settlement simulation
// ---------------------------------------------------------------------------

describe("ExactStarknetScheme.verify - settlement simulation", () => {
  // An exception before any simulation ran is a fault of this facilitator, not
  // a verdict the node reached about the payment.
  it("reports a simulation that could not be started as unexpected_verify_error", async () => {
    const signer: FacilitatorStarknetSigner = {
      ...makeSigner(),
      getOriginationSenders: () => {
        throw new Error("signer unavailable");
      },
    };
    const result = await facilitatorWith(mockProvider(), signer).verify(
      makePayload(),
      makeRequirements(),
    );
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(CORE.UNEXPECTED_VERIFY_ERROR);
  });

  it("rejects when the simulated execution reverts", async () => {
    const mock = mockProvider({
      simulate: () => successfulTrace({ revertReason: "ERC20: insufficient allowance" }),
    });
    const result = await facilitatorWith(mock).verify(makePayload(), makeRequirements());
    expect(result.invalidReason).toBe(STARKNET_ERROR_REASONS.SIMULATION_FAILED);
    expect(result.payer).toBe(FROM);
  });

  // A response with no readable trace is a response the facilitator could not
  // read, so it fails closed as a retryable fault - not a verdict blaming the
  // payer, which is reserved for a simulation the node actually ran.
  it("reports a traceless simulation response as a retryable fault", async () => {
    const mock = mockProvider({ simulate: () => [{ transaction_trace: {} }] });
    const result = await facilitatorWith(mock).verify(makePayload(), makeRequirements());
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(CORE.UNEXPECTED_VERIFY_ERROR);
  });

  it("reports an empty simulation response as a retryable fault", async () => {
    const mock = mockProvider({ simulate: () => [] });
    const result = await facilitatorWith(mock).verify(makePayload(), makeRequirements());
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(CORE.UNEXPECTED_VERIFY_ERROR);
  });

  it("does not retry-sweep senders when a wrapper simulation reverts", async () => {
    const mock = mockProvider({
      simulate: () => successfulTrace({ revertReason: "argent/invalid-caller" }),
    });
    const result = await facilitatorWith(mock).verify(makePayload(), makeRequirements());
    expect(result.invalidReason).toBe(STARKNET_ERROR_REASONS.SIMULATION_FAILED);
    expect(mock.simulatedSenders.length).toBe(1);
  });

  it("rejects when the simulation shows a wrong transfer amount", async () => {
    const mock = mockProvider({
      simulate: () =>
        successfulTrace({
          events: [
            { from_address: ASSET, keys: [TRANSFER_EVENT_KEY, FROM, PAY_TO], data: ["0x1", "0x0"] },
          ],
        }),
    });
    const result = await facilitatorWith(mock).verify(makePayload(), makeRequirements());
    expect(result.invalidReason).toBe(STARKNET_ERROR_REASONS.SIMULATION_FAILED);
  });

  it("rejects when the simulation shows extra Transfer events", async () => {
    const mock = mockProvider({
      simulate: () =>
        successfulTrace({
          events: [
            {
              from_address: ASSET,
              keys: [TRANSFER_EVENT_KEY, FROM, PAY_TO],
              data: ["0x2710", "0x0"],
            },
            { from_address: ASSET, keys: [TRANSFER_EVENT_KEY, FROM, OTHER], data: ["0x1", "0x0"] },
          ],
        }),
    });
    const result = await facilitatorWith(mock).verify(makePayload(), makeRequirements());
    expect(result.invalidReason).toBe(STARKNET_ERROR_REASONS.SIMULATION_FAILED);
  });

  it("rejects a simulated Transfer with no attributable emitter (fail closed)", async () => {
    const mock = mockProvider({
      simulate: () => [
        {
          transaction_trace: {
            execute_invocation: {
              // No contract_address on the frame, no from_address on the event.
              events: [{ keys: [TRANSFER_EVENT_KEY, FROM, PAY_TO], data: ["0x2710", "0x0"] }],
              calls: [],
            },
          },
        },
      ],
    });
    const result = await facilitatorWith(mock).verify(makePayload(), makeRequirements());
    expect(result.invalidReason).toBe(STARKNET_ERROR_REASONS.SIMULATION_FAILED);
  });
});

// ---------------------------------------------------------------------------
// verify - payer disclosure and bare-token discipline
// ---------------------------------------------------------------------------

describe("ExactStarknetScheme.verify - payer disclosure", () => {
  it("omits payer on failures before the signature is verified", async () => {
    const accepted = makeRequirements({ scheme: "upto" });
    const result = await facilitatorWith(mockProvider()).verify(
      makePayload({ accepted }),
      makeRequirements(),
    );
    expect(result.isValid).toBe(false);
    expect(result.payer).toBeUndefined();
  });

  it("includes payer only after the signature verifies (post-signature failure)", async () => {
    const result = await facilitatorWith(mockProvider({ balance: ["0x1", "0x0"] })).verify(
      makePayload(),
      makeRequirements(),
    );
    expect(result.invalidReason).toBe(CORE.INSUFFICIENT_FUNDS);
    expect(result.payer).toBe(FROM);
  });

  it("carries a bare enum token in invalidReason with human text in invalidMessage", async () => {
    const accepted = makeRequirements({ amount: "9999" });
    const result = await facilitatorWith(mockProvider()).verify(
      makePayload({ accepted }),
      makeRequirements(),
    );
    expect(result.invalidReason).toBe(CORE.INVALID_PAYLOAD);
    // Bare token: no human detail appended to the reason itself.
    expect(result.invalidReason).not.toContain(" ");
    expect(result.invalidMessage).toBeTruthy();
  });
});

describe("ExactStarknetScheme.verify - balance getter classification", () => {
  // Rule 8 pins invalid_payment_requirements to "a token exposing neither
  // getter". A transient fault on balanceOf must NOT be reclassified by the
  // fallback attempt into a requirements defect against a healthy token.
  it("reports a transient balanceOf fault as an unexpected error, not a requirements defect", async () => {
    const mock = mockProvider({ balanceOfError: new Error("socket hang up") });
    const result = await facilitatorWith(mock).verify(makePayload(), makeRequirements());
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(CORE.UNEXPECTED_VERIFY_ERROR);
  });

  it("never consults balance_of when balanceOf failed for a non-entrypoint reason", async () => {
    const mock = mockProvider({ balanceOfError: new Error("socket hang up") });
    await facilitatorWith(mock).verify(makePayload(), makeRequirements());
    expect(mock.calls).not.toContain("balance_of");
  });
});

describe("ExactStarknetScheme facilitator - /supported signers map", () => {
  // Spec: the signers map lists the accounts that actually sign the settlement
  // INVOKE. A paymaster forwarder is a contract and can never sign, so
  // advertising it would point clients at an address that never appears as a
  // transaction sender.
  it("prefers the signer's declared settlement signers over the announced feePayers", () => {
    const relayer = "0x0777777777777777777777777777777777777777777777777777777777777777";
    const facilitator = new ExactStarknetScheme({
      getAddresses: () => [FEE_PAYER],
      getSettlementSigners: () => [relayer],
      executeFromOutside: async () => ({ transactionHash: "0xabc" }),
    });
    expect(facilitator.getSigners(STARKNET_SEPOLIA_CAIP2)).toEqual([relayer]);
    // The announced feePayer is unchanged: that is still what the client binds.
    expect(facilitator.getExtra(STARKNET_SEPOLIA_CAIP2)).toEqual({ feePayer: FEE_PAYER });
  });

  it("falls back to the announced addresses for a direct executor", () => {
    const facilitator = new ExactStarknetScheme(makeSigner([FEE_PAYER]));
    expect(facilitator.getSigners(STARKNET_SEPOLIA_CAIP2)).toEqual([FEE_PAYER]);
  });
});

// ---------------------------------------------------------------------------
// verify - canonical reconstruction (spec rule 2)
// ---------------------------------------------------------------------------

describe("ExactStarknetScheme.verify - canonical reconstruction", () => {
  // Rule 2: the hash is computed over the facilitator's own canonical
  // reconstruction, never the typed data as received. The same message with
  // every felt in a different encoding must therefore reach the account's
  // is_valid_signature as the same hash, and the same nonce must reach
  // is_valid_outside_execution_nonce however the client wrote it.
  it("hashes and queries the canonical message, not the wire encoding", async () => {
    const message = makeMessage();
    const canonical = buildCanonicalOutsideExecutionTypedData(SEPOLIA_CHAIN_ID, message);
    const reencoded = {
      ...canonical,
      domain: { ...canonical.domain, chainId: "SN_SEPOLIA" },
      message: {
        ...canonical.message,
        Caller: BigInt(message.Caller).toString(),
        Nonce: BigInt(message.Nonce).toString(),
        "Execute After": Number(message["Execute After"]),
        "Execute Before": Number(message["Execute Before"]),
      },
    };
    const mock = mockProvider();
    const result = await facilitatorWith(mock).verify(
      makePayload({ typedData: reencoded }),
      makeRequirements(),
    );
    expect(result.isValid).toBe(true);

    const expectedHash = snTypedData.getMessageHash(canonical, FROM);
    expect(BigInt(mock.calldataByEntrypoint.is_valid_signature[0])).toBe(BigInt(expectedHash));
    expect(BigInt(mock.calldataByEntrypoint.is_valid_outside_execution_nonce[0])).toBe(
      BigInt(message.Nonce),
    );
  });

  // starknet.js normalizes felt encodings, so the case above would also pass a
  // facilitator that hashed the wire object directly. The `types` block is not
  // normalized: a wire object carrying altered type definitions hashes to a
  // different value, and only a facilitator that rebuilds the types itself
  // still arrives at the canonical hash.
  it("rebuilds the SNIP-12 types rather than hashing the wire object's", async () => {
    const canonical = buildCanonicalOutsideExecutionTypedData(SEPOLIA_CHAIN_ID, makeMessage());
    const tampered = {
      ...canonical,
      types: {
        ...canonical.types,
        OutsideExecution: canonical.types.OutsideExecution.map(field =>
          field.name === "Execute After" ? { ...field, type: "felt" } : field,
        ),
      },
    };
    const expectedHash = snTypedData.getMessageHash(canonical, FROM);
    // The case is only meaningful if the tampered object really hashes differently.
    expect(BigInt(snTypedData.getMessageHash(tampered, FROM))).not.toBe(BigInt(expectedHash));

    const mock = mockProvider();
    const result = await facilitatorWith(mock).verify(
      makePayload({ typedData: tampered }),
      makeRequirements(),
    );
    expect(result.isValid).toBe(true);
    expect(BigInt(mock.calldataByEntrypoint.is_valid_signature[0])).toBe(BigInt(expectedHash));
  });
});

// ---------------------------------------------------------------------------
// verify - payload and requirements shape
// ---------------------------------------------------------------------------

describe("ExactStarknetScheme.verify - payload and requirements shape", () => {
  it("rejects a payload without accepted as malformed", async () => {
    const payload = makePayload();
    delete (payload as { accepted?: unknown }).accepted;
    const result = await facilitatorWith(mockProvider()).verify(payload, makeRequirements());
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(CORE.INVALID_PAYLOAD);
    expect(result.invalidMessage).toContain("accepted");
  });

  it("rejects an extra.feePayer whose value is outside the field", async () => {
    const requirements = makeRequirements({ extra: { feePayer: `0x${"f".repeat(64)}` } });
    const result = await facilitatorWith(mockProvider()).verify(
      makePayload({ requirements }),
      requirements,
    );
    expect(result.invalidReason).toBe(CORE.INVALID_PAYMENT_REQUIREMENTS);
    expect(result.invalidMessage).toContain("out of range");
  });
});
