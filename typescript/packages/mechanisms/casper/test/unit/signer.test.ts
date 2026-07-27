import casperSdk from "casper-js-sdk";
import { describe, expect, it } from "vitest";
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
      defaultRpcUrl: "http://localhost:11101/rpc",
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
    const signer = await toFacilitatorCasperSigner(privateKey, "http://localhost:11101/rpc");

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
      "http://localhost:11101/rpc",
    );

    expect(signer.getAddresses("casper:casper-test")).toEqual([
      privateKey.publicKey.accountHash().toHex(),
    ]);
    expect(signer.getPublicKeyHex("casper:casper-test")).toBe(privateKey.publicKey.toHex());
  });
});
