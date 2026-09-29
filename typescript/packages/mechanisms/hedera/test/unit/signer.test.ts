import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { proto } from "@hiero-ledger/proto";
import {
  AccountId,
  Client,
  Hbar,
  Key,
  KeyList,
  PrivateKey,
  TokenId,
  TopicCreateTransaction,
  TransactionId,
  TransferTransaction,
} from "@hiero-ledger/sdk";
import {
  createClientHederaSigner,
  createHederaSignAndSubmitTransaction,
  createHederaVerifyPayerSignature,
} from "../../src/signer";
import { inspectHederaTransaction } from "../../src/utils";
import { HEDERA_TESTNET_USDC } from "../../src/constants";

describe("Hedera signer helpers", () => {
  it("creates default SDK-backed client signer", async () => {
    const privateKey = PrivateKey.generateED25519();
    const signer = createClientHederaSigner("0.0.1001", privateKey, {
      network: "hedera:testnet",
    });

    const txBase64 = await signer.createPartiallySignedTransferTransaction({
      scheme: "exact",
      network: "hedera:testnet",
      asset: "0.0.0",
      amount: "1000",
      payTo: "0.0.1002",
      maxTimeoutSeconds: 120,
      extra: {
        feePayer: "0.0.1003",
      },
    });

    expect(typeof txBase64).toBe("string");
    expect(txBase64.length).toBeGreaterThan(0);
  });

  it("creates token transfer transaction for HTS assets", async () => {
    const privateKey = PrivateKey.generateED25519();
    const signer = createClientHederaSigner("0.0.1001", privateKey, {
      network: "hedera:testnet",
    });

    const txBase64 = await signer.createPartiallySignedTransferTransaction({
      scheme: "exact",
      network: "hedera:testnet",
      asset: "0.0.6001",
      amount: "2500",
      payTo: "0.0.1002",
      maxTimeoutSeconds: 120,
      extra: {
        feePayer: "0.0.1003",
      },
    });
    const inspected = inspectHederaTransaction(txBase64);

    expect(inspected.tokenTransfers["0.0.6001"]).toBeDefined();
    expect(inspected.hbarTransfers.length).toBe(0);
  });

  it("requires feePayer in requirements.extra", async () => {
    const privateKey = PrivateKey.generateED25519();
    const signer = createClientHederaSigner("0.0.1001", privateKey, {
      network: "hedera:testnet",
    });

    await expect(
      signer.createPartiallySignedTransferTransaction({
        scheme: "exact",
        network: "hedera:testnet",
        asset: "0.0.0",
        amount: "1000",
        payTo: "0.0.1002",
        maxTimeoutSeconds: 120,
        extra: {},
      }),
    ).rejects.toThrow("feePayer is required");
  });

  it("rejects zero/negative transfer amounts", async () => {
    const privateKey = PrivateKey.generateED25519();
    const signer = createClientHederaSigner("0.0.1001", privateKey, {
      network: "hedera:testnet",
    });

    await expect(
      signer.createPartiallySignedTransferTransaction({
        scheme: "exact",
        network: "hedera:testnet",
        asset: "0.0.0",
        amount: "0",
        payTo: "0.0.1002",
        maxTimeoutSeconds: 120,
        extra: {
          feePayer: "0.0.1003",
        },
      }),
    ).rejects.toThrow("amount must be greater than zero");
  });

  it("rejects invalid payTo account format", async () => {
    const privateKey = PrivateKey.generateED25519();
    const signer = createClientHederaSigner("0.0.1001", privateKey, {
      network: "hedera:testnet",
    });

    await expect(
      signer.createPartiallySignedTransferTransaction({
        scheme: "exact",
        network: "hedera:testnet",
        asset: "0.0.0",
        amount: "1",
        payTo: "not-an-account",
        maxTimeoutSeconds: 120,
        extra: {
          feePayer: "0.0.1003",
        },
      }),
    ).rejects.toThrow();
  });

  it("supports repeated signing calls on the same signer instance", async () => {
    const privateKey = PrivateKey.generateED25519();
    const signer = createClientHederaSigner("0.0.1001", privateKey, {
      network: "hedera:testnet",
    });

    const requirements = {
      scheme: "exact" as const,
      network: "hedera:testnet",
      asset: "0.0.0",
      amount: "1000",
      payTo: "0.0.1002",
      maxTimeoutSeconds: 120,
      extra: { feePayer: "0.0.1003" },
    };

    const first = await signer.createPartiallySignedTransferTransaction(requirements);
    const second = await signer.createPartiallySignedTransferTransaction(requirements);

    expect(first.length).toBeGreaterThan(0);
    expect(second.length).toBeGreaterThan(0);
  });

  it("supports custom node URL client configuration", async () => {
    const privateKey = PrivateKey.generateED25519();
    const signer = createClientHederaSigner("0.0.1001", privateKey, {
      network: "hedera:testnet",
      nodeUrl: "127.0.0.1:50211",
    });

    const txBase64 = await signer.createPartiallySignedTransferTransaction({
      scheme: "exact",
      network: "hedera:testnet",
      asset: "0.0.0",
      amount: "1",
      payTo: "0.0.1002",
      maxTimeoutSeconds: 120,
      extra: {
        feePayer: "0.0.1003",
      },
    });

    expect(typeof txBase64).toBe("string");
    expect(txBase64.length).toBeGreaterThan(0);
  });
});

describe("createHederaSignAndSubmitTransaction", () => {
  const feePayerKey = PrivateKey.generateED25519();
  const feePayerAccount = "0.0.5001";

  async function buildTransferBase64(asset: string): Promise<string> {
    const tx = new TransferTransaction();
    const amount = BigInt("10000");
    if (asset === "0.0.0") {
      tx.addHbarTransfer(AccountId.fromString("0.0.9001"), Hbar.fromTinybars((-amount).toString()));
      tx.addHbarTransfer(AccountId.fromString("0.0.7001"), Hbar.fromTinybars(amount.toString()));
    } else {
      const tokenId = TokenId.fromString(asset);
      tx.addTokenTransfer(tokenId, AccountId.fromString("0.0.9001"), (-amount).toString());
      tx.addTokenTransfer(tokenId, AccountId.fromString("0.0.7001"), amount.toString());
    }
    tx.setTransactionId(TransactionId.generate(AccountId.fromString(feePayerAccount)));
    await tx.freezeWith(Client.forTestnet());
    return Buffer.from(tx.toBytes()).toString("base64");
  }

  function fakeClient(): Client {
    return { close: vi.fn() } as unknown as Client;
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the transactionId when the receipt reports SUCCESS", async () => {
    const closeSpy = vi.fn();
    const builtClient = { close: closeSpy } as unknown as Client;
    const expectedId = "0.0.5001@1700000002.000000000";
    const getReceipt = vi.fn().mockResolvedValue({ status: "SUCCESS" });
    vi.spyOn(TransferTransaction.prototype, "execute").mockResolvedValue({
      transactionId: { toString: () => expectedId },
      getReceipt,
    } as never);

    const submit = createHederaSignAndSubmitTransaction(() => builtClient, feePayerKey);
    const result = await submit(
      await buildTransferBase64(HEDERA_TESTNET_USDC),
      feePayerAccount,
      "hedera:testnet",
    );

    expect(result).toEqual({ transactionId: expectedId });
    expect(getReceipt).toHaveBeenCalledWith(builtClient);
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["TOKEN_NOT_ASSOCIATED_TO_ACCOUNT", HEDERA_TESTNET_USDC],
    ["INSUFFICIENT_ACCOUNT_BALANCE", "0.0.0"],
  ])("surfaces %s when getReceipt rejects (asset %s)", async (statusCode, asset) => {
    const closeSpy = vi.fn();
    const builtClient = { close: closeSpy } as unknown as Client;
    const getReceipt = vi
      .fn()
      .mockRejectedValue(
        new Error(
          `receipt for transaction 0.0.5001@1700000002.000000000 contained error status ${statusCode}`,
        ),
      );
    vi.spyOn(TransferTransaction.prototype, "execute").mockResolvedValue({
      transactionId: { toString: () => "0.0.5001@1700000002.000000000" },
      getReceipt,
    } as never);

    const submit = createHederaSignAndSubmitTransaction(() => builtClient, feePayerKey);

    await expect(
      submit(await buildTransferBase64(asset), feePayerAccount, "hedera:testnet"),
    ).rejects.toThrow(new RegExp(statusCode));
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it("closes the client when execute itself rejects (pre-check failure)", async () => {
    const closeSpy = vi.fn();
    const builtClient = { close: closeSpy } as unknown as Client;
    vi.spyOn(TransferTransaction.prototype, "execute").mockRejectedValue(
      new Error("transaction precheck failed: INVALID_SIGNATURE"),
    );

    const submit = createHederaSignAndSubmitTransaction(() => builtClient, feePayerKey);

    await expect(
      submit(await buildTransferBase64("0.0.0"), feePayerAccount, "hedera:testnet"),
    ).rejects.toThrow(/INVALID_SIGNATURE/);
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it("rejects payloads that are not TransferTransactions", async () => {
    const tx = new TopicCreateTransaction();
    tx.setTopicMemo("not-a-transfer");
    tx.setTransactionId(TransactionId.generate(AccountId.fromString(feePayerAccount)));
    const key = PrivateKey.generateED25519();
    tx.setSubmitKey(key.publicKey);
    await tx.freezeWith(Client.forTestnet());
    const base64 = Buffer.from(tx.toBytes()).toString("base64");

    const submit = createHederaSignAndSubmitTransaction(() => fakeClient(), feePayerKey);
    await expect(submit(base64, feePayerAccount, "hedera:testnet")).rejects.toThrow(
      /expected TransferTransaction/,
    );
  });
});

describe("createHederaVerifyPayerSignature", () => {
  const PAYER = "0.0.9001";
  const PAY_TO = "0.0.7001";
  const FEE_PAYER = "0.0.5001";

  type MirrorKey = { _type: "ED25519" | "ECDSA_SECP256K1" | "ProtobufEncoded"; key: string } | null;

  async function buildTransaction(signers: PrivateKey[]): Promise<string> {
    const tx = new TransferTransaction();
    tx.addHbarTransfer(AccountId.fromString(PAYER), Hbar.fromTinybars("-1000"));
    tx.addHbarTransfer(AccountId.fromString(PAY_TO), Hbar.fromTinybars("1000"));
    tx.setTransactionId(TransactionId.generate(AccountId.fromString(FEE_PAYER)));
    await tx.freezeWith(Client.forTestnet());
    for (const signer of signers) {
      await tx.sign(signer);
    }
    return Buffer.from(tx.toBytes()).toString("base64");
  }

  // Serializes a KeyList to the hex-encoded protobuf the Mirror Node returns
  // for threshold / KeyList accounts (`_type: "ProtobufEncoded"`).
  function keyListToProtobufHex(keyList: KeyList): string {
    const protoKey = (keyList as unknown as { _toProtobufKey(): proto.IKey })._toProtobufKey();
    return Buffer.from(proto.Key.encode(protoKey).finish()).toString("hex");
  }

  function mockMirrorKey(key: MirrorKey): ReturnType<typeof vi.fn> {
    const fn = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ key }) }));
    global.fetch = fn as unknown as typeof fetch;
    return fn;
  }

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("ok when the payer signed with their ED25519 account key", async () => {
    const key = PrivateKey.generateED25519();
    const transaction = await buildTransaction([key]);
    const fetchFn = mockMirrorKey({ _type: "ED25519", key: key.publicKey.toStringRaw() });
    const verify = createHederaVerifyPayerSignature({ mirrorNodeUrl: "https://mirror.test" });

    const result = await verify({ payer: PAYER, transaction, network: "hedera:testnet" });
    expect(result).toEqual({ ok: true });
    expect(fetchFn).toHaveBeenCalledWith(`https://mirror.test/api/v1/accounts/${PAYER}`);
  });

  it("ok when the payer signed with their ECDSA account key", async () => {
    const key = PrivateKey.generateECDSA();
    const transaction = await buildTransaction([key]);
    mockMirrorKey({ _type: "ECDSA_SECP256K1", key: key.publicKey.toStringRaw() });
    const verify = createHederaVerifyPayerSignature({ mirrorNodeUrl: "https://mirror.test" });

    const result = await verify({ payer: PAYER, transaction, network: "hedera:testnet" });
    expect(result).toEqual({ ok: true });
  });

  it("fails when signed with a different key", async () => {
    const signingKey = PrivateKey.generateED25519();
    const accountKey = PrivateKey.generateED25519();
    const transaction = await buildTransaction([signingKey]);
    mockMirrorKey({ _type: "ED25519", key: accountKey.publicKey.toStringRaw() });
    const verify = createHederaVerifyPayerSignature({ mirrorNodeUrl: "https://mirror.test" });

    const result = await verify({ payer: PAYER, transaction, network: "hedera:testnet" });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("signature_invalid");
  });

  it("fails for an unsigned transaction", async () => {
    const accountKey = PrivateKey.generateED25519();
    const transaction = await buildTransaction([]);
    mockMirrorKey({ _type: "ED25519", key: accountKey.publicKey.toStringRaw() });
    const verify = createHederaVerifyPayerSignature({ mirrorNodeUrl: "https://mirror.test" });

    const result = await verify({ payer: PAYER, transaction, network: "hedera:testnet" });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("signature_invalid");
  });

  it("ok when a KeyList threshold is met", async () => {
    const key1 = PrivateKey.generateED25519();
    const key2 = PrivateKey.generateED25519();
    const key3 = PrivateKey.generateED25519();
    const transaction = await buildTransaction([key1, key2]);
    const keyList = new KeyList([key1.publicKey, key2.publicKey, key3.publicKey], 2);
    mockMirrorKey({ _type: "ProtobufEncoded", key: keyListToProtobufHex(keyList) });
    const verify = createHederaVerifyPayerSignature({ mirrorNodeUrl: "https://mirror.test" });

    const result = await verify({ payer: PAYER, transaction, network: "hedera:testnet" });
    expect(result).toEqual({ ok: true });
  });

  it("fails when a KeyList threshold is not met", async () => {
    const key1 = PrivateKey.generateED25519();
    const key2 = PrivateKey.generateED25519();
    const key3 = PrivateKey.generateED25519();
    const transaction = await buildTransaction([key1]);
    const keyList = new KeyList([key1.publicKey, key2.publicKey, key3.publicKey], 2);
    mockMirrorKey({ _type: "ProtobufEncoded", key: keyListToProtobufHex(keyList) });
    const verify = createHederaVerifyPayerSignature({ mirrorNodeUrl: "https://mirror.test" });

    const result = await verify({ payer: PAYER, transaction, network: "hedera:testnet" });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("signature_invalid");
  });

  it("fails closed with a diagnosable reason if the SDK's internal Key._fromProtobufKey is unavailable", async () => {
    const key1 = PrivateKey.generateED25519();
    const key2 = PrivateKey.generateED25519();
    const transaction = await buildTransaction([key1, key2]);
    const keyList = new KeyList([key1.publicKey, key2.publicKey], 2);
    mockMirrorKey({ _type: "ProtobufEncoded", key: keyListToProtobufHex(keyList) });
    const verify = createHederaVerifyPayerSignature({ mirrorNodeUrl: "https://mirror.test" });

    const original = (Key as unknown as { _fromProtobufKey?: unknown })._fromProtobufKey;
    (Key as unknown as { _fromProtobufKey?: unknown })._fromProtobufKey = undefined;
    try {
      const result = await verify({ payer: PAYER, transaction, network: "hedera:testnet" });
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("signature_unverifiable");
      expect(result.message).toContain("_fromProtobufKey");
    } finally {
      (Key as unknown as { _fromProtobufKey?: unknown })._fromProtobufKey = original;
    }
  });

  it("fails when the Mirror Node returns no key", async () => {
    const transaction = await buildTransaction([PrivateKey.generateED25519()]);
    mockMirrorKey(null);
    const verify = createHederaVerifyPayerSignature({ mirrorNodeUrl: "https://mirror.test" });

    const result = await verify({ payer: PAYER, transaction, network: "hedera:testnet" });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("signature_invalid");
    expect(result.message).toContain("could not resolve payer key");
  });

  it("throws when the Mirror Node request fails", async () => {
    const transaction = await buildTransaction([PrivateKey.generateED25519()]);
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
    })) as unknown as typeof fetch;
    const verify = createHederaVerifyPayerSignature({ mirrorNodeUrl: "https://mirror.test" });

    await expect(verify({ payer: PAYER, transaction, network: "hedera:testnet" })).rejects.toThrow(
      "Mirror Node request failed",
    );
  });
});
