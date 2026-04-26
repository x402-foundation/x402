import { config } from "dotenv";
import { privateKeyToAccount } from "viem/accounts";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { base58 } from "@scure/base";
import { x402Client } from "@x402/core/client";
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from "@x402/core/http";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { UptoEvmScheme } from "@x402/evm/upto/client";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import type { PaymentRequirements } from "@x402/core/types";

config();

/**
 * Custom x402 Client Implementation (v2 Protocol)
 *
 * This example demonstrates how to implement x402 payment handling manually
 * using only the core packages, without the convenience wrappers like @x402/fetch.
 *
 * x402 v2 Protocol Headers:
 * - PAYMENT-REQUIRED: Server → Client (402 response)
 * - PAYMENT-SIGNATURE: Client → Server (retry with payment)
 * - PAYMENT-RESPONSE: Server → Client (settlement confirmation)
 */

const evmPrivateKey = process.env.EVM_PRIVATE_KEY as `0x${string}`;
const svmPrivateKey = process.env.SVM_PRIVATE_KEY as string;
const baseURL = process.env.SERVER_URL || "http://localhost:4021";
const url = `${baseURL}/weather`;

/**
 * Makes a request with x402 payment handling.
 *
 * @param client - The x402 client instance to use for payments
 * @param url - The URL to request
 */
async function makeRequestWithPayment(client: x402Client, url: string): Promise<void> {
  console.log(`\n🌐 Making initial request to: ${url}\n`);

  // Step 1: Make initial request
  let response = await fetch(url);
  console.log(`📥 Initial response status: ${response.status}\n`);

  // Step 2: Handle 402 Payment Required
  if (response.status === 402) {
    console.log("💳 Payment required! Processing...\n");

    // Decode payment requirements from PAYMENT-REQUIRED header
    const paymentRequiredHeader = response.headers.get("PAYMENT-REQUIRED");
    if (!paymentRequiredHeader) {
      throw new Error("Missing PAYMENT-REQUIRED header");
    }
    const paymentRequired = decodePaymentRequiredHeader(paymentRequiredHeader);

    const requirements: PaymentRequirements[] = Array.isArray(paymentRequired.accepts)
      ? paymentRequired.accepts
      : [paymentRequired.accepts];

    console.log("📋 Payment requirements:");
    requirements.forEach((req, i) => {
      console.log(`   ${i + 1}. ${req.network} / ${req.scheme} - ${req.amount}`);
    });

    // Step 3: Create and encode payment
    console.log("\n🔐 Creating payment...\n");
    const paymentPayload = await client.createPaymentPayload(paymentRequired);
    const paymentHeader = encodePaymentSignatureHeader(paymentPayload);

    // Step 4: Retry with PAYMENT-SIGNATURE header
    console.log("🔄 Retrying with payment...\n");
    response = await fetch(url, {
      headers: { "PAYMENT-SIGNATURE": paymentHeader },
    });
    console.log(`📥 Response status: ${response.status}\n`);
  }

  // Step 5: Handle success
  if (response.status === 200) {
    console.log("✅ Success!\n");
    console.log("Response:", await response.json());

    // Decode settlement from PAYMENT-RESPONSE header
    const settlementHeader = response.headers.get("PAYMENT-RESPONSE");
    if (settlementHeader) {
      const settlement = decodePaymentResponseHeader(settlementHeader);
      console.log("\n💰 Settlement:");
      console.log(`   Transaction: ${settlement.transaction}`);
      console.log(`   Network: ${settlement.network}`);
      console.log(`   Payer: ${settlement.payer}`);
    }
  } else {
    throw new Error(`Unexpected status: ${response.status}`);
  }
}

/**
 * Main entry point demonstrating custom x402 client usage.
 */
async function main(): Promise<void> {
  console.log("\n🔧 Custom x402 Client (v2 Protocol)\n");

  if (!evmPrivateKey) {
    console.error("❌ EVM_PRIVATE_KEY required");
    process.exit(1);
  }

  const evmSigner = privateKeyToAccount(evmPrivateKey);
  const solanaSigner = await createKeyPairSignerFromBytes(base58.decode(svmPrivateKey));

  // Custom selector - pick which payment option to use
  // This selects the second payment option (Solana)
  // Create your own logic here to select preferred payment option
  const selectPayment = (_version: number, requirements: PaymentRequirements[]) => {
    const selected = requirements[1];
    console.log(`🎯 Selected: ${selected.network} / ${selected.scheme}`);
    return selected;
  };

  const client = new x402Client(selectPayment)
    .register("eip155:*", new ExactEvmScheme(evmSigner))
    .register("eip155:*", new UptoEvmScheme(evmSigner))
    .register("solana:*", new ExactSvmScheme(solanaSigner));
  console.log("✅ Client ready\n");

  await makeRequestWithPayment(client, url);
  console.log("\n🎉 Done!");
}

main().catch(error => {
  console.error("\n❌ Error:", error.message);
  process.exit(1);
});
