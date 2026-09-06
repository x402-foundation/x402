import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Beef, P2PKH, PrivateKey, Script, Transaction, Utils } from "@bsv/sdk";
import type { WalletInterface } from "@bsv/sdk";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { ExactBsvScheme } from "../../src/exact/facilitator/scheme";
import { BRC29_PROTOCOL_ID, BSV_TESTNET_CAIP2 } from "../../src/constants";
import type { ExactBsvPayloadV2 } from "../../src/types";

const IDENTITY_KEY = PrivateKey.fromRandom().toPublicKey().toString();
const SENDER_KEY = PrivateKey.fromRandom().toPublicKey().toString();
// The BRC-42-derived per-payment key the mock wallet reports (forSelf)
const DERIVED_PRIV = PrivateKey.fromRandom();
const DERIVED_KEY = DERIVED_PRIV.toPublicKey().toString();
const NOW = 1_700_000_000_000;

/**
 * Builds a transaction paying the derived key (one output per amount).
 *
 * @param outputSatoshis - Satoshis per output
 * @returns The transaction
 */
function makeTx(...outputSatoshis: number[]): Transaction {
  const tx = new Transaction();
  tx.addInput({
    sourceTXID: "0".repeat(64),
    sourceOutputIndex: 0xffffffff,
    unlockingScript: Script.fromHex("00"),
    sequence: 0xffffffff,
  });
  for (const satoshis of outputSatoshis) {
    tx.addOutput({
      lockingScript: new P2PKH().lock(DERIVED_PRIV.toPublicKey().toAddress()),
      satoshis,
    });
  }
  return tx;
}

/**
 * Builds a minimal valid BEEF containing one transaction paying the
 * derived key.
 *
 * @param outputSatoshis - Satoshis per output (one output each)
 * @returns Base64 BEEF and the subject txid
 */
function makeBeef(...outputSatoshis: number[]): { beefBase64: string; txid: string } {
  const tx = makeTx(...outputSatoshis);
  const beef = new Beef();
  beef.mergeTransaction(tx);
  return { beefBase64: Utils.toBase64(beef.toBinary()), txid: tx.id("hex") };
}

/**
 * Builds a mock recipient wallet.
 *
 * @param opts - Wallet behavior flags
 * @returns A mock BRC-100 wallet
 */
function makeWallet(
  opts: { isMerge?: boolean; accepted?: boolean; derivedKey?: string; network?: string } = {},
): WalletInterface {
  return {
    internalizeAction: vi
      .fn()
      .mockResolvedValue({ accepted: opts.accepted ?? true, isMerge: opts.isMerge ?? false }),
    getPublicKey: vi.fn().mockImplementation(async (args: { identityKey?: boolean }) => {
      if (args.identityKey) return { publicKey: IDENTITY_KEY };
      return { publicKey: opts.derivedKey ?? DERIVED_KEY };
    }),
    getNetwork: vi.fn().mockResolvedValue({ network: opts.network ?? "testnet" }),
  } as unknown as WalletInterface;
}

/**
 * Builds valid payment requirements.
 *
 * @param overrides - Field overrides
 * @returns Payment requirements
 */
function makeRequirements(overrides: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    scheme: "exact",
    network: BSV_TESTNET_CAIP2,
    asset: "BSV",
    amount: "1000",
    payTo: IDENTITY_KEY,
    maxTimeoutSeconds: 300,
    extra: {},
    ...overrides,
  };
}

/**
 * Builds a valid scheme-specific payload.
 *
 * @param beefBase64 - Base64 BEEF transaction
 * @param overrides - Field overrides
 * @returns BSV payload
 */
function makeBsvPayload(
  beefBase64: string,
  overrides: Partial<ExactBsvPayloadV2> = {},
): ExactBsvPayloadV2 {
  return {
    transaction: beefBase64,
    derivationPrefix: Utils.toBase64([1, 2, 3, 4, 5, 6, 7, 8]),
    derivationSuffix: Utils.toBase64(Utils.toArray(String(NOW), "utf8")),
    senderIdentityKey: SENDER_KEY,
    outputIndex: 0,
    ...overrides,
  };
}

/**
 * Wraps a BSV payload in a full x402 PaymentPayload.
 *
 * @param bsvPayload - The scheme-specific payload
 * @param requirements - The accepted requirements
 * @returns A full x402 PaymentPayload
 */
function makePayload(
  bsvPayload: ExactBsvPayloadV2,
  requirements: PaymentRequirements = makeRequirements(),
): PaymentPayload {
  return {
    x402Version: 2,
    accepted: requirements,
    payload: bsvPayload as unknown as PaymentPayload["payload"],
  };
}

/**
 * Builds a facilitator scheme with a mock wallet.
 *
 * @param opts - Wallet behavior flags
 * @returns Scheme and wallet
 */
function makeScheme(
  opts: {
    isMerge?: boolean;
    accepted?: boolean;
    derivedKey?: string;
    network?: string;
    paymentWindowMs?: number;
  } = {},
): {
  scheme: ExactBsvScheme;
  wallet: WalletInterface;
} {
  const wallet = makeWallet(opts);
  const scheme = new ExactBsvScheme({
    wallet,
    identityKey: IDENTITY_KEY,
    paymentWindowMs: opts.paymentWindowMs,
  });
  return { scheme, wallet };
}

describe("ExactBsvScheme (facilitator)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("exposes scheme, caipFamily, and the identity key as signer", () => {
    const { scheme } = makeScheme();
    expect(scheme.scheme).toBe("exact");
    expect(scheme.caipFamily).toBe("bsv:*");
    expect(scheme.getSigners(BSV_TESTNET_CAIP2)).toEqual([IDENTITY_KEY.toLowerCase()]);
    expect(scheme.getExtra(BSV_TESTNET_CAIP2)).toBeUndefined();
  });

  it("rejects construction with an invalid identity key", () => {
    expect(() => new ExactBsvScheme({ wallet: makeWallet(), identityKey: "nope" })).toThrow(
      /identityKey/,
    );
  });

  it("create() fetches the identity key from the wallet", async () => {
    const wallet = makeWallet();
    const scheme = await ExactBsvScheme.create({ wallet });
    expect(scheme.getSigners(BSV_TESTNET_CAIP2)).toEqual([IDENTITY_KEY.toLowerCase()]);
    expect(wallet.getPublicKey).toHaveBeenCalledWith({ identityKey: true });
  });

  describe("verify", () => {
    it("accepts a valid payment", async () => {
      const { scheme } = makeScheme();
      const { beefBase64 } = makeBeef(1000);
      const result = await scheme.verify(
        makePayload(makeBsvPayload(beefBase64)),
        makeRequirements(),
      );
      expect(result).toEqual({ isValid: true, payer: SENDER_KEY });
    });

    it("derives the destination with BRC-29 protocol, sender counterparty, and forSelf", async () => {
      const { scheme, wallet } = makeScheme();
      const { beefBase64 } = makeBeef(1000);
      const bsvPayload = makeBsvPayload(beefBase64);
      await scheme.verify(makePayload(bsvPayload), makeRequirements());
      expect(wallet.getPublicKey).toHaveBeenCalledWith({
        protocolID: BRC29_PROTOCOL_ID,
        keyID: `${bsvPayload.derivationPrefix} ${bsvPayload.derivationSuffix}`,
        counterparty: SENDER_KEY,
        forSelf: true,
      });
    });

    it("rejects a payment whose output does not pay the derived key", async () => {
      const otherKey = PrivateKey.fromRandom().toPublicKey().toString();
      const { scheme } = makeScheme({ derivedKey: otherKey });
      const { beefBase64 } = makeBeef(1000);
      const result = await scheme.verify(
        makePayload(makeBsvPayload(beefBase64)),
        makeRequirements(),
      );
      expect(result.invalidReason).toBe("invalid_exact_bsv_payload_destination_mismatch");
    });

    it("reports derivation failure when the wallet cannot derive the key", async () => {
      const { scheme, wallet } = makeScheme();
      vi.mocked(wallet.getPublicKey).mockRejectedValue(new Error("no key"));
      const { beefBase64 } = makeBeef(1000);
      const result = await scheme.verify(
        makePayload(makeBsvPayload(beefBase64)),
        makeRequirements(),
      );
      expect(result.invalidReason).toBe("invalid_exact_bsv_payload_destination_derivation_failed");
    });

    it("rejects when the wallet operates on a different network", async () => {
      const { scheme } = makeScheme({ network: "mainnet" });
      const { beefBase64 } = makeBeef(1000);
      const result = await scheme.verify(
        makePayload(makeBsvPayload(beefBase64)),
        makeRequirements(),
      );
      expect(result.invalidReason).toBe("invalid_network");
    });

    it("rejects a non-exact scheme", async () => {
      const { scheme } = makeScheme();
      const { beefBase64 } = makeBeef(1000);
      const result = await scheme.verify(
        makePayload(makeBsvPayload(beefBase64)),
        makeRequirements({ scheme: "upto" }),
      );
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("unsupported_scheme");
    });

    it("rejects a network mismatch between accepted and requirements", async () => {
      const { scheme } = makeScheme();
      const { beefBase64 } = makeBeef(1000);
      const result = await scheme.verify(
        makePayload(makeBsvPayload(beefBase64), makeRequirements({ network: "bsv:mainnet" })),
        makeRequirements(),
      );
      expect(result.invalidReason).toBe("invalid_network");
    });

    it("rejects a non-BSV network", async () => {
      const { scheme } = makeScheme();
      const { beefBase64 } = makeBeef(1000);
      const requirements = makeRequirements({ network: "eip155:8453" });
      const result = await scheme.verify(
        makePayload(makeBsvPayload(beefBase64), requirements),
        requirements,
      );
      expect(result.invalidReason).toBe("invalid_network");
    });

    it("accepts payTo in a different hex case", async () => {
      const { scheme } = makeScheme();
      const { beefBase64 } = makeBeef(1000);
      const result = await scheme.verify(
        makePayload(makeBsvPayload(beefBase64)),
        makeRequirements({ payTo: IDENTITY_KEY.toUpperCase() }),
      );
      expect(result.isValid).toBe(true);
    });

    it.each([
      ["transaction", ""],
      ["derivationPrefix", ""],
      ["derivationSuffix", ""],
      ["outputIndex", -1],
      ["outputIndex", 1.5],
    ] as const)("rejects payload with bad %s", async (field, value) => {
      const { scheme } = makeScheme();
      const { beefBase64 } = makeBeef(1000);
      const payload = makeBsvPayload(beefBase64, { [field]: value } as Partial<ExactBsvPayloadV2>);
      const result = await scheme.verify(makePayload(payload), makeRequirements());
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_exact_bsv_payload_format");
    });

    it("rejects a malformed sender identity key", async () => {
      const { scheme } = makeScheme();
      const { beefBase64 } = makeBeef(1000);
      const payload = makeBsvPayload(beefBase64, { senderIdentityKey: "not-a-key" });
      const result = await scheme.verify(makePayload(payload), makeRequirements());
      expect(result.invalidReason).toBe("invalid_exact_bsv_payload_sender_key");
    });

    it("rejects when payTo is not this facilitator's wallet identity key", async () => {
      const { scheme } = makeScheme();
      const { beefBase64 } = makeBeef(1000);
      const otherKey = PrivateKey.fromRandom().toPublicKey().toString();
      const result = await scheme.verify(
        makePayload(makeBsvPayload(beefBase64)),
        makeRequirements({ payTo: otherKey }),
      );
      expect(result.invalidReason).toBe("invalid_exact_bsv_payload_payee_mismatch");
    });

    it("rejects a derivation suffix that is not a base64 timestamp", async () => {
      const { scheme } = makeScheme();
      const { beefBase64 } = makeBeef(1000);
      const payload = makeBsvPayload(beefBase64, {
        derivationSuffix: Utils.toBase64(Utils.toArray("hello", "utf8")),
      });
      const result = await scheme.verify(makePayload(payload), makeRequirements());
      expect(result.invalidReason).toBe("invalid_exact_bsv_payload_timestamp");
    });

    it.each([
      ["stale", NOW - 30_001],
      ["future", NOW + 30_001],
    ])("rejects a %s timestamp outside the verify window", async (_, timestamp) => {
      const { scheme } = makeScheme();
      const { beefBase64 } = makeBeef(1000);
      const payload = makeBsvPayload(beefBase64, {
        derivationSuffix: Utils.toBase64(Utils.toArray(String(timestamp), "utf8")),
      });
      const result = await scheme.verify(makePayload(payload), makeRequirements());
      expect(result.invalidReason).toBe("invalid_exact_bsv_payload_timestamp_out_of_window");
    });

    it("accepts a timestamp just inside the window", async () => {
      const { scheme } = makeScheme();
      const { beefBase64 } = makeBeef(1000);
      const payload = makeBsvPayload(beefBase64, {
        derivationSuffix: Utils.toBase64(Utils.toArray(String(NOW - 29_999), "utf8")),
      });
      const result = await scheme.verify(makePayload(payload), makeRequirements());
      expect(result.isValid).toBe(true);
    });

    it("does not extend the verify window by maxTimeoutSeconds", async () => {
      const { scheme } = makeScheme();
      const { beefBase64 } = makeBeef(1000);
      const payload = makeBsvPayload(beefBase64, {
        derivationSuffix: Utils.toBase64(Utils.toArray(String(NOW - 60_000), "utf8")),
      });
      const result = await scheme.verify(
        makePayload(payload),
        makeRequirements({ maxTimeoutSeconds: 300 }),
      );
      expect(result.invalidReason).toBe("invalid_exact_bsv_payload_timestamp_out_of_window");
    });

    it("respects a custom payment window", async () => {
      const { scheme } = makeScheme({ paymentWindowMs: 5_000 });
      const { beefBase64 } = makeBeef(1000);
      const payload = makeBsvPayload(beefBase64, {
        derivationSuffix: Utils.toBase64(Utils.toArray(String(NOW - 6_000), "utf8")),
      });
      const result = await scheme.verify(makePayload(payload), makeRequirements());
      expect(result.invalidReason).toBe("invalid_exact_bsv_payload_timestamp_out_of_window");
    });

    it("rejects an undecodable BEEF", async () => {
      const { scheme } = makeScheme();
      const payload = makeBsvPayload(Utils.toBase64([1, 2, 3]));
      const result = await scheme.verify(makePayload(payload), makeRequirements());
      expect(result.invalidReason).toBe("invalid_exact_bsv_payload_transaction");
    });

    it("rejects an out-of-bounds output index", async () => {
      const { scheme } = makeScheme();
      const { beefBase64 } = makeBeef(1000);
      const payload = makeBsvPayload(beefBase64, { outputIndex: 3 });
      const result = await scheme.verify(makePayload(payload), makeRequirements());
      expect(result.invalidReason).toBe("invalid_exact_bsv_payload_output_missing");
    });

    it("validates the output at the declared index, not index 0", async () => {
      const { scheme } = makeScheme();
      const { beefBase64 } = makeBeef(50, 1000);
      const payload = makeBsvPayload(beefBase64, { outputIndex: 1 });
      const result = await scheme.verify(makePayload(payload), makeRequirements());
      expect(result.isValid).toBe(true);
    });

    it("validates the Atomic BEEF subject, not the last transaction", async () => {
      // Payment tx (correct amount) + an unrelated decoy tx merged after it.
      const paymentTx = makeTx(1000);
      const decoyTx = makeTx(5);
      const beef = new Beef();
      beef.mergeTransaction(paymentTx);
      beef.mergeTransaction(decoyTx);
      const atomic = beef.toBinaryAtomic(paymentTx.id("hex"));

      const { scheme } = makeScheme();
      const payload = makeBsvPayload(Utils.toBase64(atomic));
      const result = await scheme.verify(makePayload(payload), makeRequirements());
      expect(result.isValid).toBe(true);
    });

    it.each([
      ["underpayment", 999],
      ["overpayment", 1001],
    ])("rejects %s (exact semantics)", async (_, satoshis) => {
      const { scheme } = makeScheme();
      const { beefBase64 } = makeBeef(satoshis);
      const result = await scheme.verify(
        makePayload(makeBsvPayload(beefBase64)),
        makeRequirements(),
      );
      expect(result.invalidReason).toBe("invalid_exact_bsv_payload_amount_mismatch");
    });

    it("rejects a non-P2PKH payment output", async () => {
      const tx = new Transaction();
      tx.addInput({
        sourceTXID: "0".repeat(64),
        sourceOutputIndex: 0xffffffff,
        unlockingScript: Script.fromHex("00"),
        sequence: 0xffffffff,
      });
      tx.addOutput({ lockingScript: Script.fromHex("006a0474657374"), satoshis: 1000 });
      const beef = new Beef();
      beef.mergeTransaction(tx);
      const { scheme } = makeScheme();
      const payload = makeBsvPayload(Utils.toBase64(beef.toBinary()));
      const result = await scheme.verify(makePayload(payload), makeRequirements());
      expect(result.invalidReason).toBe("invalid_exact_bsv_payload_script");
    });

    it("rejects a non-integer required amount", async () => {
      const { scheme } = makeScheme();
      const { beefBase64 } = makeBeef(1000);
      const requirements = makeRequirements({ amount: "1.5" });
      const result = await scheme.verify(
        makePayload(makeBsvPayload(beefBase64), requirements),
        requirements,
      );
      expect(result.invalidReason).toBe("invalid_payment_requirements");
    });

    it("never internalizes during verify", async () => {
      const { scheme, wallet } = makeScheme();
      const { beefBase64 } = makeBeef(1000);
      await scheme.verify(makePayload(makeBsvPayload(beefBase64)), makeRequirements());
      expect(wallet.internalizeAction).not.toHaveBeenCalled();
    });

    it("rejects a non-BSV requirements asset", async () => {
      const { scheme } = makeScheme();
      const { beefBase64 } = makeBeef(1000);
      const requirements = makeRequirements({ asset: "USDC" });
      const result = await scheme.verify(
        makePayload(makeBsvPayload(beefBase64), requirements),
        requirements,
      );
      expect(result.invalidReason).toBe("invalid_exact_bsv_payload_asset");
    });

    it("rejects a derivation prefix shorter than 8 bytes", async () => {
      const { scheme } = makeScheme();
      const { beefBase64 } = makeBeef(1000);
      const payload = makeBsvPayload(beefBase64, {
        derivationPrefix: Utils.toBase64([1, 2, 3]),
      });
      const result = await scheme.verify(makePayload(payload), makeRequirements());
      expect(result.invalidReason).toBe("invalid_exact_bsv_payload_derivation_prefix");
    });

    describe("spvOnVerify", () => {
      it("passes the BEEF and txid to the SPV callback and accepts when it returns true", async () => {
        const wallet = makeWallet();
        const spv = vi.fn().mockResolvedValue(true);
        const scheme = new ExactBsvScheme({ wallet, identityKey: IDENTITY_KEY, spvOnVerify: spv });
        const { beefBase64, txid } = makeBeef(1000);
        const result = await scheme.verify(
          makePayload(makeBsvPayload(beefBase64)),
          makeRequirements(),
        );
        expect(result.isValid).toBe(true);
        expect(spv).toHaveBeenCalledWith(Utils.toArray(beefBase64, "base64"), txid);
      });

      it("rejects when the SPV callback returns false", async () => {
        const wallet = makeWallet();
        const scheme = new ExactBsvScheme({
          wallet,
          identityKey: IDENTITY_KEY,
          spvOnVerify: vi.fn().mockResolvedValue(false),
        });
        const { beefBase64 } = makeBeef(1000);
        const result = await scheme.verify(
          makePayload(makeBsvPayload(beefBase64)),
          makeRequirements(),
        );
        expect(result.invalidReason).toBe("invalid_exact_bsv_payload_spv");
      });

      it("rejects when the SPV callback throws", async () => {
        const wallet = makeWallet();
        const scheme = new ExactBsvScheme({
          wallet,
          identityKey: IDENTITY_KEY,
          spvOnVerify: vi.fn().mockRejectedValue(new Error("headers unavailable")),
        });
        const { beefBase64 } = makeBeef(1000);
        const result = await scheme.verify(
          makePayload(makeBsvPayload(beefBase64)),
          makeRequirements(),
        );
        expect(result.invalidReason).toBe("invalid_exact_bsv_payload_spv");
      });
    });
  });

  describe("settle", () => {
    it("internalizes the payment with BRC-29 remittance and returns the txid", async () => {
      const { scheme, wallet } = makeScheme();
      const { beefBase64, txid } = makeBeef(1000);
      const bsvPayload = makeBsvPayload(beefBase64);
      const result = await scheme.settle(makePayload(bsvPayload), makeRequirements());

      expect(result.success).toBe(true);
      expect(result.transaction).toBe(txid);
      expect(result.network).toBe(BSV_TESTNET_CAIP2);
      expect(result.payer).toBe(SENDER_KEY);

      expect(wallet.internalizeAction).toHaveBeenCalledWith(
        expect.objectContaining({
          tx: Utils.toArray(beefBase64, "base64"),
          outputs: [
            {
              outputIndex: 0,
              protocol: "wallet payment",
              paymentRemittance: {
                derivationPrefix: bsvPayload.derivationPrefix,
                derivationSuffix: bsvPayload.derivationSuffix,
                senderIdentityKey: SENDER_KEY,
              },
            },
          ],
        }),
      );
    });

    it("extends the freshness window by maxTimeoutSeconds at settle time", async () => {
      const { scheme } = makeScheme();
      const { beefBase64 } = makeBeef(1000);
      // 60s old: fails verify (30s window) but settles within 30s + 300s.
      const payload = makeBsvPayload(beefBase64, {
        derivationSuffix: Utils.toBase64(Utils.toArray(String(NOW - 60_000), "utf8")),
      });
      const verifyResult = await scheme.verify(makePayload(payload), makeRequirements());
      expect(verifyResult.isValid).toBe(false);
      const settleResult = await scheme.settle(makePayload(payload), makeRequirements());
      expect(settleResult.success).toBe(true);
    });

    it("rejects settlement beyond the extended window", async () => {
      const { scheme } = makeScheme();
      const { beefBase64 } = makeBeef(1000);
      const payload = makeBsvPayload(beefBase64, {
        derivationSuffix: Utils.toBase64(Utils.toArray(String(NOW - 331_000), "utf8")),
      });
      const result = await scheme.settle(makePayload(payload), makeRequirements());
      expect(result.success).toBe(false);
      expect(result.errorReason).toBe("invalid_exact_bsv_payload_timestamp_out_of_window");
    });

    it("fails without touching the wallet when verification fails", async () => {
      const { scheme, wallet } = makeScheme();
      const { beefBase64 } = makeBeef(999);
      const result = await scheme.settle(
        makePayload(makeBsvPayload(beefBase64)),
        makeRequirements(),
      );
      expect(result.success).toBe(false);
      expect(result.errorReason).toBe("invalid_exact_bsv_payload_amount_mismatch");
      expect(result.transaction).toBe("");
      expect(wallet.internalizeAction).not.toHaveBeenCalled();
    });

    it("reports an isMerge replay with no new satoshis as duplicate_settlement", async () => {
      const { scheme } = makeScheme({ isMerge: true });
      const { beefBase64 } = makeBeef(1000);
      const result = await scheme.settle(
        makePayload(makeBsvPayload(beefBase64)),
        makeRequirements(),
      );
      expect(result.success).toBe(false);
      expect(result.errorReason).toBe("duplicate_settlement");
      expect(result.transaction).toBe("");
    });

    it("accepts isMerge when newly internalized satoshis are reported (self-payment)", async () => {
      const { scheme, wallet } = makeScheme({ isMerge: true });
      vi.mocked(wallet.internalizeAction).mockResolvedValueOnce({
        accepted: true,
        isMerge: true,
        satoshis: 1000,
      });
      const { beefBase64, txid } = makeBeef(1000);
      const result = await scheme.settle(
        makePayload(makeBsvPayload(beefBase64)),
        makeRequirements(),
      );
      expect(result.success).toBe(true);
      expect(result.transaction).toBe(txid);
    });

    it("rejects a second settlement of the same txid via the dedup cache", async () => {
      const { scheme, wallet } = makeScheme();
      const { beefBase64 } = makeBeef(1000);
      const first = await scheme.settle(
        makePayload(makeBsvPayload(beefBase64)),
        makeRequirements(),
      );
      expect(first.success).toBe(true);
      const second = await scheme.settle(
        makePayload(makeBsvPayload(beefBase64)),
        makeRequirements(),
      );
      expect(second.success).toBe(false);
      expect(second.errorReason).toBe("duplicate_settlement");
      expect(wallet.internalizeAction).toHaveBeenCalledTimes(1);
    });

    it("allows retry after a wallet exception", async () => {
      const { scheme, wallet } = makeScheme();
      vi.mocked(wallet.internalizeAction).mockRejectedValueOnce(new Error("transient"));
      const { beefBase64 } = makeBeef(1000);
      const failed = await scheme.settle(
        makePayload(makeBsvPayload(beefBase64)),
        makeRequirements(),
      );
      expect(failed.success).toBe(false);
      expect(failed.errorReason).toContain("settlement_failed");
      const retried = await scheme.settle(
        makePayload(makeBsvPayload(beefBase64)),
        makeRequirements(),
      );
      expect(retried.success).toBe(true);
    });

    it("reports wallet rejection", async () => {
      const { scheme } = makeScheme({ accepted: false });
      const { beefBase64 } = makeBeef(1000);
      const result = await scheme.settle(
        makePayload(makeBsvPayload(beefBase64)),
        makeRequirements(),
      );
      expect(result.success).toBe(false);
      expect(result.errorReason).toBe("settlement_rejected_by_wallet");
    });

    it("allows retry after a soft rejection (accepted: false rolls back the dedup mark)", async () => {
      const wallet = makeWallet();
      vi.mocked(wallet.internalizeAction).mockResolvedValueOnce({
        accepted: false,
        isMerge: false,
      });
      const scheme = new ExactBsvScheme({ wallet, identityKey: IDENTITY_KEY });
      const { beefBase64, txid } = makeBeef(1000);
      const payload = makePayload(makeBsvPayload(beefBase64));

      const first = await scheme.settle(payload, makeRequirements());
      expect(first.success).toBe(false);
      expect(first.errorReason).toBe("settlement_rejected_by_wallet");

      // A retry of the same BEEF must not be falsely reported as a duplicate.
      const second = await scheme.settle(payload, makeRequirements());
      expect(second.success).toBe(true);
      expect(second.transaction).toBe(txid);
      expect(wallet.internalizeAction).toHaveBeenCalledTimes(2);
    });

    it("does not run the SPV callback at settle time", async () => {
      const wallet = makeWallet();
      const spv = vi.fn().mockResolvedValue(true);
      const scheme = new ExactBsvScheme({ wallet, identityKey: IDENTITY_KEY, spvOnVerify: spv });
      const { beefBase64 } = makeBeef(1000);
      const result = await scheme.settle(
        makePayload(makeBsvPayload(beefBase64)),
        makeRequirements(),
      );
      expect(result.success).toBe(true);
      expect(spv).not.toHaveBeenCalled();
    });

    it("serializes concurrent double-settle: one succeeds, one is a duplicate", async () => {
      const { scheme, wallet } = makeScheme();
      const { beefBase64 } = makeBeef(1000);
      const payload = makePayload(makeBsvPayload(beefBase64));

      const [a, b] = await Promise.all([
        scheme.settle(payload, makeRequirements()),
        scheme.settle(payload, makeRequirements()),
      ]);

      expect([a, b].filter(r => r.success)).toHaveLength(1);
      expect([a, b].filter(r => r.errorReason === "duplicate_settlement")).toHaveLength(1);
      expect(wallet.internalizeAction).toHaveBeenCalledTimes(1);
    });

    it("keeps the dedup mark past the fixed floor when maxTimeoutSeconds is large", async () => {
      const { scheme, wallet } = makeScheme();
      const { beefBase64 } = makeBeef(1000);
      const requirements = makeRequirements({ maxTimeoutSeconds: 3600 }); // 1h settle budget
      const payload = makePayload(makeBsvPayload(beefBase64), requirements);

      const first = await scheme.settle(payload, requirements);
      expect(first.success).toBe(true);

      // Past the 600s fixed floor, but still inside the settlement window —
      // a fixed TTL would have let this replay through; the dynamic TTL holds.
      vi.advanceTimersByTime(700_000);
      const second = await scheme.settle(payload, requirements);
      expect(second.success).toBe(false);
      expect(second.errorReason).toBe("duplicate_settlement");
      expect(wallet.internalizeAction).toHaveBeenCalledTimes(1);
    });
  });
});
