import { describe, expect, it, vi } from "vitest";
import { beginCell } from "@ton/core";
import { keyPairFromSeed } from "@ton/crypto";
import { HighloadV3Config, toClientTvmSigner, type ClientTvmSigner } from "../../src/signer";
import { TVM_TESTNET } from "../../src/constants";

describe("TVM signers", () => {
  it("creates a W5R1 client signer with network-bound wallet id and state init", () => {
    const signer = toClientTvmSigner(keyPairFromSeed(Buffer.alloc(32, 1)), {
      network: TVM_TESTNET,
    });

    expect(signer.address).toMatch(/^0:[0-9a-f]{64}$/);
    expect(signer.network).toBe(TVM_TESTNET);
    expect(signer.walletId).toBeTypeOf("number");
    expect(signer.stateInit.code?.hash().toString("hex")).toBe(
      "20834b7b72b112147e1b2fb457b84e74d1a30f04f737d4f62a668e9552d2b72f",
    );
  });

  it("signs a transfer into a base64 settlement BoC", async () => {
    const signer = toClientTvmSigner(keyPairFromSeed(Buffer.alloc(32, 2)), {
      network: TVM_TESTNET,
    });

    const boc = await signer.signTransfer(
      0,
      Math.floor(Date.now() / 1000) + 60,
      [
        {
          address: "0:3333333333333333333333333333333333333333333333333333333333333333",
          amount: 1n,
          body: beginCell().storeUint(0, 1).endCell(),
        },
      ],
      { includeStateInit: true },
    );

    expect(Buffer.from(boc, "base64").length).toBeGreaterThan(0);
  });

  it("normalizes 32-byte facilitator private keys to secret keys", () => {
    const config = HighloadV3Config.fromPrivateKey(Buffer.alloc(32, 3));
    expect(config.secretKey).toHaveLength(64);
  });

  it("keeps the client signer protocol mockable", async () => {
    const mockSigner: ClientTvmSigner = {
      address: "0:1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
      network: TVM_TESTNET,
      walletId: 1,
      stateInit: { code: beginCell().endCell(), data: beginCell().endCell() },
      publicKey: "abcdef1234567890",
      signMessage: vi.fn().mockReturnValue(Buffer.alloc(64)),
      signTransfer: vi.fn().mockResolvedValue("boc"),
    };

    await expect(mockSigner.signTransfer(42, 1700000000, [])).resolves.toBe("boc");
  });
});
