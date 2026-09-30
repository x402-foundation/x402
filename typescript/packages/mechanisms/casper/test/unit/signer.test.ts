import { beforeEach, describe, expect, it, vi } from "vitest";

const { HttpHandler, RpcClient, rpcClient } = vi.hoisted(() => {
  const rpcClient = {
    putTransaction: vi.fn(),
    getTransactionByTransactionHash: vi.fn(),
  };

  return {
    HttpHandler: vi.fn((url: string) => ({ url })),
    RpcClient: vi.fn(() => rpcClient),
    rpcClient,
  };
});

vi.mock("casper-js-sdk", async importOriginal => {
  const actual = await importOriginal<typeof import("casper-js-sdk")>();
  return {
    ...actual,
    HttpHandler,
    RpcClient,
  };
});

import { KeyAlgorithm, PrivateKey, type Transaction } from "casper-js-sdk";
import {
  createClientCasperSigner,
  createFacilitatorCasperSigner,
  toClientCasperSigner,
  toFacilitatorCasperSigner,
} from "../../src/signer";

function privateKeyHex(privateKey: InstanceType<typeof PrivateKey>): string {
  return Buffer.from(privateKey.toBytes()).toString("hex");
}

describe("Casper signer adapters", () => {
  beforeEach(() => {
    vi.useRealTimers();
    HttpHandler.mockClear();
    RpcClient.mockClear();
    rpcClient.putTransaction.mockReset();
    rpcClient.getTransactionByTransactionHash.mockReset();
  });

  it("wraps a private key for client signing", async () => {
    const privateKey = PrivateKey.generate(KeyAlgorithm.ED25519);
    const signer = toClientCasperSigner(privateKey);

    expect(signer.accountAddress()).toMatch(/^00[0-9a-f]{64}$/i);
    expect(signer.publicKey()).toMatch(/^01[0-9a-f]{64}$/i);
    await expect(signer.signEIP712(new Uint8Array(32))).resolves.toHaveLength(65);
  });

  it("wraps a private key for facilitator settlement", async () => {
    const privateKey = PrivateKey.generate(KeyAlgorithm.ED25519);
    const signer = await toFacilitatorCasperSigner(privateKey, {
      rpcUrlConfig: { "casper:casper-test": "http://localhost:11101/rpc" },
    });

    expect(await signer.getNetworkConfig("casper:casper-test")).toMatchObject({
      chainName: "casper-test",
      rpcUrl: "http://localhost:11101/rpc",
    });
    expect(signer.getAddresses("casper:casper-test")[0]).toMatch(/^[0-9a-f]{64}$/i);
    expect(signer.getPublicKeyHex("casper:casper-test")).toMatch(/^01[0-9a-f]{64}$/i);
    expect(signer.getSpeculativeRpcUrl("casper:casper-test")).toBeUndefined();
  });

  it("uses default RPC URLs for known Casper networks", async () => {
    const privateKey = PrivateKey.generate(KeyAlgorithm.ED25519);
    const signer = await toFacilitatorCasperSigner(privateKey, {});

    await expect(signer.getNetworkConfig("casper:casper-test")).resolves.toEqual({
      chainName: "casper-test",
      rpcUrl: "https://node.testnet.casper.network/rpc",
    });
  });

  it("resolves configured speculative RPC URLs per network", async () => {
    const privateKey = PrivateKey.generate(KeyAlgorithm.ED25519);
    const signer = await toFacilitatorCasperSigner(privateKey, {
      speculativeRpcUrlConfig: {
        "casper:casper-test": " http://localhost:7778/rpc ",
        "casper:casper": "",
      },
    });

    expect(signer.getSpeculativeRpcUrl("casper:casper-test")).toBe("http://localhost:7778/rpc");
    expect(signer.getSpeculativeRpcUrl("casper:casper")).toBeUndefined();
    expect(signer.getSpeculativeRpcUrl("casper:other")).toBeUndefined();
  });

  it("creates a client signer from a hex private key", async () => {
    const privateKey = PrivateKey.generate(KeyAlgorithm.ED25519);
    const signer = await createClientCasperSigner(privateKeyHex(privateKey));

    expect(signer.accountAddress()).toBe(`00${privateKey.publicKey.accountHash().toHex()}`);
    expect(signer.publicKey()).toBe(privateKey.publicKey.toHex());
  });

  it("creates a facilitator signer from a hex private key", async () => {
    const privateKey = PrivateKey.generate(KeyAlgorithm.SECP256K1);
    const signer = await createFacilitatorCasperSigner(
      privateKeyHex(privateKey),
      KeyAlgorithm.SECP256K1,
      {
        rpcUrlConfig: { "casper:casper-test": "http://localhost:11101/rpc" },
      },
    );

    expect(signer.getAddresses("casper:casper-test")).toEqual([
      privateKey.publicKey.accountHash().toHex(),
    ]);
    expect(signer.getPublicKeyHex("casper:casper-test")).toBe(privateKey.publicKey.toHex());
  });

  it("rejects unsupported networks when no RPC URL is configured", async () => {
    const privateKey = PrivateKey.generate(KeyAlgorithm.ED25519);
    const signer = await toFacilitatorCasperSigner(privateKey, {
      rpcUrlConfig: { "casper:casper-test": "http://localhost:11101/rpc" },
    });

    await expect(signer.getNetworkConfig("casper:casper-net-1")).rejects.toThrow(
      "unsupported Casper network: casper:casper-net-1",
    );
  });

  it("derives chain names for configured custom networks", async () => {
    const privateKey = PrivateKey.generate(KeyAlgorithm.ED25519);
    const signer = await toFacilitatorCasperSigner(privateKey, {
      rpcUrlConfig: { "casper:custom-net": "http://localhost:11101/rpc" },
    });

    await expect(signer.getNetworkConfig("casper:custom-net")).resolves.toEqual({
      chainName: "custom-net",
      rpcUrl: "http://localhost:11101/rpc",
    });
  });

  it("signs settlement transactions with the configured private key", async () => {
    const privateKey = PrivateKey.generate(KeyAlgorithm.ED25519);
    const signer = await toFacilitatorCasperSigner(privateKey, {
      rpcUrlConfig: { "casper:casper-test": "http://localhost:11101/rpc" },
    });
    const transaction = { sign: vi.fn() } as unknown as Transaction;

    await signer.signTransaction(transaction, "casper:casper-test");

    expect(transaction.sign).toHaveBeenCalledWith(privateKey);
  });

  it("submits transactions through a cached RPC client", async () => {
    const privateKey = PrivateKey.generate(KeyAlgorithm.ED25519);
    const signer = await toFacilitatorCasperSigner(privateKey, {
      rpcUrlConfig: { "casper:custom-net": "http://localhost:11101/rpc" },
    });
    const transaction = {} as Transaction;
    rpcClient.putTransaction.mockResolvedValue({
      transactionHash: { toHex: () => "abc123" },
    });

    await expect(signer.putTransaction("casper:custom-net", transaction)).resolves.toBe("abc123");
    await expect(signer.putTransaction("casper:custom-net", transaction)).resolves.toBe("abc123");

    expect(HttpHandler).toHaveBeenCalledOnce();
    expect(HttpHandler).toHaveBeenCalledWith("http://localhost:11101/rpc");
    expect(RpcClient).toHaveBeenCalledOnce();
    expect(rpcClient.putTransaction).toHaveBeenCalledTimes(2);
  });

  it("wraps transaction submission failures with RPC source details", async () => {
    const privateKey = PrivateKey.generate(KeyAlgorithm.ED25519);
    const signer = await toFacilitatorCasperSigner(privateKey, {
      rpcUrlConfig: { "casper:casper-test": "http://localhost:11101/rpc" },
    });
    const submissionError = new Error("bad request") as Error & {
      sourceErr: { code: number; message: string };
    };
    submissionError.sourceErr = { code: -32000, message: "rejected" };
    rpcClient.putTransaction.mockRejectedValue(submissionError);

    await expect(signer.putTransaction("casper:casper-test", {} as Transaction)).rejects.toThrow(
      'transaction submission failed: bad request - {"code":-32000,"message":"rejected"}',
    );
  });

  it("wraps non-error transaction submission failures", async () => {
    const privateKey = PrivateKey.generate(KeyAlgorithm.ED25519);
    const signer = await toFacilitatorCasperSigner(privateKey, {
      rpcUrlConfig: { "casper:casper-test": "http://localhost:11101/rpc" },
    });
    rpcClient.putTransaction.mockRejectedValue("offline");

    await expect(signer.putTransaction("casper:casper-test", {} as Transaction)).rejects.toThrow(
      "transaction submission failed: offline",
    );
  });

  it("waits until a transaction has an execution result", async () => {
    vi.useFakeTimers();
    const privateKey = PrivateKey.generate(KeyAlgorithm.ED25519);
    const signer = await toFacilitatorCasperSigner(privateKey, {
      rpcUrlConfig: { "casper:casper-test": "http://localhost:11101/rpc" },
    });
    rpcClient.getTransactionByTransactionHash
      .mockResolvedValueOnce({ executionInfo: undefined })
      .mockResolvedValueOnce({
        executionInfo: {
          blockHeight: 42,
          executionResult: {},
        },
      });

    const waitPromise = signer.waitForTransaction("casper:casper-test", "abc123");
    await vi.advanceTimersByTimeAsync(3_000);

    await expect(waitPromise).resolves.toBeUndefined();
    expect(rpcClient.getTransactionByTransactionHash).toHaveBeenCalledTimes(2);
    expect(rpcClient.getTransactionByTransactionHash).toHaveBeenCalledWith("abc123");
  });

  it("rejects failed transaction execution results", async () => {
    const privateKey = PrivateKey.generate(KeyAlgorithm.ED25519);
    const signer = await toFacilitatorCasperSigner(privateKey, {
      rpcUrlConfig: { "casper:casper-test": "http://localhost:11101/rpc" },
    });
    rpcClient.getTransactionByTransactionHash.mockResolvedValue({
      executionInfo: {
        blockHeight: 42,
        executionResult: { errorMessage: "execution reverted" },
      },
    });

    await expect(signer.waitForTransaction("casper:casper-test", "abc123")).rejects.toThrow(
      "transaction execution failed: execution reverted",
    );
  });

  it("times out when a transaction never reaches an execution result", async () => {
    vi.useFakeTimers();
    const privateKey = PrivateKey.generate(KeyAlgorithm.ED25519);
    const signer = await toFacilitatorCasperSigner(privateKey, {
      rpcUrlConfig: { "casper:casper-test": "http://localhost:11101/rpc" },
    });
    rpcClient.getTransactionByTransactionHash.mockResolvedValue({
      executionInfo: {
        blockHeight: 0,
        executionResult: undefined,
      },
    });

    const waitPromise = signer.waitForTransaction("casper:casper-test", "abc123");
    const timeoutExpectation = expect(waitPromise).rejects.toThrow(
      "Timed out waiting for transaction abc123",
    );
    await vi.advanceTimersByTimeAsync(60_000);

    await timeoutExpectation;
  });
});
