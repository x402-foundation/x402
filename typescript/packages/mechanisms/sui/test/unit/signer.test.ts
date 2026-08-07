import { describe, it, expect } from "vitest";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { toFacilitatorSuiSigner, toClientSuiSigner } from "../../src/signer";

describe("Sui Signer", () => {
  describe("toFacilitatorSuiSigner", () => {
    it("has no addresses without a keypair (keyless gasless path)", () => {
      const signer = toFacilitatorSuiSigner();
      expect(signer.getAddresses()).toHaveLength(0);
    });

    it("reports the keypair address when one is provided (classic path)", () => {
      const kp = Ed25519Keypair.generate();
      const signer = toFacilitatorSuiSigner(undefined, kp);
      expect(signer.getAddresses()).toEqual([kp.toSuiAddress()]);
    });

    it("implements every required method", () => {
      const signer = toFacilitatorSuiSigner();
      expect(typeof signer.verifySignature).toBe("function");
      expect(typeof signer.simulateTransaction).toBe("function");
      expect(typeof signer.executeTransaction).toBe("function");
      expect(typeof signer.waitForTransaction).toBe("function");
    });
  });

  describe("toClientSuiSigner", () => {
    it("exposes the keypair address and a signTransaction method", () => {
      const kp = Ed25519Keypair.generate();
      // The client is only used inside signTransaction; a typed stub suffices here.
      const signer = toClientSuiSigner(kp, {} as never);
      expect(signer.address).toBe(kp.toSuiAddress());
      expect(typeof signer.signTransaction).toBe("function");
    });
  });
});
