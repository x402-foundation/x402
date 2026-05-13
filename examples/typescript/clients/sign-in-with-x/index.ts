import { config } from "dotenv";
import { x402Client, x402HTTPClient, wrapFetchWithPayment } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { UptoEvmScheme } from "@x402/evm/upto/client";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import { privateKeyToAccount } from "viem/accounts";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { base58 } from "@scure/base";
import { createSIWxClientHook, type SolanaSigner } from "@x402/extensions/sign-in-with-x";
config();

const evmPrivateKey = process.env.EVM_PRIVATE_KEY as `0x${string}` | undefined;
const svmPrivateKey = process.env.SVM_PRIVATE_KEY as string | undefined;
const baseURL = process.env.RESOURCE_SERVER_URL || "http://localhost:4021";

// Require at least one key
if (!evmPrivateKey && !svmPrivateKey) {
  console.error("Error: At least one private key required (EVM_PRIVATE_KEY or SVM_PRIVATE_KEY)");
  process.exit(1);
}

const evmSigner = evmPrivateKey ? privateKeyToAccount(evmPrivateKey) : undefined;
const svmSigner = svmPrivateKey
  ? await createKeyPairSignerFromBytes(base58.decode(svmPrivateKey))
  : undefined;

// Configure client with available signers
const client = new x402Client();
if (evmSigner) {
  client.register("eip155:*", new ExactEvmScheme(evmSigner));
  client.register("eip155:*", new UptoEvmScheme(evmSigner));
}
if (svmSigner) {
  client.register("solana:*", new ExactSvmScheme(svmSigner));
}

// Configure HTTP client with SIWX hooks for each signer
// Each hook auto-detects the chain type and fails gracefully if mismatched
const httpClient = new x402HTTPClient(client);
if (evmSigner) {
  httpClient.onPaymentRequired(createSIWxClientHook(evmSigner));
}
if (svmSigner) {
  // Cast needed until @x402/extensions is rebuilt
  httpClient.onPaymentRequired(createSIWxClientHook(svmSigner as SolanaSigner));
}

const fetchWithPayment = wrapFetchWithPayment(fetch, httpClient);

/**
 * Decodes and logs payment response from headers if present.
 *
 * @param response - The fetch response object
 * @returns true if payment response was found and logged
 */
function logPaymentResponse(response: Response): boolean {
  try {
    const paymentResponse = httpClient.getPaymentSettleResponse(name => response.headers.get(name));
    if (paymentResponse) {
      console.log("   ✓ Paid via payment settlement");
      console.log("   Payment details:", JSON.stringify(paymentResponse, null, 2));
      return true;
    }
  } catch {
    // No payment response header present (expected for SIWX auth)
  }
  return false;
}

/**
 * Demonstrates the SIWX flow for a given resource path.
 *
 * @param path - The resource path to request
 */
async function demonstrateResource(path: string): Promise<void> {
  const url = `${baseURL}${path}`;
  console.log(`\n--- ${path} ---`);

  // First request: pays for access
  console.log("1. First request...");
  const response1 = await fetchWithPayment(url);
  const body1 = await response1.json();

  logPaymentResponse(response1);
  if (response1.ok) {
    console.log("   Response:", body1);
  } else if (body1.error) {
    console.log("   ✗ Payment failed:", body1.details || body1.error);
  }

  // Second request: SIWX hook automatically proves we already paid
  console.log("2. Second request...");
  const response2 = await fetchWithPayment(url);
  const body2 = await response2.json();

  const hasPayment = logPaymentResponse(response2);
  if (response2.ok) {
    if (!hasPayment) {
      console.log("   ✓ Authenticated via SIWX (previously paid)");
    }
    console.log("   Response:", body2);
  } else if (body2.error) {
    console.log("   ✗ Payment failed:", body2.details || body2.error);
  }
}

/**
 * Demonstrates auth-only SIWX flow (no payment required).
 * The client hook handles the 402 → sign → retry cycle automatically.
 */
async function demonstrateAuthOnly(): Promise<void> {
  const url = `${baseURL}/profile`;
  console.log("\n--- /profile (auth-only, no payment) ---");

  // fetchWithPayment handles auth-only routes the same way as paid routes:
  // 402 → SIWX client hook signs the challenge → retry with signature
  const response = await fetchWithPayment(url);
  const body = await response.json();

  if (response.ok) {
    console.log("   ✓ Authenticated via SIWX (no payment required)");
    console.log("   Response:", body);
  } else {
    console.log("   ✗ Auth failed:", body);
  }
}

/**
 * Main entry point - demonstrates SIWX authentication flow.
 */
async function main(): Promise<void> {
  if (evmSigner) {
    console.log(`Client EVM address: ${evmSigner.address}`);
  }
  if (svmSigner) {
    console.log(`Client SVM address: ${svmSigner.address}`);
  }
  console.log(`Server: ${baseURL}`);

  // Auth-only: SIWX signature without payment
  await demonstrateAuthOnly();

  await demonstrateResource("/weather");

  // Small delay to avoid facilitator race condition with rapid payments
  await new Promise(resolve => setTimeout(resolve, 300));

  await demonstrateResource("/joke");

  console.log("\nDone. /profile used auth-only SIWX. /weather and /joke used payment + SIWX.");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
