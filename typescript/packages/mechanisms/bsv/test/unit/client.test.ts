import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PrivateKey } from "@bsv/sdk";
import type { WalletInterface } from "@bsv/sdk";
import type { PaymentRequirements } from "@x402/core/types";
import { ExactBsvScheme } from "../../src/exact/client/scheme";
import { BSV_TESTNET_CAIP2, BRC29_PROTOCOL_ID } from "../../src/constants";
import type { ExactBsvPayloadV2 } from "../../src/types";

const DERIVED_KEY = PrivateKey.fromRandom().toPublicKey().toString();
const SENDER_KEY = PrivateKey.fromRandom().toPublicKey().toString();
const PAY_TO = PrivateKey.fromRandom().toPublicKey().toString();
const FAKE_TX_BYTES = [1, 2, 3, 4];

/**
 * Builds a minimal mock BRC-100 wallet for client-side tests.
 *
 * @returns A mock wallet with spied getPublicKey/createAction
 */
function makeWallet(): WalletInterface {
  return {
    getPublicKey: vi.fn().mockImplementation(async (args: { identityKey?: boolean }) => {
      if (args.identityKey) return { publicKey: SENDER_KEY };
      return { publicKey: DERIVED_KEY };
    }),
    createAction: vi.fn().mockResolvedValue({ tx: FAKE_TX_BYTES, txid: "ab".repeat(32) }),
  } as unknown as WalletInterface;
}

/**
 * Builds valid payment requirements for the BSV exact scheme.
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
    payTo: PAY_TO,
    maxTimeoutSeconds: 300,
    extra: {},
    ...overrides,
  };
}

describe("ExactBsvScheme (client)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_700_000_000_000));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("has scheme 'exact'", () => {
    expect(new ExactBsvScheme(makeWallet()).scheme).toBe("exact");
  });

  it("returns a payload with all five fields", async () => {
    const scheme = new ExactBsvScheme(makeWallet());
    const result = await scheme.createPaymentPayload(2, makeRequirements());
    const payload = result.payload as unknown as ExactBsvPayloadV2;

    expect(result.x402Version).toBe(2);
    expect(typeof payload.transaction).toBe("string");
    expect(typeof payload.derivationPrefix).toBe("string");
    expect(typeof payload.derivationSuffix).toBe("string");
    expect(payload.senderIdentityKey).toBe(SENDER_KEY);
    expect(payload.outputIndex).toBe(0);
  });

  it("base64-encodes the createAction tx bytes", async () => {
    const scheme = new ExactBsvScheme(makeWallet());
    const result = await scheme.createPaymentPayload(2, makeRequirements());
    const payload = result.payload as unknown as ExactBsvPayloadV2;
    expect(payload.transaction).toBe(Buffer.from(FAKE_TX_BYTES).toString("base64"));
  });

  it("encodes the current Unix-ms timestamp in the derivation suffix", async () => {
    const scheme = new ExactBsvScheme(makeWallet());
    const result = await scheme.createPaymentPayload(2, makeRequirements());
    const payload = result.payload as unknown as ExactBsvPayloadV2;
    const decoded = Buffer.from(payload.derivationSuffix, "base64").toString("utf8");
    expect(decoded).toBe("1700000000000");
  });

  it("derives the payment key with BRC-29 protocol, payTo counterparty, and prefix+suffix keyID", async () => {
    const wallet = makeWallet();
    const scheme = new ExactBsvScheme(wallet);
    const result = await scheme.createPaymentPayload(2, makeRequirements());
    const payload = result.payload as unknown as ExactBsvPayloadV2;

    expect(wallet.getPublicKey).toHaveBeenCalledWith(
      {
        protocolID: BRC29_PROTOCOL_ID,
        keyID: `${payload.derivationPrefix} ${payload.derivationSuffix}`,
        counterparty: PAY_TO,
      },
      undefined,
    );
  });

  it("creates a P2PKH output of exactly the required satoshis at index 0", async () => {
    const wallet = makeWallet();
    const scheme = new ExactBsvScheme(wallet);
    await scheme.createPaymentPayload(2, makeRequirements({ amount: "1234" }));

    const args = vi.mocked(wallet.createAction).mock.calls[0][0];
    expect(args.outputs).toHaveLength(1);
    expect(args.outputs![0].satoshis).toBe(1234);
    expect(args.outputs![0].lockingScript).toMatch(/^76a914[0-9a-f]{40}88ac$/);
    expect(args.options?.randomizeOutputs).toBe(false);
  });

  it("passes the configured originator to every wallet call", async () => {
    const wallet = makeWallet();
    const scheme = new ExactBsvScheme(wallet, { originator: "example.com" });
    await scheme.createPaymentPayload(2, makeRequirements());

    for (const call of vi.mocked(wallet.getPublicKey).mock.calls) {
      expect(call[1]).toBe("example.com");
    }
    expect(vi.mocked(wallet.createAction).mock.calls[0][1]).toBe("example.com");
  });

  it("accepts an empty asset as native BSV", async () => {
    const scheme = new ExactBsvScheme(makeWallet());
    await expect(
      scheme.createPaymentPayload(2, makeRequirements({ asset: "" })),
    ).resolves.toBeDefined();
  });

  it("rejects a non-exact scheme", async () => {
    const scheme = new ExactBsvScheme(makeWallet());
    await expect(
      scheme.createPaymentPayload(2, makeRequirements({ scheme: "upto" })),
    ).rejects.toThrow(/scheme/i);
  });

  it("rejects a non-BSV network", async () => {
    const scheme = new ExactBsvScheme(makeWallet());
    await expect(
      scheme.createPaymentPayload(2, makeRequirements({ network: "eip155:8453" })),
    ).rejects.toThrow(/network/i);
  });

  it("rejects a non-BSV asset", async () => {
    const scheme = new ExactBsvScheme(makeWallet());
    await expect(
      scheme.createPaymentPayload(2, makeRequirements({ asset: "USDC" })),
    ).rejects.toThrow(/asset/i);
  });

  it.each(["", "0", "-5", "1.5", "abc"])("rejects invalid amount %j", async amount => {
    const scheme = new ExactBsvScheme(makeWallet());
    await expect(scheme.createPaymentPayload(2, makeRequirements({ amount }))).rejects.toThrow(
      /amount/i,
    );
  });

  it("rejects an amount above 21M BSV", async () => {
    const scheme = new ExactBsvScheme(makeWallet());
    await expect(
      scheme.createPaymentPayload(2, makeRequirements({ amount: "2100000000000001" })),
    ).rejects.toThrow(/amount/i);
  });

  it("rejects a payTo that is not a compressed public key", async () => {
    const scheme = new ExactBsvScheme(makeWallet());
    await expect(
      scheme.createPaymentPayload(2, makeRequirements({ payTo: "1BitcoinAddress" })),
    ).rejects.toThrow(/payTo/i);
  });

  it("does not call the wallet when validation fails", async () => {
    const wallet = makeWallet();
    const scheme = new ExactBsvScheme(wallet);
    await expect(
      scheme.createPaymentPayload(2, makeRequirements({ amount: "0" })),
    ).rejects.toThrow();
    expect(wallet.getPublicKey).not.toHaveBeenCalled();
    expect(wallet.createAction).not.toHaveBeenCalled();
  });

  it("throws when the wallet returns no transaction", async () => {
    const wallet = makeWallet();
    vi.mocked(wallet.createAction).mockResolvedValue({ txid: "00".repeat(32) } as never);
    const scheme = new ExactBsvScheme(wallet);
    await expect(scheme.createPaymentPayload(2, makeRequirements())).rejects.toThrow(
      /signed transaction/i,
    );
  });
});
