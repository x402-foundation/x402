import { describe, it, expect } from "vitest";
import type { DryRunTransactionBlockResponse } from "@mysten/sui/jsonRpc";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { ExactSuiScheme as ExactSuiFacilitator } from "../../src/exact/facilitator/scheme";
import type { FacilitatorSuiSigner } from "../../src/signer";
import {
  VALID_SINGLE,
  VALID_SINGLE_BALANCE_CHANGES,
  VALID_SPLIT,
  VALID_SPLIT_BALANCE_CHANGES,
  BAD_GAS_PAYING_TX,
  COIN_ONLY,
  COIN_ONLY_BALANCE_CHANGES,
  COIN_ONLY_PAYER,
  TRANSFER_OBJECTS_TX,
  PAYER,
  RECIPIENT_1,
  RECIPIENT_2,
  ASSET,
  NETWORK,
} from "../fixtures/fixtures";

// ─────────────────────────────────────────────────────────────────────────────
// A mock FacilitatorSuiSigner that replays a configured recovered-payer and a
// configured dry-run result, so verify() runs fully OFFLINE. `verifySignature`
// returns the captured payer (the real signature recovers to PAYER on-chain);
// `simulateTransaction` returns the captured balanceChanges + status.
// ─────────────────────────────────────────────────────────────────────────────
function mockSigner(opts: {
  payer?: string;
  recoverThrows?: boolean;
  balanceChanges?: unknown[];
  status?: "success" | "failure";
  statusError?: string;
  /** When true, isTransactionExecuted() returns true (the already-executed replay). */
  alreadyExecuted?: boolean;
  /** Captures the digest passed to executeTransaction() for idempotency assertions. */
  onExecute?: (digest: string) => void;
}): FacilitatorSuiSigner {
  return {
    getAddresses: () => [],
    verifySignature: async () => {
      if (opts.recoverThrows) throw new Error("Signature verification failed");
      return opts.payer ?? PAYER;
    },
    isTransactionExecuted: async () => opts.alreadyExecuted ?? false,
    simulateTransaction: async () =>
      ({
        effects: {
          status: { status: opts.status ?? "success", error: opts.statusError },
        },
        balanceChanges: opts.balanceChanges ?? [],
      }) as unknown as DryRunTransactionBlockResponse,
    executeTransaction: async () => {
      opts.onExecute?.("0xdigest");
      return "0xdigest";
    },
    waitForTransaction: async () => {},
  };
}

function buildPayload(tx: string, sig: string, network = NETWORK): PaymentPayload {
  return {
    x402Version: 2,
    accepted: { scheme: "exact", network } as PaymentRequirements,
    payload: { transaction: tx, signature: sig },
  } as PaymentPayload;
}

function requirements(over: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    scheme: "exact",
    network: NETWORK,
    asset: ASSET,
    amount: "10000",
    payTo: RECIPIENT_1,
    maxTimeoutSeconds: 60,
    extra: {},
    ...over,
  };
}

describe("ExactSuiFacilitator.verify() — step 1: version / scheme / network / shape", () => {
  it("rejects a non-2 x402Version", async () => {
    const f = new ExactSuiFacilitator(mockSigner({}));
    const p = buildPayload(VALID_SINGLE.transaction, VALID_SINGLE.signature);
    p.x402Version = 1;
    const r = await f.verify(p, requirements());
    expect(r.isValid).toBe(false);
    expect(r.invalidReason).toBe("invalid_x402_version");
  });

  it("rejects a non-exact scheme", async () => {
    const f = new ExactSuiFacilitator(mockSigner({}));
    const r = await f.verify(
      buildPayload(VALID_SINGLE.transaction, VALID_SINGLE.signature),
      requirements({ scheme: "upto" }),
    );
    expect(r.invalidReason).toBe("invalid_scheme");
  });

  it("rejects a network mismatch", async () => {
    const f = new ExactSuiFacilitator(mockSigner({}));
    const p = buildPayload(VALID_SINGLE.transaction, VALID_SINGLE.signature, "sui:mainnet");
    const r = await f.verify(p, requirements({ network: NETWORK }));
    expect(r.invalidReason).toBe("invalid_network");
  });

  it("rejects a malformed payload (missing signature)", async () => {
    const f = new ExactSuiFacilitator(mockSigner({}));
    const p = buildPayload(VALID_SINGLE.transaction, "");
    const r = await f.verify(p, requirements());
    expect(r.invalidReason).toBe("invalid_payload");
  });
});

describe("ExactSuiFacilitator.verify() — assetTransferMethod gate", () => {
  it("rejects requirements declaring the coin method", async () => {
    const f = new ExactSuiFacilitator(mockSigner({}));
    const r = await f.verify(
      buildPayload(VALID_SINGLE.transaction, VALID_SINGLE.signature),
      requirements({ extra: { assetTransferMethod: "coin" } }),
    );
    expect(r.isValid).toBe(false);
    expect(r.invalidReason).toBe("invalid_payload");
    expect(r.invalidMessage).toMatch(/unsupported assetTransferMethod: coin/);
  });

  it("rejects an echoed coin method in accepted.extra", async () => {
    const f = new ExactSuiFacilitator(mockSigner({}));
    const p = buildPayload(VALID_SINGLE.transaction, VALID_SINGLE.signature);
    p.accepted.extra = { assetTransferMethod: "coin" };
    const r = await f.verify(p, requirements());
    expect(r.isValid).toBe(false);
    expect(r.invalidReason).toBe("invalid_payload");
  });

  it("accepts a declared address-balance method (full happy path)", async () => {
    const f = new ExactSuiFacilitator(mockSigner({ balanceChanges: VALID_SINGLE_BALANCE_CHANGES }));
    const r = await f.verify(
      buildPayload(VALID_SINGLE.transaction, VALID_SINGLE.signature),
      requirements({ extra: { assetTransferMethod: "address-balance" } }),
    );
    expect(r.isValid).toBe(true);
  });
});

describe("ExactSuiFacilitator.verify() — step 2: signature binding", () => {
  it("rejects when signature verification throws", async () => {
    const f = new ExactSuiFacilitator(mockSigner({ recoverThrows: true }));
    const r = await f.verify(
      buildPayload(VALID_SINGLE.transaction, VALID_SINGLE.signature),
      requirements(),
    );
    expect(r.invalidReason).toBe("invalid_exact_sui_payload_signature");
  });

  it("rejects when the recovered address ≠ the tx sender", async () => {
    const f = new ExactSuiFacilitator(mockSigner({ payer: RECIPIENT_2 }));
    const r = await f.verify(
      buildPayload(VALID_SINGLE.transaction, VALID_SINGLE.signature),
      requirements(),
    );
    expect(r.invalidReason).toBe("invalid_exact_sui_payload_signature");
    expect(r.invalidMessage).toMatch(/≠ tx sender/);
  });
});

describe("ExactSuiFacilitator.verify() — step 3: gasless BCS shape", () => {
  // BAD_GAS_PAYING_TX is a real gas-paying object-write tx: non-zero gasPrice,
  // non-empty gasPayment, AND a non-allowlisted command. The facilitator checks
  // gasPrice first, so it rejects on that branch — the single fixture proves the
  // whole gasless-shape guard fires (the per-branch order is asserted by the
  // gasPrice message; a gasless tx can never carry a gas coin, so the price and
  // payment violations are inseparable on real bytes).
  it("rejects a gas-paying tx (non-zero gasPrice — the gasless-shape guard)", async () => {
    const f = new ExactSuiFacilitator(mockSigner({ payer: PAYER }));
    const r = await f.verify(buildPayload(BAD_GAS_PAYING_TX, "c2ln"), requirements());
    expect(r.invalidReason).toBe("invalid_payload");
    expect(r.invalidMessage).toMatch(/non-zero gasPrice/);
  });
});

describe("ExactSuiFacilitator.verify() — step 3: coin-object plumbing", () => {
  // A coin-object payer (the COMMON case: zero Address Balance) gets a PTB the SDK
  // builds as [SplitCoins, coin::into_balance, balance::send_funds, coin::send_funds].
  // The OLD allowlist rejected it ("disallowed command: SplitCoins") — the facilitator
  // refusing its own client's payloads. It must now PASS the gasless-shape guard while
  // a TransferObjects PTB (the object-leak vector) still REJECTS.
  function coinOnlyReqs(): PaymentRequirements {
    return requirements({ payTo: RECIPIENT_1, amount: "10000" });
  }

  it("ACCEPTS a coin-only payer's [SplitCoins, into_balance, send_funds, …] PTB", async () => {
    const f = new ExactSuiFacilitator(
      mockSigner({ payer: COIN_ONLY_PAYER, balanceChanges: COIN_ONLY_BALANCE_CHANGES }),
    );
    const r = await f.verify(
      buildPayload(COIN_ONLY.transaction, COIN_ONLY.signature),
      coinOnlyReqs(),
    );
    expect(r.isValid, r.invalidMessage).toBe(true);
    expect(r.payer).toBe(COIN_ONLY_PAYER);
  });

  it("REJECTS a gasless-fielded TransferObjects PTB (the object-leak vector)", async () => {
    // TRANSFER_OBJECTS_TX's sender is PAYER, so the mock must recover PAYER to reach
    // the command-shape check (otherwise step 2 rejects on sender≠signer first).
    const f = new ExactSuiFacilitator(mockSigner({ payer: PAYER }));
    const r = await f.verify(buildPayload(TRANSFER_OBJECTS_TX, "c2ln"), coinOnlyReqs());
    expect(r.invalidReason).toBe("invalid_payload");
    expect(r.invalidMessage).toMatch(/disallowed command: TransferObjects/);
  });
});

describe("ExactSuiFacilitator.verify() — step 4: replay guard", () => {
  // PROVEN on-chain: a gasless tx has no object inputs, so re-simulating ALREADY-
  // EXECUTED bytes still SUCCEEDS — simulation is NOT a replay guard. The stateless
  // guard computes the digest from the signed bytes and asks the chain directly.
  it("REJECTS an already-executed transaction (the replay) with invalid_transaction_state", async () => {
    const f = new ExactSuiFacilitator(
      mockSigner({ alreadyExecuted: true, balanceChanges: VALID_SINGLE_BALANCE_CHANGES }),
    );
    const r = await f.verify(
      buildPayload(VALID_SINGLE.transaction, VALID_SINGLE.signature),
      requirements(),
    );
    expect(r.isValid).toBe(false);
    expect(r.invalidReason).toBe("invalid_transaction_state");
    expect(r.invalidMessage).toMatch(/already executed/);
  });

  it("ACCEPTS a not-yet-executed transaction (the replay guard does not false-positive)", async () => {
    const f = new ExactSuiFacilitator(
      mockSigner({ alreadyExecuted: false, balanceChanges: VALID_SINGLE_BALANCE_CHANGES }),
    );
    const r = await f.verify(
      buildPayload(VALID_SINGLE.transaction, VALID_SINGLE.signature),
      requirements(),
    );
    expect(r.isValid, r.invalidMessage).toBe(true);
  });
});

describe("ExactSuiFacilitator.verify() — step 5: simulation", () => {
  it("rejects when simulation fails (expired/insufficient)", async () => {
    const f = new ExactSuiFacilitator(
      mockSigner({ status: "failure", statusError: "InsufficientGas" }),
    );
    const r = await f.verify(
      buildPayload(VALID_SINGLE.transaction, VALID_SINGLE.signature),
      requirements(),
    );
    expect(r.invalidReason).toBe("invalid_transaction_state");
  });
});

describe("ExactSuiFacilitator.verify() — step 5: balance-change match", () => {
  it("ACCEPTS a valid single-output payment (happy path)", async () => {
    const f = new ExactSuiFacilitator(mockSigner({ balanceChanges: VALID_SINGLE_BALANCE_CHANGES }));
    const r = await f.verify(
      buildPayload(VALID_SINGLE.transaction, VALID_SINGLE.signature),
      requirements(),
    );
    expect(r.isValid).toBe(true);
    expect(r.payer).toBe(PAYER);
  });

  it("ACCEPTS a valid two-output split (happy path)", async () => {
    const f = new ExactSuiFacilitator(mockSigner({ balanceChanges: VALID_SPLIT_BALANCE_CHANGES }));
    const reqs = requirements({
      payTo: RECIPIENT_1,
      extra: {
        outputs: [
          { to: RECIPIENT_1, amount: "9800" },
          { to: RECIPIENT_2, amount: "200" },
        ],
      },
    });
    const r = await f.verify(buildPayload(VALID_SPLIT.transaction, VALID_SPLIT.signature), reqs);
    expect(r.isValid).toBe(true);
  });

  it("rejects a single-output recipient mismatch", async () => {
    const f = new ExactSuiFacilitator(mockSigner({ balanceChanges: VALID_SINGLE_BALANCE_CHANGES }));
    const r = await f.verify(
      buildPayload(VALID_SINGLE.transaction, VALID_SINGLE.signature),
      requirements({ payTo: RECIPIENT_2 }), // expected RECIPIENT_2, got RECIPIENT_1
    );
    expect(r.invalidReason).toBe("invalid_exact_sui_payload_recipient_mismatch");
  });

  it("rejects a declared-outputs mismatch (wrong split amount)", async () => {
    const f = new ExactSuiFacilitator(mockSigner({ balanceChanges: VALID_SPLIT_BALANCE_CHANGES }));
    const reqs = requirements({
      extra: {
        outputs: [
          { to: RECIPIENT_1, amount: "9000" }, // chain credited 9800
          { to: RECIPIENT_2, amount: "1000" },
        ],
      },
    });
    const r = await f.verify(buildPayload(VALID_SPLIT.transaction, VALID_SPLIT.signature), reqs);
    expect(r.invalidReason).toBe("invalid_exact_sui_payload_outputs_mismatch");
  });

  it("rejects an undeclared recipient (skim cheat) under declared outputs", async () => {
    const f = new ExactSuiFacilitator(mockSigner({ balanceChanges: VALID_SPLIT_BALANCE_CHANGES }));
    // Declare only RECIPIENT_1 (9800) but amount=10000 — RECIPIENT_2 is undeclared,
    // and the outputs would not sum to amount, so this is a declared-outputs case.
    const reqs = requirements({
      amount: "9800",
      extra: { outputs: [{ to: RECIPIENT_1, amount: "9800" }] },
    });
    const r = await f.verify(buildPayload(VALID_SPLIT.transaction, VALID_SPLIT.signature), reqs);
    expect(r.invalidReason).toBe("invalid_exact_sui_payload_outputs_mismatch");
    expect(r.invalidMessage).toMatch(/undeclared recipient/);
  });

  it("rejects an asset mismatch (no credit in the required asset)", async () => {
    const f = new ExactSuiFacilitator(mockSigner({ balanceChanges: VALID_SINGLE_BALANCE_CHANGES }));
    const r = await f.verify(
      buildPayload(VALID_SINGLE.transaction, VALID_SINGLE.signature),
      requirements({ asset: "0xdeadbeef::other::OTHER" }),
    );
    expect(r.invalidReason).toBe("invalid_exact_sui_payload_recipient_mismatch");
  });
});

describe("ExactSuiFacilitator metadata", () => {
  it("getExtra announces the address-balance method", () => {
    const f = new ExactSuiFacilitator(mockSigner({}));
    expect(f.getExtra(NETWORK)).toEqual({ assetTransferMethod: "address-balance" });
  });

  it("caipFamily is sui:*", () => {
    const f = new ExactSuiFacilitator(mockSigner({}));
    expect(f.caipFamily).toBe("sui:*");
  });

  it("getSigners reflects the broadcast identities (empty when keyless)", () => {
    const f = new ExactSuiFacilitator(mockSigner({}));
    expect(f.getSigners(NETWORK)).toEqual([]);
  });
});

describe("ExactSuiFacilitator.settle()", () => {
  it("does not broadcast when verification fails", async () => {
    const f = new ExactSuiFacilitator(mockSigner({ recoverThrows: true }));
    const r = await f.settle(
      buildPayload(VALID_SINGLE.transaction, VALID_SINGLE.signature),
      requirements(),
    );
    expect(r.success).toBe(false);
    expect(r.transaction).toBe("");
    expect(r.errorReason).toBe("invalid_exact_sui_payload_signature");
  });

  it("returns the digest on a verified settle", async () => {
    const f = new ExactSuiFacilitator(mockSigner({ balanceChanges: VALID_SINGLE_BALANCE_CHANGES }));
    const r = await f.settle(
      buildPayload(VALID_SINGLE.transaction, VALID_SINGLE.signature),
      requirements(),
    );
    expect(r.success).toBe(true);
    expect(r.transaction).toBe("0xdigest");
    expect(r.payer).toBe(PAYER);
  });

  it("is idempotent: an already-executed tx settles to its real digest WITHOUT re-broadcasting", async () => {
    let broadcast = false;
    const f = new ExactSuiFacilitator(
      mockSigner({ alreadyExecuted: true, onExecute: () => (broadcast = true) }),
    );
    const r = await f.settle(
      buildPayload(VALID_SINGLE.transaction, VALID_SINGLE.signature),
      requirements(),
    );
    expect(r.success).toBe(true);
    // The real on-chain digest of VALID_SINGLE's signed bytes (computed offline).
    expect(r.transaction).toBe("DdzsqjvRMntkoeCg1UMzAt93iE4ug9p485YgprUnAPmS");
    expect(broadcast).toBe(false); // never re-broadcasts an executed tx
    expect(r.payer).toBe(PAYER);
  });
});
