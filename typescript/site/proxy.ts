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
const AVM_NETWORK = "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=" as const; // Algorand Testnet

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

## x402 is HTTP-native

x402 uses the HTTP 402 status code — a status code reserved since the beginning of HTTP for exactly this purpose. No proprietary protocols, no walled gardens — just the web, working as intended.

## Links

- [Ecosystem](https://x402.org/ecosystem) — Explore the x402 ecosystem of partners and integrations
- [GitHub](https://github.com/coinbase/x402) — Open source repository
- [x402 v2 Launch](https://x402.org/writing/x402-v2-launch) — Read about the latest release
- [Whitepaper](https://x402.org/x402-whitepaper.pdf) — Technical specification
`;

export const proxy = async (req: NextRequest) => {
  const pathname = new URL(req.url).pathname;
  const accept = req.headers.get("accept") || "";

  if (pathname === "/" && accept.includes("text/markdown")) {
    return new NextResponse(homepageMarkdown, {
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
      },
    });
  }

  const geolocationResponse = await geolocationProxy(req);
  if (geolocationResponse) {
    return geolocationResponse;
  }
  const delegate = x402PaymentProxy as unknown as (
    request: NextRequest,
  ) => ReturnType<typeof x402PaymentProxy>;
  return delegate(req);
};

// Configure which paths the proxy should run on
export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (metadata files)
     */
    "/((?!_next/static|_next/image|favicon.ico).*)",
    "/", // Include the root path explicitly
  ],
};
