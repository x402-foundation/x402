import { describe, expect, it, vi } from "vitest";
import { ExactSuiScheme } from "../../src/exact/facilitator/scheme";
import { SUI_TESTNET_CAIP2 } from "../../src/constants";
import { mockClient, payerKeypair, testRequirements, buildTestTransaction } from "./helpers";
import { signPayload, testPayload } from "./helpers";

const { isValidTransactionSignature } = vi.hoisted(() => ({
  isValidTransactionSignature: vi.fn(),
}));

vi.mock("@mysten/sui/verify", async importOriginal => ({
  ...(await importOriginal<typeof import("@mysten/sui/verify")>()),
  isValidTransactionSignature,
}));

describe("signature verification errors", () => {
  /**
   * A facilitator and a signed payment.
   *
   * @returns The scheme, its mock client, and the payment
   */
  async function setup() {
    const mock = mockClient();
    const scheme = new ExactSuiScheme({ clients: { [SUI_TESTNET_CAIP2]: mock.client } });
    const payload = testPayload(await signPayload(await buildTestTransaction(), payerKeypair));
    return { mock, scheme, payload };
  }

  it("reports a false result as an invalid signature", async () => {
    isValidTransactionSignature.mockResolvedValue(false);
    const { scheme, payload } = await setup();
    expect((await scheme.verify(payload, testRequirements())).invalidReason).toBe(
      "invalid_exact_sui_payload_invalid_signature",
    );
  });

  it("reports a thrown error as a verification error, not an invalid signature", async () => {
    isValidTransactionSignature.mockRejectedValue(new Error("zkLogin JWK lookup failed"));
    const { scheme, payload } = await setup();
    expect(await scheme.verify(payload, testRequirements())).toMatchObject({
      isValid: false,
      invalidReason: "invalid_exact_sui_payload_verification_error",
      invalidMessage: "zkLogin JWK lookup failed",
    });
  });

  it("reports a thrown error at settle as transaction_failed", async () => {
    isValidTransactionSignature.mockRejectedValue(new Error("zkLogin JWK lookup failed"));
    const { mock, scheme, payload } = await setup();
    expect((await scheme.settle(payload, testRequirements())).errorReason).toBe(
      "transaction_failed",
    );
    expect(mock.core.executeTransaction).not.toHaveBeenCalled();
  });
});
