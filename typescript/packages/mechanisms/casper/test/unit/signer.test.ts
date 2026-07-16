import casperSdk from "casper-js-sdk";
import { describe, expect, it } from "vitest";
import {
  toClientCasperSigner,
  toFacilitatorCasperSigner,
  createClientCasperSigner,
} from "../../src/signer";

const { KeyAlgorithm, PrivateKey } = casperSdk;

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

  it("exposes PEM client signer creation", () => {
    expect(createClientCasperSigner).toBeDefined();
  });
});
