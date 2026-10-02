import { describe, it, expect, beforeEach } from "vitest";
import { ShieldedEvmFacilitator } from "../../../src/shielded/facilitator/scheme.js";
import type {
  ShieldedProvider,
  TransactionReceipt,
  ReplayStore,
} from "../../../src/shielded/types.js";
import type {
  PaymentPayload,
  PaymentRequirements,
} from "@x402/core/types";

const POOL_CONTRACT = "0x26111e2379E5fC0A7Cd8728fe52c7b84CA4fbE85";
const PAY_TO = "0x0cB634602891d5c200C80052a5047374afcE684A";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const TX_HASH = "0x4712f6ad727eb4f72a59bf6e23edeb23589da66edc0166a2223252a5be9459c7";

// ERC-20 Transfer event log from pool contract to payTo
function makeTransferLog(from: string, to: string, amount: bigint, token: string) {
  const fromPadded = "0x" + from.slice(2).toLowerCase().padStart(64, "0");
  const toPadded = "0x" + to.slice(2).toLowerCase().padStart(64, "0");
  const valuePadded = "0x" + amount.toString(16).padStart(64, "0");
  return {
    address: token.toLowerCase(),
    topics: [
      "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
      fromPadded,
      toPadded,
    ],
    data: valuePadded,
  };
}

function makeReceipt(
  status: "success" | "reverted" = "success",
  logs: TransactionReceipt["logs"] = [],
): TransactionReceipt {
  return { status, logs };
}

function makeProvider(receipt: TransactionReceipt | null): ShieldedProvider {
  return {
    getTransactionReceipt: async () => receipt,
  };
}

function makeReplayStore(): ReplayStore & { store: Set<string> } {
  const store = new Set<string>();
  return {
    store,
    has: (key: string) => store.has(key),
    add: (key: string) => { store.add(key); },
  };
}

function makeRequirements(overrides?: Partial<PaymentRequirements>): PaymentRequirements {
  return {
    scheme: "exact",
    network: "eip155:8453" as `${string}:${string}`,
    asset: USDC,
    amount: "1000000", // 1 USDC
    payTo: PAY_TO,
    maxTimeoutSeconds: 120,
    extra: {
      assetTransferMethod: "shielded",
      poolContracts: [POOL_CONTRACT],
    },
    ...overrides,
  };
}

function makePayload(txHash: string = TX_HASH, nullifiers?: string[]): PaymentPayload {
  return {
    x402Version: 2,
    accepted: makeRequirements(),
    payload: {
      txHash,
      ...(nullifiers ? { nullifiers } : {}),
    },
  };
}

describe("ShieldedEvmFacilitator", () => {
  let replayStore: ReplayStore & { store: Set<string> };

  beforeEach(() => {
    replayStore = makeReplayStore();
  });

  describe("verify", () => {
    it("accepts valid transfer from pool to payTo", async () => {
      const log = makeTransferLog(POOL_CONTRACT, PAY_TO, 1000000n, USDC);
      const provider = makeProvider(makeReceipt("success", [log]));
      const facilitator = new ShieldedEvmFacilitator({
        provider,
        poolContracts: { 8453: [POOL_CONTRACT] },
        replayStore,
      });

      const result = await facilitator.verify(makePayload(), makeRequirements());
      expect(result.isValid).toBe(true);
      expect(result.payer).toBe(POOL_CONTRACT.toLowerCase());
    });

    it("rejects invalid txHash format", async () => {
      const provider = makeProvider(null);
      const facilitator = new ShieldedEvmFacilitator({
        provider,
        poolContracts: { 8453: [POOL_CONTRACT] },
        replayStore,
      });

      const result = await facilitator.verify(
        makePayload("not-a-hash"),
        makeRequirements(),
      );
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_tx_hash");
    });

    it("rejects reverted transaction", async () => {
      const provider = makeProvider(makeReceipt("reverted"));
      const facilitator = new ShieldedEvmFacilitator({
        provider,
        poolContracts: { 8453: [POOL_CONTRACT] },
        replayStore,
      });

      const result = await facilitator.verify(makePayload(), makeRequirements());
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("transaction_reverted");
    });

    it("rejects if transaction not found", async () => {
      const provider = makeProvider(null);
      const facilitator = new ShieldedEvmFacilitator({
        provider,
        poolContracts: { 8453: [POOL_CONTRACT] },
        replayStore,
      });

      const result = await facilitator.verify(makePayload(), makeRequirements());
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("transaction_not_found");
    });

    it("rejects if no Transfer from pool contract", async () => {
      const log = makeTransferLog(
        "0x0000000000000000000000000000000000000001", // not the pool
        PAY_TO,
        1000000n,
        USDC,
      );
      const provider = makeProvider(makeReceipt("success", [log]));
      const facilitator = new ShieldedEvmFacilitator({
        provider,
        poolContracts: { 8453: [POOL_CONTRACT] },
        replayStore,
      });

      const result = await facilitator.verify(makePayload(), makeRequirements());
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("no_matching_transfer");
    });

    it("rejects if Transfer to wrong address", async () => {
      const log = makeTransferLog(
        POOL_CONTRACT,
        "0x0000000000000000000000000000000000000002", // wrong recipient
        1000000n,
        USDC,
      );
      const provider = makeProvider(makeReceipt("success", [log]));
      const facilitator = new ShieldedEvmFacilitator({
        provider,
        poolContracts: { 8453: [POOL_CONTRACT] },
        replayStore,
      });

      const result = await facilitator.verify(makePayload(), makeRequirements());
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("no_matching_transfer");
    });

    it("rejects if Transfer amount too low", async () => {
      const log = makeTransferLog(POOL_CONTRACT, PAY_TO, 999999n, USDC); // 1 micro short
      const provider = makeProvider(makeReceipt("success", [log]));
      const facilitator = new ShieldedEvmFacilitator({
        provider,
        poolContracts: { 8453: [POOL_CONTRACT] },
        replayStore,
      });

      const result = await facilitator.verify(makePayload(), makeRequirements());
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("no_matching_transfer");
    });

    it("accepts Transfer with amount greater than required", async () => {
      const log = makeTransferLog(POOL_CONTRACT, PAY_TO, 2000000n, USDC); // 2 USDC > 1 required
      const provider = makeProvider(makeReceipt("success", [log]));
      const facilitator = new ShieldedEvmFacilitator({
        provider,
        poolContracts: { 8453: [POOL_CONTRACT] },
        replayStore,
      });

      const result = await facilitator.verify(makePayload(), makeRequirements());
      expect(result.isValid).toBe(true);
    });

    it("rejects replayed txHash", async () => {
      const log = makeTransferLog(POOL_CONTRACT, PAY_TO, 1000000n, USDC);
      const provider = makeProvider(makeReceipt("success", [log]));
      const facilitator = new ShieldedEvmFacilitator({
        provider,
        poolContracts: { 8453: [POOL_CONTRACT] },
        replayStore,
      });

      // First call succeeds
      const result1 = await facilitator.verify(makePayload(), makeRequirements());
      expect(result1.isValid).toBe(true);

      // Second call with same txHash rejected
      const result2 = await facilitator.verify(makePayload(), makeRequirements());
      expect(result2.isValid).toBe(false);
      expect(result2.invalidReason).toBe("tx_already_used");
    });

    it("rejects if Transfer event is for wrong token", async () => {
      const log = makeTransferLog(
        POOL_CONTRACT,
        PAY_TO,
        1000000n,
        "0x0000000000000000000000000000000000000099", // wrong token
      );
      const provider = makeProvider(makeReceipt("success", [log]));
      const facilitator = new ShieldedEvmFacilitator({
        provider,
        poolContracts: { 8453: [POOL_CONTRACT] },
        replayStore,
      });

      const result = await facilitator.verify(makePayload(), makeRequirements());
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("no_matching_transfer");
    });

    it("rejects replayed nullifier", async () => {
      const log = makeTransferLog(POOL_CONTRACT, PAY_TO, 1000000n, USDC);
      const provider = makeProvider(makeReceipt("success", [log]));
      const facilitator = new ShieldedEvmFacilitator({
        provider,
        poolContracts: { 8453: [POOL_CONTRACT] },
        replayStore,
      });

      const TX_HASH_2 = "0x" + "bb".repeat(32);
      const NULLIFIER = "0x" + "cc".repeat(32);

      // First with nullifier succeeds
      const result1 = await facilitator.verify(
        makePayload(TX_HASH, [NULLIFIER]),
        makeRequirements(),
      );
      expect(result1.isValid).toBe(true);

      // Different txHash but same nullifier — rejected
      const result2 = await facilitator.verify(
        makePayload(TX_HASH_2, [NULLIFIER]),
        makeRequirements(),
      );
      expect(result2.isValid).toBe(false);
      expect(result2.invalidReason).toBe("tx_already_used");
    });
  });

  describe("settle", () => {
    it("returns txHash after re-verification (client-driven)", async () => {
      const log = makeTransferLog(POOL_CONTRACT, PAY_TO, 1000000n, USDC);
      const provider = makeProvider(makeReceipt("success", [log]));
      const facilitator = new ShieldedEvmFacilitator({
        provider,
        poolContracts: { 8453: [POOL_CONTRACT] },
        replayStore,
      });

      const result = await facilitator.settle(makePayload(), makeRequirements());
      expect(result.success).toBe(true);
      expect(result.transaction).toBe(TX_HASH);
      expect(result.network).toBe("eip155:8453");
    });

    it("fails settle if verification fails", async () => {
      const provider = makeProvider(makeReceipt("reverted"));
      const facilitator = new ShieldedEvmFacilitator({
        provider,
        poolContracts: { 8453: [POOL_CONTRACT] },
        replayStore,
      });

      const result = await facilitator.settle(makePayload(), makeRequirements());
      expect(result.success).toBe(false);
      expect(result.errorReason).toBe("transaction_reverted");
    });
  });

  describe("getExtra", () => {
    it("returns pool contracts for supported network", () => {
      const provider = makeProvider(null);
      const facilitator = new ShieldedEvmFacilitator({
        provider,
        poolContracts: { 8453: [POOL_CONTRACT] },
        replayStore,
      });

      const extra = facilitator.getExtra("eip155:8453");
      expect(extra).toEqual({
        assetTransferMethod: "shielded",
        poolContracts: [POOL_CONTRACT],
      });
    });

    it("returns undefined for unsupported network", () => {
      const provider = makeProvider(null);
      const facilitator = new ShieldedEvmFacilitator({
        provider,
        poolContracts: { 8453: [POOL_CONTRACT] },
        replayStore,
      });

      const extra = facilitator.getExtra("eip155:999999");
      expect(extra).toBeUndefined();
    });
  });

  describe("getSigners", () => {
    it("returns empty array (verify-only, no facilitator signers)", () => {
      const provider = makeProvider(null);
      const facilitator = new ShieldedEvmFacilitator({
        provider,
        poolContracts: { 8453: [POOL_CONTRACT] },
        replayStore,
      });

      expect(facilitator.getSigners("eip155:8453")).toEqual([]);
    });
  });
});
