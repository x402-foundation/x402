/**
 * Client signatures go through Kit's real `verifySignature`. Kit 8.5 refuses a
 * non-extractable public key there, which once made every client signature
 * read as invalid; these cases run against the installed Kit, unmocked.
 */
import {
  generateKeyPairSigner,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
} from "@solana/kit";
import { describe, expect, it } from "vitest";

import { USDC_DEVNET_ADDRESS } from "../../src/defaultAssets";
import { ErrSignatureInvalid } from "../../src/exact/facilitator/errors";
import { verifyRequiredSignatures } from "../../src/exact/facilitator/signatureVerification";
import { buildExactPaymentTransaction } from "./helpers/signedTransaction";

async function signedPayment(version: 0 | 1) {
  const feePayer = (await generateKeyPairSigner()).address;
  const transaction = await buildExactPaymentTransaction({
    amount: 1000n,
    feePayer,
    mint: USDC_DEVNET_ADDRESS as never,
    payTo: USDC_DEVNET_ADDRESS as never,
    payer: await generateKeyPairSigner(),
    version,
  });
  const decoded = getTransactionDecoder().decode(getBase64Encoder().encode(transaction));
  const compiled = getCompiledTransactionMessageDecoder().decode(decoded.messageBytes);
  return { decoded, compiled, feePayer };
}

describe("verifyRequiredSignatures", () => {
  it.each([0, 1] as const)("accepts a valid version %s client signature", async version => {
    const { decoded, compiled, feePayer } = await signedPayment(version);
    await expect(verifyRequiredSignatures(decoded, compiled, feePayer)).resolves.toEqual({
      ok: true,
    });
  });

  it("rejects a tampered client signature", async () => {
    const { decoded, compiled, feePayer } = await signedPayment(0);
    const payer = compiled.staticAccounts[1]!;
    const signature = new Uint8Array(decoded.signatures[payer]!);
    signature[0] ^= 1;
    const tampered = { ...decoded, signatures: { ...decoded.signatures, [payer]: signature } };
    await expect(verifyRequiredSignatures(tampered as never, compiled, feePayer)).resolves.toEqual({
      ok: false,
      invalidReason: ErrSignatureInvalid,
    });
  });
});
