
import { paymentProxyFromConfig } from "@x402/next";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import { ExactAvmScheme } from "@x402/avm/exact/server";
import { NextRequest, NextResponse } from "next/server";
import { createPaywall } from "@x402/paywall";
import { evmPaywall } from "@x402/paywall/evm";
import { svmPaywall } from "@x402/paywall/svm";
import { avmPaywall } from "@x402/paywall/avm";

const evmPayeeAddress = process.env.RESOURCE_EVM_ADDRESS as `0x${string}`;
const svmPayeeAddress = process.env.RESOURCE_SVM_ADDRESS as string;
const avmPayeeAddress = process.env.RESOURCE_AVM_ADDRESS;
const facilitatorUrl = process.env.FACILITATOR_URL as string;

const EVM_NETWORK = "eip155:84532" as const; // Base Sepolia
const SVM_NETWORK = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" as const; // Solana Devnet
const AVM_NETWORK = "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDe" as const; // Algorand Testnet

// List of blocked countries and regions
const BLOCKED_COUNTRIES = [
  "KP", // North Korea
  "IR", // Iran
  "CU", // Cuba
  "SY", // Syria
];

// List of blocked regions within specific countries
const BLOCKED_REGIONS = {
  UA: ["43", "14", "09"],
};

// Validate required environment variables
if (!facilitatorUrl) {
  console.error("❌ FACILITATOR_URL environment variable is required");
}

// Create HTTP facilitator client
const facilitatorClient = new HTTPFacilitatorClient({ url: facilitatorUrl });

// Build the paywall provider
const paywallBuilder = createPaywall().withNetwork(evmPaywall).withNetwork(svmPaywall);
if (avmPayeeAddress) {
  paywallBuilder.withNetwork(avmPaywall);
}
const paywall = paywallBuilder
  .withConfig({
    appName: "x402 Demo",
    appLogo: "/logos/x402-examples.png",
  })
  .build();

/**
 * Pact-Escrow Profile: Verification Gated Release Policy for Auth-Capture
 *
 * This implements a two-phase payment flow:
 * 1. Authorization phase: Funds are authorized/captured at request time
 * 2. Release phase: Funds are only released after successful verification
 *
 * The verification gate ensures that payment settlement is contingent on
 * confirmed delivery/fulfillment, implementing the pact-escrow pattern
 * described in issue #3065.
 */

/** Verification status for auth-capture escrow */
export type VerificationStatus = "pending" | "verified" | "failed" | "released" | "refunded";

/** Pact-escrow record storing auth-capture state */
export interface PactEscrowRecord {
  id: string;
  paymentReference: string;
  authorizedAt: number;
  verificationDeadlineMs: number;
  status: VerificationStatus;
  verificationProof?: string;
  releasedAt?: number;
  refundedAt?: number;
  metadata?: Record<string, unknown>;
}

/** Policy configuration for verification gated release */
export interface VerificationGatedReleasePolicy {
  /** Maximum time (ms) to wait for verification before auto-refund */
  verificationTimeoutMs: number;
  /** Whether to auto-release on timeout (false = auto-refund) */
  autoReleaseOnTimeout: boolean;
  /** Verification endpoint to call for proof validation */
  verificationEndpoint?: string;
  /** Required proof fields that must be present for verification */
  requiredProofFields?: string[];
}

/** Default pact-escrow policy: 24-hour verification window, auto-refund on timeout */
export const DEFAULT_PACT_ESCROW_POLICY: VerificationGatedReleasePolicy = {
  verificationTimeoutMs: 24 * 60 * 60 * 1000, // 24 hours
  autoReleaseOnTimeout: false, // conservative: refund if not verified
  requiredProofFields: ["deliveryConfirmation", "timestamp"],
};

/** In-memory escrow store (production should use persistent storage) */
const escrowStore = new Map<string, PactEscrowRecord>();

/**
 * Creates a new pact-escrow record for an authorized payment.
 * Called when payment is authorized but not yet released.
 */
export function createPactEscrow(
  paymentReference: string,
  policy: VerificationGatedReleasePolicy = DEFAULT_PACT_ESCROW_POLICY,
  metadata?: Record<string, unknown>,
): PactEscrowRecord {
  const id = `escrow_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const now = Date.now();
  const record: PactEscrowRecord = {
    id,
    paymentReference,
    authorizedAt: now,
    verificationDeadlineMs: now + policy.verificationTimeoutMs,
    status: "pending",
    metadata,
  };
  escrowStore.set(id, record);
  return record;
}

/**
 * Verifies a pact-escrow record and gates the release of funds.
 * Returns true if verification passes and funds should be released.
 */
export function verifyAndReleasePactEscrow(
  escrowId: string,
  verificationProof: Record<string, unknown>,
  policy: VerificationGatedReleasePolicy = DEFAULT_PACT_ESCROW_POLICY,
): { success: boolean; record: PactEscrowRecord | null; reason?: string } {
  const record = escrowStore.get(escrowId);

  if (!record) {
    return { success: false, record: null, reason: "Escrow record not found" };
  }

  if (record.status !== "pending") {
    return {
      success: false,
      record,
      reason: `Escrow is not in pending state (current: ${record.status})`,
    };
  }

  const now = Date.now();

  // Check if verification deadline has passed
  if (now > record.verificationDeadlineMs) {
    if (policy.autoReleaseOnTimeout) {
      record.status = "released";
      record.releasedAt = now;
      escrowStore.set(escrowId, record);
      return { success: true, record, reason: "Auto-released on timeout per policy" };
    } else {
      record.status = "refunded";
      record.refundedAt = now;
      escrowStore.set(escrowId, record);
      return { success: false, record, reason: "Verification deadline exceeded, funds refunded" };
    }
  }

  // Validate required proof fields
  if (policy.requiredProofFields && policy.requiredProofFields.length > 0) {
    const missingFields = policy.requiredProofFields.filter(
      (field) => !(field in verificationProof) || verificationProof[field] == null,
    );
    if (missingFields.length > 0) {
      return {
        success: false,
        record,
        reason: `Missing required proof fields: ${missingFields.join(", ")}`,
      };
    }
  }

  // Verification passed — gate the release
  record.status = "verified";
  record.verificationProof = JSON.stringify(verificationProof);
  escrowStore.set(escrowId, record);

  // Proceed to release
  record.status = "released";
  record.releasedAt = now;
  escrowStore.set(escrowId, record);

  return { success: true, record };
}

/**
 * Refunds a pact-escrow (e.g., on failed delivery or explicit cancellation).
 */
export function refundPactEscrow(
  escrowId: string,
  reason?: string,
): { success: boolean; record: PactEscrowRecord | null; reason?: string } {
  const record = escrowStore.get(escrowId);

  if (!record) {
    return { success: false, record: null, reason: "Escrow record not found" };
  }

  if (record.status === "released") {
    return { success: false, record, reason: "Cannot refund: funds already released" };
  }

  if (record.status === "refunded") {
    return { success: false, record, reason: "Escrow already refunded" };
  }

  record.status = "refunded";
  record.refundedAt = Date.now();
  escrowStore.set(escrowId, record);

  return { success: true, record, reason: reason ?? "Manual refund" };
}

/**
 * Retrieves a pact-escrow record by ID.
 */
export function getPactEscrow(escrowId: string): PactEscrowRecord | null {
  return escrowStore.get(escrowId) ?? null;
}

/**
 * Lists all pact-escrow records with optional status filter.
 */
export function listPactEscrows(statusFilter?: VerificationStatus): PactEscrowRecord[] {
  const records = Array.from(escrowStore.values());
  if (statusFilter) {
    return records.filter((r) => r.status === statusFilter);
  }
  return records;
}

/**
 * Handles the verification gated release endpoint for pact-escrow.
 * Clients POST to this endpoint with their verification proof to release funds.
 */
export async function handlePactEscrowVerification(req: NextRequest): Promise<NextResponse> {
  if (req.method !== "POST") {
    return new NextResponse(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return new NextResponse(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const { escrowId, proof, policy } = body as {
    escrowId?: string;
    proof?: Record<string, unknown>;
    policy?: Partial<VerificationGatedReleasePolicy>;
  };

  if (!escrowId || typeof escrowId !== "string") {
    return new NextResponse(JSON.stringify({ error: "escrowId is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (!proof || typeof proof !== "object") {
    return new NextResponse(JSON.stringify({ error: "proof is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const mergedPolicy: VerificationGatedReleasePolicy = {
    ...DEFAULT_PACT_ESCROW_POLICY,
    ...policy,
  };

  const result = verifyAndReleasePactEscrow(escrowId, proof, mergedPolicy);

  if (result.success) {
    return new NextResponse(
      JSON.stringify({
        success: true,
        escrowId,
        status: result.record?.status,
        releasedAt: result.record?.releasedAt,
        reason: result.reason,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  } else {
    return new NextResponse(
      JSON.stringify({
        success: false,
        escrowId,
        status: result.record?.status ?? "not_found",
        reason: result.reason,
      }),
      {
        status: 422,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
}

const x402PaymentProxy = paymentProxyFromConfig(
  {
    "/protected": {
      accepts: [
        {
          payTo: evmPayeeAddress,
          scheme: "exact",
          price: "$0.01",
          network: EVM_NETWORK,
        },
        {
          payTo: svmPayeeAddress,
          scheme: "exact",
          price: "$0.01",
          network: SVM_NETWORK,
        },
        ...(avmPayeeAddress
          ? [
              {
                payTo: avmPayeeAddress,
                scheme: "exact" as const,
                price: "$0.01",
                network: AVM_NETWORK,
              },
            ]
          : []),
      ],
      description: "Access to protected content",
    },
  },
  facilitatorClient,
  [
    { network: EVM_NETWORK, server: new ExactEvmScheme() },
    { network: SVM_NETWORK, server: new ExactSvmScheme() },
    ...(avmPayeeAddress ? [{ network: AVM_NETWORK, server: new ExactAvmScheme() }] : []),
  ],
  undefined, // paywallConfig
  paywall, // paywall provider
);

const geolocationProxy = async (req: NextRequest) => {
  // Get the country and region from Vercel's headers
  const country = req.headers.get("x-vercel-ip-country") || "US";
  const region = req.headers.get("x-vercel-ip-country-region");

  const isCountryBlocked = BLOCKED_COUNTRIES.includes(country);
  const isRegionBlocked =
    region && BLOCKED_REGIONS[country as keyof typeof BLOCKED_REGIONS]?.includes(region);

  if (isCountryBlocked || isRegionBlocked) {
    return new NextResponse("Access denied: This service is not available in your region", {
      status: 451,
      headers: {
        "Content-Type": "text/plain",
      },
    });
  }

  return null;
};

const homepageMarkdown = `# x402 — Payment Required | Internet-Native Payments Standard

x402 is the internet's payment standard. An open standard for internet-native payments that empowers agentic payments at scale. Build a more free and fair internet.

## Accept payments with a single line of code

\`\`\`javascript
app.use(
  paymentMiddleware(
    {
      "GET /weather": {
        accepts: [...],
        description: "Weather data",
      },
    },
  )
);
\`\`\`

Add one line of code to require payment for each incoming request. If a request arrives without payment, the server responds with HTTP 402, prompting the client to pay and retry.

## Key Features

- **Zero protocol fees** — x402 is free for the customer and the merchant—just pay nominal payment network fees
- **Zero wait** — Money moves at the speed of the internet
- **Zero friction** — No accounts or personal information needed
- **Zero centralization** — Anyone on the internet can build on or extend x402
- **Zero restrictions** — x402 is a neutral standard, not tied to any specific network

## How x402 Works vs Traditional Payments

### Traditional (5 steps)

1. Create account with new API provider
2. Add payment method (KYC required)
3. Buy credits or subscription
4. Manage API key
5. Make payment

### x402 (3 steps)

1. AI agent sends HTTP request and receives 402: Payment Required
2. AI agent pays instantly with stablecoins
3. API access granted

## x402 is HTTP-nati`;

export { x402PaymentProxy, geolocationProxy, homepageMarkdown };
