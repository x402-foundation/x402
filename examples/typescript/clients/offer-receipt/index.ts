/**
 * x402 Receipt Attestation Client Example
 *
 * Demonstrates extracting signed offers and receipts from x402 payment flows.
 * Uses the raw flow for visibility into what's happening at each step.
 */

import { config } from "dotenv";
import { x402Client, x402HTTPClient, type PaymentRequired } from "@x402/fetch";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { registerExactSvmScheme } from "@x402/svm/exact/client";
import { privateKeyToAccount } from "viem/accounts";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { base58 } from "@scure/base";
import {
  extractOffersFromPaymentRequired,
  decodeSignedOffers,
  findAcceptsObjectFromSignedOffer,
  extractReceiptFromResponse,
  extractReceiptPayload,
  verifyReceiptMatchesOffer,
  verifyOfferSignatureJWS,
  verifyOfferSignatureEIP712,
  verifyReceiptSignatureJWS,
  verifyReceiptSignatureEIP712,
  isJWSSignedOffer,
  isJWSSignedReceipt,
} from "@x402/extensions/offer-receipt";

config();

const evmPrivateKey = process.env.EVM_PRIVATE_KEY as `0x${string}`;
const svmPrivateKey = process.env.SVM_PRIVATE_KEY as string;
const baseURL = process.env.RESOURCE_SERVER_URL || "http://localhost:4021";
const endpointPath = process.env.ENDPOINT_PATH || "/weather";
const url = `${baseURL}${endpointPath}`;

/**
 * Main entry point demonstrating x402 payment flow with offer-receipt extension
 *
 * @returns - Promise that resolves when the example completes
 */
async function main(): Promise<void> {
  // Set up payment client
  const evmSigner = privateKeyToAccount(evmPrivateKey);
  const svmSigner = await createKeyPairSignerFromBytes(base58.decode(svmPrivateKey));

  const client = new x402Client();
  registerExactEvmScheme(client, { signer: evmSigner });
  registerExactSvmScheme(client, { signer: svmSigner });

  const httpClient = new x402HTTPClient(client);

  // =========================================================================
  // Step 1: Initial request (expect 402)
  // =========================================================================
  console.log(`Requesting: ${url}`);
  const initialResponse = await fetch(url, { method: "GET" });

  if (initialResponse.status !== 402) {
    const body = await initialResponse.json();
    console.log("Response:", body);
    return;
  }

  // =========================================================================
  // Step 2: Extract and decode signed offers from 402 response
  // =========================================================================
  const paymentRequiredBody = (await initialResponse.json()) as PaymentRequired;
  const getHeader = (name: string) => initialResponse.headers.get(name);
  const paymentRequired = httpClient.getPaymentRequiredResponse(getHeader, paymentRequiredBody);

  const signedOffers = extractOffersFromPaymentRequired(paymentRequired);

  if (signedOffers.length === 0) {
    console.log("No signed offers (server may not have offer signing enabled)");
    return;
  }

  // Decode all offers to inspect their payloads
  const decodedOffers = decodeSignedOffers(signedOffers);

  console.log(`\nSigned Offers (${decodedOffers.length}):`);
  decodedOffers.forEach((d, i) => {
    console.log(`  [${i}] ${d.scheme} on ${d.network}: ${d.amount} to ${d.payTo}`);
  });

  // =========================================================================
  // Step 3: Verify offer signatures and select a verified offer
  // =========================================================================
  // Only consider offers that pass signature verification
  console.log("\nVerifying offer signatures...");

  let selected = null;
  for (const decoded of decodedOffers) {
    try {
      if (isJWSSignedOffer(decoded.signedOffer)) {
        await verifyOfferSignatureJWS(decoded.signedOffer);
        console.log(`  [${decoded.acceptIndex}] JWS: ✓ Valid`);
      } else {
        const { signer } = await verifyOfferSignatureEIP712(decoded.signedOffer);
        console.log(`  [${decoded.acceptIndex}] EIP-712: ✓ Valid (signer: ${signer})`);
      }
      selected = decoded;
      break;
    } catch (err) {
      console.log(
        `  [${decoded.acceptIndex}] ✗ FAILED - ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  if (!selected) {
    console.log("\nNo offers passed signature verification");
    return;
  }

  // =========================================================================
  // Step 4: Find matching accepts entry for selected offer
  // =========================================================================
  const matchingAccept = findAcceptsObjectFromSignedOffer(selected, paymentRequired.accepts);

  if (!matchingAccept) {
    console.log("\nNo matching accepts[] entry for signed offer");
    return;
  }

  console.log(`\nSelected: ${selected.scheme} on ${selected.network}`);

  // =========================================================================
  // Step 5: Create payment and retry
  // =========================================================================
  console.log("Making payment...");

  const paymentPayload = await client.createPaymentPayload(paymentRequired);
  const paymentHeaders = httpClient.encodePaymentSignatureHeader(paymentPayload);

  const paidResponse = await fetch(url, {
    method: "GET",
    headers: paymentHeaders,
  });

  if (!paidResponse.ok) {
    console.error(`Payment failed: ${paidResponse.status}`);
    return;
  }

  const responseBody = await paidResponse.json();
  console.log("Response:", responseBody);

  const paymentResponse = httpClient.getPaymentSettleResponse(name =>
    paidResponse.headers.get(name),
  );
  console.log("\nPayment response:", JSON.stringify(paymentResponse, null, 2));

  // =========================================================================
  // Step 6: Extract signed receipt from success response
  // =========================================================================
  const signedReceipt = extractReceiptFromResponse(paidResponse);

  if (signedReceipt) {
    const receiptPayload = extractReceiptPayload(signedReceipt);
    console.log(`\nSigned Receipt:`);
    console.log(`  format: ${signedReceipt.format}`);
    console.log(`  resourceUrl: ${receiptPayload.resourceUrl}`);
    console.log(`  payer: ${receiptPayload.payer}`);
    console.log(`  network: ${receiptPayload.network}`);
    console.log(`  issuedAt: ${new Date(receiptPayload.issuedAt * 1000).toISOString()}`);
    if (receiptPayload.transaction) {
      console.log(`  transaction: ${receiptPayload.transaction}`);
    }
  } else {
    console.log("\nNo signed receipt (server may not have receipt signing enabled)");
  }

  // =========================================================================
  // Step 7: Verify receipt signature
  // =========================================================================
  if (signedReceipt) {
    console.log("\nReceipt Signature Verification:");
    try {
      if (isJWSSignedReceipt(signedReceipt)) {
        const verifiedPayload = await verifyReceiptSignatureJWS(signedReceipt);
        console.log(`  JWS: ✓ Valid - payer: ${verifiedPayload.payer}`);
      } else {
        const { signer } = await verifyReceiptSignatureEIP712(signedReceipt);
        console.log(`  EIP-712: ✓ Valid - signer: ${signer}`);
      }
    } catch (err) {
      console.log(`  ✗ FAILED - ${err instanceof Error ? err.message : err}`);
    }
  }

  // =========================================================================
  // Step 8: Verify receipt matches offer (payload field verification)
  // =========================================================================

  if (signedReceipt) {
    const payerAddresses = [evmSigner.address, svmSigner.address];
    const verified = verifyReceiptMatchesOffer(signedReceipt, selected, payerAddresses);

    console.log(`\nPayload Verification: ${verified ? "✓ PASSED" : "✗ FAILED"}`);

    if (!verified) {
      const receiptPayload = extractReceiptPayload(signedReceipt);
      console.log(
        `  resourceUrl: ${receiptPayload.resourceUrl === selected.resourceUrl ? "✓" : "✗"}`,
      );
      console.log(`  network: ${receiptPayload.network === selected.network ? "✓" : "✗"}`);
      const payerMatch = payerAddresses.some(
        addr => receiptPayload.payer.toLowerCase() === addr.toLowerCase(),
      );
      console.log(`  payer: ${payerMatch ? "✓" : "✗"}`);
      const issuedRecently = Math.floor(Date.now() / 1000) - receiptPayload.issuedAt < 3600;
      console.log(`  recent: ${issuedRecently ? "✓" : "✗"}`);
    }
  }

  // =========================================================================
  // Step 9: Summary - Proofs available for downstream use
  // =========================================================================
  console.log("\n--- Proofs Available ---");
  if (signedReceipt) {
    console.log("✓ x402-receipt (proves payment received AND service delivered)");
  }
  if (selected) {
    console.log("✓ x402-offer (proves server committed to payment terms)");
  }

  // -------------------------------------------------------------------------
  // Integration Point: Trust Systems (OMATrust, PEAC, etc.)
  // -------------------------------------------------------------------------
  //
  // This is where integration with downstream systems like OMATrust and PEAC
  // can reside. These systems are planning to support x402 signed receipts
  // and offers for use cases like:
  //
  // - Verified user reviews ("Verified Purchase" badges)
  // - Audit trails and compliance records
  // - Dispute resolution evidence
  // - Agent memory proofs
  //
  // Integration examples will be added in a future update.
  // -------------------------------------------------------------------------
}

main().catch(error => {
  console.error(error?.response?.data?.error ?? error);
  process.exit(1);
});
