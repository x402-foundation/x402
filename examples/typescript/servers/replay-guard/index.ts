import { config } from "dotenv";
import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { isEIP3009Payload, isPermit2Payload, type ExactEvmPayloadV2 } from "@x402/evm";
import { HTTPFacilitatorClient } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
config();

const evmAddress = process.env.EVM_ADDRESS as `0x${string}`;
const facilitatorUrl = process.env.FACILITATOR_URL;
if (!evmAddress || !facilitatorUrl) {
  console.error("❌ EVM_ADDRESS and FACILITATOR_URL environment variables are required");
  process.exit(1);
}

const facilitatorClient = new HTTPFacilitatorClient({ url: facilitatorUrl });

// A claim is kept until the authorization it names can no longer settle, so a
// copy can never run the handler while the original is still valid. The signer
// chooses that expiry, and verification does not bound it to maxTimeoutSeconds.
// In-memory claims are atomic within one process; with several instances use a
// shared store with an atomic insert (Redis SET NX PXAT, a unique index).
const CLOCK_SKEW_MS = 60 * 1000;
const claims = new Map<string, number>(); // key -> claimed until (ms)

/**
 * Identifies the authorization a payment carries, so a copy of the same signed
 * payment maps to the same key however its JSON is encoded.
 *
 * @param payload - the verified payment payload
 * @param requirements - the requirements it was verified against
 * @returns claim key and the authorization's expiry, or undefined if it carries no nonce
 */
function claimOf(
  payload: PaymentPayload,
  requirements: PaymentRequirements,
): { key: string; expiresAt: number } | undefined {
  const evm = payload.payload as ExactEvmPayloadV2;
  if (isPermit2Payload(evm)) {
    // Permit2 nonces are uint256s scoped to the owner, across tokens. The signed
    // value is BigInt(nonce), so "1", "01" and "0x1" are one authorization.
    const { from, nonce, deadline } = evm.permit2Authorization;
    return {
      key: `${requirements.network}:permit2:${from.toLowerCase()}:${BigInt(nonce)}`,
      expiresAt: Number(deadline) * 1000,
    };
  }
  if (isEIP3009Payload(evm)) {
    // EIP-3009 nonces are bytes32 scoped to the token contract and the signer;
    // only the full 32-byte form verifies, so lowercasing is enough.
    const { from, nonce, validBefore } = evm.authorization;
    return {
      key: `${requirements.network}:${requirements.asset.toLowerCase()}:${from.toLowerCase()}:${nonce.toLowerCase()}`,
      expiresAt: Number(validBefore) * 1000,
    };
  }
  return undefined;
}

const resourceServer = new x402ResourceServer(facilitatorClient)
  .register("eip155:84532", new ExactEvmScheme())
  // Verify does not consume the authorization; settlement does. Until then one
  // signed payment verifies as often as it is sent, and each copy would run the
  // handler. Claiming here, after verification and before the handler, lets
  // exactly one copy through. Only valid payments are claimed.
  .onAfterVerify(async ({ paymentPayload, requirements, result }) => {
    if (!result.isValid) return;
    const claim = claimOf(paymentPayload as PaymentPayload, requirements as PaymentRequirements);
    if (!claim) return;
    const claimedUntil = claims.get(claim.key);
    if (claimedUntil !== undefined && Date.now() < claimedUntil) {
      return {
        abort: true,
        reason: "payment_replayed",
        message: "This payment authorization was already presented.",
      };
    }
    claims.set(claim.key, claim.expiresAt + CLOCK_SKEW_MS);
  });

setInterval(() => {
  const now = Date.now();
  for (const [key, claimedUntil] of claims) if (claimedUntil <= now) claims.delete(key);
}, 60 * 1000).unref();

const app = express();

app.use(
  paymentMiddleware(
    {
      "GET /report": {
        accepts: [{ scheme: "exact", price: "$0.001", network: "eip155:84532", payTo: evmAddress }],
        description: "A report that is expensive to produce",
        mimeType: "application/json",
      },
    },
    resourceServer,
  ),
);

let runs = 0;
app.get("/report", (_req, res) => {
  runs++;
  console.log(`[handler] run #${runs}`);
  res.json({ report: "generated", run: runs });
});

app.listen(4021, () => {
  console.log("Replay-guard example server listening at http://localhost:4021");
});
