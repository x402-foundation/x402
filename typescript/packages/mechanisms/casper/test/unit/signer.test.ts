import { describe, expect, it, vi } from "vitest";

const { speculativeExec } = vi.hoisted(() => ({ speculativeExec: vi.fn() }));

vi.mock("casper-js-sdk", async importOriginal => {
  const actual = await importOriginal<typeof import("casper-js-sdk")>();
  return {
    default: {
      ...actual.default,
      SpeculativeClient: {
        newSpeculativeClient: vi.fn(() => ({ speculativeExec })),
      },
    },
  };
});

import casperSdk from "casper-js-sdk";
import {
  toClientCasperSigner,
  toFacilitatorCasperSigner,
  createClientCasperSigner,
  createFacilitatorCasperSigner,
} from "../../src/signer";

const { KeyAlgorithm, PrivateKey } = casperSdk;

function privateKeyHex(privateKey: InstanceType<typeof PrivateKey>): string {
  return Buffer.from(privateKey.toBytes()).toString("hex");
}

function buildDeploy(privateKey: InstanceType<typeof PrivateKey>) {
  const transaction = new casperSdk.ContractCallBuilder()
    .from(privateKey.publicKey)
    .byPackageHash("a".repeat(64))
    .entryPoint("transfer_with_authorization")
    .runtimeArgs(casperSdk.Args.fromMap({}))
    .chainName("casper-test")
    .payment(2_500_000_000)
    .buildFor1_5();
  transaction.sign(privateKey);
  const deploy = transaction.getDeploy();
  if (!deploy) throw new Error("expected deploy");
  return deploy;
}

describe("Casper signer adapters", () => {
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

  it("fails closed for default preflight checks", async () => {
    const privateKey = PrivateKey.generate(KeyAlgorithm.ED25519);
    const signer = await toFacilitatorCasperSigner(privateKey, {
      rpcUrlConfig: { "casper:casper-test": "http://localhost:11101/rpc" },
    });

    await expect(
      signer.getBalance({
        network: "casper:casper-test",
        asset: "a".repeat(64),
        account: "00" + "b".repeat(64),
      }),
    ).rejects.toThrow("Casper balance preflight is not configured");
    await expect(
      signer.getAuthorizationState({
        network: "casper:casper-test",
        asset: "a".repeat(64),
        payer: "00" + "b".repeat(64),
        nonce: "c".repeat(64),
      }),
    ).rejects.toThrow("Casper authorization-state preflight is not configured");
    await expect(
      signer.assertTransferWithAuthorizationSupported({
        network: "casper:casper-test",
        asset: "a".repeat(64),
      }),
    ).rejects.toThrow("Casper contract preflight is not configured");
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

  it("exposes speculative simulation when a speculative RPC URL is configured", async () => {
    const privateKey = PrivateKey.generate(KeyAlgorithm.ED25519);
    const signer = await toFacilitatorCasperSigner(privateKey, {
      speculativeRpcUrlConfig: { "casper:casper-test": "http://localhost:7778/rpc" },
    });

    expect(signer.simulateTransferWithAuthorization).toBeDefined();
  });

  it("calls speculativeExec with the deploy", async () => {
    speculativeExec.mockResolvedValueOnce({ executionResultV1: { success: {} } });
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

  it("throws speculative execution failure messages", async () => {
    speculativeExec.mockResolvedValueOnce({
      executionResultV1: { failure: { errorMessage: "reverted" } },
    });
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
});
