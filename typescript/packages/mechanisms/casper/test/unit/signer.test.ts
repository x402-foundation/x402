import { beforeEach, describe, expect, it, vi } from "vitest";

const { newSpeculativeClient, speculativeExec } = vi.hoisted(() => ({
  newSpeculativeClient: vi.fn(),
  speculativeExec: vi.fn(),
}));

vi.mock("../../src/casper-sdk", async importOriginal => {
  const actual = await importOriginal<typeof import("../../src/casper-sdk")>();
  return {
    ...actual,
    SpeculativeClient: {
      newSpeculativeClient: newSpeculativeClient.mockImplementation(() => ({ speculativeExec })),
    },
  };
});

import { Args, ContractCallBuilder, KeyAlgorithm, PrivateKey } from "../../src/casper-sdk";
import {
  toClientCasperSigner,
  toFacilitatorCasperSigner,
  createClientCasperSigner,
  createFacilitatorCasperSigner,
} from "../../src/signer";

function privateKeyHex(privateKey: InstanceType<typeof PrivateKey>): string {
  return Buffer.from(privateKey.toBytes()).toString("hex");
}

function buildDeploy(privateKey: InstanceType<typeof PrivateKey>) {
  const transaction = new ContractCallBuilder()
    .from(privateKey.publicKey)
    .byPackageHash("a".repeat(64))
    .entryPoint("transfer_with_authorization")
    .runtimeArgs(Args.fromMap({}))
    .chainName("casper-test")
    .payment(2_500_000_000)
    .buildFor1_5();
  transaction.sign(privateKey);
  const deploy = transaction.getDeploy();
  if (!deploy) throw new Error("expected deploy");
  return deploy;
}

describe("Casper signer adapters", () => {
  beforeEach(() => {
    newSpeculativeClient.mockClear();
    speculativeExec.mockReset();
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
  });

  it("omits optional preflight hooks when they are not configured", async () => {
    const privateKey = PrivateKey.generate(KeyAlgorithm.ED25519);
    const signer = await toFacilitatorCasperSigner(privateKey, {
      rpcUrlConfig: { "casper:casper-test": "http://localhost:11101/rpc" },
    });

    expect(signer.getBalance).toBeUndefined();
    expect(signer.getAuthorizationState).toBeUndefined();
    expect(signer.assertTransferWithAuthorizationSupported).toBeUndefined();
  });

  it("exposes configured preflight hooks", async () => {
    const privateKey = PrivateKey.generate(KeyAlgorithm.ED25519);
    const getBalance = vi.fn(async () => 10n);
    const getAuthorizationState = vi.fn(async () => "unused" as const);
    const assertTransferWithAuthorizationSupported = vi.fn(async () => {});
    const signer = await toFacilitatorCasperSigner(privateKey, {
      rpcUrlConfig: { "casper:casper-test": "http://localhost:11101/rpc" },
      preflightHooks: {
        getBalance,
        getAuthorizationState,
        assertTransferWithAuthorizationSupported,
      },
    });

    await expect(
      signer.getBalance?.({
        network: "casper:casper-test",
        asset: "a".repeat(64),
        account: "00" + "b".repeat(64),
      }),
    ).resolves.toBe(10n);
    await expect(
      signer.getAuthorizationState?.({
        network: "casper:casper-test",
        asset: "a".repeat(64),
        payer: "00" + "b".repeat(64),
        nonce: "c".repeat(64),
      }),
    ).resolves.toBe("unused");
    await expect(
      signer.assertTransferWithAuthorizationSupported?.({
        network: "casper:casper-test",
        asset: "a".repeat(64),
      }),
    ).resolves.toBeUndefined();

    expect(getBalance).toHaveBeenCalledTimes(1);
    expect(getAuthorizationState).toHaveBeenCalledTimes(1);
    expect(assertTransferWithAuthorizationSupported).toHaveBeenCalledTimes(1);
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

  it("does not expose speculative simulation without a speculative RPC URL", async () => {
    const privateKey = PrivateKey.generate(KeyAlgorithm.ED25519);
    const signer = await toFacilitatorCasperSigner(privateKey, {
      rpcUrlConfig: { "casper:casper-test": "http://localhost:11101/rpc" },
    });

    expect(signer.simulateTransferWithAuthorization).toBeUndefined();
  });

  it("does not expose speculative simulation with an empty speculative RPC URL map", async () => {
    const privateKey = PrivateKey.generate(KeyAlgorithm.ED25519);
    const signer = await toFacilitatorCasperSigner(privateKey, {
      speculativeRpcUrlConfig: {},
    });

    expect(signer.simulateTransferWithAuthorization).toBeUndefined();
  });

  it("exposes speculative simulation when a speculative RPC URL is configured", async () => {
    const privateKey = PrivateKey.generate(KeyAlgorithm.ED25519);
    const signer = await toFacilitatorCasperSigner(privateKey, {
      speculativeRpcUrlConfig: { "casper:casper-test": "http://localhost:7778/rpc" },
    });

    expect(signer.simulateTransferWithAuthorization).toBeDefined();
  });

  it("calls speculativeExec with the deploy", async () => {
    speculativeExec.mockResolvedValueOnce({ executionResult: {} });
    const privateKey = PrivateKey.generate(KeyAlgorithm.ED25519);
    const deploy = buildDeploy(privateKey);
    const signer = await toFacilitatorCasperSigner(privateKey, {
      speculativeRpcUrlConfig: { "casper:casper-test": "http://localhost:7778/rpc" },
    });

    await expect(
      signer.simulateTransferWithAuthorization!({
        network: "casper:casper-test",
        asset: "a".repeat(64),
        deploy,
      }),
    ).resolves.toBeUndefined();

    expect(speculativeExec).toHaveBeenCalledWith("1", deploy);
  });

  it("skips speculative execution for a network without a configured URL", async () => {
    const privateKey = PrivateKey.generate(KeyAlgorithm.ED25519);
    const signer = await toFacilitatorCasperSigner(privateKey, {
      speculativeRpcUrlConfig: { "casper:casper-test": "http://localhost:7778/rpc" },
    });

    await expect(
      signer.simulateTransferWithAuthorization!({
        network: "casper:casper-net-1",
        asset: "a".repeat(64),
        deploy: buildDeploy(privateKey),
      }),
    ).resolves.toBeUndefined();

    expect(speculativeExec).not.toHaveBeenCalled();
  });

  it("reuses a speculative client for calls sharing a URL", async () => {
    speculativeExec.mockResolvedValue({ executionResult: {} });
    const privateKey = PrivateKey.generate(KeyAlgorithm.ED25519);
    const signer = await toFacilitatorCasperSigner(privateKey, {
      speculativeRpcUrlConfig: { "casper:casper-test": "http://localhost:7778/rpc" },
    });

    await signer.simulateTransferWithAuthorization!({
      network: "casper:casper-test",
      asset: "a".repeat(64),
      deploy: buildDeploy(privateKey),
    });
    await signer.simulateTransferWithAuthorization!({
      network: "casper:casper-test",
      asset: "a".repeat(64),
      deploy: buildDeploy(privateKey),
    });

    expect(newSpeculativeClient).toHaveBeenCalledTimes(1);
  });

  it("throws speculative execution failure messages", async () => {
    speculativeExec.mockResolvedValueOnce({ executionResult: { errorMessage: "reverted" } });
    const privateKey = PrivateKey.generate(KeyAlgorithm.ED25519);
    const signer = await toFacilitatorCasperSigner(privateKey, {
      speculativeRpcUrlConfig: { "casper:casper-test": "http://localhost:7778/rpc" },
    });

    await expect(
      signer.simulateTransferWithAuthorization!({
        network: "casper:casper-test",
        asset: "a".repeat(64),
        deploy: buildDeploy(privateKey),
      }),
    ).rejects.toThrow("speculative execution failed: reverted");
  });

  it("throws Casper v2 speculative execution errors", async () => {
    speculativeExec.mockResolvedValueOnce({ executionResult: { errorMessage: "v2 reverted" } });
    const privateKey = PrivateKey.generate(KeyAlgorithm.ED25519);
    const signer = await toFacilitatorCasperSigner(privateKey, {
      speculativeRpcUrlConfig: { "casper:casper-test": "http://localhost:7778/rpc" },
    });

    await expect(
      signer.simulateTransferWithAuthorization!({
        network: "casper:casper-test",
        asset: "a".repeat(64),
        deploy: buildDeploy(privateKey),
      }),
    ).rejects.toThrow("speculative execution failed: v2 reverted");
  });

  it("includes raw JSON in unrecognized speculative execution errors", async () => {
    speculativeExec.mockResolvedValueOnce({ rawJSON: { result: "unexpected" } });
    const privateKey = PrivateKey.generate(KeyAlgorithm.ED25519);
    const signer = await toFacilitatorCasperSigner(privateKey, {
      speculativeRpcUrlConfig: { "casper:casper-test": "http://localhost:7778/rpc" },
    });

    await expect(
      signer.simulateTransferWithAuthorization!({
        network: "casper:casper-test",
        asset: "a".repeat(64),
        deploy: buildDeploy(privateKey),
      }),
    ).rejects.toThrow(
      'speculative execution returned an unrecognized response: {"result":"unexpected"}',
    );
  });
});
